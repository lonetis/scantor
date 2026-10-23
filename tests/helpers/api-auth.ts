import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { expect, request as playwrightRequest, type APIRequestContext, type APIResponse, type Page } from '@playwright/test'
import type { CreatedApiKey } from '#shared/types/account'
import type { Tenant, test as fixturesTest } from '../fixtures'
import { ApiClient, ApiError, ok } from './api-client'
import { docker, innerDocker, stackEnv } from './docker'
import { env } from './env'
import { reserve } from './limiter'
import type { OpenApiIndex, OpenApiOperation } from './openapi'
import { unique } from './unique'
import { createUser, deleteUser } from './users'

// Helpers of the api-auth specs (api/errors, health, info, account, api-keys, users, smoke; security/auth-endpoints,
// csrf, banned): the specs' worker tenants, raw HTTP for what the Playwright request API cannot express (a Host header
// for the dashboard listener, chunked bodies without Content-Length), white-box changes of the test's own better-auth
// documents through the root mongosh, and the principals of one user (session, editor key, tools cookie, passkey).

// ── stack configuration ─────────────────────────────────────────────────────────────────────────────

/** Parses a byte size of the configuration: an integer with an optional KiB, MiB, GiB or TiB suffix. */
export function parseByteSize(value: string): number {
  const match = /^(\d{1,15})(KiB|MiB|GiB|TiB)?$/.exec(value.trim())
  if (!match) throw new Error(`not a byte size: ${JSON.stringify(value)}`)
  const unit = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 }[match[2] ?? ''] ?? 1
  return Number(match[1]) * unit
}

/** A variable of the stack's generated .env; throws when it is missing. */
export function stackValue(name: string): string {
  const value = stackEnv()[name]
  if (value === undefined) throw new Error(`${name} is not set in the test stack's .env`)
  return value
}

/** The orchestrator's dashboard listener as published on the runner (bypassing Traefik). */
export function dashboardListenerUrl(): string {
  return `http://${stackValue('SCANTOR_BIND_ADDRESS')}:${stackValue('SCANTOR_PORT')}`
}

// ── raw HTTP ────────────────────────────────────────────────────────────────────────────────────────

export interface RawResponse {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
  text(): string
  json<T = unknown>(): T
}

export interface RawRequestOptions {
  method?: string
  headers?: Record<string, string>
  /** the body; sent with Transfer-Encoding: chunked (no Content-Length) when `chunked` is true */
  body?: Buffer | string
  chunked?: boolean
}

/**
 * One HTTP/1.1 request through node:http(s) with exactly the given headers (also `Host`). https trusts the test CA
 * through NODE_EXTRA_CA_CERTS.
 */
export function rawRequest(url: string, options: RawRequestOptions = {}): Promise<RawResponse> {
  const target = new URL(url)
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest
  const body = options.body === undefined ? undefined : Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body, 'utf8')
  const headers: Record<string, string> = { ...options.headers }
  if (body && !options.chunked) headers['Content-Length'] = String(body.length)
  if (body && options.chunked) headers['Transfer-Encoding'] = 'chunked'
  return new Promise((resolve, reject) => {
    const req = send(target, { method: options.method ?? 'GET', headers, timeout: 60_000 }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => {
        const raw = Buffer.concat(chunks)
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: raw,
          text: () => raw.toString('utf8'),
          json: <T>() => JSON.parse(raw.toString('utf8')) as T,
        })
      })
    })
    req.on('timeout', () => req.destroy(new Error(`${options.method ?? 'GET'} ${url} timed out`)))
    req.on('error', (error) => {
      // A server may answer (413) and close before the whole body is written; the response still arrives.
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE' && (error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error)
    })
    if (body && options.chunked) {
      const piece = 64 * 1024
      for (let offset = 0; offset < body.length; offset += piece) req.write(body.subarray(offset, offset + piece))
      req.end()
    } else {
      req.end(body)
    }
  })
}

/**
 * Request timeout of the contexts this file creates. Playwright's default of 30 s is shorter than a long poll
 * (`?wait=50` in waitForScanState, up to `wait=120`), so such a request would time out before the server answers.
 */
export const LONG_POLL_TIMEOUT_MS = 150_000

/** A request context on the public origin (Origin header) whose timeout allows long polls. */
export function longPollContext(options: { storageState?: string; headers?: Record<string, string> } = {}): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: env.publicUrl,
    extraHTTPHeaders: { Origin: env.publicUrl, ...options.headers },
    storageState: options.storageState,
    timeout: LONG_POLL_TIMEOUT_MS,
  })
}

/** A request context on the public origin without the default Origin header (CSRF and CORS cases). */
export function contextWithoutOrigin(options: { storageState?: string; headers?: Record<string, string> } = {}): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL: env.publicUrl, storageState: options.storageState, extraHTTPHeaders: options.headers })
}

/** The session cookie value of a storage state file (the `__Secure-scantor.session_token` of the public host). */
export function sessionCookieOf(storageState: string): { name: string; value: string } {
  const state = JSON.parse(readFileSync(storageState, 'utf8')) as { cookies: { name: string; value: string }[] }
  const cookie = state.cookies.find((c) => c.name.endsWith('scantor.session_token'))
  if (!cookie) throw new Error(`no session cookie in ${storageState}`)
  return { name: cookie.name, value: cookie.value }
}

// ── cookies ─────────────────────────────────────────────────────────────────────────────────────────

export interface SetCookie {
  name: string
  value: string
  /** attribute names lowercased; flag attributes map to '' */
  attributes: Record<string, string>
}

export function parseSetCookie(header: string): SetCookie {
  const [pair = '', ...rest] = header.split(';')
  const eq = pair.indexOf('=')
  const attributes: Record<string, string> = {}
  for (const part of rest) {
    const [key = '', ...value] = part.trim().split('=')
    if (key) attributes[key.toLowerCase()] = value.join('=')
  }
  return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), attributes }
}

/** Every Set-Cookie header of a Playwright response, parsed. */
export function setCookiesOf(response: APIResponse): SetCookie[] {
  return response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .flatMap((header) => header.value.split('\n'))
    .map(parseSetCookie)
}

/** Set-Cookie headers of an ApiClient response (Playwright joins repeated headers with a newline). */
export function setCookiesOfHeaders(headers: Record<string, string>): SetCookie[] {
  return (headers['set-cookie'] ?? '').split('\n').filter(Boolean).map(parseSetCookie)
}

// ── sign-in ─────────────────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `POST /api/auth/sign-in/email` with extra headers, through the shared limiter. Several `just test-exec` runs share
 * the stack's per-IP budget, so a 429 can still happen; it is waited out (X-Retry-After) and the sign-in retried with
 * a new limiter slot until `timeoutMs`. Any other answer, including a 401 for a wrong password, is returned as is.
 */
export async function signInWithHeaders(
  context: APIRequestContext,
  email: string,
  password: string,
  headers: Record<string, string> = {},
  options: { timeoutMs?: number } = {},
): Promise<APIResponse> {
  const deadline = Date.now() + (options.timeoutMs ?? 90_000)
  for (;;) {
    await reserve('/sign-in/email')
    const response = await context.post('/api/auth/sign-in/email', { data: { email, password }, headers })
    if (response.status() !== 429 || Date.now() > deadline) return response
    const retryAfter = Number(response.headers()['x-retry-after'] ?? '60')
    await sleep((Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 1), 61) : 60) * 1000 + Math.random() * 2000)
  }
}

/** A user created by the admin for one test, with its password. */
export interface CreatedUser {
  id: string
  email: string
  name: string
  password: string
  role: 'admin' | 'user'
}

/** A created user with its own signed-in session. */
export interface SessionUser extends CreatedUser {
  /** the session as an ApiClient (Origin header set) */
  api: ApiClient
  /** the session cookie, for pages and raw requests */
  cookie: { name: string; value: string }
}

/**
 * Users a spec creates for single tests (account-level changes, bans, purges, sign-ins), deleted by `cleanup()` from
 * an afterEach hook. Sessions are signed in through {@link signInWithHeaders}, so they wait out per-IP 429s.
 */
export class TestUsers {
  private readonly users: string[] = []
  private readonly contexts: APIRequestContext[] = []

  /** Creates a user as the admin (no sign-in). */
  async create(adminApi: ApiClient, options: { prefix?: string; role?: 'admin' | 'user'; password?: boolean; email?: string } = {}): Promise<CreatedUser> {
    const name = unique(options.prefix ?? 'user')
    const email = options.email ?? `${name}@scantor.test`
    const password = randomBytes(18).toString('base64url')
    const created = await adminApi.createUser({ email, name, ...(options.password === false ? {} : { password }), role: options.role ?? 'user' })
    const user = ok(created, 'createUser')
    this.users.push(user.id)
    return { id: user.id, email: user.email, name: user.name, password, role: user.role }
  }

  /** A context on the public origin (Origin header, long-poll timeout) that the cleanup disposes. */
  async context(headers: Record<string, string> = {}): Promise<APIRequestContext> {
    const context = await longPollContext({ headers })
    this.contexts.push(context)
    return context
  }

  /** Signs a user in on a new context; fails unless the sign-in answers 200. */
  async signIn(user: CreatedUser, openapi: OpenApiIndex): Promise<SessionUser> {
    const context = await this.context()
    const response = await signInWithHeaders(context, user.email, user.password)
    expect(response.status(), `sign-in of ${user.email}: ${await response.text()}`).toBe(200)
    const state = await context.storageState()
    const cookie = state.cookies.find((c) => c.name.endsWith('scantor.session_token'))
    if (!cookie) throw new Error(`the sign-in of ${user.email} set no session cookie`)
    return { ...user, api: new ApiClient(context, openapi), cookie: { name: cookie.name, value: cookie.value } }
  }

  /** Creates and signs in a user (one limiter slot). */
  async signedIn(adminApi: ApiClient, openapi: OpenApiIndex, options: { prefix?: string; role?: 'admin' | 'user' } = {}): Promise<SessionUser> {
    return this.signIn(await this.create(adminApi, options), openapi)
  }

  /** Registers a user created another way for deletion. */
  track(userId: string): void {
    this.users.push(userId)
  }

  /** Disposes the contexts and deletes every user (a user that is already gone counts as deleted). */
  async cleanup(adminApi: ApiClient): Promise<void> {
    for (const context of this.contexts.splice(0)) await context.dispose()
    for (const userId of this.users.splice(0)) await deleteUser(adminApi, userId)
  }
}

// ── worker tenants ──────────────────────────────────────────────────────────────────────────────────

type FixturesTest = typeof fixturesTest

/**
 * Creates a tenant like the shared fixtures do (admin-created user, one session, a `default` key), but saves the
 * session under a unique file name and signs in through {@link signInWithHeaders}. Two things only show while several
 * `just test-exec` runs share the kept-alive stack: the shared tenants' `.auth/user-<workerIndex>.json` is overwritten
 * by another run's worker with the same index (a test would then act as that run's tenant, which its teardown
 * deletes), and the limiter's rolling budget can still meet better-auth's per-IP 429.
 */
export async function createAuthTenant(adminApi: ApiClient, openapi: OpenApiIndex, prefix: string): Promise<Tenant> {
  const user = await createUser(adminApi, { prefix })
  try {
    const context = await longPollContext()
    try {
      const response = await signInWithHeaders(context, user.email, user.password)
      if (response.status() !== 200) throw new Error(`sign-in of ${user.email} answered ${response.status()}: ${await response.text()}`)
      await mkdir(env.paths.auth, { recursive: true })
      const storageState = join(env.paths.auth, `api-auth-${unique(prefix)}.json`)
      await context.storageState({ path: storageState })
      const key = ok(await new ApiClient(context, openapi).createApiKey('tests'), 'createApiKey')
      return { ...user, storageState, apiKey: key.key }
    } finally {
      await context.dispose()
    }
  } catch (error) {
    await deleteUser(adminApi, user.id)
    throw error
  }
}

/** Deletes a tenant of {@link createAuthTenant} (a 404 counts as deleted) and its storage state file. */
export async function deleteAuthTenant(adminApi: ApiClient, tenant: Tenant): Promise<void> {
  try {
    await deleteUser(adminApi, tenant.id)
  } finally {
    await rm(tenant.storageState, { force: true })
  }
}

/**
 * The fixtures' `test` with this writer's worker tenants in place of `user` and `otherUser` (see
 * {@link createAuthTenant}); `api`, `apiKeyApi`, `otherApi` and `page` follow them. `adminApi` gets the long-poll
 * timeout, so `waitForScanState` and `getJob(…, wait)` work through it. The `extend` call lives here, so the spec
 * files share one worker-fixture set and Playwright reuses workers (and their tenants) across them.
 */
export function withAuthTenants(base: FixturesTest) {
  return base.extend({
    adminApi: [
      async ({ openapi }, use) => {
        const context = await longPollContext({ storageState: env.paths.adminState })
        try {
          await use(new ApiClient(context, openapi))
        } finally {
          await context.dispose()
        }
      },
      { scope: 'worker' },
    ],
    user: [
      async ({ adminApi, openapi }, use, workerInfo) => {
        const tenant = await createAuthTenant(adminApi, openapi, `w${workerInfo.workerIndex}`)
        try {
          await use(tenant)
        } finally {
          await deleteAuthTenant(adminApi, tenant)
        }
      },
      { scope: 'worker', timeout: 120_000 },
    ],
    otherUser: [
      async ({ adminApi, openapi }, use, workerInfo) => {
        const tenant = await createAuthTenant(adminApi, openapi, `w${workerInfo.workerIndex}-other`)
        try {
          await use(tenant)
        } finally {
          await deleteAuthTenant(adminApi, tenant)
        }
      },
      { scope: 'worker', timeout: 120_000 },
    ],
  })
}

// ── white-box changes of the test's own documents (root mongosh) ───────────────────────────────────

const js = (value: unknown) => JSON.stringify(value)

/** Runs a script as the MongoDB root user and returns its printed output. Only for documents the test owns. */
export function mongoRoot(script: string): Promise<string> {
  return innerDocker.mongosh(script, { as: 'root' })
}

/** Exact count of documents in a collection (root user: the better-auth collections are not readable otherwise). */
export async function rootCount(collection: string, filter: Record<string, unknown>): Promise<number> {
  return Number(await mongoRoot(`print(db.getCollection(${js(collection)}).countDocuments(${js(filter)}))`))
}

/** Lets an API key expire one hour ago. */
export async function expireApiKey(keyId: string): Promise<void> {
  const out = await mongoRoot(`print(db.apikey.updateOne({_id: ${js(keyId)}}, {$set: {expiresAt: new Date(Date.now() - 3600000)}}).matchedCount)`)
  expect(out, `API key ${keyId} exists`).toBe('1')
}

/** Sets a field of an API key document to a raw string value (to corrupt it) or back to the current time. */
export async function setApiKeyCreatedAt(keyId: string, value: 'corrupt' | 'now'): Promise<void> {
  const expression = value === 'now' ? 'new Date()' : js('not-a-date')
  const out = await mongoRoot(`print(db.apikey.updateOne({_id: ${js(keyId)}}, {$set: {createdAt: ${expression}}}).matchedCount)`)
  expect(out, `API key ${keyId} exists`).toBe('1')
}

/** Sets only the `banned` flag of a user, without the revocations of banUser (the middleware's own ban check). */
export async function setBannedFlag(userId: string, banned: boolean): Promise<void> {
  const out = await mongoRoot(`print(db.user.updateOne({_id: ${js(userId)}}, {$set: {banned: ${banned}}}).matchedCount)`)
  expect(out, `user ${userId} exists`).toBe('1')
}

/**
 * Inserts a queued `userPurge` job for a user (the shape `createJob` writes) whose `notBefore` lies an hour ahead, so
 * no runner claims it until {@link releaseJob}. While it exists the user counts as "being deleted", and `deleteUser`
 * returns this job instead of creating another one (one active job per kind and subject).
 */
export async function insertDelayedUserPurge(userId: string): Promise<string> {
  const id = randomUUID()
  const job = `{_id: ${js(id)}, kind: 'userPurge', userId: ${js(userId)}, subject: {kind: 'user', id: ${js(userId)}}, state: 'queued', active: true,
    params: {}, cursor: {}, progress: {done: 0, total: null}, attempts: 0, maxAttempts: 5, lease: null,
    notBefore: new Date(Date.now() + 3600000), error: null, createdAt: new Date(), startedAt: null, finishedAt: null, updatedAt: new Date()}`
  expect(await mongoRoot(`print(db.jobs.insertOne(${job}).acknowledged)`), `userPurge job for ${userId}`).toBe('true')
  return id
}

/** Lets the runner claim a job inserted by {@link insertDelayedUserPurge} right away. */
export async function releaseJob(jobId: string): Promise<void> {
  const out = await mongoRoot(
    `print(db.jobs.updateOne({_id: ${js(jobId)}, state: 'queued'}, {$set: {notBefore: new Date(), updatedAt: new Date()}}).matchedCount)`,
  )
  expect(out, `queued job ${jobId}`).toBe('1')
}

/** Removes a job inserted by {@link insertDelayedUserPurge} that no runner has claimed. */
export async function removeQueuedJob(jobId: string): Promise<void> {
  await mongoRoot(`print(db.jobs.deleteOne({_id: ${js(jobId)}, state: 'queued'}).deletedCount)`)
}

/** Moves the creation time of every session of a user `hours` into the past. */
export async function ageSessions(userId: string, hours: number): Promise<void> {
  const out = await mongoRoot(
    `print(db.session.updateMany({userId: ${js(userId)}}, {$set: {createdAt: new Date(Date.now() - ${hours} * 3600000)}}).matchedCount)`,
  )
  expect(Number(out), `sessions of ${userId}`).toBeGreaterThan(0)
}

// ── keys and principals ─────────────────────────────────────────────────────────────────────────────

export const API_KEY_PATTERN = /^sk_scantor_[A-Za-z]{64}$/
export const EDITOR_KEY_PATTERN = /^sk_scantor_editor_[A-Za-z]{64}$/
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A well-formed `default` key that was never issued. */
export function unknownApiKey(): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  return `sk_scantor_${Array.from(randomBytes(64), (byte) => letters[byte % letters.length]).join('')}`
}

/** A syntactically valid, unsigned-looking JWT (`eyJ…`), shaped like an MCP OAuth access token. */
export function jwtLikeToken(): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${segment({ alg: 'EdDSA', typ: 'JWT' })}.${segment({ sub: randomUUID(), aud: env.mcpUrl, scope: 'scantor:read' })}.${randomBytes(32).toString('base64url')}`
}

/** Creates a `default` key with a session client; returns the created key. */
export async function createKey(session: ApiClient, name: string, expiresInDays?: number): Promise<CreatedApiKey> {
  return ok(await session.createApiKey(name, expiresInDays), 'createApiKey')
}

/** Deletes one of the caller's keys; a key that is already gone (404) counts as deleted. */
export async function deleteKey(client: ApiClient, keyId: string): Promise<void> {
  const response = await client.call('deleteApiKey', { path: { keyId } })
  if (response.status !== 204 && response.status !== 404) throw new ApiError('deleteApiKey', response)
}

/** Promotes a test user to admin (only users the test created). */
export async function setRole(adminApi: ApiClient, userId: string, role: 'admin' | 'user'): Promise<void> {
  ok(await adminApi.call('updateUser', { path: { userId }, body: { role } }), 'updateUser')
}

export function editorContainerName(userId: string): string {
  return `scantor-editor-${userId}`
}

/**
 * Starts the caller's editor (createEditorSession) and returns its `editor` API key, read from the container's
 * environment (SCANTOR_TOKEN) as soon as the container exists.
 */
export async function startEditorKey(session: ApiClient, userId: string, timeoutMs = 90_000): Promise<string> {
  const started = await session.call('createEditorSession', { body: {} })
  expect(started.status, JSON.stringify(started.body)).toBe(201)
  let key: string | undefined
  await expect
    .poll(
      async () => {
        const inspected = await docker(['inspect', '--format', '{{json .Config.Env}}', editorContainerName(userId)], { allowFailure: true })
        if (inspected.exitCode !== 0) return 'no container yet'
        const variables = JSON.parse(inspected.stdout) as string[]
        key = variables.find((v) => v.startsWith('SCANTOR_TOKEN='))?.slice('SCANTOR_TOKEN='.length)
        return key ? 'key' : 'container without SCANTOR_TOKEN'
      },
      { message: `the editor container of ${userId} carries its editor key`, timeout: timeoutMs, intervals: [500, 1000, 2000] },
    )
    .toBe('key')
  expect(key).toMatch(EDITOR_KEY_PATTERN)
  return key!
}

/** True while the user's editor container exists. */
export async function editorContainerExists(userId: string): Promise<boolean> {
  return (await docker(['inspect', editorContainerName(userId)], { allowFailure: true })).exitCode === 0
}

/** Stops the caller's editor (204 also when it is already stopped). */
export async function stopEditor(session: ApiClient): Promise<void> {
  const response = await session.call('stopEditor')
  if (response.status !== 204) throw new ApiError('stopEditor', response)
}

/** The `scantor_tools` cookie minted by createToolsSession for an admin session. */
export async function mintToolsCookie(adminSession: ApiClient, target = 'traefik'): Promise<SetCookie> {
  const response = await adminSession.call('createToolsSession', { query: { target } })
  expect(response.status, response.raw.toString('utf8')).toBe(302)
  const cookie = setCookiesOfHeaders(response.headers).find((c) => c.name === 'scantor_tools')
  if (!cookie) throw new Error(`createToolsSession set no scantor_tools cookie: ${JSON.stringify(response.headers)}`)
  return cookie
}

/** Status of an API request to an admin tool host through Traefik's forwardAuth with the given tools cookie. */
export async function toolHostStatus(cookie: string | null, target = 'traefik'): Promise<number> {
  const response = await rawRequest(`https://${target}.${env.domain}/api/version`, {
    headers: { Accept: 'application/json', ...(cookie ? { Cookie: `scantor_tools=${cookie}` } : {}) },
  })
  return response.status
}

/**
 * Registers a passkey for the user signed in on `page` (a virtual authenticator must be installed): the passkey
 * plugin's register options, `navigator.credentials.create`, then verify-registration, all from the public origin.
 */
export async function registerPasskey(page: Page, name: string): Promise<void> {
  await page.goto('/api/health')
  const result = await page.evaluate(async (passkeyName) => {
    const optionsResponse = await fetch('/api/auth/passkey/generate-register-options', { credentials: 'include' })
    if (!optionsResponse.ok) return { step: 'options', status: optionsResponse.status, body: await optionsResponse.text() }
    const options = (await optionsResponse.json()) as PublicKeyCredentialCreationOptionsJSON
    const credential = (await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) })) as PublicKeyCredential
    const verify = await fetch('/api/auth/passkey/verify-registration', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: credential.toJSON(), name: passkeyName }),
    })
    return { step: 'verify', status: verify.status, body: await verify.text() }
  }, name)
  expect(result, JSON.stringify(result)).toMatchObject({ step: 'verify', status: 200 })
}

// ── operations ──────────────────────────────────────────────────────────────────────────────────────

/** Every operation of the OpenAPI document with one of the scopes. */
export function operationsWithScope(openapi: OpenApiIndex, scopes: readonly string[]): OpenApiOperation[] {
  return [...openapi.operations.values()].filter((op) => scopes.includes(String(op.extensions['x-scantor-scope'])))
}

/** The names of the path parameters of a path template. */
export function pathParams(template: string): string[] {
  return [...template.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!)
}

/** Expands a path template; values are URL-encoded. */
export function expandTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => encodeURIComponent(values[name] ?? randomUUID()))
}
