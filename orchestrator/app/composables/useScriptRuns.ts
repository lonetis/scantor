import { refDebounced } from '@vueuse/core'
import { computed, ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import type { RestartScriptRunBody, ScriptRunSettingsInput, StartScriptRunBody } from '#shared/schemas/scripts'
import type { ScriptRunLogLine, ScriptRunLogsPage } from '#shared/types/scripts'
import { SCRIPT_RUN_LOG_STREAMS } from '#shared/utils/enums'
import { toLogLines } from '../utils/ansi'
import { shortId } from '../utils/format'

// Script runs (docs/api.md tag `script-runs`, docs/ui.md §5, §9): the run history of a script (10 s poll while its runs
// tab is open), one run (2 s poll while it is active), its log read incrementally with `afterLine` (every 2 s until the
// log is complete), the scan choices of the run form (`listScans?q=`), and starting,
// cancelling and restarting runs. Outputs and the source are downloaded by navigation (`?redirect=true` answers with
// the presigned URL), never fetched (docs/ui.md §13).

export const SCRIPT_RUNS_POLL_MS = 10_000
export const SCRIPT_RUN_POLL_MS = 2000
export const SCRIPT_RUN_LOG_POLL_MS = 2000
export const SCRIPT_RUN_LOG_PAGE = 1000
/** Log lines a run page keeps; a longer log is shown from its tail. */
export const SCRIPT_RUN_LOG_MAX_LINES = 5000
/** Pages one log read fetches at most, so a run that logs faster than the page size cannot hold one tick forever. */
const SCRIPT_RUN_LOG_MAX_PAGES_PER_READ = 10
/** `settings.limit` of "Try on 100 analyses". */
export const SCRIPT_RUN_SAMPLE_LIMIT = 100
const SCAN_CHOICES_LIMIT = 50
const SCAN_SEARCH_DEBOUNCE_MS = 300
/** The longest `q` that listScans accepts. */
const SCAN_SEARCH_MAX_LENGTH = 64

export function isScriptRunActive(state: ScriptRunState | null | undefined): boolean {
  return state === 'queued' || state === 'building' || state === 'running'
}

/** Restarting with `resume` needs a finished run that saved a checkpoint. */
export function canResumeScriptRun(run: Pick<ScriptRun, 'state' | 'checkpoint'> | null | undefined): boolean {
  return run !== null && run !== undefined && !isScriptRunActive(run.state) && run.checkpoint !== null
}

/** Running time from the container start to the end (or to `now` while the run is active); null before the start. */
export function scriptRunDurationMs(run: Pick<ScriptRun, 'startedAt' | 'finishedAt'> | null | undefined, now: number = Date.now()): number | null {
  if (!run?.startedAt) return null
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now
  return Math.max(0, end - Date.parse(run.startedAt))
}

/** Percent of the reported progress, or null when the script reported no total. */
export function scriptRunProgressPercent(progress: ScriptRunProgress | null | undefined): number | null {
  if (!progress || progress.total === null || progress.total <= 0) return null
  return Math.min(100, Math.max(0, (progress.done / progress.total) * 100))
}

const STREAM_LABEL_WIDTH = Math.max(...SCRIPT_RUN_LOG_STREAMS.map((stream) => stream.length))

/** Highlights stderr lines in `LogView` (the label prefix of `scriptRunLogText`). */
export const SCRIPT_RUN_LOG_ERROR_PATTERN = /^stderr /

/**
 * Display lines of a script-run log: every line is labelled with its stream (`build`, `stdout`, `stderr`, `system`),
 * escape sequences are removed (docs/security.md HDR-5), and a stored line with line breaks keeps its label on each.
 */
export function scriptRunLogText(lines: readonly Pick<ScriptRunLogLine, 'stream' | 'text'>[]): string[] {
  return lines.flatMap((line) => {
    const label = `${line.stream.padEnd(STREAM_LABEL_WIDTH)} `
    const parts = toLogLines(line.text)
    return parts.length === 0 ? [label.trimEnd()] : parts.map((part) => `${label}${part}`)
  })
}

/** The form's resource and timeout inputs (timeout in seconds; empty = the manifest default). */
export interface ScriptRunSettingsFields {
  timeoutSeconds: number | null | undefined
  cpus: number | null | undefined
  memoryMiB: number | null | undefined
}

function entered(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** The `settings` of a start request from the form's inputs: only what was entered, plus the sample limit. */
export function scriptRunSettingsBody(fields: ScriptRunSettingsFields, limit: number | null): ScriptRunSettingsInput | undefined {
  const resources: NonNullable<ScriptRunSettingsInput['resources']> = {}
  if (entered(fields.cpus)) resources.cpus = fields.cpus
  if (entered(fields.memoryMiB)) resources.memoryMiB = fields.memoryMiB
  const settings: ScriptRunSettingsInput = {
    ...(entered(fields.timeoutSeconds) ? { timeoutMs: Math.round(fields.timeoutSeconds * 1000) } : {}),
    ...(Object.keys(resources).length > 0 ? { resources } : {}),
    ...(limit !== null ? { limit } : {}),
  }
  return Object.keys(settings).length > 0 ? settings : undefined
}

/** The run history of a script, newest first. */
export function useScriptRuns(script: MaybeRefOrGetter<string>, options: { enabled: MaybeRefOrGetter<boolean> }) {
  const api = useApi()
  const list = useCursorList<ScriptRun>(
    (cursor, { background }) =>
      api<Page<ScriptRun>>(`/api/scripts/${encodeURIComponent(toValue(script))}/runs`, { query: apiQuery({ cursor, limit: 20 }), background }),
    { immediate: false },
  )
  usePoll(() => list.refresh({ background: true }), { intervalMs: SCRIPT_RUNS_POLL_MS, enabled: () => toValue(options.enabled) && list.loaded.value, immediate: false })
  watch([() => toValue(script), () => toValue(options.enabled)], ([, enabled]) => {
    if (!enabled) return
    list.reset().catch((cause: unknown) => console.error('[script-runs] loading the runs failed', cause))
  }, { immediate: true })
  return list
}

/** One script run, polled every 2 s while it is active. */
export function useScriptRun(scriptRunId: MaybeRefOrGetter<string>) {
  const api = useApi()
  const run = shallowRef<ScriptRun | null>(null)
  const error = shallowRef<ApiError | null>(null)

  async function load(): Promise<void> {
    try {
      run.value = await api<ScriptRun>(`/api/script-runs/${encodeURIComponent(toValue(scriptRunId))}`, { background: true })
      error.value = null
    } catch (cause) {
      error.value = toApiError(cause)
      throw error.value
    }
  }

  const active = computed(() => isScriptRunActive(run.value?.state))
  const poll = usePoll(load, { intervalMs: SCRIPT_RUN_POLL_MS, enabled: () => run.value === null || active.value })
  watch(() => toValue(scriptRunId), () => {
    run.value = null
    void poll.refresh()
  })

  /** Applies a run that an action returned (cancel), so the page shows it before the next poll. */
  function set(next: ScriptRun): void {
    if (next.id === toValue(scriptRunId)) run.value = next
  }

  return { run, error, active, refreshing: poll.running, refresh: poll.refresh, set }
}

/**
 * The log of a script run, read with `getScriptRunLogs?afterLine=` every 2 s until the log is complete (the server marks
 * it complete once the run is terminal and every line was read), starting when the run is `ready` (loaded). A log
 * longer than `SCRIPT_RUN_LOG_MAX_LINES` is read from its tail (`totalLines`, the run's `log.lines`), and the oldest
 * lines are dropped from memory beyond that bound (`truncated`).
 */
export function useScriptRunLog(
  scriptRunId: MaybeRefOrGetter<string>,
  options: { ready: MaybeRefOrGetter<boolean>; totalLines: MaybeRefOrGetter<number | null> },
) {
  const api = useApi()
  const lines = shallowRef<ScriptRunLogLine[]>([])
  const complete = ref(false)
  const truncated = ref(false)
  const error = shallowRef<ApiError | null>(null)
  /** null until the first read: then the line to continue after */
  let nextLine: number | null = null
  let generation = 0

  function startAfter(): number | null {
    const total = toValue(options.totalLines)
    if (total === null || total <= SCRIPT_RUN_LOG_MAX_LINES) return null
    truncated.value = true
    return total - SCRIPT_RUN_LOG_MAX_LINES
  }

  async function read(): Promise<void> {
    const current = generation
    for (let page = 0; page < SCRIPT_RUN_LOG_MAX_PAGES_PER_READ; page++) {
      const after = nextLine ?? startAfter()
      const result = await api<ScriptRunLogsPage>(`/api/script-runs/${encodeURIComponent(toValue(scriptRunId))}/logs`, {
        query: apiQuery({ afterLine: after, limit: SCRIPT_RUN_LOG_PAGE }),
        background: true,
      })
      if (current !== generation) return
      if (result.lines.length > 0) {
        const next = [...lines.value, ...result.lines]
        if (next.length > SCRIPT_RUN_LOG_MAX_LINES) truncated.value = true
        lines.value = next.length > SCRIPT_RUN_LOG_MAX_LINES ? next.slice(next.length - SCRIPT_RUN_LOG_MAX_LINES) : next
      }
      nextLine = result.nextLine
      complete.value = result.complete
      error.value = null
      if (result.lines.length < SCRIPT_RUN_LOG_PAGE || result.complete) return
    }
  }

  const poll = usePoll(
    async () => {
      try {
        await read()
      } catch (cause) {
        error.value = toApiError(cause)
        throw error.value
      }
    },
    // A finished run's log is read at once in full (from its tail when it is long); an active run's log follows it.
    { intervalMs: SCRIPT_RUN_LOG_POLL_MS, enabled: () => toValue(options.ready) && !complete.value },
  )
  // Another run: start over; the poll reads it once it is ready (its `totalLines` known).
  watch(() => toValue(scriptRunId), () => {
    generation++
    lines.value = []
    nextLine = null
    complete.value = false
    truncated.value = false
  })

  const text = computed(() => scriptRunLogText(lines.value))

  return { lines, text, complete, truncated, error, refresh: poll.refresh }
}

/** An item of the scan picker of the run form. */
export interface ScanChoice {
  id: string
  label: string
  description: string
}

export function scanChoice(scan: Pick<ScanSummary, 'id' | 'name' | 'state'> & { revision: { ref: string } }): ScanChoice {
  return { id: scan.id, label: scan.name || `Scan ${shortId(scan.id)}`, description: `${scan.revision.ref} · ${scan.state}` }
}

/**
 * The scans the run form offers: the matches of `listScans?q=<typed text>` (debounced) among the scans of `owner` (a
 * script run reads only scans of the script's owner), plus the chosen scans, which stay items while the search shows
 * others. `resolve` loads scans by id (the `?scan=` prefill).
 */
export function useScanChoices(owner: MaybeRefOrGetter<string | null>) {
  const api = useApi()
  const search = ref('')
  const query = refDebounced(computed(() => search.value.trim().slice(0, SCAN_SEARCH_MAX_LENGTH)), SCAN_SEARCH_DEBOUNCE_MS)
  const found = shallowRef<ScanChoice[]>([])
  const chosen = shallowRef<ScanChoice[]>([])
  const loading = ref(false)
  const error = shallowRef<ApiError | null>(null)
  let generation = 0

  async function load(): Promise<void> {
    const current = ++generation
    loading.value = true
    try {
      const page = await api<Page<ScanSummary>>('/api/scans', {
        query: apiQuery({ q: query.value || null, userId: toValue(owner), limit: SCAN_CHOICES_LIMIT }),
        toast: false,
      })
      if (current !== generation) return
      found.value = page.items.map(scanChoice)
      error.value = null
    } catch (cause) {
      if (current === generation) error.value = toApiError(cause)
    } finally {
      if (current === generation) loading.value = false
    }
  }

  watch([query, () => toValue(owner)], () => void load())

  const items = computed(() => [...chosen.value.filter((item) => !found.value.some((other) => other.id === item.id)), ...found.value])

  /** Keeps the items of these ids (the current selection) as items while the search changes. */
  function keep(ids: readonly string[]): void {
    const known = new Map(items.value.map((item) => [item.id, item]))
    chosen.value = ids.flatMap((id) => {
      const item = known.get(id)
      return item ? [item] : []
    })
  }

  /** Loads scans by id and keeps them as items; returns the ids that exist (the others are dropped). */
  async function resolve(ids: readonly string[]): Promise<string[]> {
    const loaded = await Promise.all(ids.map((id) =>
      api<Scan>(`/api/scans/${encodeURIComponent(id)}`, { toast: false }).then(scanChoice, () => null),
    ))
    const existing = loaded.filter((item): item is ScanChoice => item !== null)
    chosen.value = [...chosen.value.filter((item) => !existing.some((other) => other.id === item.id)), ...existing]
    return existing.map((item) => item.id)
  }

  return { search, items, loading, error, load, keep, resolve }
}

/** Script-run mutations and download locations. */
export function useScriptRunActions() {
  const api = useApi()
  const runPath = (scriptRunId: string) => `/api/script-runs/${encodeURIComponent(scriptRunId)}`

  return {
    startRun: (script: string, body: StartScriptRunBody) =>
      api<ScriptRun>(`/api/scripts/${encodeURIComponent(script)}/runs`, { method: 'POST', body, toast: false }),
    cancelRun: (scriptRunId: string) => api<ScriptRun>(`${runPath(scriptRunId)}/cancel`, { method: 'POST', toast: false }),
    restartRun: (scriptRunId: string, body: Partial<RestartScriptRunBody>) =>
      api<ScriptRun>(`${runPath(scriptRunId)}/restart`, { method: 'POST', body, toast: false }),
    /** Navigating here downloads the output (302 to its presigned URL). */
    outputDownloadUrl: (scriptRunId: string, outputId: string) => `${runPath(scriptRunId)}/outputs/${encodeURIComponent(outputId)}?redirect=true`,
    /** Navigating here downloads the snapshot the run was built from. */
    sourceDownloadUrl: (scriptRunId: string) => `${runPath(scriptRunId)}/source?redirect=true`,
  }
}
