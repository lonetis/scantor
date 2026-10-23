import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, request, type APIRequestContext } from '@playwright/test'
import { ApiError, ok, type ApiClient, type ApiResponse } from './api-client'
import { docker } from './docker'
import { env } from './env'

// The browser editor from the API side (writer api-platform; docs/editor.md, docs/api.md §4.18): starting and stopping
// a user's editor through the dashboard API, redeeming one-time codes on the editor origin like a browser does,
// reading the editor's container (its API key lives in the container's environment) and raw WebSocket upgrades.
// Every editor belongs to a dedicated user of the test (`freshUser` or a created user), so its start, stop and
// cookies never touch another test.

export const EDITOR_CODE = /^sec_[A-Za-z0-9_-]{43}$/
export const EDITOR_KEY = /^sk_scantor_editor_[A-Za-z0-9_-]+$/
export const WORKSPACE_ROOT = '/home/coder/workspace'

export interface EditorStatus {
  state: 'starting' | 'running' | 'stopping' | 'stopped'
  startedAt: string | null
  lastActivityAt: string | null
  idleTimeoutMs: number
  error: string | null
}

export interface EditorSession {
  url: string
  expiresAt: string
  editor: { state: 'starting' | 'running'; startedAt: string | null; lastActivityAt: string | null }
}

export const editorContainerName = (userId: string) => `scantor-editor-${userId}`

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `createEditorSession`; while SCANTOR_EDITOR_MAX_RUNNING editors of other tests are running (429 tooManyRequests)
 * the request is repeated until `timeoutMs`. Returns the 201 response.
 */
export async function openEditorSession(api: ApiClient, body: Record<string, unknown> = {}, timeoutMs = 180_000): Promise<ApiResponse<EditorSession>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await api.call<EditorSession>('createEditorSession', { body })
    if (response.status !== 429 || Date.now() > deadline) {
      if (response.status !== 201) throw new ApiError('createEditorSession', response)
      return response
    }
    await sleep(3000 + Math.random() * 2000)
  }
}

export async function editorStatus(api: ApiClient): Promise<EditorStatus> {
  return ok(await api.call<EditorStatus>('getEditor'), 'getEditor')
}

/** Polls getEditor until the editor is in `state`; returns that status. */
export async function waitForEditor(api: ApiClient, state: EditorStatus['state'], timeoutMs = 120_000): Promise<EditorStatus> {
  let last: EditorStatus | null = null
  await expect
    .poll(
      async () => {
        last = await editorStatus(api)
        return last.state
      },
      { timeout: timeoutMs, intervals: [500, 1000, 2000], message: `the editor reaches ${state}` },
    )
    .toBe(state)
  return last!
}

/** Starts the caller's editor and waits until it runs; returns the session of that start. */
export async function startEditor(api: ApiClient, body: Record<string, unknown> = {}): Promise<EditorSession> {
  const session = ok(await openEditorSession(api, body), 'createEditorSession')
  const running = await waitForEditor(api, 'running')
  if (running.error !== null) throw new Error(`the editor runs with an error: ${running.error}`)
  return session
}

export async function stopEditor(api: ApiClient): Promise<void> {
  const response = await api.call('stopEditor')
  if (response.status !== 204) throw new ApiError('stopEditor', response)
}

export interface ContainerInspect {
  Id: string
  Name: string
  Config: { User: string; Env: string[]; Cmd: string[]; Labels: Record<string, string>; Image: string; Hostname: string }
  State: { Running: boolean; Status: string }
  HostConfig: {
    Init: boolean
    RestartPolicy: { Name: string }
    NetworkMode: string
    CapDrop: string[] | null
    CapAdd: string[] | null
    SecurityOpt: string[] | null
    ReadonlyRootfs: boolean
    PidsLimit: number
    Memory: number
    MemorySwap: number
    NanoCpus: number
    Tmpfs: Record<string, string> | null
    Binds: string[] | null
    Privileged: boolean
    PortBindings: Record<string, unknown> | null
    Mounts: { Type: string; Source: string; Target: string; VolumeOptions?: { Subpath?: string } }[] | null
  }
  Mounts: { Type: string; Name?: string; Source: string; Destination: string; RW: boolean }[]
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> }
}

/** `docker inspect` of the user's editor container, or null when it does not exist. */
export async function inspectEditor(userId: string): Promise<ContainerInspect | null> {
  const result = await docker(['inspect', editorContainerName(userId)], { allowFailure: true })
  if (result.exitCode !== 0) return null
  return (JSON.parse(result.stdout) as ContainerInspect[])[0]!
}

/** The environment of the user's editor container as a map. */
export async function editorEnv(userId: string): Promise<Record<string, string>> {
  const inspected = await inspectEditor(userId)
  if (!inspected) throw new Error(`the editor container of ${userId} does not exist`)
  return Object.fromEntries(inspected.Config.Env.map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]))
}

/** The `editor` API key of the user's running editor (its container's SCANTOR_TOKEN). */
export async function editorKey(userId: string): Promise<string> {
  const key = (await editorEnv(userId)).SCANTOR_TOKEN
  if (!key) throw new Error(`the editor container of ${userId} has no SCANTOR_TOKEN`)
  return key
}

/** `docker exec` in the user's editor container as the editor user (1000:1000). */
export async function execInEditor(userId: string, command: string[], options: { workdir?: string; timeoutMs?: number } = {}) {
  const args = ['exec', '-u', '1000:1000', ...(options.workdir ? ['-w', options.workdir] : []), editorContainerName(userId), ...command]
  return docker(args, { allowFailure: true, timeoutMs: options.timeoutMs ?? 120_000 })
}

// ── the editor origin ───────────────────────────────────────────────────────

/** A request context on the editor origin with no stored state and no default headers (like a fresh browser tab). */
export function editorOrigin(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: env.editorUrl, extraHTTPHeaders: {} })
}

export interface OriginResponse {
  status: number
  headers: Record<string, string>
  /** every Set-Cookie line */
  setCookies: string[]
  /** every value of a header, by lowercase name (repeated headers, for example two Content-Security-Policy lines) */
  values(name: string): string[]
  body: string
}

export async function originGet(context: APIRequestContext, path: string, headers: Record<string, string> = {}): Promise<OriginResponse> {
  const response = await context.get(path, { headers, maxRedirects: 0 })
  const all = await response.headersArray()
  const values = (name: string) => all.filter((header) => header.name.toLowerCase() === name.toLowerCase()).map((header) => header.value)
  return {
    status: response.status(),
    headers: response.headers(),
    setCookies: values('set-cookie'),
    values,
    body: (await response.body()).toString('utf8'),
  }
}

/**
 * Redeems a one-time URL (`<editor url>/_auth?code=…`) like a fresh browser tab and returns the answer with the cookie
 * value, if any. The redeem uses a context of its own, so no cookie jar keeps the cookie: every later request names
 * its cookie explicitly (`editorCookieHeader`) or carries none.
 */
export async function redeem(url: string): Promise<OriginResponse & { cookie: string | null }> {
  const target = new URL(url)
  expect(target.origin).toBe(env.editorUrl)
  const context = await editorOrigin()
  try {
    const answer = await originGet(context, `${target.pathname}${target.search}`)
    const line = answer.setCookies.find((cookie) => cookie.startsWith('scantor_editor='))
    return { ...answer, cookie: line ? line.slice('scantor_editor='.length, line.indexOf(';')) : null }
  } finally {
    await context.dispose()
  }
}

/** `Cookie` header with the editor cookie. */
export const editorCookieHeader = (value: string) => ({ Cookie: `scantor_editor=${value}` })

/** Starts the caller's editor, waits until it runs and returns a cookie redeemed from a fresh code. */
export async function signedInEditor(api: ApiClient, body: Record<string, unknown> = {}): Promise<{ cookie: string; session: EditorSession }> {
  await startEditor(api, body)
  const session = ok(await openEditorSession(api, body), 'createEditorSession')
  const redeemed = await redeem(session.url)
  expect(redeemed.status, redeemed.body).toBe(302)
  return { cookie: redeemed.cookie!, session }
}

// ── raw requests ────────────────────────────────────────────────────────────

export interface RawAnswer {
  status: number | null
  headers: Record<string, string | string[] | undefined>
  /** a connection that ended without a status line */
  error: string | null
}

/**
 * A WebSocket upgrade request, sent raw, to `url` (https through Traefik, or http to a listener port). Resolves with
 * the status line's code (101 when the upgrade was accepted) or with the connection error.
 */
export function upgradeRequest(url: string, headers: Record<string, string>, timeoutMs = 15_000): Promise<RawAnswer> {
  const target = new URL(url)
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve) => {
    const req = send({
      host: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...headers,
      },
      ...(target.protocol === 'https:' ? { ca: readFileSync(env.caCertFile), servername: target.hostname } : {}),
      timeout: timeoutMs,
    })
    req.on('upgrade', (response, socket) => {
      socket.destroy()
      resolve({ status: response.statusCode ?? null, headers: response.headers, error: null })
    })
    req.on('response', (response) => {
      response.resume()
      resolve({ status: response.statusCode ?? null, headers: response.headers, error: null })
      req.destroy()
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (error) => resolve({ status: null, headers: {}, error: error.message }))
    req.end()
  })
}

/** A plain HTTP GET with an explicit Host header to a listener port on the runner's loopback. */
export function hostRequest(
  port: number,
  path: string,
  host: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host, ...headers }, timeout: 15_000 }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
      response.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}
