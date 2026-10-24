import { randomUUID } from 'node:crypto'
import { apiKey } from '@better-auth/api-key'
import { cimd } from '@better-auth/cimd'
import { fetchClientMetadataResource } from '@better-auth/cimd/node'
import { mcp } from '@better-auth/mcp'
import { passkey } from '@better-auth/passkey'
import { betterAuth } from 'better-auth'
import { getDatabaseFieldIndexName, getDatabaseIndexName } from '@better-auth/core/db/internal'
import { mongodbAdapter } from 'better-auth/adapters/mongodb'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { symmetricDecrypt } from 'better-auth/crypto'
import { admin, jwt } from 'better-auth/plugins'
import type { CreateIndexesOptions, Db } from 'mongodb'
import {
  AUTH_BASE_PATH,
  authHttpAllowlist,
  isAllowedMcpRedirect,
  OAUTH_SCOPES,
  rateLimitConfig,
  resolveMcpConfig,
  resolvePasskeyConfig,
  trustedOrigins,
} from './auth-policy'
import { useConfig } from './config'
import { useKeys } from './keys'
import { type Logger, useLogger } from './logger'
import { type IndexSpec, useMongo } from './mongo'
import { DEFAULT_API_KEY_PATTERN, EDITOR_API_KEY_PATTERN, bearerValue } from './principal'
import { completePasskeySetupUser, resolvePasskeySetupUser } from './setup'
import { invalidateCachedUser } from './user-cache'

// The better-auth instance (docs/auth.md §2): MongoDB adapter on the shared client (transactions, plain uuid ids),
// no self sign-up, the HTTP allowlist (§2.5), admin + api-key + passkey + jwt/mcp/cimd plugins, scantor cookie names,
// rate limits and the client IP header set by middleware/00.request.ts. Built lazily and initialised eagerly in boot
// step 3. The instance is typed `any` on purpose: the nested better-call/zod types make TypeScript unusably slow;
// typed wrappers live in server/utils/users.ts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AuthInstance = any

/** `x-api-key` or `Authorization: Bearer` value, if it matches `pattern`. */
function keyGetter(pattern: RegExp) {
  return (ctx: { headers?: Headers }): string | null => {
    const headers = ctx.headers
    if (!headers) return null
    const header = headers.get('x-api-key')
    if (header && pattern.test(header)) return header
    const bearer = bearerValue(headers.get('authorization'))
    return bearer && pattern.test(bearer) ? bearer : null
  }
}

function apiKeyConfigurations(editorKeyTtlSeconds: number) {
  return [
    {
      configId: 'default',
      defaultPrefix: 'sk_scantor_',
      customAPIKeyGetter: keyGetter(DEFAULT_API_KEY_PATTERN),
      enableSessionForAPIKeys: true,
      rateLimit: { enabled: false },
      // seconds (better-auth api-key 1.7.12 reads defaultExpiresIn with getDate(value, "sec"))
      keyExpiration: { defaultExpiresIn: 7_776_000, minExpiresIn: 1, maxExpiresIn: 365 },
      startingCharactersConfig: { shouldStore: true, charactersLength: 15 },
      requireName: true,
      maximumNameLength: 32,
      enableMetadata: false,
    },
    {
      configId: 'editor',
      defaultPrefix: 'sk_scantor_editor_',
      customAPIKeyGetter: keyGetter(EDITOR_API_KEY_PATTERN),
      enableSessionForAPIKeys: true,
      rateLimit: { enabled: false },
      keyExpiration: { defaultExpiresIn: editorKeyTtlSeconds, disableCustomExpiresTime: true },
      startingCharactersConfig: { shouldStore: true, charactersLength: 22 },
      requireName: true,
      maximumNameLength: 32,
      enableMetadata: false,
    },
  ]
}

function lowercaseEmail<T extends { email?: unknown }>(user: T) {
  return Promise.resolve({ data: typeof user.email === 'string' ? { ...user, email: user.email.toLowerCase() } : user })
}

function buildAuth(): AuthInstance {
  const config = useConfig()
  const { db, client } = useMongo()
  const passkeyConfig = resolvePasskeyConfig(config)
  const mcpConfig = resolveMcpConfig(config)

  const beforeHook = createAuthMiddleware(async (ctx) => {
    if (ctx.path === '/oauth2/register') {
      const uris = (ctx.body as { redirect_uris?: unknown } | undefined)?.redirect_uris
      const list = Array.isArray(uris) ? uris : []
      if (list.some((uri) => typeof uri !== 'string' || !isAllowedMcpRedirect(uri, config.mcpAllowedRedirectOrigins))) {
        throw new APIError('BAD_REQUEST', {
          error: 'invalid_redirect_uri',
          error_description: 'redirect URIs must be http loopback, an allowed https origin or a private-use scheme',
        })
      }
      return
    }
    if (ctx.path === '/oauth2/consent') {
      const body = (ctx.body ?? {}) as { accept?: unknown; scope?: unknown }
      if (body.accept !== true) return
      if (typeof body.scope !== 'string' || body.scope.trim() === '') {
        throw new APIError('BAD_REQUEST', { error: 'invalid_request', error_description: 'scope is required when accepting' })
      }
      const session = await getSessionFromCtx(ctx)
      if ((session?.user as { role?: string } | undefined)?.role === 'admin') return
      const scope = body.scope
        .split(/\s+/)
        .filter((item) => item && item !== 'scantor:admin')
        .join(' ')
      return { context: { body: { ...body, scope } } }
    }
  })

  const afterHook = createAuthMiddleware(async (ctx) => {
    if (ctx.path === '/sign-out' && config.domain) {
      ctx.setCookie('scantor_tools', '', {
        domain: config.domain,
        path: '/',
        maxAge: 0,
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
      })
      return
    }
    if (ctx.path === '/change-password' || ctx.path === '/revoke-sessions') {
      const userId = ctx.context.session?.user?.id ?? ctx.context.newSession?.user?.id
      if (typeof userId === 'string') invalidateCachedUser(userId)
    }
  })

  return betterAuth({
    appName: 'scantor',
    baseURL: config.publicUrl,
    basePath: AUTH_BASE_PATH,
    secret: useKeys().betterAuthSecret(),
    database: mongodbAdapter(db, { client, usePlural: false }),
    trustedOrigins: trustedOrigins(config),
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
      requireEmailVerification: false,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    user: {
      additionalFields: {
        canRunPrivileged: { type: 'boolean', required: false, defaultValue: false, input: false },
        maxWorkers: { type: 'number', required: false, defaultValue: () => config.userMaxWorkers, input: false },
      },
      changeEmail: { enabled: true, updateEmailWithoutVerification: true },
      deleteUser: { enabled: false },
    },
    session: {
      expiresIn: 604_800,
      updateAge: 86_400,
      freshAge: 86_400,
      cookieCache: { enabled: false },
    },
    rateLimit: rateLimitConfig(config.authRateLimitScale),
    advanced: {
      cookiePrefix: 'scantor',
      useSecureCookies: config.publicUrl.startsWith('https://'),
      defaultCookieAttributes: { sameSite: 'lax', httpOnly: true },
      database: { generateId: () => randomUUID() },
      ipAddress: { ipAddressHeaders: ['x-scantor-client-ip'], ipv6Subnet: 64 },
    },
    databaseHooks: {
      user: {
        create: { before: lowercaseEmail },
        update: { before: lowercaseEmail },
      },
    },
    hooks: { before: beforeHook, after: afterHook },
    plugins: [
      // first, so that no other plugin and no endpoint sees a request outside the HTTP allowlist
      authHttpAllowlist(),
      admin({ defaultRole: 'user', adminRoles: ['admin'] }),
      apiKey(apiKeyConfigurations(Math.round(config.editorApiKeyTtlMs / 1000))),
      ...(passkeyConfig.enabled
        ? [
            passkey({
              rpID: passkeyConfig.rpID,
              rpName: 'scantor',
              origin: passkeyConfig.origin,
              authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
              registration: {
                requireSession: false,
                resolveUser: resolvePasskeySetupUser,
                afterVerification: completePasskeySetupUser,
              },
            }),
          ]
        : []),
      ...(mcpConfig.oauth
        ? [
            jwt(),
            mcp({
              resource: mcpConfig.resource,
              loginPage: '/login',
              consentPage: '/oauth/consent',
              scopes: OAUTH_SCOPES,
              clientRegistrationDefaultScopes: OAUTH_SCOPES,
              allowDynamicClientRegistration: true,
              allowUnauthenticatedClientRegistration: true,
              clientRegistrationDefaultApplicationType: 'infer',
              validateRedirectUri: (uri: string, _registered: readonly string[], defaultResult: boolean) =>
                defaultResult && isAllowedMcpRedirect(uri, config.mcpAllowedRedirectOrigins),
              accessTokenExpiresIn: 3600,
              refreshTokenExpiresIn: 2_592_000,
              codeExpiresIn: 600,
            }),
            cimd({
              fetchClientMetadataResource,
              metadataProfile: 'mcp-2026-07-28',
              isMetadataDocumentUrlAllowed: (url: string) => url.startsWith('https://'),
            }),
          ]
        : []),
    ],
  })
}

let instance: AuthInstance | null = null

/** The better-auth instance (built on first use; boot step 3 builds it eagerly). */
export function useAuth(): AuthInstance {
  instance ??= buildAuth()
  return instance
}

/** The better-auth context with `internalAdapter`, `adapter` and `password` helpers. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function useAuthContext(): Promise<any> {
  return useAuth().$context
}

/**
 * Boot step 3 cleanup (docs/architecture.md §4.1): deletes `jwks` signing keys whose private key cannot be decrypted
 * with the current secret (after a SCANTOR_SECRET change), so the jwt plugin mints a new key.
 */
export async function deleteUndecryptableJwks(log: Logger = useLogger('auth')): Promise<number> {
  if (!resolveMcpConfig(useConfig()).oauth) return 0
  const ctx = await useAuthContext()
  const keys = (await ctx.adapter.findMany({ model: 'jwks' })) as { id: string; privateKey: string }[]
  let deleted = 0
  for (const key of keys) {
    let usable = true
    try {
      await symmetricDecrypt({ key: ctx.secretConfig, data: JSON.parse(key.privateKey) })
    } catch {
      usable = false
    }
    if (usable) continue
    await ctx.adapter.delete({ model: 'jwks', where: [{ field: 'id', value: key.id }] })
    deleted++
  }
  if (deleted > 0) log.warn('deleted OAuth signing keys that the current SCANTOR_SECRET cannot decrypt', { count: deleted })
  return deleted
}

// ── indexes of the better-auth collections ──────────────────────────────────

/** The subset of better-auth's table metadata (`$context.tables`) that describes indexes. */
export interface AuthTableMeta {
  modelName: string
  fields: Record<string, { fieldName?: string; unique?: boolean; index?: boolean; required?: boolean }>
  indexes?: { fields: string[]; unique?: boolean }[]
}

/** A better-auth index: always named, because the MongoDB adapter creates table-level indexes under these names. */
export interface AuthIndexSpec extends IndexSpec {
  options: CreateIndexesOptions & { name: string }
}

/**
 * The indexes better-auth declares for its tables (field `unique`/`index` attributes and table-level indexes),
 * mapped onto MongoDB collections, under the names better-auth itself uses. The MongoDB adapter creates only the
 * table-level indexes, lazily on first use of a model and by name; field-level indexes it never creates, so without
 * them every session, API key and OAuth token lookup scans its collection. Using better-auth's names makes the
 * adapter's own `createIndex` a no-op instead of an IndexOptionsConflict. Unique indexes are kept only for required
 * fields, so that absent optional values can never collide.
 */
export function authIndexesFrom(tables: Record<string, AuthTableMeta>): { collection: string; specs: AuthIndexSpec[] }[] {
  const result: { collection: string; specs: AuthIndexSpec[] }[] = []
  for (const table of Object.values(tables)) {
    const column = (name: string) => (name === 'id' ? '_id' : (table.fields[name]?.fieldName ?? name))
    const specs: AuthIndexSpec[] = []
    for (const [name, field] of Object.entries(table.fields)) {
      if (name === 'id' || (!field.unique && !field.index)) continue
      const unique = field.unique === true && field.required !== false
      const options = { name: getDatabaseFieldIndexName(table.modelName, column(name), unique), ...(unique ? { unique: true } : {}) }
      specs.push({ key: { [column(name)]: 1 }, options })
    }
    for (const index of table.indexes ?? []) {
      const columns = index.fields.map(column)
      const unique = index.unique === true
      const options = { name: getDatabaseIndexName(table.modelName, { fields: columns, unique }), ...(unique ? { unique: true } : {}) }
      specs.push({ key: Object.fromEntries(columns.map((name) => [name, 1 as const])), options })
    }
    if (specs.length > 0) result.push({ collection: table.modelName, specs })
  }
  return result
}

/**
 * Creates named indexes idempotently. An index with the same key pattern under another name (created by an earlier
 * boot, which used MongoDB's default names) is dropped and recreated under the better-auth name, because MongoDB
 * refuses a second index with the same key and a different name.
 */
async function ensureNamedIndexes(db: Db, name: string, specs: AuthIndexSpec[], log: Logger): Promise<void> {
  const collection = db.collection(name)
  const existing = await collection
    .listIndexes()
    .toArray()
    .catch((error: unknown) => {
      if ((error as { code?: number }).code === 26) return [] // NamespaceNotFound: collection not created yet
      throw error
    })
  for (const spec of specs) {
    if (existing.some((index) => index.name === spec.options.name)) continue
    const sameKey = existing.find((index) => JSON.stringify(index.key) === JSON.stringify(spec.key))
    if (sameKey) {
      await collection.dropIndex(sameKey.name as string)
      log.info('renamed a better-auth index', { collection: name, from: sameKey.name, to: spec.options.name })
    }
    await collection.createIndex(spec.key, spec.options)
  }
}

/**
 * Boot step 3: ensures the indexes of the better-auth collections. A failure (for example duplicate data under a
 * unique index) is logged and does not stop the boot: the indexes speed up lookups but correctness does not depend
 * on them.
 */
export async function ensureAuthIndexes(log: Logger = useLogger('auth')): Promise<void> {
  const ctx = await useAuthContext()
  const { db } = useMongo()
  for (const { collection, specs } of authIndexesFrom(ctx.tables as Record<string, AuthTableMeta>)) {
    try {
      await ensureNamedIndexes(db, collection, specs, log)
    } catch (error) {
      log.error('ensuring better-auth indexes failed', { collection, err: error })
    }
  }
}
