import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parseConfig, setConfigForTesting } from '../../server/utils/config'
import {
  abortMultipartUpload,
  completeMultipartUpload,
  contentDisposition,
  createMultipartUpload,
  getObjectRange,
  headObject,
  isS3InvalidRange,
  isS3NotFound,
  lifecycleRules,
  presignInternalGet,
  presignPut,
  presignUploadPart,
  s3ErrorCode,
  safeName,
} from '../../server/utils/s3'

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

describe('presignInternalGet', () => {
  // The fast signer must produce exactly the URL of the SDK presigner (the one presignGet uses) for the same inputs.
  const KEYS = [
    'files/0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11/12/b2f1c0d9-8e7a-4b6c-9d5e-4f3a2b1c0d9e/e0c4b2a1-9f8e-4d7c-8b6a-5f4e3d2c1b0a/report.json',
    'script-runs/r/outputs/o/a b c.csv',
    'x/plus+sign/percent%25/%/tilde~/a',
    'unicode/ü-é-名前/🚀.txt',
    "reserved/!'()*@:;=,$&[]#?/end",
    'double//slash/./dot/../dotdot',
    'trailing/',
  ]
  const ENDPOINTS = ['http://rustfs:9000', 'https://s3.example.com', 'http://127.0.0.1:80']

  async function sdkUrl(endpoint: string, key: string, ttl: number, signingDate: Date, accessKey: string, secretKey: string): Promise<string> {
    const client = new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
    try {
      return await getSignedUrl(client, new GetObjectCommand({ Bucket: 'scantor', Key: key }), { expiresIn: ttl, signingDate })
    } finally {
      client.destroy()
    }
  }

  afterEach(() => setConfigForTesting(null))

  it.each(ENDPOINTS)('is byte-identical to the SDK presigner for %s', async (endpoint) => {
    const accessKey = 'scantor'
    const secretKey = 'rustfs/secret+key=='
    setConfigForTesting(
      parseConfig({ SCANTOR_S3_INTERNAL_URL: endpoint, SCANTOR_S3_ACCESS_KEY: accessKey, SCANTOR_S3_SECRET_KEY: secretKey, SCANTOR_S3_BUCKET: 'scantor' })
        .config,
    )
    const now = new Date('2026-01-02T03:04:05.678Z')
    for (const key of KEYS) {
      const ours = presignInternalGet(key, 3600, now)
      expect(ours.url, key).toBe(await sdkUrl(endpoint, key, 3600, now, accessKey, secretKey))
      expect(ours.expiresAt.toISOString()).toBe('2026-01-02T04:04:05.678Z')
    }
  })

  it('refreshes the cached signing key when the day or the secret changes', async () => {
    const config = (secret: string) =>
      parseConfig({
        SCANTOR_S3_INTERNAL_URL: 'http://rustfs:9000',
        SCANTOR_S3_ACCESS_KEY: 'ak with space',
        SCANTOR_S3_SECRET_KEY: secret,
        SCANTOR_S3_BUCKET: 'scantor',
      }).config
    const key = 'files/a/b.txt'
    const days = [new Date('2026-03-31T23:59:59Z'), new Date('2026-04-01T00:00:00Z'), new Date('2026-04-01T12:00:00Z')]
    for (const secret of ['first-secret', 'second-secret']) {
      setConfigForTesting(config(secret))
      for (const day of days) {
        expect(presignInternalGet(key, 60, day).url).toBe(await sdkUrl('http://rustfs:9000', key, 60, day, 'ak with space', secret))
      }
    }
  })

  it('signs only the host header for the internal endpoint', () => {
    setConfigForTesting(parseConfig({ SCANTOR_S3_INTERNAL_URL: 'http://rustfs:9000', SCANTOR_S3_PUBLIC_URL: 'https://s3.example.com' }).config)
    const url = new URL(presignInternalGet('files/x', 3600).url)
    expect(url.origin).toBe('http://rustfs:9000')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600')
    expect([...url.searchParams.keys()].some((name) => name.toLowerCase().startsWith('response-'))).toBe(false)
  })

  it('rejects validities SigV4 does not allow', () => {
    setConfigForTesting(parseConfig({}).config)
    for (const ttl of [0, -1, 1.5, 604_801]) expect(() => presignInternalGet('files/x', ttl)).toThrow(/invalid presigned URL validity/)
    expect(() => presignInternalGet('files/x', 604_800)).not.toThrow()
  })
})

describe('presignUploadPart', () => {
  afterEach(() => setConfigForTesting(null))

  it('signs Content-Length and returns it as the only header to send', async () => {
    setConfigForTesting(parseConfig({ SCANTOR_S3_INTERNAL_URL: 'http://rustfs:9000', SCANTOR_S3_BUCKET: 'scantor' }).config)
    const signed = await presignUploadPart({
      key: 'script-runs/r/outputs/o/out.csv',
      uploadId: 'upload/1+2',
      partNumber: 7,
      contentLength: 16 * 1024 ** 2,
      expiresInSeconds: 900,
      profile: 'internal',
    })
    const url = new URL(signed.url)
    expect(`${url.origin}${url.pathname}`).toBe('http://rustfs:9000/scantor/script-runs/r/outputs/o/out.csv')
    expect(url.searchParams.get('partNumber')).toBe('7')
    expect(url.searchParams.get('uploadId')).toBe('upload/1+2')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host')
    // No checksum parameters the uploader could not reproduce.
    expect([...url.searchParams.keys()].filter((name) => /checksum/i.test(name))).toEqual([])
    expect(signed.headers).toEqual({ 'Content-Length': String(16 * 1024 ** 2) })
  })
})

describe('multipart uploads and headObject', () => {
  // A fake S3 endpoint on loopback recording the multipart calls.
  const calls: { method: string; path: string; query: URLSearchParams; body: string; headers: IncomingMessage['headers'] }[] = []
  let failNext: { status: number; code: string } | null = null
  let server: Server

  const xmlError = (res: ServerResponse, status: number, code: string) => {
    res.writeHead(status, { 'Content-Type': 'application/xml' })
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`)
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://s3')
        calls.push({ method: req.method ?? '', path: url.pathname, query: url.searchParams, body: Buffer.concat(chunks).toString(), headers: req.headers })
        if (failNext) {
          const { status, code } = failNext
          failNext = null
          xmlError(res, status, code)
          return
        }
        if (req.method === 'POST' && url.searchParams.has('uploads')) {
          res.writeHead(200, { 'Content-Type': 'application/xml' })
          res.end(
            '<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>scantor</Bucket><Key>k</Key><UploadId>up-1</UploadId></InitiateMultipartUploadResult>',
          )
        } else if (req.method === 'POST' && url.searchParams.has('uploadId')) {
          res.writeHead(200, { 'Content-Type': 'application/xml' })
          res.end(
            '<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Bucket>scantor</Bucket><Key>k</Key><ETag>"e"</ETag></CompleteMultipartUploadResult>',
          )
        } else if (req.method === 'DELETE') {
          res.writeHead(204)
          res.end()
        } else if (req.method === 'HEAD' && url.pathname === '/scantor/present') {
          res.writeHead(200, { 'Content-Length': '1234', 'Content-Type': 'text/csv', 'x-amz-meta-output-id': 'o1' })
          res.end()
        } else if (req.method === 'HEAD') {
          res.writeHead(404)
          res.end()
        } else xmlError(res, 400, 'BadRequest')
      })
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
    calls.length = 0
    failNext = null
  })

  it('creates an upload with type and metadata and returns its id', async () => {
    expect(await createMultipartUpload('script-runs/r/outputs/o/out.csv', 'text/csv', { 'output-id': 'o', name: 'out.csv' })).toBe('up-1')
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/scantor/script-runs/r/outputs/o/out.csv' })
    expect(calls[0]!.headers['content-type']).toBe('text/csv')
    expect(calls[0]!.headers['x-amz-meta-output-id']).toBe('o')
  })

  it('completes an upload with the parts sorted by part number', async () => {
    await completeMultipartUpload('k', 'up-1', [
      { partNumber: 2, etag: '"b"' },
      { partNumber: 1, etag: '"a"' },
    ])
    expect(calls[0]!.query.get('uploadId')).toBe('up-1')
    expect(calls[0]!.body.replace(/\s/g, '')).toContain(
      '<Part><ETag>&quot;a&quot;</ETag><PartNumber>1</PartNumber></Part><Part><ETag>&quot;b&quot;</ETag><PartNumber>2</PartNumber></Part>',
    )
  })

  it('surfaces S3 error codes of a failed completion', async () => {
    failNext = { status: 400, code: 'InvalidPart' }
    const error = await completeMultipartUpload('k', 'up-1', [{ partNumber: 1, etag: '"a"' }]).catch((thrown: unknown) => thrown)
    expect(s3ErrorCode(error)).toBe('InvalidPart')
    expect(s3ErrorCode(new Error('plain'))).toBeNull()
  })

  it('aborts an upload and treats a vanished upload as aborted', async () => {
    await abortMultipartUpload('k', 'up-1')
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/scantor/k' })
    failNext = { status: 404, code: 'NoSuchUpload' }
    await expect(abortMultipartUpload('k', 'up-2')).resolves.toBeUndefined()
    failNext = { status: 403, code: 'AccessDenied' }
    await expect(abortMultipartUpload('k', 'up-3')).rejects.toBeTruthy()
  })

  it('reads size, type and metadata of an object, or null when it is missing', async () => {
    expect(await headObject('present')).toEqual({ size: 1234, contentType: 'text/csv', metadata: { 'output-id': 'o1' } })
    expect(await headObject('absent')).toBeNull()
  })
})
