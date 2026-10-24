import { request as playwrightRequest, type APIRequestContext } from '@playwright/test'
import type { Analysis } from '#shared/types/analyses'
import type { Export, FileDownload } from '#shared/types/exports'
import type { FileRef } from '#shared/types/common'
import { ok, type ApiClient } from '../helpers/api-client'
import { stackEnv } from '../helpers/docker'
import { presignS3Get } from '../helpers/security'
import { FILE_TYPES } from '../helpers/security-tasks'
import { withSecurityTenants, type SharedTasks } from '../helpers/security-tenants'
import { expect, test as base } from '../fixtures'

// The tenant fixtures of the security specs (helpers/security-tenants.ts).
const test = withSecurityTenants(base)

// Downloads and exports (docs/security.md §6.15 DL-1…DL-5, GUI-5): presigned GETs on the public S3 origin that force a
// safe Content-Type and Content-Disposition, live ten minutes, and a private bucket that answers only signed requests
// and CORS preflights from the dashboard origin. The tasks and their completed scans are shared per worker (they are
// only read here).

const DOWNLOAD_TTL_SECONDS = 600
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** The completed one-analysis scan of hostile-output (files x.html, x.svg, x.png and a name with CR/LF/quotes). */
const hostileScan = (shared: SharedTasks) =>
  shared.completedScan('hostile-output', async () => ({ revision: (await shared.fixture('hostile-output')).revision.ref }))

/** The completed one-analysis scan of the probe task in mode `files` (one file per FILE_TYPES entry). */
const fileTypesScan = (shared: SharedTasks) =>
  shared.completedScan('file-types', async () => ({ revision: (await shared.probe()).revision.ref, taskConfig: { mode: 'files' } }))

/** The files of the scan's only analysis by name. */
async function filesOf(api: ApiClient, scanId: string): Promise<{ analysis: Analysis; files: Map<string, FileRef> }> {
  const [analysis] = ok(await api.call<{ items: Analysis[] }>('listAnalyses', { path: { scanId } }), 'listAnalyses').items
  expect(analysis?.status, JSON.stringify(analysis)).toBe('succeeded')
  return { analysis: analysis!, files: new Map((analysis!.files as FileRef[]).map((file) => [file.name, file])) }
}

function expectTenMinutes(url: string, expiresAt: string): void {
  const signed = new URL(url)
  expect(signed.searchParams.get('X-Amz-Expires')).toBe(String(DOWNLOAD_TTL_SECONDS))
  const remaining = (Date.parse(expiresAt) - Date.now()) / 1000
  expect(remaining).toBeGreaterThan(DOWNLOAD_TTL_SECONDS - 60)
  expect(remaining).toBeLessThanOrEqual(DOWNLOAD_TTL_SECONDS + 5)
}

test.describe('downloads', () => {
  // A context without default headers (no Origin, no cookies): what a browser tab opening the URL sends.
  let bare: APIRequestContext
  test.beforeEach(async () => {
    bare = await playwrightRequest.newContext({ extraHTTPHeaders: {} })
  })
  test.afterEach(async () => {
    await bare?.dispose()
  })

  /** Mints a download URL for one file and fetches it like a browser tab. */
  async function download(env: { publicUrl: string }, api: ApiClient, analysis: Analysis, file: FileRef) {
    const location = ok(await api.call<FileDownload>('getFileDownload', { path: { analysisId: analysis.id, fileId: file.id } }), 'getFileDownload')
    expect(new URL(location.url).origin, 'served from the S3 origin, never the dashboard').toBe(new URL(stackEnv().SCANTOR_S3_PUBLIC_URL!).origin)
    expect(new URL(location.url).origin).not.toBe(env.publicUrl)
    expectTenMinutes(location.url, location.expiresAt)
    const response = await bare.get(location.url)
    expect(response.status(), file.name).toBe(200)
    return { location, headers: response.headers(), body: await response.body() }
  }

  test(
    'hostile-output files: png inline as image/png, html and svg as octet-stream attachments, names sanitised',
    { tag: ['@RES-018', '@RES-019'] },
    async ({ env, api, shared }) => {
      const { analysis, files } = await filesOf(api, (await hostileScan(shared)).id)
      expect([...files.keys()].sort()).toEqual(['bad\r\nname "quoted" \'single\'.txt', 'x.html', 'x.png', 'x.svg'].sort())

      for (const name of ['x.html', 'x.svg']) {
        const { location, headers, body } = await download(env, api, analysis, files.get(name)!)
        expect(location.inline, name).toBe(false)
        expect(headers['content-type'], name).toBe('application/octet-stream')
        expect(headers['content-disposition'], name).toBe(`attachment; filename="${name}"; filename*=UTF-8''${name}`)
        expect(body.toString('utf8')).toContain('<script>')
      }
      const png = await download(env, api, analysis, files.get('x.png')!)
      expect(png.location.inline).toBe(true)
      expect(png.headers['content-type']).toBe('image/png')
      expect(png.headers['content-disposition']).toBe(`inline; filename="x.png"; filename*=UTF-8''x.png`)
      expect(png.body.subarray(1, 4).toString('latin1')).toBe('PNG')

      // CR, LF and quotes never reach the header: the ASCII name has no quote inside, the RFC 5987 form is encoded.
      const odd = await download(env, api, analysis, files.get('bad\r\nname "quoted" \'single\'.txt')!)
      const disposition = odd.headers['content-disposition']!
      expect(disposition).not.toMatch(/[\r\n]/)
      const match = /^attachment; filename="([^"]*)"; filename\*=UTF-8''(\S+)$/.exec(disposition)
      expect(match, disposition).not.toBeNull()
      expect(match![1]).not.toMatch(/["\r\n]/)
      expect(match![2]).toMatch(/^[A-Za-z0-9%._~!$&+,;=:@-]+$/)
      expect(decodeURIComponent(match![2]!)).not.toMatch(/["\r\n]/)
      expect(odd.headers['content-type']).toBe('application/octet-stream')

      // A redirect form exists for browsers; it points at the S3 origin as well.
      const redirect = await api.call('getFileDownload', { path: { analysisId: analysis.id, fileId: files.get('x.png')!.id }, query: { redirect: true } })
      expect(redirect.status).toBe(302)
      expect(new URL(redirect.headers['location']!).origin).toBe(new URL(stackEnv().SCANTOR_S3_PUBLIC_URL!).origin)
    },
  )

  test(
    'jpeg, gif and webp are served inline with their type; json, pdf, text and scripts as attachments',
    { tag: ['@RES-018'] },
    async ({ env, api, shared }) => {
      const { analysis, files } = await filesOf(api, (await fileTypesScan(shared)).id)
      expect([...files.keys()].sort()).toEqual(Object.keys(FILE_TYPES).sort())
      for (const [name, contentType] of Object.entries(FILE_TYPES)) {
        const { location, headers, body } = await download(env, api, analysis, files.get(name)!)
        expect(body.toString('utf8')).toBe(`content of ${name}`)
        if (INLINE_TYPES.has(contentType)) {
          expect(location.inline, name).toBe(true)
          expect(headers['content-type'], name).toBe(contentType)
          expect(headers['content-disposition'], name).toBe(`inline; filename="${name}"; filename*=UTF-8''${name}`)
        } else {
          expect(location.inline, name).toBe(false)
          expect(headers['content-type'], name).toBe('application/octet-stream')
          expect(headers['content-disposition'], name).toBe(`attachment; filename="${name}"; filename*=UTF-8''${name}`)
        }
      }
    },
  )

  test(
    'exports and revision sources download as attachments; unsigned, tampered and expired URLs are refused',
    { tag: ['@RES-019', '@SEC-017'] },
    async ({ api, shared }) => {
      const scan = await hostileScan(shared)
      const { task, revision } = await shared.fixture('hostile-output')

      const exported = await api.call<Export>('exportScan', { path: { scanId: scan.id }, body: { format: 'csv' }, query: { wait: 60 } })
      expect(exported.status).toBe(201)
      expect(exported.body.state).toBe('ready')
      expect(new URL(exported.body.download!.url).origin).toBe(new URL(stackEnv().SCANTOR_S3_PUBLIC_URL!).origin)
      expectTenMinutes(exported.body.download!.url, exported.body.download!.expiresAt)
      const csv = await bare.get(exported.body.download!.url)
      expect(csv.status()).toBe(200)
      expect(csv.headers()['content-disposition']).toMatch(/^attachment; /)
      expect(csv.headers()['content-type']).toBe('application/octet-stream')

      const source = await api.call<{ url: string; expiresAt: string }>('downloadRevisionSource', {
        path: { task: task.name, revision: revision.id },
        query: { redirect: false },
      })
      expect(source.status, JSON.stringify(source.body)).toBe(200)
      expectTenMinutes(source.body.url, source.body.expiresAt)
      const snapshot = await bare.get(source.body.url)
      expect(snapshot.status()).toBe(200)
      expect(snapshot.headers()['content-type']).toBe('application/gzip')
      expect(snapshot.headers()['content-disposition']).toMatch(/^attachment; /)
      expect((await snapshot.body()).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))

      // The bucket is private: the same object without a signature, or with a tampered one, is refused.
      const signed = new URL(source.body.url)
      const unsigned = await bare.get(`${signed.origin}${signed.pathname}`)
      expect(unsigned.status()).toBe(403)
      const tampered = new URL(source.body.url)
      tampered.searchParams.set('X-Amz-Expires', '604800')
      expect((await bare.get(tampered.toString())).status()).toBe(403)

      // A correctly signed URL whose ten minutes are over is refused (signed white-box with the stack's S3 key).
      const stack = stackEnv()
      const credentials = {
        endpoint: stack.SCANTOR_S3_PUBLIC_URL!,
        accessKey: stack.SCANTOR_S3_ACCESS_KEY!,
        secretKey: stack.SCANTOR_S3_SECRET_KEY!,
        path: signed.pathname,
      }
      const fresh = await bare.get(presignS3Get({ ...credentials, expiresSeconds: DOWNLOAD_TTL_SECONDS }))
      expect(fresh.status(), 'the white-box signature is valid').toBe(200)
      const expired = await bare.get(presignS3Get({ ...credentials, expiresSeconds: DOWNLOAD_TTL_SECONDS, signedAt: new Date(Date.now() - 11 * 60_000) }))
      expect(expired.status()).toBe(403)
      expect(await expired.text()).toMatch(/expired/i)
    },
  )

  test(
    'the bucket answers CORS preflights only from the dashboard origin, and only for GET',
    { tag: ['@SEC-017', '@TOOLS-004'] },
    async ({ env, api, shared }) => {
      const { task, revision } = await shared.fixture('hostile-output')
      const source = ok(
        await api.call<{ url: string }>('downloadRevisionSource', { path: { task: task.name, revision: revision.id }, query: { redirect: false } }),
        'downloadRevisionSource',
      )
      const preflight = (origin: string, method = 'GET') =>
        bare.fetch(source.url, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': method } })

      const foreign = await preflight('https://evil.example')
      expect(foreign.status()).toBeGreaterThanOrEqual(400)
      expect(foreign.headers()['access-control-allow-origin']).toBeUndefined()
      for (const origin of [env.editorUrl, `https://s3.${env.domain}`, 'null']) {
        expect((await preflight(origin)).headers()['access-control-allow-origin'], origin).toBeUndefined()
      }

      const dashboard = await preflight(env.publicUrl)
      expect(dashboard.status()).toBeLessThan(300)
      expect(dashboard.headers()['access-control-allow-origin']).toBe(env.publicUrl)
      expect(dashboard.headers()['access-control-allow-methods'] ?? '').toMatch(/GET/)
      expect(dashboard.headers()['access-control-allow-methods'] ?? '').not.toMatch(/PUT|DELETE|POST/)
      for (const method of ['PUT', 'DELETE']) expect((await preflight(env.publicUrl, method)).headers()['access-control-allow-origin'], method).toBeUndefined()
    },
  )
})
