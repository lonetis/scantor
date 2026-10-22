import type { CredentialKind } from '../utils/enums'
import type { IsoDate } from './common'

// Git credential representation (docs/api.md §4.5; docs/data-model.md §4.9). The token is write-only. `Credential`
// collides with the DOM global of the same name when auto-imported into app code; import it explicitly or use the
// `GitCredential` alias there.

export interface Credential {
  id: string
  kind: CredentialKind
  name: string
  host: string
  username: string
  last4: string
  lastUsedAt: IsoDate | null
  createdAt: IsoDate
  updatedAt: IsoDate
}

export type GitCredential = Credential
