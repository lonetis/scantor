import { effectScope, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScriptRunLogLine } from '#shared/types/scripts'
import {
  SCRIPT_RUN_LOG_ERROR_PATTERN,
  SCRIPT_RUN_LOG_MAX_LINES,
  SCRIPT_RUN_LOG_PAGE,
  canResumeScriptRun,
  isScriptRunActive,
  scanChoice,
  scriptRunDurationMs,
  scriptRunLogText,
  scriptRunProgressPercent,
  scriptRunSettingsBody,
  useScanChoices,
  useScriptRunLog,
} from '../../app/composables/useScriptRuns'
import { currentConfigSchema } from '../../app/composables/useScripts'
import { editorSessionBody } from '../../app/composables/useEditor'

// The script pages: run states and actions, durations, progress, the labelled log, the settings of a start request,
// the config schema of the run form, the editor's script folder, the incremental log reader and the scan choices.

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('script run states', () => {
  it('treats queued, building and running as active', () => {
    expect(['queued', 'building', 'running'].every((state) => isScriptRunActive(state as never))).toBe(true)
    expect(['completed', 'failed', 'cancelled'].some((state) => isScriptRunActive(state as never))).toBe(false)
    expect(isScriptRunActive(null)).toBe(false)
  })

  it('offers "Resume" only for a finished run with a checkpoint', () => {
    const checkpoint = { savedAt: '2026-11-08T10:00:00.000Z', bytes: 12 }
    expect(canResumeScriptRun({ state: 'failed', checkpoint })).toBe(true)
    expect(canResumeScriptRun({ state: 'cancelled', checkpoint })).toBe(true)
    expect(canResumeScriptRun({ state: 'running', checkpoint })).toBe(false)
    expect(canResumeScriptRun({ state: 'completed', checkpoint: null })).toBe(false)
    expect(canResumeScriptRun(null)).toBe(false)
  })
})

describe('scriptRunDurationMs and scriptRunProgressPercent', () => {
  it('measures from the start to the end, or to now while the run is active', () => {
    const startedAt = '2026-11-08T10:00:00.000Z'
    expect(scriptRunDurationMs({ startedAt, finishedAt: '2026-11-08T10:01:30.000Z' })).toBe(90_000)
    expect(scriptRunDurationMs({ startedAt, finishedAt: null }, Date.parse(startedAt) + 5000)).toBe(5000)
    expect(scriptRunDurationMs({ startedAt: null, finishedAt: null })).toBeNull()
  })

  it('gives a percent only with a positive total, bounded to 0–100', () => {
    const at = '2026-11-08T10:00:00.000Z'
    expect(scriptRunProgressPercent({ done: 25, total: 200, message: null, updatedAt: at })).toBe(12.5)
    expect(scriptRunProgressPercent({ done: 300, total: 200, message: null, updatedAt: at })).toBe(100)
    expect(scriptRunProgressPercent({ done: 3, total: null, message: null, updatedAt: at })).toBeNull()
    expect(scriptRunProgressPercent({ done: 3, total: 0, message: null, updatedAt: at })).toBeNull()
    expect(scriptRunProgressPercent(null)).toBeNull()
  })
})

describe('scriptRunLogText', () => {
  it('labels every line with its stream, strips escape sequences and keeps the label on each line of a line', () => {
    const lines = scriptRunLogText([
      { stream: 'build', text: 'Step 1/3' },
      { stream: 'stdout', text: '\u001b[32mok\u001b[0m' },
      { stream: 'stderr', text: 'Traceback\n  File "main.py"' },
      { stream: 'system', text: '' },
    ])
    expect(lines).toEqual([
      'build  Step 1/3',
      'stdout ok',
      'stderr Traceback',
      'stderr   File "main.py"',
      'system',
    ])
  })

  it('highlights only stderr lines', () => {
    const [stdout, stderr] = scriptRunLogText([{ stream: 'stdout', text: 'stderr is fine here' }, { stream: 'stderr', text: 'boom' }])
    expect(SCRIPT_RUN_LOG_ERROR_PATTERN.test(stdout!)).toBe(false)
    expect(SCRIPT_RUN_LOG_ERROR_PATTERN.test(stderr!)).toBe(true)
  })
})

describe('scriptRunSettingsBody', () => {
  it('sends only the entered values, the timeout in milliseconds, and the sample limit', () => {
    expect(scriptRunSettingsBody({ timeoutSeconds: null, cpus: null, memoryMiB: null }, null)).toBeUndefined()
    expect(scriptRunSettingsBody({ timeoutSeconds: null, cpus: null, memoryMiB: null }, 100)).toEqual({ limit: 100 })
    expect(scriptRunSettingsBody({ timeoutSeconds: 90.5, cpus: 2, memoryMiB: null }, null)).toEqual({ timeoutMs: 90_500, resources: { cpus: 2 } })
    expect(scriptRunSettingsBody({ timeoutSeconds: null, cpus: null, memoryMiB: 2048 }, 100)).toEqual({ resources: { memoryMiB: 2048 }, limit: 100 })
    // A cleared number input reports undefined (or NaN while its text does not parse): the default applies.
    expect(scriptRunSettingsBody({ timeoutSeconds: undefined, cpus: Number.NaN, memoryMiB: undefined }, null)).toBeUndefined()
  })
})

describe('currentConfigSchema', () => {
  const configSchema = { type: 'object', properties: { minBytes: { type: 'integer' } } }
  const describe = { packSha256: 'a'.repeat(64), configSchema, resultSchema: null, at: '2026-11-08T10:00:00.000Z' }
  const workspace = (packSha256: string | null) => ({ packSha256, fileCount: 4, bytes: 100, checkedAt: null })

  it('uses the described config schema while it belongs to the folder\'s current code', () => {
    expect(currentConfigSchema({ describe, workspace: workspace('a'.repeat(64)) })).toBe(configSchema)
  })

  it('falls back to JSON after the folder changed, before the first describe or without a schema', () => {
    expect(currentConfigSchema({ describe, workspace: workspace('b'.repeat(64)) })).toBeNull()
    expect(currentConfigSchema({ describe, workspace: workspace(null) })).toBeNull()
    expect(currentConfigSchema({ describe: null, workspace: workspace('a'.repeat(64)) })).toBeNull()
    expect(currentConfigSchema({ describe: { ...describe, configSchema: null }, workspace: workspace('a'.repeat(64)) })).toBeNull()
    expect(currentConfigSchema(null)).toBeNull()
  })
})

describe('editorSessionBody', () => {
  it('opens a task folder with `open` and a script folder with `openScript`', () => {
    expect(editorSessionBody({ kind: 'task', name: 'echo' })).toEqual({ open: 'echo' })
    expect(editorSessionBody({ kind: 'script', name: 'csp-report' })).toEqual({ openScript: 'csp-report' })
    expect(editorSessionBody(null)).toEqual({})
  })
})

/** A fake getScriptRunLogs over lines 1…total; `complete` once the last line was served and the run is terminal. */
function fakeLogApi(total: () => number, terminal: () => boolean) {
  const requests: (number | null)[] = []
  const api = (path: string, options: { query?: Record<string, string> }) => {
    expect(path).toMatch(/^\/api\/script-runs\/run-1\/logs$/)
    const after = options.query?.afterLine === undefined ? null : Number(options.query.afterLine)
    requests.push(after)
    const limit = Number(options.query?.limit)
    const from = (after ?? 0) + 1
    const to = Math.min(total(), from + limit - 1)
    const lines: ScriptRunLogLine[] = []
    for (let line = from; line <= to; line++) lines.push({ line, at: '2026-11-08T10:00:00.000Z', stream: 'stdout', text: `line ${line}` })
    return Promise.resolve({ lines, firstLine: 1, nextLine: Math.max(after ?? 0, to), complete: terminal() && to >= total() })
  }
  return { api, requests }
}

function stubPoll(): void {
  vi.stubGlobal('usePoll', (fn: () => Promise<void>) => ({ running: ref(false), refresh: () => fn().catch(() => {}) }))
  vi.stubGlobal('apiQuery', (params: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(params).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => [key, String(value)])))
  vi.stubGlobal('toApiError', (cause: unknown) => cause)
}

describe('useScriptRunLog', () => {
  it('reads a long log of a finished run from its tail, in pages, until it is complete', async () => {
    const fake = fakeLogApi(() => 12_000, () => true)
    vi.stubGlobal('useApi', () => fake.api)
    stubPoll()
    const log = effectScope().run(() => useScriptRunLog('run-1', { ready: true, totalLines: 12_000 }))!
    await log.refresh()
    expect(fake.requests[0]).toBe(12_000 - SCRIPT_RUN_LOG_MAX_LINES)
    expect(fake.requests).toHaveLength(SCRIPT_RUN_LOG_MAX_LINES / SCRIPT_RUN_LOG_PAGE)
    expect(log.complete.value).toBe(true)
    expect(log.truncated.value).toBe(true)
    expect(log.lines.value).toHaveLength(SCRIPT_RUN_LOG_MAX_LINES)
    expect(log.lines.value[0]!.line).toBe(7001)
    expect(log.text.value.at(-1)).toBe('stdout line 12000')
  })

  it('starts at the first retained line of a short log and continues after the last line it read', async () => {
    let total = 3
    let terminal = false
    const fake = fakeLogApi(() => total, () => terminal)
    vi.stubGlobal('useApi', () => fake.api)
    stubPoll()
    const log = effectScope().run(() => useScriptRunLog('run-1', { ready: true, totalLines: 3 }))!
    await log.refresh()
    expect(fake.requests).toEqual([null])
    expect(log.lines.value.map((line) => line.line)).toEqual([1, 2, 3])
    expect(log.complete.value).toBe(false)
    total = 5
    terminal = true
    await log.refresh()
    expect(fake.requests).toEqual([null, 3])
    expect(log.lines.value.map((line) => line.line)).toEqual([1, 2, 3, 4, 5])
    expect(log.complete.value).toBe(true)
    expect(log.truncated.value).toBe(false)
  })

  it('keeps at most the newest lines in memory while a run logs', async () => {
    let total = 0
    const fake = fakeLogApi(() => total, () => false)
    vi.stubGlobal('useApi', () => fake.api)
    stubPoll()
    const log = effectScope().run(() => useScriptRunLog('run-1', { ready: true, totalLines: 0 }))!
    total = SCRIPT_RUN_LOG_MAX_LINES - 10
    await log.refresh()
    expect(log.truncated.value).toBe(false)
    total = SCRIPT_RUN_LOG_MAX_LINES + 25
    await log.refresh()
    expect(log.truncated.value).toBe(true)
    expect(log.lines.value).toHaveLength(SCRIPT_RUN_LOG_MAX_LINES)
    expect(log.lines.value[0]!.line).toBe(26)
  })
})

describe('scan choices of the run form', () => {
  it('labels a scan by its name (or short id), revision and state', () => {
    const id = '7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c'
    expect(scanChoice({ id, name: 'tranco 1k', state: 'completed', revision: { ref: 'http-title@3' } })).toEqual({
      id,
      label: 'tranco 1k',
      description: 'http-title@3 · completed',
    })
    expect(scanChoice({ id, name: null, state: 'running', revision: { ref: 'echo@1' } }).label).toBe('Scan 7f3b2c1a')
  })

  it('resolves linked scans by id, drops missing ones and keeps the chosen ones as items', async () => {
    const scan = (id: string, name: string) => ({ id, name, state: 'completed', revision: { ref: 'echo@1' } })
    vi.stubGlobal('useApi', () => (path: string, options: { query?: Record<string, string> } = {}) => {
      if (path === '/api/scans') {
        expect(options.query?.userId).toBe('owner-1')
        return Promise.resolve({ items: [scan('s-2', 'second')], nextCursor: null })
      }
      return path === '/api/scans/s-1' ? Promise.resolve(scan('s-1', 'first')) : Promise.reject(new Error('notFound'))
    })
    stubPoll()
    const choices = effectScope().run(() => useScanChoices('owner-1'))!
    await choices.load()
    expect(await choices.resolve(['s-1', 'missing'])).toEqual(['s-1'])
    expect(choices.items.value.map((item) => item.id)).toEqual(['s-1', 's-2'])
    choices.keep(['s-2'])
    expect(choices.items.value.map((item) => item.id)).toEqual(['s-2'])
  })
})
