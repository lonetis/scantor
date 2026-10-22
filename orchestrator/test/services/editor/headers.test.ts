import { describe, expect, it } from 'vitest'
import {
  editorSecurityHeaders,
  filterRequestHeaders,
  filterResponseHeaders,
  serializeUpgradeRequest,
  withSecurityHeaders,
} from '../../../server/services/editor/headers'

// Header rules of the editor origin (docs/editor.md §8.6–§8.8, security.md ED-2, HDR-4).

const browserRequest = {
  host: 'editor.scantor.example',
  origin: 'https://editor.scantor.example',
  'user-agent': 'Mozilla/5.0',
  accept: 'text/html',
  'accept-encoding': 'gzip',
  'content-type': 'application/json',
  'content-length': '12',
  'if-none-match': '"abc"',
  range: 'bytes=0-10',
  cookie: 'scantor_editor=v1.x; scantor.session_token=secret; scantor_tools=jwt',
  authorization: 'Bearer sk_scantor_abc',
  'proxy-authorization': 'Basic abc',
  'x-api-key': 'sk_scantor_abc',
  'x-scantor-internal-auth': 'sic_abc',
  'x-scantor-client-ip': '203.0.113.7',
  forwarded: 'for=1.2.3.4',
  'x-forwarded-for': '1.2.3.4',
  'x-forwarded-host': 'evil.example',
  'x-forwarded-proto': 'https',
  'x-real-ip': '1.2.3.4',
  connection: 'keep-alive, Upgrade',
  'keep-alive': 'timeout=5',
  'proxy-connection': 'keep-alive',
  te: 'trailers',
  trailer: 'x-foo',
  'transfer-encoding': 'chunked',
  upgrade: 'websocket',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  'sec-websocket-version': '13',
  'sec-websocket-extensions': 'permessage-deflate',
}

const STRIPPED = [
  'cookie',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-scantor-internal-auth',
  'x-scantor-client-ip',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
]

describe('request headers', () => {
  it('strips credentials, forwarding and hop-by-hop headers and keeps everything else unchanged', () => {
    const filtered = filterRequestHeaders(browserRequest, { upgrade: false })
    for (const name of [...STRIPPED, 'connection', 'upgrade']) expect(filtered, name).not.toHaveProperty(name)
    expect(filtered).toMatchObject({
      host: 'editor.scantor.example',
      origin: 'https://editor.scantor.example',
      'user-agent': 'Mozilla/5.0',
      accept: 'text/html',
      'accept-encoding': 'gzip',
      'content-type': 'application/json',
      'content-length': '12',
      'if-none-match': '"abc"',
      range: 'bytes=0-10',
    })
  })

  it('keeps the upgrade handshake for WebSockets', () => {
    const filtered = filterRequestHeaders(browserRequest, { upgrade: true })
    for (const name of STRIPPED) expect(filtered, name).not.toHaveProperty(name)
    expect(filtered).toMatchObject({
      connection: 'Upgrade',
      upgrade: 'websocket',
      host: 'editor.scantor.example',
      origin: 'https://editor.scantor.example',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      'sec-websocket-extensions': 'permessage-deflate',
    })
  })

  it('serialises the upgrade request head', () => {
    const head = serializeUpgradeRequest('GET', '/stable-abc?reconnectionToken=t', {
      host: 'editor.scantor.example',
      connection: 'Upgrade',
      'sec-websocket-protocol': ['a', 'b'],
    })
    expect(head).toBe(
      'GET /stable-abc?reconnectionToken=t HTTP/1.1\r\nhost: editor.scantor.example\r\nconnection: Upgrade\r\n' +
        'sec-websocket-protocol: a\r\nsec-websocket-protocol: b\r\n\r\n',
    )
  })
})

describe('response headers', () => {
  it('removes Set-Cookie and hop-by-hop headers', () => {
    const filtered = filterResponseHeaders({
      'set-cookie': ['a=1', 'scantor_editor=evil'],
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      'content-type': 'text/html',
      etag: '"x"',
    })
    expect(filtered).toEqual({ 'content-type': 'text/html', etag: '"x"' })
  })

  it('adds frame-ancestors as an additional CSP and replaces the other security headers', () => {
    const security = editorSecurityHeaders({ dashboardOrigin: 'https://scantor.example', https: true }, 'proxy')
    expect(security).toEqual({
      'content-security-policy': "frame-ancestors 'self' https://scantor.example",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'strict-transport-security': 'max-age=31536000',
    })
    const merged = withSecurityHeaders(
      { 'content-security-policy': "default-src 'self'", 'referrer-policy': 'unsafe-url', 'cache-control': 'max-age=60' },
      security,
    )
    expect(merged['content-security-policy']).toEqual(["default-src 'self'", "frame-ancestors 'self' https://scantor.example"])
    expect(merged['referrer-policy']).toBe('same-origin')
    expect(merged['cache-control']).toBe('max-age=60')
  })

  it('uses no-referrer and no-store on /_auth, no-store on pages, and no HSTS on http', () => {
    const http = { dashboardOrigin: 'http://localhost:3000', https: false }
    expect(editorSecurityHeaders(http, 'auth')).toEqual({
      'content-security-policy': "frame-ancestors 'self' http://localhost:3000",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    })
    expect(editorSecurityHeaders(http, 'page')['cache-control']).toBe('no-store')
    expect(editorSecurityHeaders(http, 'proxy')).not.toHaveProperty('cache-control')
  })
})
