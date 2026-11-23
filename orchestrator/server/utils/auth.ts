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
import type { RequestOrigin } from '#shared/utils/enums'
import {
  anyMcpOAuth,
  AUTH_BASE_PATH,
  authHttpAllowlist,
  configuredOrigins,
  dataAuthOrigin,
  isAllowedMcpRedirect,
  mcpOAuthResources,
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
import { originUrlOf } from './tunnel'
import { invalidateCachedUser } from './user-cache'

// The better-auth instances (docs/auth.md §2), one per origin (the public URL and, when set, the tunnel URL): each
// has its own base URL (OAuth issuer), trusted origin, cookie prefix, passkey RP and MCP resource, and every plugin
// object is created per instance, because cimd extends its own mcp plugin at init. They share the MongoDB adapter's
// client (transactions, plain uuid ids), the secret, the signing keys and the in-memory rate limits. No self sign-up,
// the HTTP allowlist (§2.5), admin + api-key + passkey + jwt/mcp/cimd plugins, scantor cookie names, rate limits and
// the client IP header set by middleware/00.request.ts. Built lazily and initialised eagerly in boot step 3. An
// instance is typed `any` on purpose: the nested better-call/zod types make TypeScript unusably slow; typed wrappers
// live in server/utils/users.ts.

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

/** Every `resource` value of an OAuth request: query, body and the repeated fields of a form body (RFC 8707). */
async function requestedResources(ctx: { query?: Record<string, unknown>; body?: unknown; request?: Request }): Promise<unknown[]> {
  const values: unknown[] = []
  const add = (value: unknown) => values.push(...(Array.isArray(value) ? value : value === undefined ? [] : [value]))
  add(ctx.query?.resource)
  add((ctx.body as { resource?: unknown } | undefined)?.resource)
  // better-call keeps only the last value of a repeated form field; the token endpoint reads them all itself
  if (ctx.request?.headers.get('content-type')?.toLowerCase().includes('application/x-www-form-urlencoded')) {
    try {
      add(new URLSearchParams(await ctx.request.clone().text()).getAll('resource'))
    } catch {
      // an unreadable body: the endpoint fails on it as well
    }
  }
  return values
}

function buildAuth(origin: RequestOrigin): AuthInstance {
  const config = useConfig()
  const { db, client } = useMongo()
  const baseURL = originUrlOf(config, origin)
  const passkeyConfig = resolvePasskeyConfig(config, origin)
  const mcpConfig = resolveMcpConfig(config, origin)

  // This origin's resources: its `/mcp` and the userinfo endpoint better-auth accepts as a resource of its own.
  const ownResources = new Set([mcpConfig.resource, `${baseURL}${AUTH_BASE_PATH}/oauth2/userinfo`])
  // The `/mcp` of the other origins with MCP OAuth: empty without a tunnel, where better-auth alone checks resources.
  const foreignResources = new Set(mcpOAuthResources(config).filter((resource) => resource !== mcpConfig.resource))

  const beforeHook = createAuthMiddleware(async (ctx) => {
    // The OAuth rows are shared between the origins, so a client linked to the other origin's resource would otherwise
    // get a token with this issuer and that audience, which neither `/mcp` accepts. The authorize endpoint refuses only
    // the other origins' resources (better-auth redirects any other unknown one to the client with invalid_target);
    // the token endpoint, which answers JSON either way, anything but this origin's own. Empty values are better-auth's.
    if (mcpConfig.oauth && foreignResources.size > 0 && (ctx.path === '/oauth2/authorize' || ctx.path === '/oauth2/token')) {
      const refused =
        ctx.path === '/oauth2/authorize'
          ? (resource: unknown) => typeof resource === 'string' && foreignResources.has(resource)
          : (resource: unknown) => typeof resource === 'string' && resource !== '' && !ownResources.has(resource)
      const foreign = (await requestedResources(ctx)).find(refused)
      if (foreign !== undefined) {
        throw new APIError('BAD_REQUEST', { error: 'invalid_target', error_description: `${String(foreign)} is not a resource of this origin` })
      }
      return
    }
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
    // The admin tools cookie belongs to the public URL's domain; the tunnel never serves the admin tools.
    if (ctx.path === '/sign-out' && origin === 'public' && config.domain) {
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
    baseURL,
    basePath: AUTH_BASE_PATH,
    secret: useKeys().betterAuthSecret(),
    database: mongodbAdapter(db, { client, usePlural: false }),
    trustedOrigins: trustedOrigins(config, origin),
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
      // better-auth skips its origin check when NODE_ENV=test or TEST is set; scantor's never depends on the environment.
      disableOriginCheck: false,
      cookiePrefix: 'scantor',
      useSecureCookies: baseURL.startsWith('https://'),
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
              // A client registered through either origin works on both (auth-policy.ts mcpOAuthResources).
              resources: mcpOAuthResources(config),
              clientRegistrationDefaultResources: mcpOAuthResources(config),
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

const instances = new Map<RequestOrigin, AuthInstance>()

/**
 * The better-auth instance of an origin (built on first use; boot step 3 builds every configured origin's eagerly).
 * Requests use the instance of their origin (requestOriginOf in server/utils/tunnel.ts); never call one instance's
 * `auth.api.*` from inside another instance's endpoint or hook, which would run in the other's endpoint context.
 */
export function useAuth(origin: RequestOrigin = 'public'): AuthInstance {
  let instance = instances.get(origin)
  if (!instance) {
    instance = buildAuth(origin)
    instances.set(origin, instance)
  }
  return instance
}

/**
 * The better-auth context with `internalAdapter`, `adapter` and `password` helpers, for database work outside a
 * request's origin: that of the instance whose schema has every model (dataAuthOrigin).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function useAuthContext(): Promise<any> {
  return useAuth(dataAuthOrigin(useConfig())).$context
}

/**
 * Boot step 3 cleanup (docs/architecture.md §4.1): deletes `jwks` signing keys whose private key cannot be decrypted
 * with the current secret (after a SCANTOR_SECRET change), so the jwt plugin mints a new key. The instances share
 * the keys and the secret, so this runs once.
 */
export async function deleteUndecryptableJwks(log: Logger = useLogger('auth')): Promise<number> {
  if (!anyMcpOAuth(useConfig())) return 0
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

// ── OAuth clients of every origin ───────────────────────────────────────────

const CLIENT_PAGE_SIZE = 500

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000 || /E11000|duplicate key/i.test(String((error as Error | null)?.message))
}

/** Every row of a better-auth model, page by page (findMany returns 100 rows unless told otherwise). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function findAllRows<T>(adapter: any, model: string): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; ; offset += CLIENT_PAGE_SIZE) {
    const page = (await adapter.findMany({ model, limit: CLIENT_PAGE_SIZE, offset, sortBy: { field: 'id', direction: 'asc' } })) as T[]
    rows.push(...page)
    if (page.length < CLIENT_PAGE_SIZE) return rows
  }
}

/**
 * Boot step 3 (docs/auth.md §2.2): links every stored OAuth client to every origin's `/mcp` resource it lacks, as
 * `clientRegistrationDefaultResources` links a client at registration. better-auth issues a token only for a resource
 * the client is linked to, so a client registered before SCANTOR_TUNNEL_URL was set (or before the public or tunnel URL
 * changed) would otherwise get invalid_target through the new origin. Idempotent; a link another replica created
 * meanwhile (duplicate key) is skipped. Links of an origin no longer configured stay: nothing requests them. Returns
 * the number of links created.
 */
export async function linkOAuthClientsToMcpResources(log: Logger = useLogger('auth')): Promise<number> {
  const resources = mcpOAuthResources(useConfig())
  if (resources.length === 0) return 0
  const { adapter } = await useAuthContext()
  const clients = await findAllRows<{ clientId: string }>(adapter, 'oauthClient')
  if (clients.length === 0) return 0
  const linked = new Set(
    (await findAllRows<{ clientId: string; resourceId: string }>(adapter, 'oauthClientResource')).map((link) => `${link.clientId}\n${link.resourceId}`),
  )
  let created = 0
  for (const { clientId } of clients) {
    for (const resourceId of resources) {
      if (linked.has(`${clientId}\n${resourceId}`)) continue
      try {
        await adapter.create({ model: 'oauthClientResource', data: { clientId, resourceId, createdAt: new Date() } })
        created++
      } catch (error) {
        if (!isDuplicateKey(error)) throw error
      }
    }
  }
  if (created > 0) log.info('linked existing OAuth clients to the MCP resources of every origin', { links: created, resources })
  return created
}

// ── indexes of the better-auth collections ──────────────────────────────────

/** The subset of better-auth's table metadata (`$context.tables`) that describes indexes. */
export interface AuthTableMeta {
  modelName: string
  fields: Record<string, { fieldName?: string; unique?: boolean; index?: boolean; required?: boolean }>
  indexes?: { fields: readonly [string, ...string[]]; unique?: boolean }[]
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
      const [first, ...rest] = index.fields
      const columns: [string, ...string[]] = [column(first), ...rest.map(column)]
      const unique = index.unique === true
      const options = { name: getDatabaseIndexName(table.modelName, { fields: columns, unique }), ...(unique ? { unique: true } : {}) }
      specs.push({ key: Object.fromEntries(columns.map((name) => [name, 1 as const])), options })
    }
    if (specs.length > 0) result.push({ collection: table.modelName, specs })
  }
  return result
}

/**
 * The union of several instances' tables. Their plugin sets can differ (an http public URL without passkeys or MCP
 * OAuth next to an https tunnel URL), so each instance knows only some models; fields of a model are merged.
 */
export function mergeAuthTables(tableSets: Record<string, AuthTableMeta>[]): Record<string, AuthTableMeta> {
  const merged: Record<string, AuthTableMeta> = {}
  for (const tables of tableSets) {
    for (const [key, table] of Object.entries(tables)) {
      const known = merged[key]
      merged[key] = known ? { ...known, ...table, fields: { ...known.fields, ...table.fields } } : table
    }
  }
  return merged
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
 * Boot step 3: ensures the indexes of the better-auth collections of every configured origin's instance. A failure
 * (for example duplicate data under a unique index) is logged and does not stop the boot: the indexes speed up
 * lookups but correctness does not depend on them.
 */
export async function ensureAuthIndexes(log: Logger = useLogger('auth')): Promise<void> {
  const contexts = await Promise.all(configuredOrigins(useConfig()).map((origin) => useAuth(origin).$context))
  const tables = mergeAuthTables(contexts.map((ctx) => ctx.tables as Record<string, AuthTableMeta>))
  const { db } = useMongo()
  for (const { collection, specs } of authIndexesFrom(tables)) {
    try {
      await ensureNamedIndexes(db, collection, specs, log)
    } catch (error) {
      log.error('ensuring better-auth indexes failed', { collection, err: error })
    }
  }
}
