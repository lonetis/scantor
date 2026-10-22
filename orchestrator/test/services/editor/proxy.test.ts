import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, request, type Server } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { EditorCodeStore, FailureLimiter } from '../../../server/services/editor/codes'
import { createEditorServer } from '../../../server/services/editor/listener'
import { EditorProxy } from '../../../server/services/editor/proxy'
import { EditorSessions, type EditorStateSnapshot } from '../../../server/services/editor/sessions'
import { createKeyring } from '../../../server/utils/keys'
import { useLogger } from '../../../server/utils/logger'
import type { CachedUser } from '../../../server/utils/user-cache'
import { waitFor } from './fakes'

// The editor listener end to end with a fake code-server on a unix socket (docs/editor.md §8, security.md ED-1,
// ED-2, HDR-4; docs/testing.md §4.2: the fake upstream receives no cookie or authorization header). The safe socket
// connect is Linux-only and has its own test (socket.test.ts); here the proxy connects with a plain unix connect.

const EDITOR_HOST = 'editor.test'
const EDITOR_URL = `http://${EDITOR_HOST}`
const PUBLIC_URL = 'http://dashboard.test'
const USER_ID = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const STARTED_AT = new Date('2026-10-21T09:00:00.000Z')

const keyring = createKeyring('editor proxy test secret')
const sign = (userId: string, startedAtMs: number, expiresAtMs: number) => keyring.editorCookie(userId, startedAtMs, expiresAtMs)

interface Recorded {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

// ── fake code-server ─────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'scantor-editor-'))
const socketPath = join(dir, 'code.sock')
const recorded: Recorded[] = []
const upgrades: IncomingHttpHeaders[] = []
const halfOpen: Socket[] = []
let upstream: Server

function acceptKey(key: string): string {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      recorded.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(200, {
        'content-type': 'text/plain',
        'set-cookie': ['code-server-session=abc', 'scantor_editor=shadow; Path=/'],
        'content-security-policy': "default-src 'self'",
        'x-upstream': 'yes',
      })
      res.end(`hello ${req.url}`)
    })
  })
  upstream.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    upgrades.push(req.headers)
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Accept: ${acceptKey(String(req.headers['sec-websocket-key']))}\r\n\r\n`,
    )
    if (head.length > 0) socket.write(head)
    // Like code-server, `/half-open` keeps its side open after the client's FIN; everything else echoes.
    if (req.url?.startsWith('/half-open')) {
      halfOpen.push(socket)
      socket.resume()
    } else {
      socket.pipe(socket)
    }
  })
  await new Promise<void>((resolve) => upstream.listen(socketPath, resolve))
})

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

// ── the listener under test ─────────────────────────────────────────────────

let editorState: EditorStateSnapshot | null
let user: CachedUser | null
let activity: string[]
let connectFails: boolean
/** where the proxy's connections go: the fake code-server, or a missing path (an asynchronous connect error) */
let connectTarget: string
let codes: EditorCodeStore
let proxy: EditorProxy
let listener: Server
let port: number

beforeEach(async () => {
  recorded.length = 0
  upgrades.length = 0
  editorState = { state: 'running', startedAt: STARTED_AT }
  user = { id: USER_ID, email: 'a@example.com', name: 'A', role: 'user', banned: false, banExpires: null, canRunPrivileged: false, maxWorkers: 0 }
  activity = []
  connectFails = false
  connectTarget = socketPath
  codes = new EditorCodeStore()
  const log = useLogger('test')
  const security = { dashboardOrigin: PUBLIC_URL, https: false }
  proxy = new EditorProxy({
    connect: () => {
      if (connectFails) throw new Error('socket missing')
      return createConnection(connectTarget)
    },
    security,
    dashboardUrl: PUBLIC_URL,
    onRequest: (userId) => activity.push(userId),
    log,
    maxWebSocketsPerUser: 2,
  })
  const sessions = new EditorSessions({
    sign,
    getUser: async () => user,
    isBanned: (candidate) => candidate.banned,
    loadEditor: async () => editorState,
    codes,
    stateTtlMs: 0,
  })
  listener = createEditorServer({ editorUrl: EDITOR_URL, publicUrl: PUBLIC_URL, trustProxy: false, sessions, proxy, limiter: new FailureLimiter(), log })
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  port = (listener.address() as { port: number }).port
})

afterEach(async () => {
  for (const socket of halfOpen.splice(0)) socket.destroy()
  proxy.closeAll()
  listener.closeAllConnections()
  await new Promise<void>((resolve) => listener.close(() => resolve()))
})

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function send(path: string, headers: Record<string, string> = {}, options: { method?: string; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: EDITOR_HOST, ...headers }, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

function validCookie(startedAt = STARTED_AT, expiresAtMs = Date.now() + 3_600_000): string {
  return `scantor_editor=${sign(USER_ID, startedAt.getTime(), expiresAtMs)}`
}

type UpgradeOutcome = { kind: 'upgraded'; socket: Socket; headers: IncomingHttpHeaders } | { kind: 'rejected'; status: number; headers: IncomingHttpHeaders }

function upgrade(headers: Record<string, string>, path = '/stable-abc?reconnectionToken=t&skipWebSocketFrames=false'): Promise<UpgradeOutcome> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      agent: false,
      headers: {
        host: EDITOR_HOST,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
        ...headers,
      },
    })
    req.on('upgrade', (res, socket) => resolve({ kind: 'upgraded', socket, headers: res.headers }))
    req.on('response', (res) => {
      res.resume()
      resolve({ kind: 'rejected', status: res.statusCode!, headers: res.headers })
    })
    req.on('error', reject)
    req.end()
  })
}

function readBytes(socket: Socket, count: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const onData = (data: Buffer) => {
      chunks.push(data)
      if (Buffer.concat(chunks).length < count) return
      socket.off('data', onData)
      resolve(Buffer.concat(chunks))
    }
    socket.on('data', onData)
  })
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('editor listener: host check and handoff', () => {
  it('answers 421 for any host but the editor host', async () => {
    const reply = await send('/', { host: 'dashboard.test' })
    expect(reply.status).toBe(421)
    expect(reply.headers['content-security-policy']).toBe(`frame-ancestors 'self' ${PUBLIC_URL}`)
    expect((await send('/_auth?code=x', { host: `${EDITOR_HOST}:8080` })).status).toBe(421)
  })

  it('redeems a one-time code into a host-only cookie and redirects to the task folder', async () => {
    const { code } = codes.issue(USER_ID, 'echo')
    const reply = await send(`/_auth?code=${code}`)
    expect(reply.status).toBe(302)
    expect(reply.headers.location).toBe('/?folder=/home/coder/workspace/echo')
    expect(reply.headers['cache-control']).toBe('no-store')
    expect(reply.headers['referrer-policy']).toBe('no-referrer')
    expect(reply.headers['content-security-policy']).toBe(`frame-ancestors 'self' ${PUBLIC_URL}`)
    const [cookie] = reply.headers['set-cookie']!
    expect(cookie).toMatch(new RegExp(`^scantor_editor=v1\\.${USER_ID}\\.${STARTED_AT.getTime()}\\.\\d+\\.[A-Za-z0-9_-]{43}; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax$`))
    const again = await send(`/_auth?code=${code}`)
    expect(again.status).toBe(401)
    expect(again.headers['set-cookie']).toBeUndefined()
  })

  it('opens the workspace root without a task', async () => {
    const { code } = codes.issue(USER_ID, null)
    expect((await send(`/_auth?code=${code}`)).headers.location).toBe('/?folder=/home/coder/workspace')
  })

  it('refuses codes of banned users and of stopped editors', async () => {
    user = { ...user!, banned: true }
    expect((await send(`/_auth?code=${codes.issue(USER_ID, null).code}`)).status).toBe(401)
    user = { ...user, banned: false }
    editorState = { state: 'stopped', startedAt: STARTED_AT }
    expect((await send(`/_auth?code=${codes.issue(USER_ID, null).code}`)).status).toBe(410)
  })

  it('answers 429 after 30 failed codes from one client', async () => {
    for (let i = 0; i < 30; i++) expect((await send('/_auth?code=sec_nope')).status).toBe(401)
    const blocked = await send(`/_auth?code=${codes.issue(USER_ID, null).code}`)
    expect(blocked.status).toBe(429)
    expect(blocked.headers['retry-after']).toBe('60')
  })

  it('allows only GET on /_auth', async () => {
    expect((await send('/_auth', {}, { method: 'POST' })).status).toBe(405)
  })
})

describe('editor listener: HTTP proxy', () => {
  it('requires a valid cookie and never accepts dashboard credentials', async () => {
    expect((await send('/')).status).toBe(401)
    expect((await send('/', { cookie: 'scantor.session_token=abc' })).status).toBe(401)
    expect((await send('/', { authorization: 'Bearer sk_scantor_x', 'x-api-key': 'sk_scantor_x' })).status).toBe(401)
    expect((await send('/', { cookie: validCookie(STARTED_AT, Date.now() - 1) })).status).toBe(401)
    expect(recorded).toHaveLength(0)
  })

  it('proxies with credentials, forwarding and hop-by-hop headers stripped', async () => {
    const reply = await send(
      '/static/out/vs/code.js?x=1',
      {
        cookie: `${validCookie()}; scantor.session_token=secret; scantor_tools=jwt`,
        authorization: 'Bearer sk_scantor_abc',
        'proxy-authorization': 'Basic abc',
        'x-api-key': 'sk_scantor_abc',
        'x-scantor-internal-auth': 'sic_abc',
        'x-forwarded-for': '1.2.3.4',
        'x-forwarded-host': 'evil.test',
        'x-real-ip': '1.2.3.4',
        forwarded: 'for=1.2.3.4',
        origin: EDITOR_URL,
        'if-none-match': '"etag"',
      },
    )
    expect(reply.status).toBe(200)
    expect(reply.body).toBe('hello /static/out/vs/code.js?x=1')
    const seen = recorded[0]!
    expect(seen.method).toBe('GET')
    expect(seen.url).toBe('/static/out/vs/code.js?x=1')
    for (const name of ['cookie', 'authorization', 'proxy-authorization', 'x-api-key', 'x-scantor-internal-auth', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded']) {
      expect(seen.headers, name).not.toHaveProperty(name)
    }
    expect(seen.headers.host).toBe(EDITOR_HOST)
    expect(seen.headers.origin).toBe(EDITOR_URL)
    expect(seen.headers['if-none-match']).toBe('"etag"')
    expect(activity).toContain(USER_ID)
  })

  it('removes Set-Cookie and adds the editor origin headers to proxied responses', async () => {
    const reply = await send('/', { cookie: validCookie() })
    expect(reply.headers['set-cookie']).toBeUndefined()
    expect(reply.headers['x-upstream']).toBe('yes')
    // Node joins repeated headers with ", "; both policies arrive.
    expect(reply.headers['content-security-policy']).toBe(`default-src 'self', frame-ancestors 'self' ${PUBLIC_URL}`)
    expect(reply.headers['x-content-type-options']).toBe('nosniff')
    expect(reply.headers['referrer-policy']).toBe('same-origin')
    expect(reply.headers['strict-transport-security']).toBeUndefined()
  })

  it('streams request bodies to code-server', async () => {
    const body = JSON.stringify({ data: 'x'.repeat(100_000) })
    const reply = await send('/upload', { cookie: validCookie(), 'content-type': 'application/json' }, { method: 'POST', body })
    expect(reply.status).toBe(200)
    expect(recorded[0]!.body).toBe(body)
    expect(recorded[0]!.headers['content-type']).toBe('application/json')
  })

  it('shows the starting page while the editor starts and 410 once it stopped or restarted', async () => {
    editorState = { state: 'starting', startedAt: STARTED_AT }
    const starting = await send('/', { cookie: validCookie() })
    expect(starting.status).toBe(503)
    expect(starting.headers['retry-after']).toBe('2')
    expect(starting.body).toContain('<meta http-equiv="refresh" content="2">')
    expect(starting.headers['cache-control']).toBe('no-store')

    editorState = { state: 'stopping', startedAt: STARTED_AT }
    expect((await send('/', { cookie: validCookie() })).status).toBe(410)
    editorState = { state: 'running', startedAt: new Date(STARTED_AT.getTime() + 1) }
    const restarted = await send('/', { cookie: validCookie() })
    expect(restarted.status).toBe(410)
    expect(restarted.body).toContain(PUBLIC_URL)
    expect(recorded).toHaveLength(0)
  })

  it('answers 502 when the socket cannot be reached', async () => {
    connectFails = true
    const reply = await send('/', { cookie: validCookie() })
    expect(reply.status).toBe(502)
    expect(reply.headers['content-security-policy']).toContain(`frame-ancestors 'self' ${PUBLIC_URL}`)
  })

  it('rejects absolute-form request targets', async () => {
    expect((await send('//evil.test/x', { cookie: validCookie() })).status).toBe(400)
  })
})

describe('editor listener: WebSocket relay', () => {
  it('relays an authenticated same-origin upgrade byte for byte with filtered headers', async () => {
    const outcome = await upgrade({
      cookie: `${validCookie()}; scantor.session_token=secret`,
      origin: EDITOR_URL,
      authorization: 'Bearer sk_scantor_abc',
      'x-forwarded-host': 'evil.test',
    })
    expect(outcome.kind).toBe('upgraded')
    if (outcome.kind !== 'upgraded') return
    expect(outcome.headers['sec-websocket-accept']).toBe(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='))
    const seen = upgrades[0]!
    expect(seen.cookie).toBeUndefined()
    expect(seen.authorization).toBeUndefined()
    expect(seen['x-forwarded-host']).toBeUndefined()
    expect(seen.host).toBe(EDITOR_HOST)
    expect(seen.origin).toBe(EDITOR_URL)
    expect(seen.upgrade).toBe('websocket')
    expect(seen['sec-websocket-key']).toBe('dGhlIHNhbXBsZSBub25jZQ==')

    // A masked text frame travels to code-server and (echoed by the fake) back, unchanged in both directions.
    const frame = Buffer.from([0x81, 0x85, 1, 2, 3, 4, 0x69, 0x67, 0x6f, 0x68, 0x6e])
    const echo = readBytes(outcome.socket, frame.length)
    outcome.socket.write(frame)
    expect(await echo).toEqual(frame)
    expect(proxy.openWebSockets(USER_ID)).toBe(1)
    expect(proxy.usersWithOpenWebSockets()).toEqual([USER_ID])

    const closed = new Promise((resolve) => outcome.socket.once('close', resolve))
    activity.length = 0
    proxy.closeUser(USER_ID)
    await closed
    expect(proxy.openWebSockets(USER_ID)).toBe(0)
    // Closing a WebSocket counts as activity (docs/editor.md §8.7 step 8).
    await waitFor(() => activity.includes(USER_ID))
  })

  it('rejects foreign origins, missing cookies, foreign hosts and editors that are not running', async () => {
    expect(await upgrade({ cookie: validCookie(), origin: 'http://evil.test' })).toMatchObject({ kind: 'rejected', status: 403 })
    expect(await upgrade({ cookie: validCookie(), origin: PUBLIC_URL })).toMatchObject({ kind: 'rejected', status: 403 })
    expect(await upgrade({ origin: EDITOR_URL })).toMatchObject({ kind: 'rejected', status: 401 })
    expect(await upgrade({ cookie: validCookie(), origin: EDITOR_URL, host: 'dashboard.test' })).toMatchObject({ kind: 'rejected', status: 421 })
    editorState = { state: 'starting', startedAt: STARTED_AT }
    expect(await upgrade({ cookie: validCookie(), origin: EDITOR_URL })).toMatchObject({ kind: 'rejected', status: 503 })
    editorState = { state: 'stopped', startedAt: STARTED_AT }
    expect(await upgrade({ cookie: validCookie(), origin: EDITOR_URL })).toMatchObject({ kind: 'rejected', status: 401 })
    expect(upgrades).toHaveLength(0)
  })

  it('closes the relay when the client ends, even if code-server keeps its side open', async () => {
    const outcome = await upgrade({ cookie: validCookie(), origin: EDITOR_URL }, '/half-open')
    expect(outcome.kind).toBe('upgraded')
    if (outcome.kind !== 'upgraded') return
    expect(proxy.openWebSockets(USER_ID)).toBe(1)
    outcome.socket.end()
    await waitFor(() => proxy.openWebSockets(USER_ID) === 0)
  })

  it('limits open WebSockets per user', async () => {
    const opened: Socket[] = []
    for (let i = 0; i < 2; i++) {
      const outcome = await upgrade({ cookie: validCookie(), origin: EDITOR_URL })
      expect(outcome.kind).toBe('upgraded')
      if (outcome.kind === 'upgraded') opened.push(outcome.socket)
    }
    expect(await upgrade({ cookie: validCookie(), origin: EDITOR_URL })).toMatchObject({ kind: 'rejected', status: 429 })
    for (const socket of opened) socket.destroy()
  })

  it('answers 502 when the socket cannot be reached', async () => {
    connectFails = true
    expect(await upgrade({ cookie: validCookie(), origin: EDITOR_URL })).toMatchObject({ kind: 'rejected', status: 502 })
  })

  it('answers a complete 502 when the connection fails after the socket was opened', async () => {
    connectTarget = join(dir, 'missing.sock')
    expect(await upgrade({ cookie: validCookie(), origin: EDITOR_URL })).toMatchObject({ kind: 'rejected', status: 502 })
    expect(proxy.openWebSockets(USER_ID)).toBe(0)
  })
})
