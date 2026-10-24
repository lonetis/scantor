import { createHash, createHmac, X509Certificate } from 'node:crypto'
import { connect, type PeerCertificate } from 'node:tls'

// Raw network probes of the test stack's Traefik for security/traefik.spec.ts (docs/deployment.md §7): the certificate
// served for an SNI name, an AMQP protocol handshake through the `amqp.` TCP router, and SigV4-signed S3 requests that
// prove the `Host` header reaches the object store unchanged. Every connection verifies TLS against the trusted test
// CA (NODE_EXTRA_CA_CERTS); nothing disables verification.

export interface TlsPeer {
  certificate: X509Certificate
  /** always true: the handshake verifies the chain and the name, and fails otherwise */
  authorized: boolean
}

/**
 * Opens a verified TLS connection to `host:443` with the SNI `servername` and returns the served leaf certificate.
 * The handshake fails unless the certificate chains to a trusted CA and covers `servername`.
 */
export function tlsPeer(servername: string, options: { host?: string; port?: number; timeoutMs?: number } = {}): Promise<TlsPeer> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: options.host ?? servername, port: options.port ?? 443, servername, timeout: options.timeoutMs ?? 10_000 })
    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate(false) as PeerCertificate
      const result: TlsPeer = { certificate: new X509Certificate(peer.raw), authorized: socket.authorized }
      socket.end()
      resolve(result)
    })
    socket.once('timeout', () => socket.destroy(new Error(`TLS connection to ${servername} timed out`)))
    socket.once('error', reject)
  })
}

/** The AMQP 0-9-1 protocol header a client sends first. */
const AMQP_HEADER = Buffer.from([0x41, 0x4d, 0x51, 0x50, 0x00, 0x00, 0x09, 0x01])

/**
 * Sends the AMQP 0-9-1 protocol header over TLS (SNI `servername`, port 443) and returns the first frame the broker
 * answers with: a `connection.start` method frame from RabbitMQ when the TCP router reaches it.
 */
export function amqpHandshake(servername: string, options: { timeoutMs?: number } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: servername, port: 443, servername, timeout: options.timeoutMs ?? 10_000 })
    let received = Buffer.alloc(0)
    socket.once('secureConnect', () => socket.write(AMQP_HEADER))
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk])
      if (received.length < 7) return
      const size = received.readUInt32BE(3)
      if (received.length >= 7 + size + 1) {
        socket.destroy()
        resolve(received.subarray(0, 7 + size + 1))
      }
    })
    socket.once('timeout', () => socket.destroy(new Error(`no AMQP answer from ${servername}`)))
    socket.once('error', reject)
    socket.once('close', () => reject(new Error(`${servername} closed the connection after ${received.length} bytes`)))
  })
}

const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data, 'utf8').digest()

/** AWS Signature V4 headers for a body-less S3 request (path-style, unsigned query). */
export function s3SignedHeaders(
  method: string,
  url: URL,
  credentials: { accessKey: string; secretKey: string; region: string },
  now = new Date(),
): Record<string, string> {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  const day = amzDate.slice(0, 8)
  const payloadHash = sha256Hex('')
  const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }
  const signedHeaders = Object.keys(headers).sort().join(';')
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join('')
  const query = [...url.searchParams]
    .map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)])
    .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  const canonicalRequest = [method, url.pathname, query, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${day}/${credentials.region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretKey}`, day), credentials.region), 's3'), 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')
  return {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}
