import type { AnalysisStatus } from '../utils/enums'
import type { FileRef, IsoDate, ScantorError } from './common'
import type { AnalysisTimings } from './test-runs'

// Analysis representations (docs/api.md §2, §4.14; docs/data-model.md §4.6).

export interface Attempt {
  attempt: number
  round: number
  executionId: string
  workerId: string | null
  nodeId: string | null
  startedAt: IsoDate | null
  finishedAt: IsoDate | null
  durationMs: number | null
  error: ScantorError | null
  logTail: string
}

export interface Analysis {
  /** `<scanId>-<seq>` */
  id: string
  scanId: string
  userId: string
  seq: number
  round: number
  status: AnalysisStatus
  attempt: number
  config?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: ScantorError
  attempts: Attempt[]
  files: FileRef[]
  logTail?: string
  timings?: AnalysisTimings
  workerId?: string
  nodeId?: string
  executionId?: string
  createdAt: IsoDate
  updatedAt: IsoDate
}

/** `queryAnalyses` response; `nextCursor` is null when a `sort` is given. */
export interface AnalysisQueryResult {
  items: Record<string, unknown>[]
  nextCursor: string | null
}

export interface AnalysisAggregateResult {
  items: Record<string, unknown>[]
  truncated: boolean
}
