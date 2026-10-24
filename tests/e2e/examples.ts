// The example tasks under tasks/ and how e2e/examples.spec.ts publishes and scans each of them (docs/testing.md §8.3,
// docs/tasks.md §12.1). Every folder with a scantor.yaml needs an entry: the spec fails for an example without one.
// Together the entries cover every language of schemas/languages.json and every template of schemas/templates/,
// unwrapped (`schedule: {kind: "template"}`) or wrapped by a custom schedule (`kind: "custom"`, listed in `wraps`).
//
// The scans stay small and need no internet: the data-source templates read the fixtures server, and the origins they
// list (`siteN.example`) do not resolve, which the HTTP examples record as results, not failures.

import type { ScanState } from '#shared/utils/enums'

export interface ExampleScan {
  taskConfig?: Record<string, unknown>
  scanConfig?: Record<string, unknown>
  /** lines of a list upload; its id becomes `scanConfig.upload` */
  upload?: string[]
  /** merged over helpers/scans.ts SMALL_SETTINGS */
  settings?: Record<string, unknown>
  confirm?: boolean
}

export interface ExampleExpect {
  state: ScanState
  /** exact analysis counts by status */
  counts: Record<string, number>
  /** the expected (partial) result of the analysis with this seq */
  resultMatch: (seq: number) => Record<string, unknown>
  /** text every analysis log tail contains (ctx.log lines) */
  logTail?: string
  /** files every succeeded analysis carries */
  filesPerAnalysis?: number
  /** the scan's in-flight list shows ctx.progress while it runs */
  inflightProgress?: boolean
  timeoutMs?: number
}

/** What describe derives from the example's definition beyond the checks every example gets. */
export interface ExampleDescription {
  /** property names of a config schema in source order */
  propertyOrder?: Partial<Record<'taskConfig' | 'scanConfig' | 'result', string[]>>
  /** `uploadPaths` (default: none) */
  uploadPaths?: { taskConfig: string[]; scanConfig: string[] }
  /** `fileRefPaths` in any order (default: none) */
  fileRefPaths?: string[]
}

export interface Example {
  /** folder name under tasks/ */
  dir: string
  language: 'python' | 'typescript' | 'javascript' | 'go'
  /** what describe reports */
  schedule: { kind: 'template'; template: string } | { kind: 'custom' }
  description?: ExampleDescription
  /** templates a custom schedule wraps (their resolutions appear in `scheduling.resolved`) */
  wraps?: string[]
  scan: ExampleScan
  expect: ExampleExpect
}

/** The templates an example covers: the unwrapped one, or the ones its custom schedule wraps. */
export function exampleTemplates(example: Example): string[] {
  return example.schedule.kind === 'template' ? [example.schedule.template] : (example.wraps ?? [])
}

const LIST_ITEMS = ['gamma', 'alpha', 'beta']

export const EXAMPLES: Example[] = [
  {
    dir: 'echo',
    language: 'python',
    schedule: { kind: 'template', template: 'single' },
    scan: { taskConfig: { text: 'hello from the examples' } },
    expect: {
      state: 'completed',
      counts: { succeeded: 1 },
      resultMatch: () => ({ echo: 'hello from the examples' }),
      logTail: '[info] echoing length=23',
    },
  },
  {
    dir: 'files',
    language: 'python',
    schedule: { kind: 'template', template: 'list' },
    description: {
      propertyOrder: { result: ['item', 'length', 'data', 'image', 'notes', 'nested', 'gallery'] },
      uploadPaths: { taskConfig: [], scanConfig: ['/upload'] },
      fileRefPaths: ['/data', '/image', '/notes', '/nested/data', '/nested/image', '/gallery/*'],
    },
    // Inline items come first, then the upload's lines.
    scan: { taskConfig: { copies: 1 }, scanConfig: { items: ['gamma'] }, upload: ['alpha', '', '  beta  '] },
    expect: {
      state: 'completed',
      counts: { succeeded: 3 },
      resultMatch: (seq) => ({ item: LIST_ITEMS[seq], length: LIST_ITEMS[seq]!.length }),
      filesPerAnalysis: 6,
    },
  },
  {
    dir: 'http-status',
    language: 'typescript',
    schedule: { kind: 'template', template: 'crux' },
    description: { propertyOrder: { taskConfig: ['expectedStatus', 'followRedirects', 'timeoutMs', 'userAgent'] } },
    // The smallest CrUX bucket is 1000, and the fixture list has 1000 origins in it: two runners with two processes.
    scan: { taskConfig: { timeoutMs: 1000 }, scanConfig: { bucket: 1000 }, settings: { workers: 2, processes: 2 }, confirm: true },
    expect: {
      state: 'completed',
      counts: { succeeded: 1000 },
      resultMatch: (seq) => ({ origin: `${(seq + 1) % 10 === 0 ? 'http' : 'https'}://site${seq + 1}.example`, rank: 1000, status: null, matches: false }),
      timeoutMs: 300_000,
    },
  },
  {
    dir: 'origins',
    language: 'python',
    schedule: { kind: 'custom' },
    description: { propertyOrder: { taskConfig: ['user_agent', 'timeout_seconds', 'follow_redirects'] } },
    wraps: ['tranco'],
    scan: { scanConfig: { limit: 3 } },
    expect: {
      state: 'completed',
      counts: { succeeded: 3 },
      resultMatch: (seq) => ({ origin: `https://site${seq + 1}.example`, rank: seq + 1, status: null, final_url: null }),
      logTail: '[warning] request failed',
    },
  },
  {
    dir: 'power',
    language: 'javascript',
    schedule: { kind: 'custom' },
    description: { propertyOrder: { scanConfig: ['start', 'end', 'onlyOdd'], result: ['base', 'power', 'report'] }, fileRefPaths: ['/report'] },
    wraps: ['range'],
    scan: { taskConfig: { exponent: 3, report: true }, scanConfig: { start: 1, end: 6 } },
    expect: {
      state: 'completed',
      counts: { succeeded: 5 },
      resultMatch: (seq) => ({ base: seq + 1, power: String((seq + 1) ** 3) }),
      filesPerAnalysis: 1,
    },
  },
  {
    dir: 'reverse-dns',
    language: 'go',
    schedule: { kind: 'template', template: 'cidr' },
    // TEST-NET-1 has no PTR records: every lookup is a "not found" result.
    scan: { scanConfig: { cidrs: ['192.0.2.0/30'] } },
    expect: { state: 'completed', counts: { succeeded: 4 }, resultMatch: () => ({ names: [], found: false }) },
  },
  {
    dir: 'sleep',
    language: 'python',
    schedule: { kind: 'template', template: 'repeat' },
    // Long enough for a few state polls (every 5 s) to report the progress; both iterations run at the same time.
    scan: { taskConfig: { seconds: 8 }, scanConfig: { times: 2 }, settings: { processes: 2 } },
    expect: { state: 'completed', counts: { succeeded: 2 }, resultMatch: (seq) => ({ iteration: seq }), inflightProgress: true },
  },
  {
    dir: 'throws',
    language: 'python',
    schedule: { kind: 'custom' },
    wraps: ['range'],
    // Every analysis fails once and succeeds on its second attempt.
    scan: {
      taskConfig: { mode: 'flaky', fail_attempts: 1 },
      scanConfig: { end: 3 },
      settings: { maxAttempts: 3, backoff: { initialMs: 1000, factor: 1, maxMs: 1000, jitter: false } },
    },
    expect: { state: 'completed', counts: { succeeded: 3 }, resultMatch: (seq) => ({ value: seq, attempt: 2 }) },
  },
]
