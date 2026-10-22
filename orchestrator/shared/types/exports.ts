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
