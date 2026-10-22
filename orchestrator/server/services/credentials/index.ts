import { randomUUID } from 'node:crypto'
import type { CreateCredentialBody, UpdateCredentialBody } from '#shared/schemas/tasks'
import type { Credential } from '#shared/types/credentials'
import type { CredentialDoc } from '../../types/documents'
import type { UserPrincipal } from '../../utils/principal'
import { loadOwned, ownedRef } from '../../utils/authz'
import { apiError } from '../../utils/errors'
import { useCollections } from '../../utils/mongo'
import { decryptSecret, encryptSecret, SecretDecryptionError } from '../../utils/secrets'
import { isoDate, isoDateOrNull } from '../../utils/serialize'

// Git credentials (docs/api.md §4.5, docs/data-model.md §4.9, security.md WS-7): the token is stored only as
// `secretEnc` (AES-256-GCM, HKDF label `credentials`, AAD `credentials:<_id>:secretEnc`) and never returned; the API
// shows `last4`. Tokens reach git only through GIT_CONFIG_* variables of a git helper, for the exact host.

export function credentialAad(id: string): string {
  return `credentials:${id}:secretEnc`
}

export function toApiCredential(doc: CredentialDoc): Credential {
  return {
    id: doc._id,
    kind: doc.kind,
    name: doc.name,
    host: doc.host,
    username: doc.username,
    last4: doc.last4,
    lastUsedAt: isoDateOrNull(doc.lastUsedAt),
    createdAt: isoDate(doc.createdAt),
    updatedAt: isoDate(doc.updatedAt),
  }
}

function last4(token: string): string {
  return token.slice(-4)
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000
}

export async function listCredentials(principal: UserPrincipal): Promise<{ items: Credential[] }> {
  const docs = await useCollections().credentials.find({ userId: principal.user.id }).sort({ name: 1 }).toArray()
  return { items: docs.map(toApiCredential) }
}

export async function createCredential(principal: UserPrincipal, body: CreateCredentialBody): Promise<Credential> {
  const now = new Date()
  const id = randomUUID()
  const doc: CredentialDoc = {
    _id: id,
    userId: principal.user.id,
    kind: body.kind,
    name: body.name,
    host: body.host,
    username: body.username,
    secretEnc: encryptSecret(body.token, 'credentials', credentialAad(id)),
    last4: last4(body.token),
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  try {
    await useCollections().credentials.insertOne(doc)
  } catch (error) {
    if (isDuplicateKey(error)) throw apiError('alreadyExists', `a credential named ${body.name} already exists`)
    throw error
  }
  return toApiCredential(doc)
}

export async function updateCredential(principal: UserPrincipal, credentialId: string, body: UpdateCredentialBody): Promise<Credential> {
  const { credentials } = useCollections()
  const current = await loadOwned(credentials, credentialId, principal, { what: 'credential' })
  const set: Partial<CredentialDoc> = { updatedAt: new Date() }
  if (body.name !== undefined) set.name = body.name
  if (body.host !== undefined) set.host = body.host
  if (body.username !== undefined) set.username = body.username
  if (body.token !== undefined) {
    set.secretEnc = encryptSecret(body.token, 'credentials', credentialAad(current._id))
    set.last4 = last4(body.token)
  }
  try {
    const updated = await credentials.findOneAndUpdate({ _id: current._id, userId: current.userId }, { $set: set }, { returnDocument: 'after' })
    if (!updated) throw apiError('notFound', 'credential not found')
    return toApiCredential(updated)
  } catch (error) {
    if (isDuplicateKey(error)) throw apiError('alreadyExists', `a credential named ${body.name} already exists`)
    throw error
  }
}

export async function deleteCredential(principal: UserPrincipal, credentialId: string): Promise<void> {
  const { credentials } = useCollections()
  const current = await loadOwned(credentials, credentialId, principal, { what: 'credential' })
  await credentials.deleteOne({ _id: current._id, userId: current.userId })
}

// ── use by git helpers ──────────────────────────────────────────────────────

export interface GitCredentialEnv {
  env: Record<string, string>
  /** values that must never appear in messages */
  secrets: string[]
}

/** GIT_CONFIG_* variables that send `Authorization: Basic <base64(username:token)>` to exactly `host` (editor.md §9.7). */
export function gitCredentialEnv(host: string, username: string, token: string): GitCredentialEnv {
  const basic = Buffer.from(`${username}:${token}`, 'utf8').toString('base64')
  return {
    env: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.https://${host}/.extraheader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    },
    secrets: [token, basic],
  }
}

/**
 * Loads a credential of `ownerId` for a git URL host: the credential's host must equal the URL host exactly
 * (otherwise 400 badRequest, so a token is never sent elsewhere). Decrypts the token just before use and records
 * `lastUsedAt`.
 */
export async function credentialForGit(ownerId: string, credentialId: string, urlHost: string): Promise<GitCredentialEnv> {
  const { credentials } = useCollections()
  const doc = await credentials.findOne({ _id: credentialId, userId: ownerId })
  if (!doc) throw apiError('notFound', 'credential not found')
  if (doc.host !== urlHost) {
    throw apiError('badRequest', `credential ${doc.name} is for host ${doc.host}, not ${urlHost}`)
  }
  let token: string
  try {
    token = decryptSecret(doc.secretEnc, 'credentials', credentialAad(doc._id))
  } catch (error) {
    if (error instanceof SecretDecryptionError) {
      throw apiError('badRequest', `credential ${doc.name} can no longer be decrypted (SCANTOR_SECRET changed); set its token again`)
    }
    throw error
  }
  await credentials.updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date() } })
  return gitCredentialEnv(doc.host, doc.username, token)
}

/** Checks that a credential referenced by a create body belongs to the caller (404 otherwise). */
export async function assertOwnCredential(principal: UserPrincipal, credentialId: string): Promise<CredentialDoc> {
  return ownedRef(useCollections().credentials, credentialId, principal, 'credential')
}
