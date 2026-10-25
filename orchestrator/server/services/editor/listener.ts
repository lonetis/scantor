import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { computeClientIp, normalizeHost } from '../../utils/client-ip'
import type { Logger } from '../../utils/logger'
import type { ProxyTrust } from '../../utils/trusted-proxy'
import { editorCookieHeader } from './cookie'
import type { FailureLimiter } from './codes'
import { editorSecurityHeaders, type SecurityHeaderOptions } from './headers'
import {
  badRequestPage,
  editorEndedPage,
  methodNotAllowedPage,
  startingPage,
  tooManyRequestsPage,
  unauthorizedPage,
} from './pages'
import { type EditorProxy, rejectUpgrade, sendPage } from './proxy'
import type { EditorSessions } from './sessions'

/*
 * The editor origin (docs/editor.md §8.1–§8.2, security.md ED-1): a dedicated node:http listener on container port
 * 3001, outside Nitro, that accepts only the host (and port) of SCANTOR_EDITOR_URL and serves nothing but
 *   GET /_auth?code=…   the one-time-code handoff to the `scantor_editor` cookie, and
 *   everything else      the HTTP proxy and WebSocket relay to the user's code-server socket.
 * The Host header is used as sent (Traefik preserves it); X-Forwarded-Host is never trusted.
 */

export const EDITOR_LISTENER_PORT = 3001
export const AUTH_PATH = '/_auth'
export const HEADERS_TIMEOUT_MS = 60_000

export interface EditorListenerOptions {
  editorUrl: string
  publicUrl: string
  /** whether a socket peer is a trusted reverse proxy whose X-Forwarded-For counts (utils/trusted-proxy.ts) */
  isTrustedProxy: ProxyTrust
  sessions: EditorSessions
  proxy: EditorProxy
  limiter: FailureLimiter
  log: Logger
}

export interface EditorRequestHandlers {
  onRequest(req: IncomingMessage, res: ServerResponse): void
  onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
}

function securityOptions(options: Pick<EditorListenerOptions, 'editorUrl' | 'publicUrl'>): SecurityHeaderOptions {
  return { dashboardOrigin: new URL(options.publicUrl).origin, https: new URL(options.editorUrl).protocol === 'https:' }
}

/** True when the request's Host header names the editor origin (default ports ignored). */
export function isEditorHostHeader(host: string | undefined, editorUrl: string): boolean {
  if (!host) return false
  const url = new URL(editorUrl)
  const protocol = url.protocol as 'http:' | 'https:'
  return normalizeHost(host, protocol) === normalizeHost(url.host, protocol)
}

function sendMisdirected(res: ServerResponse, security: SecurityHeaderOptions): void {
  const body = 'Misdirected Request: this listener serves only the editor origin.\n'
  res.writeHead(421, 'Misdirected Request', {
    ...editorSecurityHeaders(security, 'page'),
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** The request target as an origin-form path, or null for absolute-form and other targets. */
function originFormPath(url: string | undefined): URL | null {
  if (!url || !url.startsWith('/') || url.startsWith('//')) return null
  try {
    return new URL(url, 'http://editor.invalid')
  } catch {
    return null
  }
}

export function createEditorRequestHandlers(options: EditorListenerOptions): EditorRequestHandlers {
  const security = securityOptions(options)
  const editorOrigin = new URL(options.editorUrl).origin
  const dashboardUrl = options.publicUrl
  const { sessions, proxy, limiter, log } = options

  function clientIp(req: IncomingMessage): string {
    return computeClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], options.isTrustedProxy)
  }

  async function handleAuth(req: IncomingMessage, res: ServerResponse, target: URL): Promise<void> {
    if (req.method !== 'GET') {
      sendPage(res, methodNotAllowedPage(), security, 'auth')
      return
    }
    const ip = clientIp(req)
    if (limiter.isBlocked(ip)) {
      sendPage(res, tooManyRequestsPage(), security, 'auth')
      return
    }
    const redemption = await sessions.redeem(target.searchParams.get('code') ?? '')
    switch (redemption.kind) {
      case 'invalid':
        limiter.recordFailure(ip)
        sendPage(res, unauthorizedPage(dashboardUrl, 'code'), security, 'auth')
        return
      case 'ended':
        sendPage(res, editorEndedPage(dashboardUrl), security, 'auth')
        return
      case 'ok':
        res.writeHead(302, {
          ...editorSecurityHeaders(security, 'auth'),
          location: redemption.location,
          'set-cookie': editorCookieHeader(redemption.cookieValue, security.https),
          'content-length': '0',
        })
        res.end()
        log.info('editor session opened', { userId: redemption.userId })
    }
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isEditorHostHeader(req.headers.host, options.editorUrl)) {
      sendMisdirected(res, security)
      return
    }
    const target = originFormPath(req.url)
    if (!target) {
      sendPage(res, badRequestPage(), security)
      return
    }
    if (target.pathname === AUTH_PATH) {
      await handleAuth(req, res, target)
      return
    }
    const access = await sessions.check(req.headers.cookie)
    if (access.kind === 'invalid') {
      sendPage(res, unauthorizedPage(dashboardUrl, 'cookie'), security)
      return
    }
    if (access.kind === 'ended') {
      sendPage(res, editorEndedPage(dashboardUrl), security)
      return
    }
    if (access.state === 'starting') {
      sendPage(res, startingPage(), security)
      return
    }
    proxy.proxyHttp(req, res, access.userId)
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (!isEditorHostHeader(req.headers.host, options.editorUrl)) return rejectUpgrade(socket, 421, security)
    if (!originFormPath(req.url)) return rejectUpgrade(socket, 400, security)
    const access = await sessions.check(req.headers.cookie)
    if (access.kind !== 'ok') return rejectUpgrade(socket, 401, security)
    // Cross-site WebSocket hijacking: only pages of the editor origin may open the editor's WebSockets.
    if (req.headers.origin !== editorOrigin) return rejectUpgrade(socket, 403, security)
    if (access.state !== 'running') return rejectUpgrade(socket, 503, security)
    proxy.relayWebSocket(req, socket, head, access.userId)
  }

  return {
    onRequest(req, res) {
      handleRequest(req, res).catch((error: unknown) => {
        log.error('editor listener request failed', { err: error, path: originFormPath(req.url)?.pathname })
        if (!res.headersSent) {
          res.writeHead(500, { ...editorSecurityHeaders(security, 'page'), 'content-type': 'text/plain; charset=utf-8' })
          res.end('Internal error\n')
        } else {
          res.destroy()
        }
      })
    },
    onUpgrade(req, socket, head) {
      socket.on('error', (error) => log.debug('editor WebSocket client error', { err: error }))
      handleUpgrade(req, socket, head).catch((error: unknown) => {
        log.error('editor listener upgrade failed', { err: error })
        socket.destroy()
      })
    },
  }
}

/** The editor origin's HTTP server: no request timeout (uploads into the editor), 60 s for the headers. */
export function createEditorServer(options: EditorListenerOptions): Server {
  const handlers = createEditorRequestHandlers(options)
  const server = createServer({ requestTimeout: 0, headersTimeout: HEADERS_TIMEOUT_MS })
  server.on('request', handlers.onRequest)
  server.on('upgrade', handlers.onUpgrade)
  server.on('clientError', (error, socket) => {
    options.log.debug('editor listener client error', { err: error })
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    else socket.destroy()
  })
  return server
}

/**
 * Listens on `port`. In development Nitro reloads while the previous listener may still hold the port, so
 * EADDRINUSE is retried for `retryAddressInUseMs` (docs/editor.md §8.1).
 */
export async function listenEditorServer(server: Server, port: number, options: { retryAddressInUseMs: number; log: Logger }): Promise<void> {
  const deadline = Date.now() + options.retryAddressInUseMs
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port)
      })
      return
    } catch (error) {
      const inUse = (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
      if (!inUse || Date.now() >= deadline) throw error
      options.log.warn('editor listener port in use; retrying', { port })
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

/** Closes the listener and every connection it still holds. */
export async function closeEditorServer(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
      else resolve()
    })
  })
}
