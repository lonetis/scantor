import { S3ServiceException } from '@aws-sdk/client-s3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScriptRunDoc, ScriptRunOutputDoc } from '../../../server/types/documents'
import { parseConfig, setConfigForTesting } from '../../../server/utils/config'
import { OWNER, RUN, SCAN, SCRIPT } from './helpers'

// The output state machine of script runs (docs/scripts.md): create (idempotent on the name), presigned parts within
// the quota and the per-run cap, complete (HEAD size, idempotent), URLs of stored outputs of the run and of the run a
// resumed run continues, and the abort of outputs a run left pending.

const s3 = vi.hoisted(() => ({
  createMultipartUpload: vi.fn(async () => 'upload-1'),
  presignUploadPart: vi.fn(async (options: { contentLength: number }) => ({
    url: 'http://rustfs:9000/part',
    headers: { 'Content-Length': String(options.contentLength) },
    expiresAt: new Date('2026-01-01T00:15:00Z'),
  })),
  completeMultipartUpload: vi.fn(async () => undefined),
  abortMultipartUpload: vi.fn(async () => undefined),
  headObject: vi.fn(async (): Promise<{ size: number; contentType: string | null; metadata: Record<string, string> } | null> => ({
    size: 100,
    contentType: 'text/csv',
    metadata: {},
  })),
  deleteObject: vi.fn(async () => undefined),
}))
const quota = vi.hoisted(() => ({ reserveStorage: vi.fn(async () => undefined) }))

vi.mock('../../../server/utils/s3', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../server/utils/s3')>()), ...s3 }))
vi.mock('../../../server/services/runtime/uploads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/runtime/uploads')>()),
  ...quota,
}))

const { abortPendingOutputs, completeOutput, createOutput, outputKey, outputUrl, presignOutputPart, runOutputBytes } =
  await import('../../../server/services/script-runtime/outputs')
type OutputStore = import('../../../server/services/script-runtime/outputs').OutputStore
const { apiError } = await import('../../../server/utils/errors')

const ORIGINAL = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const principal = { kind: 'scriptRun' as const, scriptRun: { id: RUN, userId: OWNER, scriptId: SCRIPT, scanIds: [SCAN], limit: null } }
const NOW = new Date('2026-01-01T00:00:00Z')
const SHA = 'c'.repeat(64)

/** An in-memory OutputStore with the semantics of the conditional updates of mongoOutputStore. */
class MemoryStore implements OutputStore {
  runs = new Map<string, Pick<ScriptRunDoc, '_id' | 'userId' | 'state' | 'outputs' | 'restartedFrom'>>()
  /** the next push fails as if a concurrent request had won (after adding this output) */
  racePush: ScriptRunOutputDoc | null = null

  async loadRunning(id: string, userId: string) {
    const run = this.runs.get(id)
    return run && run.userId === userId && run.state === 'running' ? structuredClone(run) : null
  }
  async loadOriginal(id: string, userId: string) {
    const run = this.runs.get(id)
    return run && run.userId === userId ? structuredClone(run) : null
  }
  async push(id: string, output: ScriptRunOutputDoc, maxOutputs: number) {
    const run = this.runs.get(id)!
    if (this.racePush) {
      run.outputs.push(this.racePush)
      this.racePush = null
    }
    if (run.state !== 'running' || run.outputs.some((o) => o.name === output.name) || run.outputs.length >= maxOutputs) return false
    run.outputs.push(structuredClone(output))
    return true
  }
  async reserve(id: string, outputId: string, bytes: number, maxBytes: number) {
    const run = this.runs.get(id)
    const output = run?.outputs.find((o) => o.id === outputId && o.state === 'pending')
    if (!run || run.state !== 'running' || !output || runOutputBytes(run.outputs) + bytes > maxBytes) return false
    output.reservedBytes += bytes
    return true
  }
  async unreserve(id: string, outputId: string, bytes: number) {
    const output = this.runs.get(id)?.outputs.find((o) => o.id === outputId && o.state === 'pending')
    if (output) output.reservedBytes -= bytes
  }
  async markStored(id: string, outputId: string, stored: { size: number; sha256: string }, now: Date) {
    const output = this.runs.get(id)?.outputs.find((o) => o.id === outputId && o.state === 'pending')
    if (!output) return false
    Object.assign(output, { state: 'stored', size: stored.size, sha256: stored.sha256, uploadId: null, reservedBytes: 0, storedAt: now })
    return true
  }
  async removePending(id: string, outputIds: readonly string[]) {
    const run = this.runs.get(id)
    if (run) run.outputs = run.outputs.filter((o) => !(outputIds.includes(o.id) && o.state === 'pending'))
  }
}

function output(overrides: Partial<ScriptRunOutputDoc> = {}): ScriptRunOutputDoc {
  const id = overrides.id ?? 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
  return {
    id,
    name: 'out.csv',
    key: outputKey(RUN, id, overrides.name ?? 'out.csv'),
    contentType: 'text/csv',
    state: 'pending',
    uploadId: 'upload-0',
    reservedBytes: 0,
    size: null,
    sha256: null,
    createdAt: NOW,
    storedAt: null,
    ...overrides,
  }
}

let store: MemoryStore
const config = { scriptRunMaxOutputs: 3, scriptRunMaxOutputBytes: 1000, userStorageQuotaBytes: 0, uploadTimeoutMs: 900_000 }

function seed(outputs: ScriptRunOutputDoc[] = [], overrides: Partial<ScriptRunDoc> = {}) {
  store.runs.set(RUN, { _id: RUN, userId: OWNER, state: 'running', outputs, restartedFrom: null, ...overrides })
}

beforeEach(() => {
  store = new MemoryStore()
  seed()
  setConfigForTesting(parseConfig({ SCANTOR_S3_INTERNAL_URL: 'http://rustfs:9000' }).config)
})

afterEach(() => {
  vi.clearAllMocks()
  setConfigForTesting(null)
})

describe('createOutput', () => {
  it('starts a multipart upload at a server-generated key and adds a pending output', async () => {
    const created = await createOutput(principal, { name: 'résumé report.csv', contentType: 'text/csv' }, config, store, NOW)
    expect(created.created).toBe(true)
    const { id } = created.body.output
    expect(created.body).toEqual({ output: { id, name: 'résumé report.csv', contentType: 'text/csv' }, partBytes: 16 * 1024 ** 2 })
    expect(s3.createMultipartUpload).toHaveBeenCalledWith(`script-runs/${RUN}/outputs/${id}/r_sum__report.csv`, 'text/csv', {
      'output-id': id,
      name: 'r%C3%A9sum%C3%A9%20report.csv',
    })
    expect(store.runs.get(RUN)!.outputs).toEqual([expect.objectContaining({ id, state: 'pending', uploadId: 'upload-1', reservedBytes: 0 })])
  })

  it('returns the pending output of the same name and type without a new upload', async () => {
    seed([output({ contentType: 'application/octet-stream' })])
    const again = await createOutput(principal, { name: 'out.csv' }, config, store, NOW)
    expect(again).toEqual({
      created: false,
      body: { output: { id: output().id, name: 'out.csv', contentType: 'application/octet-stream' }, partBytes: 16 * 1024 ** 2 },
    })
    expect(s3.createMultipartUpload).not.toHaveBeenCalled()
  })

  it('refuses a stored name and a pending one of another type (409)', async () => {
    seed([output({ state: 'stored', size: 1, sha256: SHA })])
    await expect(createOutput(principal, { name: 'out.csv', contentType: 'text/csv' }, config, store)).rejects.toMatchObject({ code: 'alreadyExists' })
    seed([output()])
    await expect(createOutput(principal, { name: 'out.csv', contentType: 'text/plain' }, config, store)).rejects.toMatchObject({ code: 'alreadyExists' })
  })

  it('refuses more than SCANTOR_SCRIPT_RUN_MAX_OUTPUTS outputs', async () => {
    seed([
      output({ id: '11111111-1111-4111-8111-111111111111', name: 'a' }),
      output({ id: '22222222-2222-4222-8222-222222222222', name: 'b' }),
      output({ id: '33333333-3333-4333-8333-333333333333', name: 'c' }),
    ])
    await expect(createOutput(principal, { name: 'd' }, config, store)).rejects.toMatchObject({ code: 'validationFailed' })
    expect(s3.createMultipartUpload).not.toHaveBeenCalled()
  })

  it('aborts its own upload when a concurrent request created the name first', async () => {
    store.racePush = output({ id: '44444444-4444-4444-8444-444444444444', contentType: 'application/octet-stream' })
    const created = await createOutput(principal, { name: 'out.csv' }, config, store)
    expect(created).toMatchObject({ created: false, body: { output: { id: '44444444-4444-4444-8444-444444444444' } } })
    expect(s3.abortMultipartUpload).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^script-runs/${RUN}/outputs/`)), 'upload-1')
    expect(store.runs.get(RUN)!.outputs).toHaveLength(1)
  })

  it('answers 401 once the run is no longer running', async () => {
    seed([], { state: 'completed' })
    await expect(createOutput(principal, { name: 'x' }, config, store)).rejects.toMatchObject({ code: 'unauthorized' })
  })
})

describe('presignOutputPart', () => {
  it('reserves the part size and presigns an UploadPart with Content-Length for the internal endpoint', async () => {
    seed([output()])
    const part = await presignOutputPart(principal, output().id, { partNumber: 2, size: 400 }, config, store, NOW)
    expect(part).toEqual({ url: 'http://rustfs:9000/part', method: 'PUT', headers: { 'Content-Length': '400' }, expiresAt: '2026-01-01T00:15:00.000Z' })
    expect(s3.presignUploadPart).toHaveBeenCalledWith({
      key: output().key,
      uploadId: 'upload-0',
      partNumber: 2,
      contentLength: 400,
      expiresInSeconds: 900,
      profile: 'internal',
    })
    expect(quota.reserveStorage).toHaveBeenCalledWith(OWNER, 400, 0)
    expect(store.runs.get(RUN)!.outputs[0]!.reservedBytes).toBe(400)
  })

  it('refuses parts beyond the per-run total of stored sizes and pending reservations (413)', async () => {
    seed([
      output({ id: '11111111-1111-4111-8111-111111111111', name: 'done', state: 'stored', size: 500, sha256: SHA, reservedBytes: 0 }),
      output({ reservedBytes: 300 }),
    ])
    await expect(presignOutputPart(principal, output().id, { partNumber: 3, size: 201 }, config, store)).rejects.toMatchObject({ code: 'payloadTooLarge' })
    expect(quota.reserveStorage).not.toHaveBeenCalled()
    await expect(presignOutputPart(principal, output().id, { partNumber: 3, size: 200 }, config, store)).resolves.toMatchObject({ method: 'PUT' })
  })

  it('lets concurrent parts of one run pass the per-run cap together exactly once (413 for the part beyond it)', async () => {
    seed([output()])
    const settled = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((partNumber) => presignOutputPart(principal, output().id, { partNumber, size: 250 }, config, store)),
    )
    const refused = settled.filter((result) => result.status === 'rejected')
    expect(refused).toHaveLength(1)
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'payloadTooLarge', statusCode: 413, details: { limit: 1000, used: 1000 } })
    expect(store.runs.get(RUN)!.outputs[0]!.reservedBytes).toBe(1000)
  })

  it('answers 409 when the output was stored while its part was reserved', async () => {
    seed([output()])
    store.reserve = async (id: string, outputId: string) => {
      Object.assign(
        store.runs.get(id)!.outputs.find((o) => o.id === outputId)!,
        { state: 'stored', size: 1, sha256: SHA, uploadId: null },
      )
      return false
    }
    await expect(presignOutputPart(principal, output().id, { partNumber: 1, size: 1 }, config, store)).rejects.toMatchObject({ code: 'invalidState' })
  })

  it('passes the owner quota refusal on (403) without reserving on the output', async () => {
    seed([output()])
    quota.reserveStorage.mockRejectedValueOnce(apiError('quotaExceeded', 'quota'))
    await expect(presignOutputPart(principal, output().id, { partNumber: 1, size: 10 }, config, store)).rejects.toMatchObject({ code: 'quotaExceeded' })
    expect(store.runs.get(RUN)!.outputs[0]!.reservedBytes).toBe(0)
  })

  it('refuses unknown (404) and stored (409) outputs', async () => {
    seed([output({ state: 'stored', size: 1, sha256: SHA, uploadId: null })])
    await expect(presignOutputPart(principal, '55555555-5555-4555-8555-555555555555', { partNumber: 1, size: 1 }, config, store)).rejects.toMatchObject({
      code: 'notFound',
    })
    await expect(presignOutputPart(principal, output().id, { partNumber: 1, size: 1 }, config, store)).rejects.toMatchObject({ code: 'invalidState' })
  })
})

describe('completeOutput', () => {
  const parts = [
    { partNumber: 2, etag: '"b"' },
    { partNumber: 1, etag: '"a"' },
  ]

  it('completes the upload, reads the stored size and marks the output stored', async () => {
    seed([output({ reservedBytes: 300 })])
    const done = await completeOutput(principal, output().id, { parts, sha256: SHA }, store, NOW)
    expect(done).toEqual({
      output: { id: output().id, name: 'out.csv', size: 100, sha256: SHA, contentType: 'text/csv', createdAt: '2026-01-01T00:00:00.000Z' },
    })
    expect(s3.completeMultipartUpload).toHaveBeenCalledWith(output().key, 'upload-0', parts)
    expect(store.runs.get(RUN)!.outputs[0]).toMatchObject({ state: 'stored', size: 100, sha256: SHA, uploadId: null, reservedBytes: 0, storedAt: NOW })
  })

  it('returns a stored output again without touching S3', async () => {
    seed([output({ state: 'stored', size: 7, sha256: SHA, uploadId: null })])
    expect((await completeOutput(principal, output().id, { parts, sha256: SHA }, store)).output.size).toBe(7)
    expect(s3.completeMultipartUpload).not.toHaveBeenCalled()
  })

  it('maps S3 rejections of the parts to 400 and a vanished upload to 409', async () => {
    seed([output({ reservedBytes: 300 })])
    const s3Error = (name: string, status: number) => new S3ServiceException({ name, $fault: 'client', $metadata: { httpStatusCode: status } })
    s3.completeMultipartUpload.mockRejectedValueOnce(s3Error('InvalidPart', 400))
    await expect(completeOutput(principal, output().id, { parts, sha256: SHA }, store)).rejects.toMatchObject({ code: 'validationFailed' })
    s3.completeMultipartUpload.mockRejectedValueOnce(s3Error('NoSuchUpload', 404))
    await expect(completeOutput(principal, output().id, { parts, sha256: SHA }, store)).rejects.toMatchObject({ code: 'invalidState' })
  })

  it('refuses an object larger than the reserved parts and deletes it', async () => {
    seed([output({ reservedBytes: 50 })])
    await expect(completeOutput(principal, output().id, { parts, sha256: SHA }, store)).rejects.toMatchObject({ code: 'validationFailed' })
    expect(s3.deleteObject).toHaveBeenCalledWith(output().key)
    expect(store.runs.get(RUN)!.outputs).toEqual([])
  })
})

describe('outputUrl', () => {
  it('presigns stored outputs of the run for the internal endpoint', async () => {
    seed([output({ state: 'stored', size: 9, sha256: SHA, uploadId: null })])
    const url = await outputUrl(principal, output().id, store, NOW)
    expect(url).toMatchObject({ name: 'out.csv', size: 9, sha256: SHA, contentType: 'text/csv', expiresAt: '2026-01-01T01:00:00.000Z' })
    expect(url.url.startsWith(`http://rustfs:9000/scantor/${output().key}?`)).toBe(true)
  })

  it('reaches the outputs of the continued run only when the run resumes it', async () => {
    const old = output({ id: '66666666-6666-4666-8666-666666666666', state: 'stored', size: 3, sha256: SHA, uploadId: null })
    store.runs.set(ORIGINAL, { _id: ORIGINAL, userId: OWNER, state: 'completed', outputs: [old], restartedFrom: null })
    seed([], { restartedFrom: { id: ORIGINAL, resume: true } })
    expect((await outputUrl(principal, old.id, store)).size).toBe(3)
    seed([], { restartedFrom: { id: ORIGINAL, resume: false } })
    await expect(outputUrl(principal, old.id, store)).rejects.toMatchObject({ code: 'notFound' })
  })

  it('does not presign pending outputs', async () => {
    seed([output()])
    await expect(outputUrl(principal, output().id, store)).rejects.toMatchObject({ code: 'notFound' })
  })
})

describe('abortPendingOutputs', () => {
  it('aborts the uploads of pending outputs and drops them, keeping stored ones', async () => {
    const stored = output({ id: '77777777-7777-4777-8777-777777777777', name: 'kept', state: 'stored', size: 1, sha256: SHA, uploadId: null })
    const pending = output({ reservedBytes: 10 })
    seed([stored, pending])
    s3.abortMultipartUpload.mockRejectedValueOnce(new Error('S3 down'))
    await abortPendingOutputs({ _id: RUN, outputs: [stored, pending] }, store)
    expect(s3.abortMultipartUpload).toHaveBeenCalledWith(pending.key, 'upload-0')
    expect(s3.abortMultipartUpload).toHaveBeenCalledTimes(1)
    expect(store.runs.get(RUN)!.outputs.map((o) => o.id)).toEqual([stored.id])
  })
})

describe('runOutputBytes', () => {
  it('counts stored sizes and pending reservations', () => {
    expect(runOutputBytes([output({ state: 'stored', size: 5, reservedBytes: 99 }), output({ reservedBytes: 7 })])).toBe(12)
  })
})
