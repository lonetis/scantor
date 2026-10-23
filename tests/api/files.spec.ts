import type { Analysis } from '#shared/types/analyses'
import type { FileDownload } from '#shared/types/exports'
import { ok } from '../helpers/api-client'
import { download, settleScan, sha256 } from '../helpers/api-results'
import { expect, test as fixturesTest } from '../fixtures'
import { apiResultsTest } from '../helpers/api-results-fixtures'

const test = apiResultsTest(fixturesTest)

// Analysis files (docs/api.md §4.15, docs/architecture.md §11.5): getFileDownload returns a presigned GET of
// SCANTOR_S3_PUBLIC_URL valid for 10 minutes, or redirects to it. The resultset task stores one text file per
// `file:<name>` item; its content is `report of <item>\n`.

test.describe('analysis files', () => {
  test('getFileDownload serves the exact bytes of a stored file, directly or as a redirect', { tag: ['@RES-017'] }, async ({ api, otherApi, resultset }) => {
    const scan = await resultset.start({ scanConfig: { items: ['file:report.txt', 'file:notes.md', 'plain'] } })
    await settleScan(api, scan.id)
    const [report, notes, plain] = await Promise.all(
      [0, 1, 2].map(async (seq) => ok(await api.call<Analysis>('getAnalysis', { path: { analysisId: `${scan.id}-${seq}` } }), 'getAnalysis')),
    )

    for (const [analysis, name] of [
      [report!, 'report.txt'],
      [notes!, 'notes.md'],
    ] as const) {
      const content = `report of file:${name}\n`
      const file = analysis.files[0]!
      expect(file).toEqual({ id: expect.any(String), name, size: Buffer.byteLength(content), sha256: sha256(content), contentType: 'text/plain' })

      const before = Date.now()
      const link = ok(await api.call<FileDownload>('getFileDownload', { path: { analysisId: analysis.id, fileId: file.id } }), 'getFileDownload')
      expect(link).toEqual({
        url: expect.any(String),
        expiresAt: expect.any(String),
        name,
        size: file.size,
        sha256: file.sha256,
        contentType: 'text/plain',
        inline: false,
      })
      expect(link.url.startsWith('https://s3.')).toBe(true)
      expect(Date.parse(link.expiresAt) - before).toBeGreaterThan(9 * 60_000)
      expect(Date.parse(link.expiresAt) - Date.now()).toBeLessThanOrEqual(10 * 60_000 + 5000)

      const fetched = await download(link.url)
      expect(fetched.status).toBe(200)
      expect(sha256(fetched.body)).toBe(file.sha256)
      expect(fetched.body.toString('utf8')).toBe(content)
      expect(fetched.headers['content-disposition']).toMatch(new RegExp(`^attachment; filename="${name.replace('.', '\\.')}"`))

      const redirect = await api.call('getFileDownload', { path: { analysisId: analysis.id, fileId: file.id }, query: { redirect: true } })
      expect(redirect.status).toBe(302)
      const followed = await download(redirect.headers.location!)
      expect(followed.status).toBe(200)
      expect(sha256(followed.body)).toBe(file.sha256)
    }

    // Unknown file ids, a file of another analysis, an analysis without files and another user are all 404.
    const missing: [string, string][] = [
      [report!.id, '00000000-0000-4000-8000-000000000000'],
      [report!.id, notes!.files[0]!.id],
      [plain!.id, report!.files[0]!.id],
      [`${scan.id}-99`, report!.files[0]!.id],
      [`${scan.id}-x`, report!.files[0]!.id],
      [report!.id, 'not-a-uuid'],
    ]
    for (const [analysisId, fileId] of missing) {
      const response = await api.call('getFileDownload', { path: { analysisId, fileId } })
      expect(response.status, `${analysisId} ${fileId}`).toBe(404)
      expect(response.body).toMatchObject({ error: { code: 'notFound' } })
    }
    const foreign = await otherApi.call('getFileDownload', { path: { analysisId: report!.id, fileId: report!.files[0]!.id } })
    expect(foreign.status).toBe(404)
  })
})
