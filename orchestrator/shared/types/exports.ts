import type { ExportFormat, ExportState } from '../utils/enums'
import type { DownloadLocation, IsoDate } from './common'

// Export and download representations (docs/api.md §2, §4.15; docs/data-model.md §4.14).

export interface Export {
  id: string
  userId: string
  scanId: string
  format: ExportFormat
  filter: Record<string, unknown>
  fields: string[] | null
  afterSeq: number | null
  state: ExportState
  bytes: number
  rows: number
  error: { code: string; message: string } | null
  jobId: string
  /** Set when `ready`. */
  download?: DownloadLocation
  createdAt: IsoDate
  finishedAt: IsoDate | null
  updatedAt: IsoDate
  expiresAt: IsoDate
}

export interface FileDownload {
  url: string
  expiresAt: IsoDate
  name: string
  size: number
  sha256: string
  contentType: string
  inline: boolean
}

export type FileContentEncoding = 'utf8' | 'base64'

/** One byte range of a stored file, inline (readAnalysisFile, readTestRunFile; docs/api.md §2, §4.15). */
export interface FileContent {
  name: string
  contentType: string
  /** of the whole file */
  size: number
  /** of the whole file */
  sha256: string
  /** the first byte returned */
  offset: number
  /** bytes returned; can be fewer than requested (a text page never ends inside a character) */
  length: number
  encoding: FileContentEncoding
  content: string
  /** `offset + length < size` */
  truncated: boolean
  /** `offset + length` when truncated, else null */
  nextOffset: number | null
}
