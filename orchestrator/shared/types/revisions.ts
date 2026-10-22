import type { RevisionSourceKind, RevisionState } from '../utils/enums'
import type { BuildError, Description, IsoDate, Platform, ScanSettingsDefaults } from './common'

// Revision representations (docs/api.md §2, §4.10; docs/data-model.md §4.2).

export interface RevisionSource {
  kind: RevisionSourceKind
  packSha256: string
  packBytes: number
  fileCount: number
  git?: { url: string; ref: string; path: string; commit: string; dirty: boolean }
}

export interface RevisionImage {
  repository: string
  tag: string
  digest: string
  bytes: number
  platform: Platform
}

export interface Revision {
  id: string
  userId: string
  taskId: string
  taskName: string
  number: number
  /** `<taskName>@<number>` */
  ref: string
  state: RevisionState
  message?: string | null
  source: RevisionSource
  manifest?: Record<string, unknown> | null
  language?: string | null
  baseImage?: { ref: string; digest: string } | null
  image: RevisionImage | null
  description: Description | null
  settingsDefaults?: ScanSettingsDefaults | null
  privileged: boolean
  errors: BuildError[]
  createdAt: IsoDate
  startedAt?: IsoDate | null
  finishedAt?: IsoDate | null
  updatedAt: IsoDate
}

export interface RevisionSummary {
  id: string
  number: number
  ref: string
  state: RevisionState
  source: { kind: RevisionSourceKind; packSha256: string }
  privileged: boolean
  errorsCount: number
  createdAt: IsoDate
  finishedAt: IsoDate | null
}

export type BuildLogStream = 'pipeline' | 'build' | 'stdout' | 'stderr' | 'check'

/** One task-pipeline event of the build log (`line` = event seq + 1). */
export interface BuildLogLine {
  line: number
  at: IsoDate
  phase: string
  type: 'log' | 'error' | 'result'
  stream?: BuildLogStream
  level?: 'info' | 'warning'
  text?: string
  error?: BuildError
  result?: Record<string, unknown>
}

export interface BuildLogPage {
  lines: BuildLogLine[]
  nextLine: number
  complete: boolean
}
