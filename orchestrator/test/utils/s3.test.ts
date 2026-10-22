import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig, setConfigForTesting } from '../../server/utils/config'
import { contentDisposition, lifecycleRules, presignPut, safeName } from '../../server/utils/s3'

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
