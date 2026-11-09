import type { ScriptCheckpointBody, ScriptProgressBody } from './schemas'
import type { ScriptRunDoc } from '../../types/documents'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import type { ScriptRunPrincipal } from '../../utils/principal'
import { isoDate } from '../../utils/serialize'
import { assertJsonSize, assertStorableJson, CHECKPOINT_WRITE_INTERVAL_MS, PROGRESS_WRITE_INTERVAL_MS, SCRIPT_CHECKPOINT_MAX_BYTES } from './limits'
import { jsonByteLength } from './schemas'
import { loadMaskableSecrets, maskScriptRunText } from './secrets'

/*
 * Progress and checkpoints of script runs (docs/scripts.md): a script may report as often as it likes, but each run
 * writes its progress at most once per PROGRESS_WRITE_INTERVAL_MS and its checkpoint at most once per
 * CHECKPOINT_WRITE_INTERVAL_MS. The first value of an interval is written at once; later ones replace a pending value
 * in memory that a timer writes when the interval ends. flushScriptRunState writes the pending values of a run at
 * once (the run's finish and cancel paths call it), and the component stop writes every pending value.
 *
 * Writes are ordered by their acceptance time (`progress.updatedAt`, `checkpoint.savedAt`): a write never replaces a
 * newer value, so two orchestrator processes serving the same run cannot move it backwards. A pending value lives in
 * this process only; a crash loses at most one interval. A failed write keeps the value pending and retries.
 */

const log = useLogger('script-runtime')

type Clock = () => number

/** At most one write per key per interval; the latest value of an interval is written when it ends. */
export class ThrottledWriter<T> {
  private readonly pending = new Map<string, T>()
  private readonly lastWriteAt = new Map<string, number>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private sweepAt = 0
  /** set by flushAll: the process stops, so every later value is written at once */
  private draining = false

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly write: (key: string, value: T) => Promise<void>,
    private readonly now: Clock = Date.now,
  ) {}

  /** Writes `value` now when the key's interval allows it, else keeps it as the pending value. */
  async submit(key: string, value: T): Promise<void> {
    const now = this.now()
    this.sweep(now)
    const last = this.lastWriteAt.get(key)
    if (this.draining || (!this.timers.has(key) && (last === undefined || now - last >= this.intervalMs))) {
      this.clearTimer(key)
      this.pending.delete(key)
      this.lastWriteAt.set(key, now)
      try {
        await this.write(key, value)
      } catch (error) {
        this.keep(key, value, error)
      }
      return
    }
    this.pending.set(key, value)
    if (!this.timers.has(key)) this.schedule(key, (last ?? now) + this.intervalMs - now)
  }

  /** Writes the pending value of `key` now (none: nothing) and forgets the key; a failed write stays pending and throws. */
  async flush(key: string): Promise<void> {
    this.clearTimer(key)
    const value = this.pending.get(key)
    this.pending.delete(key)
    this.lastWriteAt.delete(key)
    if (value === undefined) return
    try {
      await this.write(key, value)
    } catch (error) {
      this.keep(key, value, error)
      throw error
    }
  }

  /** Writes every pending value and every later one at once (component stop); failures are logged, never thrown. */
  async flushAll(): Promise<void> {
    this.draining = true
    const keys = [...new Set([...this.pending.keys(), ...this.timers.keys()])]
    await Promise.all(
      keys.map((key) => this.flush(key).catch((error: unknown) => log.warn(`writing the pending ${this.name} failed`, { scriptRunId: key, err: error }))),
    )
    this.lastWriteAt.clear()
  }

  /** Keys with a pending value (tests). */
  pendingKeys(): string[] {
    return [...this.pending.keys()]
  }

  /** Back to throttling after a flushAll (tests; a stopped process does not start again). */
  resume(): void {
    this.draining = false
  }

  /** Forgets the write times of keys whose interval is over (runs that ended without a flush in this process). */
  private sweep(now: number): void {
    if (now < this.sweepAt) return
    this.sweepAt = now + 60_000
    for (const [key, at] of this.lastWriteAt) {
      if (now - at >= this.intervalMs && !this.timers.has(key) && !this.pending.has(key)) this.lastWriteAt.delete(key)
    }
  }

  private keep(key: string, value: T, error: unknown): void {
    log.warn(`writing the ${this.name} failed; retrying`, { scriptRunId: key, err: error })
    if (!this.pending.has(key)) this.pending.set(key, value)
    if (!this.timers.has(key)) this.schedule(key, this.intervalMs)
  }

  private schedule(key: string, delayMs: number): void {
    const timer = setTimeout(() => void this.fire(key), Math.max(0, delayMs))
    timer.unref()
    this.timers.set(key, timer)
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key)
    if (timer) clearTimeout(timer)
    this.timers.delete(key)
  }

  private async fire(key: string): Promise<void> {
    this.timers.delete(key)
    const value = this.pending.get(key)
    if (value === undefined) return
    this.pending.delete(key)
    this.lastWriteAt.set(key, this.now())
    try {
      await this.write(key, value)
    } catch (error) {
      this.keep(key, value, error)
    }
  }
}

type ProgressValue = NonNullable<ScriptRunDoc['progress']>
type CheckpointValue = NonNullable<ScriptRunDoc['checkpoint']>

/** Writes a progress value; its message is masked like the log (at most one write per second, so one read of the secrets). */
async function writeProgress(scriptRunId: string, progress: ProgressValue): Promise<void> {
  const stored =
    progress.message === null ? progress : { ...progress, message: maskScriptRunText(progress.message, await loadMaskableSecrets(scriptRunId, log)) }
  await useCollections().scriptRuns.updateOne(
    { _id: scriptRunId, $or: [{ progress: null }, { 'progress.updatedAt': { $lt: progress.updatedAt } }] },
    { $set: { progress: stored, updatedAt: new Date() } },
  )
}

async function writeCheckpoint(scriptRunId: string, checkpoint: CheckpointValue): Promise<void> {
  await useCollections().scriptRuns.updateOne(
    { _id: scriptRunId, $or: [{ checkpoint: null }, { 'checkpoint.savedAt': { $lt: checkpoint.savedAt } }] },
    { $set: { checkpoint, updatedAt: new Date() } },
  )
}

const progressWriter = new ThrottledWriter<ProgressValue>('progress', PROGRESS_WRITE_INTERVAL_MS, writeProgress)
const checkpointWriter = new ThrottledWriter<CheckpointValue>('checkpoint', CHECKPOINT_WRITE_INTERVAL_MS, writeCheckpoint)

/** scriptRuntimeProgress: accepts the progress of the principal's run (written at most once per second). */
export async function reportProgress(principal: ScriptRunPrincipal, body: ScriptProgressBody, now = new Date()): Promise<{ state: 'running' }> {
  await progressWriter.submit(principal.scriptRun.id, {
    done: body.done,
    total: body.total ?? null,
    message: body.message ?? null,
    updatedAt: now,
  })
  return { state: 'running' }
}

/**
 * scriptRuntimeCheckpoint: accepts the checkpoint state of the principal's run (413 above 1 MiB of JSON; written at most
 * once per 10 s, the latest value always). `savedAt` is the acceptance time stored with the state.
 */
export async function saveCheckpoint(principal: ScriptRunPrincipal, body: ScriptCheckpointBody, now = new Date()): Promise<{ savedAt: string }> {
  const bytes = jsonByteLength(body.state)
  assertJsonSize(bytes, SCRIPT_CHECKPOINT_MAX_BYTES, 'the checkpoint state')
  assertStorableJson(body.state, 'state')
  await checkpointWriter.submit(principal.scriptRun.id, { state: body.state, savedAt: now, bytes })
  return { savedAt: isoDate(now) }
}

/**
 * Writes the progress and checkpoint values of a run that this process still holds in memory (the run's finish and
 * cancel paths call it before the final state update). Throws when a write fails.
 */
export async function flushScriptRunState(scriptRunId: string): Promise<void> {
  await Promise.all([progressWriter.flush(scriptRunId), checkpointWriter.flush(scriptRunId)])
}

/** Writes every pending value of this process (component stop). */
export async function flushAllScriptRunState(): Promise<void> {
  await Promise.all([progressWriter.flushAll(), checkpointWriter.flushAll()])
}
