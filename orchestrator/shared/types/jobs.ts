import type { JobKind, JobState, JobSubjectKind } from '../utils/enums'
import type { IsoDate } from './common'

// Job representation (docs/api.md §4.16; docs/data-model.md §4.12). `JobRef` lives in ./common.

export interface Job {
  id: string
  kind: JobKind
  subject: { kind: JobSubjectKind; id: string }
  state: JobState
  progress: { done: number; total: number | null }
  attempts: number
  error: { code: string; message: string } | null
  createdAt: IsoDate
  startedAt: IsoDate | null
  finishedAt: IsoDate | null
}
