import type { Socket } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Collection } from 'mongodb'
import type { EditorStatus } from '#shared/types/editor'
import type { EditorDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { apiError } from '../../utils/errors'
import type { Logger } from '../../utils/logger'
import { isoDateOrNull } from '../../utils/serialize'
import { type EditorContainerConfig, type EditorDocker, editorContainerName, editorContainerSpec, editorImageRef } from './container'
import { probeEditorHealth } from './health'
import type { EditorKeyStore } from './keys'

/*
 * The editor manager (docs/editor.md §6, docs/data-model.md §4.15, §6.10): the `editors` state machine
 *
 *   stopped → starting → running → stopping → stopped,   starting → stopped on a failed start (with `error`)
 *
 * Every transition is one conditional update, so concurrent requests, the reaper and lockout hooks never act on a
 * state they did not see. `startedAt` is set on entering `starting` and binds the editor's cookies.
 *
 * A start returns at once; the container is created in the background of this (`api`) process. A stop aborts an
 * in-flight start of the same user and waits for it before it tears down, so a superseded start never races the
 * teardown. Teardown always deletes the user's editor keys and closes the proxy, even when Docker fails; a failed
 * teardown leaves the editor `stopping` and the reaper retries it.
 */

export type EditorStopReason = 'user' | 'idle' | 'keyExpired' | 'banned' | 'userDeleted' | 'startFailed' | 'orphan'

export type EditorManagerConfig = EditorContainerConfig &
  Pick<Config, 'editorMaxRunning' | 'editorStartTimeoutMs' | 'editorIdleTimeoutMs'>

export interface EditorUser {
  id: string
  email: string
}

export interface EditorSocketOperations {
  prepare(userId: string): Promise<void>
  remove(userId: string): Promise<void>
  connect(userId: string): Socket
}

export interface EditorManagerHooks {
  /** the user's editor changed state (the cookie validator forgets its cached state) */
  onStateChanged(userId: string): void
  /** the user's editor is being torn down: close its proxy agent and WebSockets, drop its one-time codes */
  onTeardown(userId: string): void
}

export interface EditorManagerDeps {
  editors: Collection<EditorDoc>
  config: EditorManagerConfig
  docker: EditorDocker
  keys: EditorKeyStore
  sockets: EditorSocketOperations
  /** workspace helper `init` (orchestrator tasks area; cached per user per process) */
  ensureUserDirs(userId: string): Promise<void>
  hooks: EditorManagerHooks
  log: Logger
  now?: () => number
  /** readiness poll interval (docs/editor.md §6.2: 250 ms) */
  pollIntervalMs?: number
}

export const READINESS_POLL_MS = 250
export const HEALTH_TIMEOUT_MS = 2_000
/** how long createEditorSession waits for a stopping editor before answering 409 */
export const STOPPING_WAIT_MS = 15_000

const LIVE_STATES = ['starting', 'running'] as const

class StartSuperseded extends Error {
  constructor() {
    super('the editor start was superseded')
    this.name = 'StartSuperseded'
  }
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000
}

function stoppedFields(now: Date) {
  return {
    state: 'stopped' as const,
    stoppedAt: now,
    updatedAt: now,
    containerId: null,
    containerName: null,
    apiKeyId: null,
    apiKeyExpiresAt: null,
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1024)
}

export class EditorManager {
  private readonly starts = new Map<string, { controller: AbortController; done: Promise<void> }>()

  constructor(private readonly deps: EditorManagerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** `getEditor` (docs/api.md §4.18): a user without a document has a stopped editor. */
  async status(userId: string): Promise<EditorStatus> {
    const doc = await this.deps.editors.findOne({ _id: userId })
    return {
      state: doc?.state ?? 'stopped',
      startedAt: isoDateOrNull(doc?.startedAt),
      lastActivityAt: isoDateOrNull(doc?.lastActivityAt),
      idleTimeoutMs: this.deps.config.editorIdleTimeoutMs,
      error: doc?.error ?? null,
    }
  }

  /**
   * Makes sure the user's editor is starting or running (docs/editor.md §6.2) and returns its document. A stopped
   * editor transitions to `starting` and the container start continues in the background; above
   * SCANTOR_EDITOR_MAX_RUNNING the transition is reverted with 429.
   */
  async ensureStarted(user: EditorUser): Promise<EditorDoc> {
    const { editors, config } = this.deps
    const waitUntil = this.now() + STOPPING_WAIT_MS
    for (;;) {
      const now = new Date(this.now())
      if (now.getTime() > waitUntil) {
        throw apiError('invalidState', 'the editor is still stopping; try again in a moment', { state: 'stopping', allowed: ['stopped', ...LIVE_STATES] })
      }
      let started: EditorDoc | null = null
      try {
        started = await editors.findOneAndUpdate(
          { _id: user.id, state: 'stopped' },
          {
            $set: { state: 'starting', startedAt: now, image: editorImageRef(config), error: null, updatedAt: now },
            $setOnInsert: { containerId: null, containerName: null, apiKeyId: null, apiKeyExpiresAt: null, lastActivityAt: null, stoppedAt: null },
          },
          { upsert: true, returnDocument: 'after' },
        )
      } catch (error) {
        // The document exists in another state: the upsert's insert collided with it.
        if (!isDuplicateKey(error)) throw error
      }
      if (started) return this.admit(user, started)

      const current = await editors.findOne({ _id: user.id })
      if (current && (current.state === 'starting' || current.state === 'running')) return current
      // `stopping`: wait for the stop to finish; `stopped` (a stop finished in between): retry at once.
      if (current?.state === 'stopping') await sleep(READINESS_POLL_MS)
    }
  }

  private async admit(user: EditorUser, doc: EditorDoc): Promise<EditorDoc> {
    const { editors, config } = this.deps
    // Registered before the first await, so a stop arriving now finds (and aborts) this start.
    const controller = new AbortController()
    let finish!: () => void
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    this.starts.set(user.id, { controller, done })
    const release = () => {
      if (this.starts.get(user.id)?.controller === controller) this.starts.delete(user.id)
      finish()
    }
    try {
      const active = await editors.countDocuments({ state: { $in: [...LIVE_STATES] } })
      if (active > config.editorMaxRunning) {
        const now = new Date(this.now())
        await editors.updateOne({ _id: user.id, state: 'starting', startedAt: doc.startedAt }, { $set: { state: 'stopped', stoppedAt: now, updatedAt: now } })
        this.deps.hooks.onStateChanged(user.id)
        throw apiError('tooManyRequests', `too many editors are running (limit ${config.editorMaxRunning}); try again later`, {
          limit: config.editorMaxRunning,
        })
      }
    } catch (error) {
      release()
      throw error
    }
    this.deps.hooks.onStateChanged(user.id)
    void this.runStart(user, doc, controller.signal).finally(release)
    return doc
  }

  /** The background part of a start (docs/editor.md §6.2 steps 1–8). Never rejects. */
  private async runStart(user: EditorUser, doc: EditorDoc, signal: AbortSignal): Promise<void> {
    const { editors, docker, keys, sockets, config } = this.deps
    const startedAt = doc.startedAt!
    const guard = { _id: user.id, state: 'starting' as const, startedAt }
    const log = this.deps.log.child({ userId: user.id })
    const containerName = editorContainerName(user.id)
    const step = () => {
      if (signal.aborted) throw new StartSuperseded()
    }
    try {
      step()
      await this.deps.ensureUserDirs(user.id)
      step()
      await sockets.prepare(user.id)
      step()
      await keys.deleteAll(user.id)
      const key = await keys.mint(user.id)
      step()
      const keyUpdate = await editors.updateOne(guard, { $set: { apiKeyId: key.id, apiKeyExpiresAt: key.expiresAt, updatedAt: new Date(this.now()) } })
      if (keyUpdate.matchedCount === 0) throw new StartSuperseded()
      await docker.remove(containerName)
      step()
      if (!(await docker.imageExists(doc.image))) {
        if (!config.imagePrefix) throw new Error(`the editor image ${doc.image} does not exist; build it first (just build-images editor)`)
        log.info('pulling the editor image', { image: doc.image })
        await docker.pullImage(doc.image)
        step()
      }
      const containerId = await docker.createAndStart(editorContainerSpec({ userId: user.id, email: user.email, image: doc.image, apiKey: key.key }, config))
      step()
      await this.waitReady(user.id, containerName, signal)
      const now = new Date(this.now())
      const ready = await editors.updateOne(guard, { $set: { state: 'running', containerId, containerName, lastActivityAt: now, updatedAt: now } })
      if (ready.matchedCount === 0) throw new StartSuperseded()
      this.deps.hooks.onStateChanged(user.id)
      log.info('editor started', { durationMs: now.getTime() - startedAt.getTime() })
    } catch (error) {
      if (signal.aborted || error instanceof StartSuperseded) {
        log.info('editor start superseded by a stop')
        return
      }
      log.warn('editor start failed', { err: error })
      try {
        await this.settleFailedStart(user.id, startedAt, errorMessage(error))
      } catch (cleanupError) {
        log.error('cleaning up after a failed editor start failed; the reaper retries', { err: cleanupError })
      }
    }
  }

  /** Readiness (docs/editor.md §6.2 step 7): safe connect + `GET /healthz` → 200, polled until the start timeout. */
  private async waitReady(userId: string, containerName: string, signal: AbortSignal): Promise<void> {
    const { config, sockets, docker } = this.deps
    const deadline = this.now() + config.editorStartTimeoutMs
    const interval = this.deps.pollIntervalMs ?? READINESS_POLL_MS
    for (let poll = 1; ; poll++) {
      if (signal.aborted) throw new StartSuperseded()
      const probe = await probeEditorHealth(() => sockets.connect(userId), HEALTH_TIMEOUT_MS)
      if (probe.healthy) return
      // A container that died never becomes ready: notice it every ~2 s instead of waiting for the timeout.
      if (poll % 8 === 0) {
        const state = await docker.inspect(containerName)
        if (!state?.running) {
          throw new Error(`the editor container exited${state?.exitCode != null ? ` with code ${state.exitCode}` : ''} before it became ready`)
        }
      }
      if (this.now() >= deadline) {
        throw new Error(`the editor did not become ready within ${Math.round(config.editorStartTimeoutMs / 1000)} s (${probe.reason})`)
      }
      await sleep(interval, undefined, { signal }).catch((error: unknown) => {
        // An abort ends the loop through the check at its top.
        if (!signal.aborted) throw error
      })
    }
  }

  /**
   * The reaper's cleanup of a start that has been `starting` for too long (docs/editor.md §6.4): abort it if it still
   * runs in this process, then finish it as a failed start.
   */
  async failStuckStart(userId: string, startedAt: Date, message: string): Promise<void> {
    await this.abortStart(userId)
    await this.settleFailedStart(userId, startedAt, message)
  }

  /** `starting → stopping → stopped` with `error` after a failed start (docs/editor.md §6.2). */
  private async settleFailedStart(userId: string, startedAt: Date, message: string): Promise<void> {
    const { editors } = this.deps
    const claimed = await editors.findOneAndUpdate(
      { _id: userId, state: 'starting', startedAt },
      { $set: { state: 'stopping', error: message, updatedAt: new Date(this.now()) } },
    )
    // Someone else (a stop) owns the cleanup.
    if (!claimed) return
    this.deps.hooks.onStateChanged(userId)
    try {
      await this.teardown(userId)
    } finally {
      // The start failed either way; orphan containers and keys of a failed teardown are swept by the reaper.
      await editors.updateOne({ _id: userId, state: 'stopping', startedAt }, { $set: stoppedFields(new Date(this.now())) })
      this.deps.hooks.onStateChanged(userId)
    }
  }

  /**
   * Stops the user's editor (docs/editor.md §6.3): `starting|running → stopping`, teardown, `stopped`. Nothing
   * happens when the editor is not starting or running. A failed teardown leaves it `stopping` and rethrows.
   */
  async stop(userId: string, reason: EditorStopReason): Promise<void> {
    const claimed = await this.deps.editors.findOneAndUpdate(
      { _id: userId, state: { $in: [...LIVE_STATES] } },
      { $set: { state: 'stopping', updatedAt: new Date(this.now()) } },
    )
    if (!claimed) return
    // Cookies stop working at once; the reaper's 5 s state cache elsewhere follows within 5 s.
    this.deps.hooks.onStateChanged(userId)
    await this.finishStop(userId, reason)
  }

  /** The reaper's retry of a stop that has been `stopping` since before `olderThan` (docs/editor.md §6.4). */
  async retryStop(userId: string, olderThan: Date): Promise<boolean> {
    const claimed = await this.deps.editors.findOneAndUpdate(
      { _id: userId, state: 'stopping', updatedAt: { $lt: olderThan } },
      { $set: { updatedAt: new Date(this.now()) } },
    )
    if (!claimed) return false
    await this.finishStop(userId, 'orphan')
    return true
  }

  private async finishStop(userId: string, reason: EditorStopReason): Promise<void> {
    await this.abortStart(userId)
    await this.teardown(userId)
    await this.deps.editors.updateOne({ _id: userId, state: 'stopping' }, { $set: stoppedFields(new Date(this.now())) })
    this.deps.hooks.onStateChanged(userId)
    this.deps.log.info('editor stopped', { userId, reason })
  }

  /** Aborts and awaits an in-flight start of this process, so it never acts after the teardown. */
  private async abortStart(userId: string): Promise<void> {
    const start = this.starts.get(userId)
    if (!start) return
    start.controller.abort()
    await start.done
  }

  /**
   * Removes everything a start created: the container, the user's editor keys, the socket file, the proxy agent,
   * open WebSockets and pending one-time codes. Every step runs even when an earlier one fails.
   */
  private async teardown(userId: string): Promise<void> {
    const { docker, keys, sockets, log } = this.deps
    const failures: unknown[] = []
    const attempt = async (step: string, run: () => Promise<void>) => {
      try {
        await run()
      } catch (error) {
        failures.push(error)
        log.error('editor teardown step failed', { userId, step, err: error })
      }
    }
    await attempt('container', () => docker.stopAndRemove(editorContainerName(userId)))
    await attempt('apiKeys', () => keys.deleteAll(userId))
    await attempt('socket', () => sockets.remove(userId))
    this.deps.hooks.onTeardown(userId)
    if (failures.length > 0) throw new AggregateError(failures, `tearing down the editor of user ${userId} failed`)
  }

  /** userPurge step 20 (docs/data-model.md §5): stop, tear down whatever is left, delete the document. */
  async purge(userId: string): Promise<void> {
    await this.stop(userId, 'userDeleted')
    await this.abortStart(userId)
    await this.teardown(userId)
    await this.deps.editors.deleteOne({ _id: userId })
    this.deps.hooks.onStateChanged(userId)
  }

  /** `/healthz` of a user's running editor (the reaper's orphan check). */
  probe(userId: string) {
    return probeEditorHealth(() => this.deps.sockets.connect(userId), HEALTH_TIMEOUT_MS)
  }
}
