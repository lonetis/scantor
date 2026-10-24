import { createHash } from 'node:crypto'
import type { Analysis } from '#shared/types/analyses'
import type { FileRef } from '#shared/types/common'
import type { FileDownload } from '#shared/types/exports'
import { ok, type ApiClient } from '../helpers/api-client'
import { stackEnv } from '../helpers/docker'
import { allAnalyses, backoff, pollUntil, settings } from '../helpers/e2e-runtime'
import { extendRuntime } from '../helpers/e2e-runtime-fixtures'
import { writeGeneratedTask, type ProbeConfig } from '../helpers/e2e-runtime-tasks'
import { cancelAndDeleteScan, startScan, waitForScanState } from '../helpers/scans'
import { packTask, removeDir, waitForRevision } from '../helpers/tasks'
import { expect, test as base, unique } from '../fixtures'

// Files of analyses end to end (docs/runtime.md §8.4, §8.8; docs/protocol.md §5.6; docs/guide/authoring-python.md
// "Files"): `ctx.files.put` returns FileRefs, the runtime enforces the per-analysis limits, uploads happen only
// after a successful run, and FileRefs anywhere in the result are recorded at the revision's `fileRefPaths` and can
// be downloaded through presigned URLs. The runs come from the generated `probe` task, published once per run
// (helpers/e2e-runtime-fixtures.ts).

const test = extendRuntime(base)

test.describe.configure({ timeout: 180_000 })

test.beforeAll(async ({ shared }) => {
  // Publishing builds images; the stack builds at most SCANTOR_BUILD_CONCURRENCY of them at a time for every user.
  test.setTimeout(300_000)
  await Promise.all([shared.generated('probe')])
})

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

/** Downloads a file of an analysis through its presigned URL; returns the bytes and the download description. */
async function download(api: ApiClient, analysisId: string, fileId: string): Promise<{ meta: FileDownload; body: Buffer }> {
  const meta = ok(await api.call<FileDownload>('getFileDownload', { path: { analysisId, fileId } }), 'getFileDownload')
  // A plain fetch: the presigned URL carries its own signature and must not get the API key header.
  const response = await fetch(meta.url)
  expect(response.status, meta.url).toBe(200)
  return { meta, body: Buffer.from(await response.arrayBuffer()) }
}

async function onlyAnalysis(api: ApiClient, scanId: string): Promise<Analysis> {
  const analyses = await allAnalyses(api, scanId)
  expect(analyses).toHaveLength(1)
  return analyses[0]!
}

const fileRef = (name: string, contentType: string, content: string) => ({
  id: expect.stringMatching(/^[0-9a-f-]{36}$/),
  name,
  size: Buffer.byteLength(content),
  sha256: sha256(content),
  contentType,
})

test.describe('file references', () => {
  test(
    'ctx.files.put returns FileRefs that are recorded wherever the result holds them and can be downloaded',
    { tag: ['@RT-015', '@RT-016'] },
    async ({ api, shared, scans }) => {
      const { revision } = await shared.generated('probe')
      // FileRefs at the top level, nested in an object and in a list nested in an object.
      expect(revision.description?.fileRefPaths).toEqual(expect.arrayContaining(['/files/*', '/nested/file', '/nested/more/*']))
      const scan = await scans.start({ revision: revision.ref, taskConfig: { mode: 'files', count: 2 }, scanConfig: { times: 1 } })
      await scans.wait(scan.id, { timeoutMs: 120_000 })
      const analysis = await onlyAnalysis(api, scan.id)
      expect(analysis.status).toBe('succeeded')
      const result = analysis.result as { files: FileRef[]; nested: { file: FileRef; more: FileRef[] } }
      expect(result.files).toEqual([fileRef('file-0.txt', 'text/plain', 'file 0\n'), fileRef('file-1.txt', 'text/plain', 'file 1\n')])
      // No content type given: application/octet-stream.
      expect(result.nested.file).toEqual(fileRef('nested.bin', 'application/octet-stream', 'nested'))
      expect(result.nested.more).toEqual([fileRef('more-0.json', 'application/json', '{"n": 0}')])

      // Every registered file is listed with the analysis, exactly as the FileRefs in the result.
      const refs = [...result.files, result.nested.file, ...result.nested.more]
      expect([...analysis.files].sort((a, b) => a.name.localeCompare(b.name))).toEqual([...refs].sort((a, b) => a.name.localeCompare(b.name)))
      for (const ref of refs) {
        const { meta, body } = await download(api, analysis.id, ref.id)
        expect(meta).toMatchObject({ name: ref.name, size: ref.size, sha256: ref.sha256, contentType: ref.contentType })
        expect(sha256(body)).toBe(ref.sha256)
      }
    },
  )

  test('files of failed attempts are never uploaded', { tag: ['@RT-016'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('probe')
    // Each attempt stores attempt-<n>.txt; the first attempt then fails, the second succeeds.
    const taskConfig: ProbeConfig = { mode: 'flaky_files', fail_attempts: 1 }
    const scan = await scans.start({
      revision: revision.ref,
      taskConfig: { ...taskConfig },
      scanConfig: { times: 1 },
      settings: settings({ maxAttempts: 2, backoff: backoff(1000) }),
    })
    await scans.wait(scan.id, { timeoutMs: 120_000 })
    const analysis = await onlyAnalysis(api, scan.id)
    expect(analysis).toMatchObject({ status: 'succeeded', attempt: 2 })
    expect(analysis.attempts.map((a) => [a.attempt, a.error?.message ?? null])).toEqual([
      [1, 'RuntimeError: probe failure after storing a file'],
      [2, null],
    ])
    expect(analysis.files).toEqual([fileRef('attempt-2.txt', 'text/plain', 'attempt 2\n')])
    expect((analysis.result as { files: FileRef[] }).files).toEqual(analysis.files)
    expect((await download(api, analysis.id, analysis.files[0]!.id)).body.toString('utf8')).toBe('attempt 2\n')
  })
})

test.describe('file limits', () => {
  test('too many files or a file above the size limit raise a validation error in user code', { tag: ['@RT-015'] }, async ({ api, shared, scans }) => {
    const { revision } = await shared.generated('probe')
    const stack = stackEnv()
    expect(stack.SCANTOR_MAX_FILES_PER_ANALYSIS).toBe('100')
    expect(stack.SCANTOR_MAX_FILE_BYTES).toBe('1GiB')
    // Iteration 0 stores 101 files, iteration 1 a sparse file of 1 GiB + 1 byte.
    const limits = (caught: boolean): ProbeConfig => ({
      mode: 'too_many_files',
      iterations: [0],
      others: 'big_file',
      count: 101,
      bytes: 1024 ** 3 + 1,
      catch: caught,
    })
    const retried = settings({ maxAttempts: 2, backoff: backoff(1000) })
    const [caught, uncaught] = await Promise.all([
      scans.start({ revision: revision.ref, taskConfig: { ...limits(true) }, scanConfig: { times: 2 }, settings: retried }),
      scans.start({ revision: revision.ref, taskConfig: { ...limits(false) }, scanConfig: { times: 2 }, settings: retried }),
    ])
    await Promise.all([scans.wait(caught.id, { timeoutMs: 120_000 }), scans.wait(uncaught.id, { timeoutMs: 120_000 })])

    // Caught in user code: the analysis succeeds and reports the error it saw.
    const [tooMany, tooBig] = await allAnalyses(api, caught.id)
    expect(tooMany!.status).toBe('succeeded')
    const [type, retryable, message] = String((tooMany!.result as { note: string }).note).split('|')
    expect({ type, retryable }).toEqual({ type: 'validation', retryable: 'False' })
    expect(message).toContain('100')
    expect(tooBig!.status).toBe('succeeded')
    expect((tooBig!.result as { note: string }).note).toMatch(/^validation\|False\|.*sparse\.bin.*1073741825.*1073741824/)

    // Uncaught: the analysis fails at once with the validation error, without retries.
    for (const analysis of await allAnalyses(api, uncaught.id)) {
      expect(analysis).toMatchObject({ status: 'failed', attempt: 1, error: { type: 'validation', retryable: false } })
      expect(analysis.attempts).toHaveLength(1)
      expect(analysis.files).toEqual([])
    }
  })
})

/** SCANTOR_USER_STORAGE_QUOTA_BYTES of the stack in bytes (`0` = unlimited; units as in .env.example). */
function storageQuotaBytes(): number {
  const raw = (stackEnv().SCANTOR_USER_STORAGE_QUOTA_BYTES ?? '0').trim()
  const match = /^(\d+)\s*(B|KiB|MiB|GiB|TiB)?$/.exec(raw)
  if (!match) throw new Error(`unexpected SCANTOR_USER_STORAGE_QUOTA_BYTES ${JSON.stringify(raw)}`)
  const units: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 }
  return Number(match[1]) * units[match[2] ?? 'B']!
}

test.describe('storage quota', () => {
  // The quota is an instance setting (SCANTOR_USER_STORAGE_QUOTA_BYTES) that applies to every user; the shared test
  // stack runs without one (stack.env), and no test may change it for the other tenants. The test runs once the stack
  // sets a quota of at most one file's size (SCANTOR_MAX_FILE_BYTES); the fixture-free conditions are evaluated before
  // the fresh user is created.
  test.skip(() => storageQuotaBytes() === 0, 'SCANTOR_USER_STORAGE_QUOTA_BYTES is 0 (unlimited) on this stack')
  test.skip(() => storageQuotaBytes() > 1024 ** 3, 'the quota is larger than one file may be (SCANTOR_MAX_FILE_BYTES)')

  test(
    'an upload above the owner storage quota fails the analysis; retry-failed runs it again once storage is free',
    { tag: ['@RT-017'] },
    async ({ freshApi: api }) => {
      // Builds a task of the fresh user and waits for the measured storage usage to refresh.
      test.setTimeout(360_000)
      const quota = storageQuotaBytes()
      // A fresh user starts without stored files; its tasks are purged with it.
      const dir = await writeGeneratedTask('probe')
      const name = unique('probe-quota')
      const scanIds: string[] = []
      try {
        const uploaded = ok(await api.uploadTask(await packTask(dir, { name }), { publish: true, wait: 120 }), 'uploadTask')
        const revision = await waitForRevision(api, uploaded.task.id, uploaded.revision!.id)
        expect(revision.state).toBe('ready')
        // Each analysis stores one file of 60 % of the quota: the first fits, the second does not.
        const size = Math.ceil(quota * 0.6)
        const body = { revision: revision.ref, taskConfig: { mode: 'big_file', bytes: size }, scanConfig: { times: 1 } }
        const first = await startScan(api, body)
        scanIds.push(first.id)
        await waitForScanState(api, first.id, 'completed', 240_000)
        expect((await onlyAnalysis(api, first.id)).status).toBe('succeeded')

        const second = await startScan(api, body)
        scanIds.push(second.id)
        await waitForScanState(api, second.id, 'completed', 240_000)
        const rejected = await onlyAnalysis(api, second.id)
        expect(rejected).toMatchObject({
          status: 'failed',
          attempt: 1,
          error: { type: 'platform', phase: 'upload', retryable: false, message: expect.stringContaining('storage quota exceeded') },
        })
        expect(rejected.files).toEqual([])

        // Free the storage: deleting the first scan removes its files from the owner's usage, which the presign route
        // measures again after a while; retry-failed runs the analysis again until a run fits the quota.
        await cancelAndDeleteScan(api, first.id, { waitForJob: true })
        const retried = await pollUntil(
          'a retried analysis within the freed quota',
          async () => {
            const retry = await api.call('retryFailedAnalyses', { path: { scanId: second.id } })
            expect(retry.status, JSON.stringify(retry.body)).toBe(202)
            await waitForScanState(api, second.id, 'completed', 120_000)
            return onlyAnalysis(api, second.id)
          },
          (analysis) => analysis.status === 'succeeded' || !analysis.error?.message.includes('storage quota exceeded'),
          { timeoutMs: 240_000, intervalMs: 5000 },
        )
        expect(retried).toMatchObject({ status: 'succeeded', files: [expect.objectContaining({ name: 'sparse.bin', size })] })
        expect(retried.round).toBeGreaterThanOrEqual(2)
      } finally {
        for (const scanId of scanIds.reverse()) await cancelAndDeleteScan(api, scanId, { waitForJob: true })
        await removeDir(dir)
      }
    },
  )
})
