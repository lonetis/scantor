import type { UserRole } from '../utils/enums'
import type { IsoDate } from './common'

// User representation (docs/api.md §2, §4.4).

export interface UserUsage {
  activeWorkers: number
  tasks: number
  scans: number
}

export interface User {
  id: string
  email: string
  name: string
  role: UserRole
  banned: boolean
  banReason: string | null
  canRunPrivileged: boolean
  /** 0 = unlimited */
  maxWorkers: number
  createdAt: IsoDate
  updatedAt: IsoDate
  usage: UserUsage
}
