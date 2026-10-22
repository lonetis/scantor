import type { Account, ApiKey, OAuthApp } from '#shared/types/account'
import { apiError } from '../../utils/errors'
import { isoDate, isoDateOrNull } from '../../utils/serialize'
import { type ApiKeyRecord, credentialSummary, findAuthUser, type OAuthAppRecord } from '../../utils/users'

// Account, API key and OAuth app representations (docs/api.md §2, §4.3).

export async function getApiAccount(userId: string): Promise<Account> {
  const user = await findAuthUser(userId)
  if (!user) throw apiError('unauthorized', 'the account no longer exists')
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    canRunPrivileged: user.canRunPrivileged,
    maxWorkers: user.maxWorkers,
    credentials: await credentialSummary(user.id),
    createdAt: isoDate(user.createdAt),
  }
}

export function toApiKey(record: ApiKeyRecord): ApiKey {
  return {
    id: record.id,
    name: record.name,
    start: record.start,
    configId: record.configId,
    enabled: record.enabled,
    createdAt: isoDate(record.createdAt),
    expiresAt: isoDateOrNull(record.expiresAt),
    lastRequest: isoDateOrNull(record.lastRequest),
  }
}

export function toOAuthApp(record: OAuthAppRecord): OAuthApp {
  return { clientId: record.clientId, name: record.name, uri: record.uri, scopes: record.scopes, createdAt: isoDate(record.createdAt) }
}
