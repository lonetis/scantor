import type Docker from 'dockerode'
import { ACTIVE_SCRIPT_RUN_STATES } from '#shared/utils/enums'
import type { Config } from '../../utils/config'
import { useDocker } from '../../utils/docker'
import { isManagedContainer } from '../../utils/labels'
import { LeaseLock } from '../../utils/locks'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { SCRIPT_IMAGE_TAG } from '../pipeline/script-build'
import { deleteScriptRunData, scriptImagesInUse } from '../script-runs/cleanup'
import { removeContainerById } from '../script-runs/container'
import { failScriptRun } from '../script-runs/job'
import { recomputeLatestRunPointer } from '../script-runs/pointer'

// Garbage collection of script runs (docs/scripts.md), run by the reconciler under the `scriptsGc` lease: once when the
// lease is acquired and then every minute:
//   - active runs without an active job whose job ended (or, without a job, that were created) more than 5 minutes ago
//     fail ("interrupted; restart it"), their container removed; the run's own writes (progress, checkpoint) do not
//     count as activity
//   - a pending cancel whose job does not run (queued behind other runs, or gone) ends `cancelled` 2 minutes after the
//     request: the container is removed, pending outputs are aborted, the queued job is cancelled
//   - active runs past `startedAt + timeoutMs + 10 min` fail the same way (the job enforces the timeout; this is the
//     hard limit when no job does)
//   - orphan `scantor-s-*` containers (managed labels and prefix) whose run is finished or gone are removed
//   - images `scripts/<scriptId>:<packSha256>` older than SCANTOR_DRAFT_IMAGE_RETENTION that no active run uses
//   - finished runs past their `expiresAt` (SCANTOR_SCRIPT_RUN_RETENTION_DAYS): S3 prefix, log chunks, document; not
//     while an active run resumes from one (its bootstrap handed out that run's checkpoint and outputs)

export const SCRIPTS_GC_TICK_MS = 60_000
const STALE_RUN_GRACE_MS = 5 * 60_000
/** A pending cancel the gc ends itself when no job runs it: the stop grace, the log drain and a margin. */
export const CANCEL_SETTLE_GRACE_MS = 2 * 60_000
const HARD_LIMIT_MARGIN_MS = 10 * 60_000
const EXPIRED_BATCH = 100

interface ContainerSummary {
  Id: string
  Names: string[]
  Labels: Record<string, string>
  Created: number
}

export class ScriptsGc {
  private readonly lock: LeaseLock
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly docker: Docker = useDocker(),
  ) {
    this.lock = new LeaseLock(useCollections().locks, 'scriptsGc', { logger: log, onAcquired: () => setImmediate(() => this.tick()) })
  }

  start(): void {
    this.lock.start()
    this.timer = setInterval(() => this.tick(), SCRIPTS_GC_TICK_MS)
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
    this.running = this.sweep()
      .catch((error: unknown) => this.log.error('script garbage collection failed', { err: error }))
      .finally(() => {
        this.running = null
      })
  }

  async sweep(now = Date.now()): Promise<void> {
    await this.failStaleRuns(now)
    await this.removeOrphanContainers()
    await this.removeOldImages(now)
    await this.deleteExpiredRuns(now)
  }

  private async fail(scriptRunId: string, message: string): Promise<void> {
    const state = await failScriptRun(scriptRunId, message, this.config, this.log)
    if (state) this.log.warn('ended a script run', { scriptRunId, state, reason: message })
  }

  async failStaleRuns(now: number): Promise<void> {
    const { scriptRuns, jobs } = useCollections()
    const active = await scriptRuns
      .find(
        { state: { $in: [...ACTIVE_SCRIPT_RUN_STATES] } },
        { projection: { _id: 1, jobId: 1, createdAt: 1, startedAt: 1, cancelRequest: 1, 'input.settings.timeoutMs': 1 } },
      )
      .toArray()
    for (const run of active) {
      const timeoutMs = run.input?.settings?.timeoutMs ?? this.config.scriptRunTimeoutMs
      if (run.startedAt && now > run.startedAt.getTime() + timeoutMs + HARD_LIMIT_MARGIN_MS) {
        await this.fail(run._id, 'the script run exceeded its timeout and no job stopped it')
        continue
      }
      const job = run.jobId ? await jobs.findOne({ _id: run.jobId }, { projection: { state: 1, active: 1, finishedAt: 1, updatedAt: 1 } }) : null
      if (run.cancelRequest) {
        // A running job stops the container itself; a queued one may wait for a slot for hours.
        if (job?.state === 'running' || run.cancelRequest.at.getTime() > now - CANCEL_SETTLE_GRACE_MS) continue
        await this.fail(run._id, 'the script run was cancelled')
        continue
      }
      if (job?.active) continue
      const quietSince = job ? (job.finishedAt ?? job.updatedAt) : run.createdAt
      if (quietSince.getTime() > now - STALE_RUN_GRACE_MS) continue
      await this.fail(run._id, 'the script run was interrupted; restart it')
    }
  }

  async removeOrphanContainers(): Promise<void> {
    const containers = (await this.docker.listContainers({
      all: true,
      filters: { label: ['scantor.managed=true', 'scantor.kind=scriptRun'] },
    })) as ContainerSummary[]
    if (containers.length === 0) return
    const ids = containers.map((container) => container.Labels['scantor.script-run']).filter((id): id is string => typeof id === 'string')
    const active = new Set(
      (
        await useCollections()
          .scriptRuns.find({ _id: { $in: ids }, state: { $in: [...ACTIVE_SCRIPT_RUN_STATES] } }, { projection: { _id: 1 } })
          .toArray()
      ).map((run) => run._id),
    )
    for (const container of containers) {
      const name = (container.Names[0] ?? '').replace(/^\//, '')
      const runId = container.Labels['scantor.script-run']
      if (!runId || !isManagedContainer('scriptRun', name, container.Labels, { 'scantor.script-run': runId }) || active.has(runId)) continue
      try {
        await removeContainerById(this.docker, container.Id)
        this.log.info('removed an orphan script-run container', { container: name })
      } catch (error) {
        this.log.warn('removing an orphan script-run container failed', { container: name, err: error })
      }
    }
  }

  async removeOldImages(now: number): Promise<void> {
    const inUse = await scriptImagesInUse()
    const images = await this.docker.listImages({ filters: { reference: ['scripts/*:*'] } })
    for (const image of images) {
      if (now - image.Created * 1000 <= this.config.draftImageRetentionMs) continue
      for (const tag of image.RepoTags ?? []) {
        if (!SCRIPT_IMAGE_TAG.test(tag) || inUse.has(tag)) continue
        try {
          await this.docker.getImage(tag).remove()
          this.log.info('removed a script image', { image: tag })
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode
          if (status !== 404 && status !== 409) this.log.warn('removing a script image failed', { image: tag, err: error })
        }
      }
    }
  }

  async deleteExpiredRuns(now: number): Promise<void> {
    const { scriptRuns } = useCollections()
    const resumed = await scriptRuns
      .find({ state: { $in: [...ACTIVE_SCRIPT_RUN_STATES] }, 'restartedFrom.resume': true }, { projection: { restartedFrom: 1 } })
      .toArray()
    const inUse = resumed.map((run) => run.restartedFrom?.id).filter((id): id is string => typeof id === 'string')
    const expired = await scriptRuns
      .find(
        { expiresAt: { $lt: new Date(now) }, state: { $nin: [...ACTIVE_SCRIPT_RUN_STATES] }, ...(inUse.length > 0 ? { _id: { $nin: inUse } } : {}) },
        { projection: { _id: 1, scriptId: 1 } },
      )
      .limit(EXPIRED_BATCH)
      .toArray()
    for (const run of expired) {
      await deleteScriptRunData(run._id)
      // The script's latestRun may name the deleted run; it moves to the newest remaining run (or null).
      await recomputeLatestRunPointer(run.scriptId, run._id)
      this.log.info('deleted an expired script run', { scriptRunId: run._id })
    }
  }
}
