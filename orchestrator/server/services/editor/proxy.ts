import { Agent, type ClientRequest, type IncomingMessage, request as httpRequest, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { Logger } from '../../utils/logger'
import {
  editorSecurityHeaders,
  filterRequestHeaders,
  filterResponseHeaders,
  type HeaderRecord,
  type SecurityHeaderOptions,
  serializeUpgradeRequest,
  withSecurityHeaders,
  writeHeadWith,
} from './headers'
import { badGatewayPage, type EditorPage, PAGE_CSP } from './pages'

/*
 * HTTP proxy and WebSocket relay from the editor origin to a user's code-server unix socket (docs/editor.md §8.6,
 * §8.7). Each user has one keep-alive agent whose connections come from the safe socket connect; bodies stream both
 * ways and are never buffered. WebSockets are relayed byte for byte after the upgrade request was rewritten with the
 * filtered headers: code-server's own status line and frames pass through unchanged. Stopping an editor closes the
 * user's agent and every open WebSocket (closeUser).
 *
 * The listener (server/services/editor/listener.ts) authenticates before calling in here.
 */

export const MAX_AGENT_SOCKETS = 16
export const MAX_WEBSOCKETS_PER_USER = 32

export interface EditorProxyOptions {
  /** opens a connection to the user's code-server socket; may throw synchronously */
  connect: (userId: string) => Socket
  security: SecurityHeaderOptions
  dashboardUrl: string
  /** activity for the idle reaper: every proxied HTTP request, and every WebSocket as it opens and closes */
  onRequest: (userId: string) => void
  log: Logger
  maxWebSocketsPerUser?: number
}

interface RelayedSocket {
  client: Duplex
  upstream: Socket
}

/** Writes a complete page response with the editor origin's headers (plus the pages' own restrictive policy). */
export function sendPage(res: ServerResponse, page: EditorPage, security: SecurityHeaderOptions, kind: 'page' | 'auth' = 'page'): void {
  const securityHeaders = editorSecurityHeaders(security, kind)
  const headers: HeaderRecord = {
    ...securityHeaders,
    'content-security-policy': [securityHeaders['content-security-policy']!, PAGE_CSP],
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(page.body)),
    ...page.headers,
  }
  writeHeadWith(res, page.status, headers)
  res.end(page.body)
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  421: 'Misdirected Request',
  429: 'Too Many Requests',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
}

/** Rejects an upgrade request with a bare status line and closes the connection. */
export function rejectUpgrade(socket: Duplex, status: number, security: SecurityHeaderOptions): void {
  const headers = { ...editorSecurityHeaders(security, 'page'), connection: 'close', 'content-length': '0' }
  const lines = [`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)]
  if (!socket.writable) {
    socket.destroy()
    return
  }
  socket.once('finish', () => socket.destroy())
  socket.once('error', () => socket.destroy())
  socket.end(`${lines.join('\r\n')}\r\n\r\n`)
}

export class EditorProxy {
  private readonly agents = new Map<string, Agent>()
  private readonly relays = new Map<string, Set<RelayedSocket>>()

  constructor(private readonly options: EditorProxyOptions) {}

  private agentFor(userId: string): Agent {
    let agent = this.agents.get(userId)
    if (agent) return agent
    agent = new Agent({ keepAlive: true, maxSockets: MAX_AGENT_SOCKETS })
    const connect = this.options.connect
    // The agent never resolves a host: every connection is a safe connect to the user's socket.
    ;(agent as unknown as { createConnection: unknown }).createConnection = (_options: unknown, callback: (error: Error | null, socket?: Socket) => void) => {
      let socket: Socket
      try {
        socket = connect(userId)
      } catch (error) {
        callback(error as Error)
        return undefined
      }
      return socket
    }
    this.agents.set(userId, agent)
    return agent
  }

  /** Proxies one HTTP request to the user's code-server (docs/editor.md §8.6). */
  proxyHttp(req: IncomingMessage, res: ServerResponse, userId: string): void {
    this.options.onRequest(userId)
    let upstreamRequest: ClientRequest
    try {
      upstreamRequest = httpRequest({
        agent: this.agentFor(userId),
        method: req.method,
        path: req.url,
        headers: filterRequestHeaders(req.headers, { upgrade: false }),
      })
    } catch (error) {
      this.options.log.warn('editor proxy request could not be created', { userId, err: error })
      sendPage(res, badGatewayPage(this.options.dashboardUrl), this.options.security)
      return
    }

    upstreamRequest.on('response', (upstream) => {
      const headers = withSecurityHeaders(filterResponseHeaders(upstream.headers), editorSecurityHeaders(this.options.security, 'proxy'))
      writeHeadWith(res, upstream.statusCode ?? 502, headers, upstream.statusMessage)
      upstream.pipe(res)
      upstream.on('error', () => res.destroy())
    })
    upstreamRequest.on('error', (error) => {
      this.options.log.warn('editor proxy upstream error', { userId, err: error })
      if (!res.headersSent) sendPage(res, badGatewayPage(this.options.dashboardUrl), this.options.security)
      else res.destroy()
    })
    // A client that goes away aborts the upstream request (and an upload stops streaming into the editor).
    res.on('close', () => {
      if (!res.writableFinished) upstreamRequest.destroy()
    })
    req.pipe(upstreamRequest)
  }

  /** Number of open relayed WebSockets of a user. */
  openWebSockets(userId: string): number {
    return this.relays.get(userId)?.size ?? 0
  }

  /** Users with at least one open relayed WebSocket (the activity heartbeat). */
  usersWithOpenWebSockets(): string[] {
    return [...this.relays.entries()].filter(([, set]) => set.size > 0).map(([userId]) => userId)
  }

  /**
   * Relays an authenticated WebSocket upgrade to the user's code-server (docs/editor.md §8.7 steps 4–8). The caller
   * has checked the Host, the cookie, the Origin and that the editor is running.
   */
  relayWebSocket(req: IncomingMessage, client: Duplex, head: Buffer, userId: string): void {
    const security = this.options.security
    if (this.openWebSockets(userId) >= (this.options.maxWebSocketsPerUser ?? MAX_WEBSOCKETS_PER_USER)) {
      rejectUpgrade(client, 429, security)
      return
    }
    let upstream: Socket
    try {
      upstream = this.options.connect(userId)
    } catch (error) {
      this.options.log.warn('editor WebSocket upstream unavailable', { userId, err: error })
      rejectUpgrade(client, 502, security)
      return
    }

    const relay: RelayedSocket = { client, upstream }
    let set = this.relays.get(userId)
    if (!set) {
      set = new Set()
      this.relays.set(userId, set)
    }
    set.add(relay)
    this.options.onRequest(userId)

    let connected = false
    let closed = false
    const close = (options: { keepClient?: boolean } = {}) => {
      if (closed) return
      closed = true
      const current = this.relays.get(userId)
      current?.delete(relay)
      if (current?.size === 0) this.relays.delete(userId)
      upstream.destroy()
      // A rejected client closes itself once its status line is flushed (rejectUpgrade).
      if (!options.keepClient) client.destroy()
      // docs/editor.md §8.7 step 8: closing a WebSocket counts as activity, so a tab closed just now is not idle.
      this.options.onRequest(userId)
    }
    upstream.once('connect', () => {
      connected = true
      upstream.write(serializeUpgradeRequest(req.method ?? 'GET', req.url ?? '/', filterRequestHeaders(req.headers, { upgrade: true })))
      if (head.length > 0) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', (error) => {
      if (!connected && !closed) {
        this.options.log.warn('editor WebSocket upstream connect failed', { userId, err: error })
        rejectUpgrade(client, 502, security)
        close({ keepClient: true })
        return
      }
      close()
    })
    upstream.on('close', () => close())
    client.on('error', () => close())
    client.on('close', () => close())
    // A WebSocket is never half-open: when one side ends, the pipe flushes its last bytes and ends the other side,
    // and then both close. code-server keeps a connection open after the browser's FIN; without this a closed tab
    // would keep its relay, and with it the editor's activity heartbeat, alive.
    upstream.once('finish', () => close())
    client.once('finish', () => close())
  }

  /** Closes the user's agent and every open WebSocket of the user (editor stop). */
  closeUser(userId: string): void {
    this.agents.get(userId)?.destroy()
    this.agents.delete(userId)
    for (const relay of this.relays.get(userId) ?? []) {
      relay.upstream.destroy()
      relay.client.destroy()
    }
    this.relays.delete(userId)
  }

  closeAll(): void {
    for (const userId of new Set([...this.agents.keys(), ...this.relays.keys()])) this.closeUser(userId)
  }
}
