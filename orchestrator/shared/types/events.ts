import type { EventLevel } from '../utils/enums'
import type { IsoDate } from './common'

// Event representation (docs/data-model.md §4.11). `Event` collides with the DOM global of the same name when
// auto-imported into app code; import it explicitly or use the `ScantorEvent` alias there.

export interface Event {
  id: string
  at: IsoDate
  type: string
  level: EventLevel
  userId: string | null
  scanId?: string
  taskId?: string
  revisionId?: string
  workerId?: string
  nodeId?: string
  message: string
  data?: Record<string, unknown>
}

export type ScantorEvent = Event
