import { onScopeDispose, ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import type { TestTaskBody } from '#shared/schemas/tasks'

// Test runs (docs/api.md §4.11, docs/ui.md §5.8, §9): the history of a task, starting and cancelling, and the live
// view of one run over the SSE stream `streamTestRun`, falling back to polling `getTestRun` every 2 s when the
// stream fails, until the run settles.

export const TEST_RUN_POLL_MS = 2000
const MAX_LOG_LINES = 5000

export function isTestRunActive(state: TestRunState | null | undefined): boolean {
  return state === 'queued' || state === 'building' || state === 'running'
}

export function useTestRuns(taskId: MaybeRefOrGetter<string>, limit = 10) {
  const api = useApi()
  const list = useCursorList<TestRun>((cursor) =>
    api<Page<TestRun>>(`/api/tasks/${encodeURIComponent(toValue(taskId))}/test-runs`, { query: apiQuery({ cursor, limit }), background: true }),
  )
  watch(() => toValue(taskId), () => {
    list.reset().catch((cause: unknown) => console.error('[test-runs] loading test runs failed', cause))
  })
  return list
}

export function useTestRunActions() {
  const api = useApi()
  return {
    startTestRun: (task: string, body: Partial<TestTaskBody>) =>
      api<TestRun>(`/api/tasks/${encodeURIComponent(task)}/test-runs`, { method: 'POST', body, toast: false }),
    cancelTestRun: (testRunId: string) => api<TestRun>(`/api/test-runs/${testRunId}/cancel`, { method: 'POST' }),
    getTestRun: (testRunId: string, options: { background?: boolean } = {}) =>
      api<TestRun>(`/api/test-runs/${testRunId}`, { query: { analyses: 'true' }, background: options.background ?? false }),
    fileDownload: (testRunId: string, fileId: string) => api<FileDownload>(`/api/test-runs/${testRunId}/files/${fileId}`),
  }
}

function appendCapped(lines: string[], line: string): string[] {
  const next = [...lines, line]
  return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next
}

/** The live state of one test run: its document, analyses by seq, errors and log lines. */
export function useTestRunStream() {
  const actions = useTestRunActions()
  const testRun = shallowRef<TestRun | null>(null)
  const state = ref<TestRunState | null>(null)
  const analyses = shallowRef<TestRunAnalysis[]>([])
  const errors = shallowRef<BuildError[]>([])
  const buildLines = shallowRef<string[]>([])
  const runLines = shallowRef<string[]>([])
  const streaming = ref(false)
  let source: EventSource | null = null
  const currentId = ref<string | null>(null)

  function upsertAnalysis(analysis: TestRunAnalysis): void {
    const others = analyses.value.filter((item) => item.seq !== analysis.seq)
    analyses.value = [...others, analysis].sort((a, b) => a.seq - b.seq)
  }

  function addError(error: BuildError): void {
    const key = JSON.stringify(error)
    if (errors.value.some((item) => JSON.stringify(item) === key)) return
    errors.value = [...errors.value, error]
  }

  function applyRun(run: TestRun): void {
    testRun.value = run
    state.value = run.state
    for (const error of run.errors) addError(error)
    for (const analysis of run.analyses ?? []) upsertAnalysis(analysis)
  }

  /** Applies a late answer only while its run is still the followed one (another history row may be loaded). */
  function applyIfFollowed(run: TestRun): void {
    if (run.id === currentId.value) applyRun(run)
  }

  function close(): void {
    source?.close()
    source = null
    streaming.value = false
  }

  const poll = usePoll(
    async () => {
      if (!currentId.value) return
      applyIfFollowed(await actions.getTestRun(currentId.value, { background: true }))
    },
    { intervalMs: TEST_RUN_POLL_MS, enabled: () => currentId.value !== null && !streaming.value && isTestRunActive(state.value), immediate: false },
  )

  function parse<T>(event: MessageEvent): T | null {
    try {
      return JSON.parse(String(event.data)) as T
    } catch (cause) {
      console.error('[test-runs] unreadable stream event', cause)
      return null
    }
  }

  /** Follows a test run; `initial` (the start response or a history entry) is shown at once. */
  function follow(initial: TestRun): void {
    close()
    currentId.value = initial.id
    analyses.value = []
    errors.value = []
    buildLines.value = []
    runLines.value = []
    applyRun(initial)
    if (!isTestRunActive(initial.state)) {
      if (!initial.analyses) void actions.getTestRun(initial.id).then(applyIfFollowed, (cause: unknown) => console.error('[test-runs] loading the test run failed', cause))
      return
    }
    const stream = new EventSource(`/api/test-runs/${initial.id}/stream`)
    source = stream
    streaming.value = true
    stream.addEventListener('state', (event) => {
      const data = parse<{ state: TestRunState }>(event as MessageEvent)
      if (data) state.value = data.state
    })
    stream.addEventListener('log', (event) => {
      const data = parse<TestRunStreamEvents['log']>(event as MessageEvent)
      if (!data) return
      if (data.stream === 'build') buildLines.value = appendCapped(buildLines.value, data.text)
      else runLines.value = appendCapped(runLines.value, data.seq === null ? data.text : `[${data.seq}] ${data.text}`)
    })
    stream.addEventListener('analysis', (event) => {
      const data = parse<TestRunAnalysis>(event as MessageEvent)
      if (data) upsertAnalysis(data)
    })
    stream.addEventListener('error', (event) => {
      // Named `error` events carry a BuildError; a transport failure is a plain Event without data.
      const message = event as MessageEvent
      if (typeof message.data === 'string') {
        const data = parse<BuildError>(message)
        if (data) addError(data)
        return
      }
      close()
      void poll.refresh()
    })
    stream.addEventListener('end', (event) => {
      const data = parse<TestRun>(event as MessageEvent)
      close()
      if (data) applyIfFollowed({ ...data, analyses: data.analyses ?? testRun.value?.analyses })
      void actions.getTestRun(initial.id).then(applyIfFollowed, (cause: unknown) => console.error('[test-runs] loading the final test run failed', cause))
    })
  }

  onScopeDispose(close)

  return { testRun, state, analyses, errors, buildLines, runLines, streaming, follow, close }
}
