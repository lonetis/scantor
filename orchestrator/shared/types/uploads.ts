import type { UploadKind } from '../utils/enums'
import type { IsoDate } from './common'

// Upload representation (docs/api.md §4.9; docs/data-model.md §4.10).

export interface Upload {
  id: string
  kind: UploadKind
  name: string
  contentType: string
  bytes: number
  sha256: string
  lines: number
  lastUsedAt: IsoDate | null
  createdAt: IsoDate
}
