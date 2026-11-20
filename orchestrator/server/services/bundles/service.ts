import { randomUUID } from 'node:crypto'
import type { Collection } from 'mongodb'
import type { BundleDoc, JobDoc, RevisionDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { apiError } from '../../utils/errors'
import { cancelActiveJobs, createJob } from '../../utils/jobs'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { deleteObject, isS3NotFound } from '../../utils/s3'
import { scantorVersion } from '../../utils/version'
import { bundleFileName, bundleImageName, bundleRef } from './info'

// Bundles of revisions (docs/api.md, tag `revisions`; docs/data-model.md §4.21, §6.12): one `bundles` document per
// revision (unique `revisionId`) and a `bundle` job that writes the archive to `bundles/<taskId>/<bundleId>.tar.gz`.
// A bundle belongs to the owner of its revision and expires after SCANTOR_BUNDLE_RETENTION_DAYS (TTL index plus the
// `bundles/` lifecycle rule). Bundles do not count toward SCANTOR_USER_STORAGE_QUOTA_BYTES, like exports.
//
// createRevisionBundle applies these rules in order:
//   1. a task being deleted is 404;
//   2. a revision that is not ready is 409 revisionNotReady, a privileged one 409 bundleUnsupported (reason
//      `privileged`: a bundle run never starts a Docker daemon);
//   3. an unexpired queued or running bundle is returned (200), unless it has had no active job for a while (stale);
//   4. an unexpired ready bundle with the runtime version of this orchestrator is returned (200) without `rebuild`;
//   5. otherwise the old bundle's job is cancelled, its object and document are deleted and a new one is inserted
//      (a duplicate key on revisionId means a concurrent request won: its bundle is returned, 200);
//   6. the `bundle` job is created; without it the document is deleted again. 201.

/** How long a queued or running bundle without an active job still counts as active (its job may be being inserted). */
export const STALE_BUNDLE_GRACE_MS = 5 * 60_000

export function bundleKey(taskId: string, bundleId: string): string {
  return `bundles/${taskId}/${bundleId}.tar.gz`
}

export function isBundleActive(doc: Pick<BundleDoc, 'state'>): boolean {
  return doc.state === 'queued' || doc.state === 'running'
}

export function isBundleExpired(doc: Pick<BundleDoc, 'expiresAt'>, now: Date = new Date()): boolean {
  return doc.expiresAt.getTime() <= now.getTime()
}

export type ReuseVerdict = 'reuse' | 'replace'

/** Whether an existing bundle answers a create request (rules 3 and 4; pure). */
export function reuseVerdict(
  doc: Pick<BundleDoc, 'state' | 'expiresAt' | 'scantorVersion' | 'updatedAt'>,
  options: { rebuild: boolean; version: string; jobActive: boolean; now?: Date },
): ReuseVerdict {
  const now = options.now ?? new Date()
  // An expired bundle no longer exists for getRevisionBundle, whatever its state.
  if (isBundleExpired(doc, now)) return 'replace'
  if (isBundleActive(doc)) {
    return options.jobActive || now.getTime() - doc.updatedAt.getTime() < STALE_BUNDLE_GRACE_MS ? 'reuse' : 'replace'
  }
  if (doc.state === 'ready' && doc.scantorVersion === options.version && !options.rebuild) return 'reuse'
  return 'replace'
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000
}

/** Deletes a bundle's archive; a missing object counts as deleted. */
export async function deleteBundleObject(key: string): Promise<void> {
  try {
    await deleteObject(key)
  } catch (error) {
    if (!isS3NotFound(error)) throw error
  }
}

/** Deletes a bundle's archive, logging instead of throwing (cleanup after a failed or superseded job). */
export async function discardBundleObject(key: string, log: Logger): Promise<void> {
  await deleteBundleObject(key).catch((error: unknown) => log.warn('deleting a bundle archive failed', { key, err: error }))
}

/** The current bundle of a revision; 404 notFound when there is none or it expired (the TTL removes it soon). */
export async function loadBundle(revision: Pick<RevisionDoc, '_id'>, bundles: Collection<BundleDoc> = useCollections().bundles): Promise<BundleDoc> {
  const doc = await bundles.findOne({ revisionId: revision._id })
  if (!doc || isBundleExpired(doc)) throw apiError('notFound', 'bundle not found')
  return doc
}

export interface CreateBundleResult {
  bundle: BundleDoc
  /** true when this request inserted the bundle (201), false when it returned an existing one (200) */
  created: boolean
}

/** createRevisionBundle: the rules of the header comment. */
export async function createBundle(
  revision: RevisionDoc,
  options: { rebuild?: boolean },
  config: Pick<Config, 'bundleRetentionDays'>,
): Promise<CreateBundleResult> {
  const { bundles, jobs, tasks } = useCollections()
  const ref = bundleRef(revision.taskName, revision.number)
  const task = await tasks.findOne({ _id: revision.taskId, deletingAt: null }, { projection: { _id: 1 } })
  if (!task) throw apiError('notFound', 'task not found')
  if (revision.state !== 'ready' || !revision.image) {
    throw apiError('revisionNotReady', `revision ${ref} is ${revision.state}`, { state: revision.state, allowed: ['ready'] })
  }
  if (revision.privileged) {
    throw apiError('bundleUnsupported', `revision ${ref} is privileged: a bundle cannot run Docker-in-Docker`, { reason: 'privileged' })
  }

  const existing = await bundles.findOne({ revisionId: revision._id })
  if (existing) {
    const jobActive = isBundleActive(existing) && (await jobs.countDocuments({ kind: 'bundle', 'subject.id': existing._id, active: true }, { limit: 1 })) > 0
    if (reuseVerdict(existing, { rebuild: options.rebuild === true, version: scantorVersion, jobActive }) === 'reuse')
      return { bundle: existing, created: false }
    await cancelActiveJobs('bundle', existing._id)
    await deleteBundleObject(existing.key)
    await bundles.deleteOne({ _id: existing._id })
  }

  const now = new Date()
  const id = randomUUID()
  const platform = { os: revision.image.platform.os, arch: revision.image.platform.arch }
  const doc: BundleDoc = {
    _id: id,
    userId: revision.userId,
    taskId: revision.taskId,
    taskName: revision.taskName,
    revisionId: revision._id,
    revisionNumber: revision.number,
    state: 'queued',
    image: bundleImageName(revision.taskName, revision.number),
    platform,
    key: bundleKey(revision.taskId, id),
    fileName: bundleFileName(revision.taskName, revision.number, platform),
    bytes: null,
    sha256: null,
    scantorVersion: null,
    // Set right after the job exists; the job reads only the bundle id.
    jobId: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    expiresAt: new Date(now.getTime() + config.bundleRetentionDays * 86_400_000),
  }
  try {
    await bundles.insertOne(doc)
  } catch (error) {
    if (!isDuplicateKey(error)) throw error
    const winner = await bundles.findOne({ revisionId: revision._id })
    if (winner) return { bundle: winner, created: false }
    throw error
  }
  let job: JobDoc
  try {
    ;({ job } = await createJob({ kind: 'bundle', userId: revision.userId, subject: { kind: 'bundle', id }, params: { bundleId: id } }))
  } catch (error) {
    // Without its job the bundle would stay queued.
    await bundles.deleteOne({ _id: id }).catch(() => undefined)
    throw error
  }
  await bundles.updateOne({ _id: id }, { $set: { jobId: job._id } })
  doc.jobId = job._id
  return { bundle: doc, created: true }
}

/**
 * Re-reads the bundle of a revision during a wait (by revision, so a bundle that a concurrent request replaced is
 * followed). A bundle that disappeared or expired meanwhile is 404, like any bundle that does not exist.
 */
export async function reloadBundle(doc: Pick<BundleDoc, 'revisionId'>, bundles: Collection<BundleDoc> = useCollections().bundles): Promise<BundleDoc> {
  return loadBundle({ _id: doc.revisionId }, bundles)
}
