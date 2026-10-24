import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import type { Worker } from '#shared/types/workers'
import type { WorkerRole } from '#shared/utils/enums'
import { ok, type ApiClient, type ApiResponse } from './api-client'
import { CONTAINERS, docker, DockerError } from './docker'
import { unique } from './unique'

// Shared helpers of the security specs (tests/security/*.spec.ts, docs/testing.md §8.6): error envelopes, polling,
// white-box access to test-owned Docker objects and a minimal OAuth 2.1 client for throwaway orchestrators.

export interface ErrorEnvelope {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

/** The `error.code` of an API error envelope (undefined for other bodies). */
export function errorCode(response: ApiResponse): string | undefined {
  return (response.body as Partial<ErrorEnvelope>).error?.code
}

/** The `error.details` of an API error envelope. */
export function errorDetails(response: ApiResponse): Record<string, unknown> {
  return (response.body as Partial<ErrorEnvelope>).error?.details ?? {}
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls `check` until it returns a value other than undefined; throws `describe()` after the timeout. */
export async function pollFor<T>(
  check: () => Promise<T | undefined>,
  timeoutMs: number,
  describe: () => string | Promise<string>,
  intervalMs = 1000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(await describe())
    await sleep(intervalMs)
  }
}

/** Runs `fn` over the items with at most `limit` running at once; keeps the order of the results. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index]!, index)
    }
  })
  await Promise.all(workers)
  return results
}

export const sha256Hex = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

/** The image the stack runs a container with (exactly the images under test). */
export async function containerImage(container: string): Promise<string> {
  return (await docker(['inspect', '--format', '{{.Config.Image}}', container])).stdout.trim()
}

/**
 * Runs a short-lived shell command in a test-owned container of the scantor image (`--rm`, label `scantor.test=true`,
 * no network), for white-box reads and writes of test-owned volumes. Returns the exec result; throws on failure.
 */
export async function runScantorShell(script: string, options: { mounts?: string[]; user?: string; allowFailure?: boolean } = {}) {
  const image = await containerImage(CONTAINERS.node)
  const args = ['run', '--rm', '--name', unique('scantor-test-sh'), '--label', 'scantor.test=true', '--network', 'none']
  if (options.user) args.push('--user', options.user)
  for (const mount of options.mounts ?? []) args.push('--mount', mount)
  args.push('--entrypoint', 'sh', image, '-c', script)
  const result = await docker(args, { allowFailure: true })
  if (result.exitCode !== 0 && !options.allowFailure) throw new DockerError(['run', '…', 'sh', '-c', script], result)
  return result
}

/** The workspace folder of one task, mounted read-write (white-box: the user's own task in `scantor-workspaces`). */
export function taskFolderMount(userId: string, task: string): string {
  return `type=volume,src=scantor-workspaces,dst=/task,volume-subpath=${userId}/${task}`
}

/** The whole workspace directory of one user, mounted read-only. */
export function userWorkspaceMount(userId: string): string {
  return `type=volume,src=scantor-workspaces,dst=/workspace,volume-subpath=${userId},readonly`
}

/** The sorted paths below a user's workspace directory (without `.scantor-staging`), for "nothing written outside" checks. */
export async function listUserWorkspace(userId: string): Promise<string[]> {
  const { stdout } = await runScantorShell('cd /workspace && find . -mindepth 1 -path ./.scantor-staging -prune -o -print | sort', {
    mounts: [userWorkspaceMount(userId)],
  })
  return stdout.split('\n').filter(Boolean)
}

// ── OAuth 2.1 against a throwaway orchestrator ───────────────────────────────────────────────────────

export const OAUTH_REDIRECT_URI = 'http://127.0.0.1:53682/callback'

export interface OAuthGrant {
  clientId: string
  accessToken: string
}

/**
 * The full MCP OAuth flow of docs/mcp.md §3 against an orchestrator reached through `session` (signed in, sending the
 * orchestrator's public origin as Origin): dynamic client registration, authorize with PKCE (S256), the consent
 * decision, the code exchange. `publicUrl` is the orchestrator's SCANTOR_PUBLIC_URL (issuer and resource).
 */
export async function oauthAuthorize(session: APIRequestContext, publicUrl: string, scope = 'offline_access scantor:read scantor:write'): Promise<OAuthGrant> {
  const registered = await session.post('/api/auth/oauth2/register', {
    data: {
      client_name: 'scantor security tests',
      redirect_uris: [OAUTH_REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope,
    },
  })
  if (registered.status() !== 200 && registered.status() !== 201)
    throw new Error(`client registration answered ${registered.status()}: ${await registered.text()}`)
  const clientId = ((await registered.json()) as { client_id: string }).client_id

  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const resource = `${publicUrl}/mcp`
  const authorize = await session.get('/api/auth/oauth2/authorize', {
    params: {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: OAUTH_REDIRECT_URI,
      scope,
      state: randomBytes(8).toString('hex'),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource,
    },
    maxRedirects: 0,
  })
  const location = authorize.headers()['location']
  if (!location) throw new Error(`authorize answered ${authorize.status()} without a redirect: ${await authorize.text()}`)
  let callback = new URL(location, publicUrl)
  if (callback.pathname === '/oauth/consent') {
    const consent = await session.post('/api/auth/oauth2/consent', {
      headers: { Accept: 'application/json' },
      data: { accept: true, oauth_query: callback.search.slice(1), scope },
    })
    if (!consent.ok()) throw new Error(`consent answered ${consent.status()}: ${await consent.text()}`)
    callback = new URL(((await consent.json()) as { url: string }).url)
  }
  const code = callback.searchParams.get('code')
  if (!code) throw new Error(`the authorization returned no code: ${callback.toString()}`)

  const token = await session.post('/api/auth/oauth2/token', {
    form: { grant_type: 'authorization_code', code, redirect_uri: OAUTH_REDIRECT_URI, client_id: clientId, code_verifier: verifier, resource },
  })
  if (!token.ok()) throw new Error(`the token exchange answered ${token.status()}: ${await token.text()}`)
  return { clientId, accessToken: ((await token.json()) as { access_token: string }).access_token }
}

/** One JSON-RPC request to a Streamable HTTP MCP endpoint (`initialize` or `tools/list`); returns status and body. */
export async function mcpRequest(context: APIRequestContext, url: string, bearer: string, method: string, params: Record<string, unknown> = {}) {
  const response = await context.post(url, {
    headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
    data: { jsonrpc: '2.0', id: 1, method, params },
  })
  return { status: response.status(), text: await response.text(), headers: response.headers() }
}

// ── scans and workers ─────────────────────────────────────────────────────────────────────────────────

/**
 * Waits until the scan has a worker of `role` in state `running` with a container (the runtime bootstrapped), and
 * returns it. Throws with the scan's workers when none gets there in time.
 */
export async function waitForRunningWorker(api: ApiClient, scanId: string, role: WorkerRole, timeoutMs = 150_000): Promise<Worker> {
  let last: Worker[] = []
  return pollFor(
    async () => {
      last = ok(await api.listScanWorkers(scanId, { limit: 50 }), 'listScanWorkers').items
      return last.find((worker) => worker.role === role && worker.state === 'running' && worker.container !== null && worker.runtime?.bootstrappedAt)
    },
    timeoutMs,
    () =>
      `no running ${role} of scan ${scanId} within ${timeoutMs / 1000} s: ${JSON.stringify(last.map((w) => ({ id: w.id, role: w.role, state: w.state, stateReason: w.stateReason, node: w.node })))}`,
    1000,
  )
}

/** `docker inspect` of a worker container on the built-in node (inner Docker) or on the remote node (its DinD). */
export async function inspectWorker(workerId: string, where: 'builtin' | 'remote'): Promise<WorkerInspect> {
  const args = ['inspect', `scantor-w-${workerId}`]
  const result = where === 'builtin' ? await docker(args) : await docker(['exec', CONTAINERS.remoteNode, 'docker', ...args])
  return (JSON.parse(result.stdout) as WorkerInspect[])[0]!
}

export interface WorkerInspect {
  Name: string
  Config: { Image: string; Entrypoint: string[] | null; Cmd: string[] | null; Env: string[]; Labels: Record<string, string> }
  HostConfig: {
    Init: boolean | null
    RestartPolicy: { Name: string }
    NetworkMode: string
    CapDrop: string[] | null
    CapAdd: string[] | null
    SecurityOpt: string[] | null
    Privileged: boolean
    ReadonlyRootfs: boolean
    PidsLimit: number | null
    Memory: number
    MemorySwap: number
    NanoCpus: number
    ShmSize: number
    Ulimits: { Name: string; Soft: number; Hard: number }[] | null
    LogConfig: { Type: string; Config: Record<string, string> }
    Binds: string[] | null
    Mounts?: unknown[] | null
    PortBindings: Record<string, unknown> | null
    PublishAllPorts: boolean
    Tmpfs?: Record<string, string> | null
  }
  Mounts: unknown[]
  NetworkSettings: { Networks: Record<string, unknown>; Ports: Record<string, unknown> | null }
  State: { Running: boolean }
}

// ── S3 presigning (white-box) ───────────────────────────────────────────────────────────────────────────

/**
 * A SigV4 query-presigned GET for an object of the stack's bucket on its public endpoint, signed with the stack's S3
 * credentials (region us-east-1, as the orchestrator signs). `signedAt` back-dates the signature, so an already expired
 * URL can be made without waiting.
 */
export function presignS3Get(options: {
  endpoint: string
  accessKey: string
  secretKey: string
  path: string
  expiresSeconds: number
  signedAt?: Date
}): string {
  const url = new URL(options.endpoint)
  const at = options.signedAt ?? new Date()
  const amzDate = at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  const day = amzDate.slice(0, 8)
  const region = 'us-east-1'
  const scope = `${day}/${region}/s3/aws4_request`
  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${options.accessKey}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(options.expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ]
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  const canonicalQuery = query
    .map(([key, value]) => [encode(key), encode(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  const canonicalRequest = ['GET', options.path, canonicalQuery, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest()
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${options.secretKey}`, day), region), 's3'), 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  return `${url.origin}${options.path}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

// ── short-lived containers (white-box) ────────────────────────────────────────────────────────────────

export interface ContainerInspect {
  Id: string
  Name: string
  Config: { Image: string; User: string; Entrypoint: string[] | null; Cmd: string[] | null; Env: string[] | null; Labels: Record<string, string> }
  HostConfig: WorkerInspect['HostConfig'] & {
    Mounts?: { Type: string; Source: string; Target: string; ReadOnly?: boolean; VolumeOptions?: { Subpath?: string } }[] | null
  }
  Image: string
}

/**
 * Inspects every container created on the inner Docker (or on the engine that `engine` selects, for example
 * `['-H', 'tcp://<ip>:2375']`) while `trigger` runs whose labels match `labels`, right at its `create` event (helpers,
 * build and test-run containers live for a moment only). Events are read from before the trigger (`--since`), so none
 * is missed; after the trigger a sentinel container with the same labels is created (never started) and the stream is
 * read until its event arrives, so every earlier create has been seen without a fixed wait. Returns the inspections
 * in creation order; containers already gone when inspected are skipped.
 */
export async function captureContainers(
  labels: Record<string, string>,
  trigger: () => Promise<void>,
  options: { engine?: string[] } = {},
): Promise<ContainerInspect[]> {
  const engine = options.engine ?? []
  const since = Math.floor(Date.now() / 1000) - 1
  const sentinel = unique('scantor-test-sentinel')
  const args = [
    ...engine,
    'events',
    '--since',
    String(since),
    '--format',
    '{{.Actor.ID}} {{index .Actor.Attributes "name"}}',
    '--filter',
    'type=container',
    '--filter',
    'event=create',
  ]
  for (const [key, value] of Object.entries(labels)) args.push('--filter', `label=${key}=${value}`)
  const events = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const inspections: Promise<ContainerInspect | null>[] = []
  let sentinelSeen!: () => void
  const seen = new Promise<void>((resolve) => (sentinelSeen = resolve))
  let buffer = ''
  events.stdout.setEncoding('utf8')
  events.stdout.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines.map((l) => l.trim()).filter(Boolean)) {
      const [id, name] = line.split(' ')
      if (name === sentinel) {
        sentinelSeen()
        continue
      }
      inspections.push(
        docker([...engine, 'inspect', id!], { allowFailure: true }).then((result) =>
          result.exitCode === 0 ? (JSON.parse(result.stdout) as ContainerInspect[])[0]! : null,
        ),
      )
    }
  })
  const exited = new Promise<never>((_, reject) =>
    events.on('close', (code) => reject(new Error(`docker events exited with ${code} before the sentinel ${sentinel} arrived`))),
  )
  exited.catch(() => undefined)
  try {
    await trigger()
    const sentinelLabels = Object.entries({ ...labels, 'scantor.test': 'true' }).flatMap(([key, value]) => ['--label', `${key}=${value}`])
    await docker([
      ...engine,
      'create',
      '--name',
      sentinel,
      ...sentinelLabels,
      '--network',
      'none',
      '--entrypoint',
      'true',
      await containerImage(CONTAINERS.node),
    ])
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>(
      (_, reject) => (timer = setTimeout(() => reject(new Error(`the create event of ${sentinel} did not arrive within 30 s`)), 30_000)),
    )
    try {
      await Promise.race([seen, exited, timeout])
    } finally {
      clearTimeout(timer)
    }
  } finally {
    events.kill('SIGTERM')
    await docker([...engine, 'rm', '-f', sentinel], { allowFailure: true })
  }
  return (await Promise.all(inspections)).filter((inspection): inspection is ContainerInspect => inspection !== null)
}

/** The image environment of a container's image (to separate it from what the creator added). */
export async function imageEnv(image: string, where: 'builtin' | 'remote' = 'builtin'): Promise<string[]> {
  const args = ['image', 'inspect', '--format', '{{json .Config.Env}}', image]
  const result = where === 'builtin' ? await docker(args) : await docker(['exec', CONTAINERS.remoteNode, 'docker', ...args])
  return (JSON.parse(result.stdout) as string[] | null) ?? []
}

/** Whether a container still exists. */
export async function containerExists(id: string, where: 'builtin' | 'remote' = 'builtin'): Promise<boolean> {
  const args = ['inspect', '--format', '{{.Id}}', id]
  const result =
    where === 'builtin' ? await docker(args, { allowFailure: true }) : await docker(['exec', CONTAINERS.remoteNode, 'docker', ...args], { allowFailure: true })
  return result.exitCode === 0
}

/** Copies an image of the inner Docker into another Docker engine that runs in `container` (`docker save | docker load`). */
export async function copyImageInto(image: string, container: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const save = spawn('docker', ['save', image], { stdio: ['ignore', 'pipe', 'pipe'] })
    const load = spawn('docker', ['exec', '-i', container, 'docker', 'load'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let errors = ''
    save.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString()))
    load.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString()))
    save.stdout.pipe(load.stdin)
    let pending = 2
    const done = (what: string) => (code: number | null) => {
      if (code !== 0) reject(new Error(`${what} of ${image} into ${container} exited with ${code}: ${errors.slice(-2000)}`))
      else if (--pending === 0) resolve()
    }
    save.on('close', done('docker save'))
    load.on('close', done('docker load'))
    save.on('error', reject)
    load.on('error', reject)
  })
}
