import type { Collection } from 'mongodb'
import type { EditorDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import type { Logger } from '../../utils/logger'
import type { EditorDocker } from './container'
import type { EditorKeyStore } from './keys'
import type { EditorManager, EditorStopReason } from './manager'

/*
 * The editor reaper (docs/editor.md §6.4): a reconciler loop (every 60 s under the `reconciler` lock) and the boot
 * sweep that runs once before the API serves editor sessions.
 *
 * | running, lastActivityAt older than SCANTOR_EDITOR_IDLE_TIMEOUT             | stop (idle)
 * | running, apiKeyExpiresAt less than 5 minutes away                           | stop (keyExpired)
 * | starting for longer than SCANTOR_EDITOR_START_TIMEOUT + 30 s                | fail the start (cleanup)
 * | stopping for longer than 2 minutes                                          | stop again (cleanup)
 * | running, container not running or /healthz failing three times in a row    | stop (orphan)
 * | an editor container whose user has no editor starting or running            | remove the container
 * | an `editor` API key whose user has no editor starting or running            | delete it
 *
 * At boot of the process that runs the `api` component, `starting` and `stopping` documents are stale at once:
 * their transitions ran in-process in the previous orchestrator, which is gone.
 */

export const REAPER_INTERVAL_MS = 60_000
export const KEY_EXPIRY_MARGIN_MS = 5 * 60_000
export const START_GRACE_MS = 30_000
export const STOPPING_STALE_MS = 2 * 60_000
export const HEALTH_FAILURE_LIMIT = 3

export interface SweepOptions {
  /** treat `starting`/`stopping` documents as abandoned (boot sweep of the `api` process) */
  staleTransitions: boolean
}

export interface SweepReport {
  stopped: { userId: string; reason: EditorStopReason }[]
  failedStarts: string[]
  retriedStops: string[]
  removedContainers: string[]
  deletedKeysOf: string[]
  errors: number
}

export type EditorDecision =
  | { kind: 'keep' }
  | { kind: 'probe' }
  | { kind: 'stop'; reason: EditorStopReason }
  | { kind: 'failStart'; message: string }
  | { kind: 'retryStop' }

export interface DecisionContext {
  now: number
  config: Pick<Config, 'editorIdleTimeoutMs' | 'editorStartTimeoutMs'>
  /** the editor container exists and is running */
  containerRunning: boolean
  staleTransitions: boolean
}

/** The reaper's rule table for one `editors` document (health probing excluded). */
export function decideEditor(doc: EditorDoc, context: DecisionContext): EditorDecision {
  const { now, config } = context
  switch (doc.state) {
    case 'running': {
      const lastActivity = (doc.lastActivityAt ?? doc.startedAt ?? doc.updatedAt).getTime()
      if (lastActivity < now - config.editorIdleTimeoutMs) return { kind: 'stop', reason: 'idle' }
      if (doc.apiKeyExpiresAt && doc.apiKeyExpiresAt.getTime() < now + KEY_EXPIRY_MARGIN_MS) return { kind: 'stop', reason: 'keyExpired' }
      if (!context.containerRunning) return { kind: 'stop', reason: 'orphan' }
      return { kind: 'probe' }
    }
    case 'starting': {
      if (context.staleTransitions) return { kind: 'failStart', message: 'the orchestrator restarted while the editor was starting' }
      const startedAt = (doc.startedAt ?? doc.updatedAt).getTime()
      if (startedAt < now - config.editorStartTimeoutMs - START_GRACE_MS) {
        return { kind: 'failStart', message: 'the editor did not finish starting in time' }
      }
      return { kind: 'keep' }
    }
    case 'stopping':
      if (context.staleTransitions || doc.updatedAt.getTime() < now - STOPPING_STALE_MS) return { kind: 'retryStop' }
      return { kind: 'keep' }
    case 'stopped':
      return { kind: 'keep' }
  }
}

export interface EditorReaperDeps {
  editors: Collection<EditorDoc>
  docker: EditorDocker
  keys: EditorKeyStore
  manager: EditorManager
  config: Pick<Config, 'editorIdleTimeoutMs' | 'editorStartTimeoutMs'>
  log: Logger
  now?: () => number
}

export class EditorReaper {
  /** consecutive failed /healthz probes per running editor */
  private readonly healthFailures = new Map<string, number>()

  constructor(private readonly deps: EditorReaperDeps) {}

  async sweep(options: SweepOptions): Promise<SweepReport> {
    const { editors, docker, keys, manager, config, log } = this.deps
    const report: SweepReport = { stopped: [], failedStarts: [], retriedStops: [], removedContainers: [], deletedKeysOf: [], errors: 0 }
    const attempt = async (what: string, fields: Record<string, unknown>, run: () => Promise<void>) => {
      try {
        await run()
      } catch (error) {
        report.errors++
        log.error(`editor reaper: ${what} failed`, { ...fields, err: error })
      }
    }

    // Containers and keys are listed before the documents are read: whatever exists at listing time was created by a
    // start whose document already said `starting`, so a fresh start is never mistaken for an orphan.
    const containers = await docker.listEditors()
    const keyOwners = await keys.owners()
    const docs = await editors.find({ state: { $ne: 'stopped' } }).toArray()
    const now = this.deps.now?.() ?? Date.now()
    const runningContainers = new Set(containers.filter((container) => container.running).map((container) => container.userId))

    const live = new Set<string>()
    // Users whose editor this sweep stopped: the teardown already removed their container and keys.
    const tornDown = new Set<string>()
    for (const doc of docs) {
      const userId = doc._id
      const decision = decideEditor(doc, { now, config, containerRunning: runningContainers.has(userId), staleTransitions: options.staleTransitions })
      if (doc.state !== 'running') this.healthFailures.delete(userId)
      switch (decision.kind) {
        case 'keep':
          if (doc.state === 'starting' || doc.state === 'running') live.add(userId)
          break
        case 'probe': {
          const probe = await manager.probe(userId)
          if (probe.healthy) {
            this.healthFailures.delete(userId)
            live.add(userId)
            break
          }
          const failures = (this.healthFailures.get(userId) ?? 0) + 1
          this.healthFailures.set(userId, failures)
          log.warn('editor health check failed', { userId, failures, problem: probe.reason })
          if (failures < HEALTH_FAILURE_LIMIT) {
            live.add(userId)
            break
          }
          this.healthFailures.delete(userId)
          await attempt('stopping an unhealthy editor', { userId }, async () => {
            await manager.stop(userId, 'orphan')
            report.stopped.push({ userId, reason: 'orphan' })
            tornDown.add(userId)
          })
          break
        }
        case 'stop':
          await attempt('stopping an editor', { userId, reason: decision.reason }, async () => {
            await manager.stop(userId, decision.reason)
            report.stopped.push({ userId, reason: decision.reason })
            tornDown.add(userId)
          })
          break
        case 'failStart':
          await attempt('cleaning up a stuck editor start', { userId }, async () => {
            await manager.failStuckStart(userId, doc.startedAt ?? doc.updatedAt, decision.message)
            report.failedStarts.push(userId)
            tornDown.add(userId)
          })
          break
        case 'retryStop':
          await attempt('retrying an editor stop', { userId }, async () => {
            const olderThan = options.staleTransitions ? new Date(now + 1) : new Date(now - STOPPING_STALE_MS)
            if (await manager.retryStop(userId, olderThan)) {
              report.retriedStops.push(userId)
              tornDown.add(userId)
            }
          })
          break
      }
    }
    for (const userId of this.healthFailures.keys()) if (!live.has(userId)) this.healthFailures.delete(userId)

    for (const container of containers) {
      if (container.userId && (live.has(container.userId) || tornDown.has(container.userId))) continue
      await attempt('removing an orphan editor container', { container: container.name }, async () => {
        await docker.remove(container.name)
        report.removedContainers.push(container.name)
      })
    }
    for (const userId of keyOwners) {
      if (live.has(userId) || tornDown.has(userId)) continue
      await attempt('deleting orphan editor keys', { userId }, async () => {
        await keys.deleteAll(userId)
        report.deletedKeysOf.push(userId)
      })
    }

    if (report.stopped.length + report.failedStarts.length + report.retriedStops.length + report.removedContainers.length > 0) {
      log.info('editor reaper sweep', {
        stopped: report.stopped,
        failedStarts: report.failedStarts.length,
        retriedStops: report.retriedStops.length,
        removedContainers: report.removedContainers.length,
        deletedKeysOf: report.deletedKeysOf.length,
      })
    }
    return report
  }
}
