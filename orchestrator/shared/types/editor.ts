import type { EditorState } from '../utils/enums'
import type { IsoDate } from './common'

// Editor representations (docs/api.md §4.18).

export interface EditorStatus {
  state: EditorState
  startedAt: IsoDate | null
  lastActivityAt: IsoDate | null
  idleTimeoutMs: number
  error: string | null
}

export interface EditorSession {
  url: string
  expiresAt: IsoDate
  editor: { state: 'starting' | 'running'; startedAt: IsoDate | null; lastActivityAt: IsoDate | null }
}
