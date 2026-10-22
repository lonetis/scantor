import type { ApiKeyConfigId, UserRole } from '../utils/enums'
import type { IsoDate } from './common'

// Account, API key and OAuth app representations (docs/api.md §2, §4.3).

export interface Account {
  id: string
  email: string
  name: string
  role: UserRole
  canRunPrivileged: boolean
  maxWorkers: number
  credentials: { hasPassword: boolean; passkeyCount: number }
  createdAt: IsoDate
}

export interface ApiKey {
  id: string
  name: string | null
  /** The first characters of the key, for recognition (`sk_scantor_abcd`). */
  start: string | null
  configId: ApiKeyConfigId
  enabled: boolean
  createdAt: IsoDate
  expiresAt: IsoDate | null
  lastRequest: IsoDate | null
}

/** `createApiKey` response: `key` is shown exactly once. */
export interface CreatedApiKey {
  apiKey: ApiKey
  key: string
}

export interface OAuthApp {
  clientId: string
  name: string | null
  uri: string | null
  scopes: string[]
  createdAt: IsoDate
}
