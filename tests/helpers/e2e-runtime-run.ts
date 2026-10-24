import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { env } from './env'

// Run-scoped sharing for the e2e runtime specs. The Playwright workers of one run are children of one runner
// process; they share one tenant and the tasks it publishes, so every task image is built once per run instead of
// once per worker (a publish builds an image, and the stack builds SCANTOR_BUILD_CONCURRENCY images at a time for
// all users). The state lives in .auth/e2e-runtime/<run>/state.json, guarded by a lock directory:
//   - `runOnce(key, produce)`: exactly one worker produces an entry while the others wait for it; an entry whose
//     producer failed is removed, and one whose producer died is produced again by the next caller;
//   - `joinRun()`/`leaveRun()`: worker membership; the last worker to leave clears the entries and owns their cleanup.

const STALE_LOCK_MS = 15_000
const LOCK_TIMEOUT_MS = 30_000

type Entry = { state: 'producing'; owner: number; since: number } | { state: 'ready'; value: unknown }

interface RunState {
  members: number[]
  entries: Record<string, Entry>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The runner process (the parent of every worker) and its start time, so a reused pid never meets old state. */
function runKey(): string {
  const parent = process.ppid
  const status = readFileSync(`/proc/${parent}/stat`, 'utf8')
  // Fields after the parenthesised command name start at field 3; field 22 is the start time in clock ticks.
  const startTime = status.slice(status.lastIndexOf(')') + 2).split(' ')[19]
  if (!startTime) throw new Error(`cannot read the start time of the runner process ${parent}`)
  return `${parent}-${startTime}`
}

/** The run's state paths, resolved on first use: listing the suite (`playwright test --list`) never needs them. */
let paths: { runDir: string; stateFile: string; lockDir: string } | undefined
function runPaths(): { runDir: string; stateFile: string; lockDir: string } {
  if (!paths) {
    const runDir = join(env.paths.auth, 'e2e-runtime', runKey())
    paths = { runDir, stateFile: join(runDir, 'state.json'), lockDir: join(runDir, 'lock') }
  }
  return paths
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function withLock<T>(fn: (state: RunState) => Promise<T>): Promise<T> {
  const { runDir, stateFile, lockDir } = runPaths()
  await mkdir(runDir, { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      await mkdir(lockDir)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const info = await stat(lockDir).catch((statError: NodeJS.ErrnoException) => {
        if (statError.code === 'ENOENT') return null
        throw statError
      })
      if (info && Date.now() - info.mtimeMs > STALE_LOCK_MS) await rm(lockDir, { recursive: true, force: true })
      if (Date.now() > deadline) throw new Error(`the run lock ${lockDir} is held for more than ${LOCK_TIMEOUT_MS / 1000} s`, { cause: error })
      await sleep(20 + Math.random() * 30)
    }
  }
  try {
    const state = await readState(stateFile)
    const result = await fn(state)
    const temporary = `${stateFile}.${process.pid}`
    await writeFile(temporary, JSON.stringify(state))
    await rename(temporary, stateFile)
    return result
  } finally {
    await rm(lockDir, { recursive: true, force: true })
  }
}

async function readState(stateFile: string): Promise<RunState> {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8')) as RunState
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { members: [], entries: {} }
    throw error
  }
}

/** This process's pending productions and waits, so concurrent calls of one worker share them. */
const local = new Map<string, Promise<unknown>>()

/**
 * The value of `key` for this run: produced by `produce` in exactly one worker, which records it for the others.
 * A failed production is not recorded: the next call produces again.
 */
export function runOnce<T>(key: string, produce: () => Promise<T>): Promise<T> {
  let pending = local.get(key) as Promise<T> | undefined
  if (!pending) {
    pending = shared(key, produce)
    local.set(key, pending)
    pending.catch(() => local.delete(key))
  }
  return pending
}

async function shared<T>(key: string, produce: () => Promise<T>): Promise<T> {
  for (;;) {
    const decision = await withLock(async (state): Promise<{ value: T } | 'wait' | 'produce'> => {
      const entry = state.entries[key]
      if (entry?.state === 'ready') return { value: entry.value as T }
      if (entry?.state === 'producing' && entry.owner !== process.pid && alive(entry.owner)) return 'wait'
      state.entries[key] = { state: 'producing', owner: process.pid, since: Date.now() }
      return 'produce'
    })
    if (decision === 'wait') {
      await sleep(500)
      continue
    }
    if (decision !== 'produce') return decision.value
    try {
      const value = await produce()
      await withLock(async (state) => {
        state.entries[key] = { state: 'ready', value }
      })
      return value
    } catch (error) {
      await withLock(async (state) => {
        const entry = state.entries[key]
        if (entry?.state === 'producing' && entry.owner === process.pid) delete state.entries[key]
      })
      throw error
    }
  }
}

/** Registers this worker as a member of the run. */
export async function joinRun(): Promise<void> {
  await withLock(async (state) => {
    if (!state.members.includes(process.pid)) state.members.push(process.pid)
  })
}

/**
 * Removes this worker (and members that died) from the run. The last member clears every entry, so a worker that
 * joins later produces them anew, and gets their values: the cleanup of what they refer to is its job.
 */
export async function leaveRun(): Promise<{ last: false } | { last: true; values: Record<string, unknown> }> {
  return withLock(async (state) => {
    state.members = state.members.filter((pid) => pid !== process.pid && alive(pid))
    if (state.members.length > 0) return { last: false }
    const values: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(state.entries)) if (entry.state === 'ready') values[key] = entry.value
    state.entries = {}
    return { last: true, values }
  })
}
