import type { TestRunAnalysisStatus, TestRunState } from '../utils/enums'
import type { BuildError, Description, FileRef, IsoDate, ScantorError } from './common'

// Test-run representations (docs/api.md §2, §4.11; docs/data-model.md §4.3, §4.4).

export interface TestRunInput {
  taskConfig?: Record<string, unknown>
  scanConfig?: Record<string, unknown>
  analysisConfig?: Record<string, unknown>
  limit: number
  maxAttempts: number
  timeoutMs: number
}

export interface TestRunAttempt {
  attempt: number
  startedAt: IsoDate | null
  finishedAt: IsoDate | null
  durationMs: number | null
  error: ScantorError | null
  logTail: string
}

export interface AnalysisTimings {
  scheduledAt: IsoDate | null
  startedAt: IsoDate | null
  finishedAt: IsoDate | null
  durationMs: number | null
}

/** As `Analysis`, without round and worker fields. */
export interface TestRunAnalysis {
  id: string
  seq: number
  status: TestRunAnalysisStatus
  attempt: number
  config?: Record<string, unknown>
  result?: Record<string, unknown> | null
  error?: ScantorError | null
  attempts: TestRunAttempt[]
  files: FileRef[]
  logTail?: string
  timings?: AnalysisTimings
}

export interface TestRun {
  id: string
  userId: string
  taskId: string
  taskName: string
  state: TestRunState
  input: TestRunInput
  packSha256?: string | null
  draftImage?: { ref: string; digest: string; cached: boolean } | null
  description?: Description | null
  errors: BuildError[]
  summary: { analyses: number; succeeded: number; failed: number }
  /** Present when requested (`analyses=true`). */
  analyses?: TestRunAnalysis[]
  createdAt: IsoDate
  startedAt?: IsoDate | null
  finishedAt?: IsoDate | null
  expiresAt: IsoDate
}

/** Events of `GET /api/test-runs/{testRunId}/stream`. */
export interface TestRunStreamEvents {
  state: { state: TestRunState }
  log: { seq: number | null; stream: 'stdout' | 'stderr' | 'build'; text: string; at: IsoDate }
  analysis: TestRunAnalysis
  error: BuildError
  end: TestRun
}
