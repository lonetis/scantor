import { z } from 'zod'
import { API_KEY_CONFIG_IDS } from '../utils/enums'
import { text } from './common'
import { password, personName } from './users'

// Request schemas of the `account` and `api-keys` tags (docs/api.md §4.3).

export const API_KEY_DEFAULT_EXPIRES_IN_DAYS = 90

export const updateAccountBody = z.strictObject({ name: personName() })

export const setAccountPasswordBody = z.strictObject({ newPassword: password() })

export const listApiKeysQuery = z.strictObject({ configId: z.enum(API_KEY_CONFIG_IDS).optional() })

export const createApiKeyBody = z.strictObject({
  name: text(32),
  expiresInDays: z.number().int().min(1).max(365).default(API_KEY_DEFAULT_EXPIRES_IN_DAYS),
})
export type CreateApiKeyBody = z.infer<typeof createApiKeyBody>

export const keyIdParams = z.strictObject({ keyId: z.uuid() })

/** OAuth client ids are random strings for DCR clients and https URLs for CIMD clients. */
export const clientIdParams = z.strictObject({ clientId: z.string().min(1).max(2048) })
