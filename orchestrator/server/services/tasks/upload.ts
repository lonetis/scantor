import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { RevisionDoc, TaskDoc } from '../../types/documents'
import { ByteCap } from '../../utils/byte-cap'
import { type ApiError, apiError } from '../../utils/errors'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import type { UserPrincipal } from '../../utils/principal'
import { isKnownLanguage } from '../catalog/languages'
import { commit, discard, extract, snapshotHash } from '../helpers/ops'
import type { ExtractOutput, WorkspaceSummary } from '../helpers/types'
import { publishRevision } from '../revisions/publish'
import { applyWorkspaceSummary, findTaskByName, insertTask, newTaskDoc } from './store'

// Task upload (`uploadTask`, `scantor push`; docs/api.md §4.6, §5.3; docs/tasks.md §13; docs/editor.md §9.6, §9.9):
// the tar.gz streams into helper `extract`, the manifest name selects or creates the task, the orchestrator decides on
// conflicts from the current workspace hash, helper `commit --expect <hash>` replaces the folder atomically (a
// concurrent edit still fails), `lastSyncSha256` becomes the uploaded hash, and a revision is published unless
// `publish=false`. The `extract` helper holds a helper slot while it reads the body, so a body that sends nothing for
// UPLOAD_IDLE_MS fails the upload (400 badRequest) instead of holding the slot until the helper timeout.

/** How long a task upload's body may send nothing while none of it is buffered, before the upload fails. */
export const UPLOAD_IDLE_MS = 30_000

export interface UploadInput {
  body: Readable
  /** cap of the compressed stream (SCANTOR_TASK_MAX_PACK_BYTES) */
  maxBytes: number
  /** test seam: UPLOAD_IDLE_MS */
  idleMs?: number
  publish: boolean
  force: boolean
  message?: string
}

/** The media types accepted for a task upload. */
export const TASK_UPLOAD_CONTENT_TYPES = ['application/gzip', 'application/x-gzip'] as const

export function assertTaskUploadContentType(header: string | undefined): void {
  const type = (header ?? '').split(';')[0]!.trim().toLowerCase()
  if (!(TASK_UPLOAD_CONTENT_TYPES as readonly string[]).includes(type)) {
    throw apiError('unsupportedMediaType', 'the task upload body must be application/gzip (a tar.gz of the task folder)')
  }
}

function tooLarge(cap: ByteCap): ApiError {
  return apiError('payloadTooLarge', `the upload exceeds ${cap.maxBytes} bytes`, { limit: cap.maxBytes })
}

function stalledError(idleMs: number): ApiError {
  return apiError('badRequest', `the upload sent no data for ${Math.round(idleMs / 1000)} s`, { idleMs })
}

/**
 * Ends the helper's input once the body sends nothing for `idleMs` while nothing of it waits in `cap`: then the
 * client, not the helper, is slow. Data buffered behind a helper that has not started yet (waiting for a slot) keeps
 * the guard quiet. Ending (not destroying) the input lets the helper fail at once on the truncated archive.
 */
class StallGuard {
  stalled = false
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly body: Readable,
    private readonly cap: ByteCap,
    private readonly idleMs: number,
  ) {
    body.once('end', () => this.stop())
    this.touch()
  }

  touch(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.check(), this.idleMs)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private check(): void {
    this.timer = null
    if (this.body.readableLength + this.cap.readableLength + this.cap.writableLength > 0) {
      this.touch()
      return
    }
    this.stalled = true
    this.body.unpipe(this.cap)
    this.cap.end()
  }
}

export interface UploadOutcome {
  task: TaskDoc
  revision: RevisionDoc | null
  created: boolean
}

/**
 * The conflict rule of docs/api.md §5.3: no conflict when the folder is absent, or the current workspace hash equals
 * the uploaded hash, `latestRevision.packSha256` (any state) or `workspace.lastSyncSha256`.
 */
export function uploadConflicts(current: WorkspaceSummary | null, uploadedSha256: string, task: Pick<TaskDoc, 'latestRevision' | 'workspace'>): boolean {
  if (!current) return false
  const hash = current.packSha256
  if (hash === uploadedSha256) return false
  if (task.latestRevision && hash === task.latestRevision.packSha256) return false
  if (task.workspace.lastSyncSha256 !== null && hash === task.workspace.lastSyncSha256) return false
  return true
}

async function discardQuietly(userId: string, stagingId: string): Promise<void> {
  await discard(userId, stagingId).catch((error: unknown) => useLogger('tasks').warn('discarding a staging directory failed', { stagingId, err: error }))
}

/** Finds the caller's task by manifest name or creates it (`source.kind = upload`). */
async function taskForManifest(principal: UserPrincipal, manifest: ExtractOutput['manifest']): Promise<{ task: TaskDoc; created: boolean }> {
  const existing = await findTaskByName(principal.user.id, manifest.name)
  if (existing) {
    if (existing.deletingAt) throw apiError('alreadyExists', `task ${manifest.name} is being deleted; retry when the deletion finished`)
    return { task: existing, created: false }
  }
  if (!isKnownLanguage(manifest.language)) {
    throw apiError('manifestInvalid', `unknown language ${manifest.language}`, {
      errors: [{ phase: 'static', file: 'scantor.yaml', message: `unknown language "${manifest.language}"` }],
    })
  }
  try {
    const task = await insertTask(
      newTaskDoc({
        userId: principal.user.id,
        name: manifest.name,
        language: manifest.language,
        description: typeof manifest.description === 'string' ? manifest.description : null,
        source: { kind: 'upload' },
      }),
    )
    return { task, created: true }
  } catch (error) {
    // A concurrent upload created it first: continue with that task.
    const raced = (error as { code?: unknown }).code === 'alreadyExists' ? await findTaskByName(principal.user.id, manifest.name) : null
    if (raced && !raced.deletingAt) return { task: raced, created: false }
    throw error
  }
}

export async function uploadTask(principal: UserPrincipal, input: UploadInput): Promise<UploadOutcome> {
  const userId = principal.user.id
  const stagingId = randomUUID()
  const idleMs = input.idleMs ?? UPLOAD_IDLE_MS
  const cap: ByteCap = new ByteCap(input.maxBytes, () => guard.touch())
  const guard = new StallGuard(input.body, cap, idleMs)
  input.body.on('error', (error) => cap.destroy(error))
  let extracted: ExtractOutput
  try {
    extracted = await extract(userId, stagingId, input.body.pipe(cap))
  } catch (error) {
    await discardQuietly(userId, stagingId)
    throw cap.exceeded ? tooLarge(cap) : guard.stalled ? stalledError(idleMs) : error
  } finally {
    guard.stop()
  }
  if (cap.exceeded || guard.stalled) {
    await discardQuietly(userId, stagingId)
    throw cap.exceeded ? tooLarge(cap) : stalledError(idleMs)
  }
  let committed = false
  try {
    const { task, created } = await taskForManifest(principal, extracted.manifest)
    let expect: string
    if (created) {
      // A folder without a task document (a crashed request) carries nothing worth keeping.
      expect = 'any'
    } else {
      const current = await snapshotHash(userId, task.name)
      if (!input.force && uploadConflicts(current, extracted.summary.packSha256, task)) {
        throw apiError('workspaceDirty', `the workspace of task ${task.name} has unpublished changes; retry with force=true to replace them`, {
          current: current?.packSha256 ?? null,
          uploaded: extracted.summary.packSha256,
        })
      }
      expect = input.force ? 'any' : (current?.packSha256 ?? 'absent')
    }
    let result: Awaited<ReturnType<typeof commit>>
    try {
      result = await commit(userId, { stagingId, task: task.name, expect })
    } catch (error) {
      if (created) await useCollections().tasks.deleteOne({ _id: task._id, revisionSeq: 0 })
      throw error
    }
    committed = true
    const updated = (await applyWorkspaceSummary(task._id, result.workspace, { lastSyncSha256: result.workspace.packSha256 })) ?? task
    const revision = input.publish ? (await publishRevision(updated, { message: input.message, viaUpload: true })).revision : null
    return { task: revision ? ((await findTaskByName(userId, updated.name)) ?? updated) : updated, revision, created }
  } finally {
    if (!committed) await discardQuietly(userId, stagingId)
  }
}
