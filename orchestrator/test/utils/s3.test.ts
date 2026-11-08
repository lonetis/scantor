import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parseConfig, setConfigForTesting } from '../../server/utils/config'
import { contentDisposition, getObjectRange, isS3InvalidRange, isS3NotFound, lifecycleRules, presignPut, safeName } from '../../server/utils/s3'

// S3 key and download helpers (docs/data-model.md §9, security.md DL-1).

describe('safeName', () => {
  it.each([
    ['report.json', 'report.json'],
    ['screen shot (1).png', 'screen_shot__1_.png'],
    ['../../etc/passwd', '.._.._etc_passwd'],
    ['.', '_'],
    ['..', '__'],
    ['', '_'],
    ['ü-é.txt', '_-_.txt'],
    ['x'.repeat(300), 'x'.repeat(128)],
  ])('%j → %j', (input, expected) => {
    expect(safeName(input)).toBe(expected)
  })
})

describe('contentDisposition', () => {
  it('sanitises the fallback and encodes the UTF-8 name (RFC 5987)', () => {
    expect(contentDisposition('attachment', 'rapport "final"\r\n.html')).toBe(
      `attachment; filename="rapport__final___.html"; filename*=UTF-8''rapport%20_final___.html`,
    )
    expect(contentDisposition('inline', 'bild-ü.png')).toBe(`inline; filename="bild-_.png"; filename*=UTF-8''bild-%C3%BC.png`)
  })
})

describe('lifecycleRules', () => {
  it('expires test runs, exports and tmp/ and aborts incomplete uploads', () => {
    const rules = lifecycleRules({ testRunRetentionDays: 7, exportRetentionDays: 3 })
    expect(rules.map((rule) => [rule.Filter.Prefix, rule.Expiration?.Days ?? null])).toEqual([
      ['test-runs/', 7],
      ['exports/', 3],
      ['tmp/', 1],
      ['', null],
    ])
    expect(rules.at(-1)?.AbortIncompleteMultipartUpload).toEqual({ DaysAfterInitiation: 1 })
  })
})

describe('presignPut', () => {
  afterEach(() => setConfigForTesting(null))

  it('signs Content-Type, Content-Length and the metadata as headers and returns every header to send', async () => {
    setConfigForTesting(parseConfig({ SCANTOR_S3_PUBLIC_URL: 'https://s3.example.com', SCANTOR_S3_BUCKET: 'scantor' }).config)
    const signed = await presignPut({
      key: 'files/s/1/e/f/report.json',
      contentType: 'application/json',
      contentLength: 42,
      expiresInSeconds: 900,
      profile: 'public',
      metadata: { 'file-id': 'f', name: 'r%C3%A9port.json' },
    })
    const url = new URL(signed.url)
    expect(`${url.origin}${url.pathname}`).toBe('https://s3.example.com/scantor/files/s/1/e/f/report.json')
    // RustFS ignores hoisted metadata and refuses unsigned x-amz-meta-* headers (rustfs 1.0.3).
    expect([...url.searchParams.keys()].filter((name) => name.toLowerCase().startsWith('x-amz-meta-'))).toEqual([])
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(['content-length', 'content-type', 'host', 'x-amz-meta-file-id', 'x-amz-meta-name'])
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(signed.headers).toEqual({
      'Content-Type': 'application/json',
      'Content-Length': '42',
      'x-amz-meta-file-id': 'f',
      'x-amz-meta-name': 'r%C3%A9port.json',
    })
  })

  it('signs only Content-Type and Content-Length without metadata', async () => {
    setConfigForTesting(parseConfig({}).config)
    const signed = await presignPut({ key: 'tmp/x', contentType: 'text/plain', contentLength: 1, expiresInSeconds: 60, profile: 'internal' })
    expect(new URL(signed.url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host')
    expect(signed.headers).toEqual({ 'Content-Type': 'text/plain', 'Content-Length': '1' })
  })
})

describe('getObjectRange', () => {
  // A fake S3 endpoint on loopback: GET /scantor/<key> answers with the handler of the key.
  const OBJECT = Buffer.from('0123456789')
  const requests: { url: string; range: string | undefined }[] = []
  const handlers: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {
    // honours the range like RustFS
    ranged: (req, res) => {
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')!
      if (Number(start) >= OBJECT.length) {
        res.writeHead(416, { 'Content-Type': 'application/xml', 'Content-Range': `bytes */${OBJECT.length}` })
        res.end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>InvalidRange</Code><Message>The requested range is not satisfiable</Message></Error>')
        return
      }
      const body = OBJECT.subarray(Number(start), Number(end) + 1)
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${Number(start) + body.length - 1}/${OBJECT.length}`, 'Content-Length': body.length })
      res.end(body)
    },
    // ignores the range and sends the whole object
    whole: (_req, res) => {
      res.writeHead(200, { 'Content-Length': OBJECT.length })
      res.end(OBJECT)
    },
    missing: (_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/xml' })
      res.end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>')
    },
  }
  let server: Server

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push({ url: req.url ?? '', range: req.headers.range })
      const key = new URL(req.url ?? '/', 'http://s3').pathname.replace(/^\/scantor\//, '')
      ;(handlers[key] ?? handlers.missing!)(req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    setConfigForTesting(parseConfig({ SCANTOR_S3_INTERNAL_URL: `http://127.0.0.1:${port}`, SCANTOR_S3_BUCKET: 'scantor' }).config)
  })

  afterAll(async () => {
    setConfigForTesting(null)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  afterEach(() => {
    requests.length = 0
  })

  it('sends a Range header and returns exactly the requested bytes', async () => {
    expect((await getObjectRange('ranged', 2, 5)).toString()).toBe('2345')
    expect(requests.map((request) => request.range)).toEqual(['bytes=2-5'])
    expect(new URL(requests[0]!.url, 'http://s3').pathname).toBe('/scantor/ranged')
  })

  it('returns fewer bytes when the object is shorter than the range', async () => {
    expect((await getObjectRange('ranged', 8, 20)).toString()).toBe('89')
  })

  it('reads at most the requested length from a server that sends more', async () => {
    expect((await getObjectRange('whole', 0, 3)).toString()).toBe('0123')
  })

  it('refuses a response that ignored the range of a non-zero start', async () => {
    await expect(getObjectRange('whole', 4, 6)).rejects.toThrow(/answered range \(none\) for bytes 4-6 of whole/)
  })

  it('surfaces a missing object as an S3 not-found error', async () => {
    const error = await getObjectRange('gone', 0, 1).catch((thrown: unknown) => thrown)
    expect(isS3NotFound(error)).toBe(true)
  })

  it('surfaces a range that starts at the end of the object as an S3 invalid-range error', async () => {
    const error = await getObjectRange('ranged', 10, 12).catch((thrown: unknown) => thrown)
    expect(isS3InvalidRange(error)).toBe(true)
    expect(isS3NotFound(error)).toBe(false)
  })

  it('rejects invalid ranges without a request', async () => {
    for (const [start, end] of [
      [-1, 3],
      [5, 4],
      [0.5, 3],
    ]) {
      await expect(getObjectRange('ranged', start!, end!)).rejects.toThrow(/invalid byte range/)
    }
    expect(requests).toEqual([])
  })
})
