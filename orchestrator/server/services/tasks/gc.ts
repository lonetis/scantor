import type Docker from 'dockerode'
import type { Config } from '../../utils/config'
import { useDocker } from '../../utils/docker'
import { type ManagedKind, isManagedContainer } from '../../utils/labels'
import { LeaseLock } from '../../utils/locks'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { platformError } from '../pipeline/events'
import { failRevision } from '../revisions/build'
import { ACTIVE_TEST_RUN_STATES } from '../test-runs'

// Garbage collection of the task domain (docs/architecture.md §4.1 reconciler, docs/tasks.md §11.1,
// docs/deployment.md §14.2), run by the reconciler under the `gc` lease: once at start (the boot sweep) and then
// every minute (draft images every 10 minutes):
//   - orphan containers: workspace helpers (`scantor-h-*`) older than SCANTOR_HELPER_TIMEOUT, test-run containers
//     (`scantor-t-*`) of runs that are not running or older than SCANTOR_TEST_RUN_TIMEOUT, describe/check containers
//     (`scantor-b-*`) older than their timeouts; ages leave a margin, so containers a live process still manages
//     are never touched (the api component may run in another process);
//   - draft images `tasks/<taskId>:draft-<packSha256>` created more than SCANTOR_DRAFT_IMAGE_RETENTION ago that no
//     queued, building or running test run uses;
//   - test runs and revisions left unfinished without an active job (their job was cancelled or deleted) fail.

export const GC_TICK_MS = 60_000
export const DRAFT_GC_EVERY_TICKS = 10
const CONTAINER_MARGIN_MS = 5 * 60_000
/** Documents younger than this may still be waiting for their job to be inserted or claimed. */
const STALE_DOCUMENT_GRACE_MS = 5 * 60_000
const DRAFT_TAG = /^tasks\/[0-9a-f-]{36}:draft-[0-9a-f]{64}$/

export interface ContainerSummary {
  Id: string
  Names: string[]
  Labels: Record<string, string>
  Created: number
}

export type OrphanVerdict = 'keep' | 'remove'

/** Whether a managed helper, test-run or build container is an orphan (pure; `activeTestRunIds` are running runs). */
export function orphanVerdict(
  container: ContainerSummary,
  now: number,
  config: Pick<Config, 'helperTimeoutMs' | 'testRunTimeoutMs' | 'describeTimeoutMs' | 'buildTimeoutMs'>,
  runningTestRuns: ReadonlySet<string>,
): OrphanVerdict {
  const name = (container.Names[0] ?? '').replace(/^\//, '')
  const ageMs = now - container.Created * 1000
  const is = (kind: ManagedKind) => isManagedContainer(kind, name, container.Labels)
  if (is('helper')) return ageMs > config.helperTimeoutMs + CONTAINER_MARGIN_MS ? 'remove' : 'keep'
  if (is('build')) return ageMs > config.buildTimeoutMs + 2 * config.describeTimeoutMs + CONTAINER_MARGIN_MS ? 'remove' : 'keep'
  if (is('testRun')) {
    const testRunId = name.slice('scantor-t-'.length)
    if (ageMs > config.testRunTimeoutMs + CONTAINER_MARGIN_MS) return 'remove'
    return runningTestRuns.has(testRunId) || ageMs < CONTAINER_MARGIN_MS ? 'keep' : 'remove'
  }
  return 'keep'
}

/** Whether a draft image tag may be removed (pure). */
export function draftVerdict(tag: string, createdSeconds: number, now: number, retentionMs: number, inUse: ReadonlySet<string>): OrphanVerdict {
  if (!DRAFT_TAG.test(tag) || inUse.has(tag)) return 'keep'
  return now - createdSeconds * 1000 > retentionMs ? 'remove' : 'keep'
}

export class TasksGc {
  private readonly lock: LeaseLock
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private ticks = 0

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly docker: Docker = useDocker(),
  ) {
    this.lock = new LeaseLock(useCollections().locks, 'gc', { logger: log, onAcquired: () => setImmediate(() => this.tick()) })
  }

  start(): void {
    this.lock.start()
    this.timer = setInterval(() => this.tick(), GC_TICK_MS)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.running
    await this.lock.stop()
  }

  private tick(): void {
    if (this.running || !this.lock.held) return
    const withDrafts = this.ticks % DRAFT_GC_EVERY_TICKS === 0
    this.ticks++
    this.running = this.sweep(withDrafts)
      .catch((error: unknown) => this.log.error('task garbage collection failed', { err: error }))
      .finally(() => {
        this.running = null
      })
  }

  async sweep(withDrafts: boolean, now = Date.now()): Promise<void> {
    await this.failStaleTestRuns(now)
    await this.failStaleRevisions(now)
    await this.removeOrphanContainers(now)
    if (withDrafts) await this.removeOldDraftImages(now)
  }

  /** Active test runs without an active job (cancelled or deleted job) fail. */
  async failStaleTestRuns(now: number): Promise<void> {
    const { testRuns, jobs } = useCollections()
    const candidates = await testRuns
      .find({ state: { $in: [...ACTIVE_TEST_RUN_STATES] }, updatedAt: { $lt: new Date(now - STALE_DOCUMENT_GRACE_MS) } }, { projection: { _id: 1 } })
      .toArray()
    for (const testRun of candidates) {
      if ((await jobs.countDocuments({ kind: 'testRun', 'subject.id': testRun._id, active: true }, { limit: 1 })) > 0) continue
      const at = new Date()
      const result = await testRuns.updateOne(
        { _id: testRun._id, state: { $in: [...ACTIVE_TEST_RUN_STATES] } },
        { $set: { state: 'failed', errors: [platformError('the test run was interrupted; start it again')], finishedAt: at, updatedAt: at }, $unset: { 'secrets.request': '' } },
      )
      if (result.modifiedCount > 0) this.log.warn('failed an interrupted test run', { testRunId: testRun._id })
    }
  }

  /** Unfinished revisions without an active build job fail. */
  async failStaleRevisions(now: number): Promise<void> {
    const { revisions, jobs } = useCollections()
    const candidates = await revisions
      .find({ state: { $in: ['queued', 'building'] }, updatedAt: { $lt: new Date(now - STALE_DOCUMENT_GRACE_MS) } }, { projection: { _id: 1 } })
      .toArray()
    for (const revision of candidates) {
      if ((await jobs.countDocuments({ kind: 'revisionBuild', 'subject.id': revision._id, active: true }, { limit: 1 })) > 0) continue
      await failRevision(revision._id, [platformError('the build was interrupted; publish again')], this.log)
    }
  }

  async removeOrphanContainers(now: number): Promise<void> {
    const containers = (await this.docker.listContainers({ all: true, filters: { label: ['scantor.managed=true'] } })) as ContainerSummary[]
    const running = new Set(
      (await useCollections().testRuns.find({ state: 'running' }, { projection: { _id: 1 } }).toArray()).map((testRun) => testRun._id),
    )
    for (const container of containers) {
      if (orphanVerdict(container, now, this.config, running) !== 'remove') continue
      try {
        await this.docker.getContainer(container.Id).remove({ force: true, v: true })
        this.log.info('removed an orphan container', { container: container.Names[0], kind: container.Labels['scantor.kind'] })
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) this.log.warn('removing an orphan container failed', { container: container.Names[0], err: error })
      }
    }
  }

  async removeOldDraftImages(now: number): Promise<void> {
    const inUse = new Set(
      (await useCollections().testRuns.find({ state: { $in: [...ACTIVE_TEST_RUN_STATES] } }, { projection: { draftImage: 1 } }).toArray())
        .map((testRun) => testRun.draftImage?.ref)
        .filter((ref): ref is string => typeof ref === 'string'),
    )
    const images = await this.docker.listImages({ filters: { reference: ['tasks/*:draft-*'] } })
    for (const image of images) {
      for (const tag of image.RepoTags ?? []) {
        if (draftVerdict(tag, image.Created, now, this.config.draftImageRetentionMs, inUse) !== 'remove') continue
        try {
          await this.docker.getImage(tag).remove()
          this.log.info('removed a draft image', { image: tag })
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode
          // 409: a (test-run) container still uses it; the next sweep retries.
          if (status !== 404 && status !== 409) this.log.warn('removing a draft image failed', { image: tag, err: error })
        }
      }
    }
  }
}
