import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { describe, expect, it } from 'vitest'
import { assertTaskUploadContentType, uploadConflicts } from '../../../server/services/tasks/upload'
import type { TaskDoc } from '../../../server/types/documents'
import { ByteCap } from '../../../server/utils/byte-cap'
import { ApiError } from '../../../server/utils/errors'

// The upload conflict rule (docs/api.md §5.3, docs/tasks.md §13) and the streaming cap (security.md WS-9).

function task(latest: string | null, lastSync: string | null): Pick<TaskDoc, 'latestRevision' | 'workspace'> {
  return {
    latestRevision: latest ? { id: 'r', number: 1, state: 'failed', packSha256: latest, createdAt: new Date() } : null,
    workspace: { packSha256: null, fileCount: 0, bytes: 0, checkedAt: null, lastSyncSha256: lastSync },
  }
}

const summary = (packSha256: string) => ({ packSha256, fileCount: 1, bytes: 1 })

describe('uploadConflicts', () => {
  it('never conflicts when the folder does not exist', () => {
    expect(uploadConflicts(null, 'new', task(null, null))).toBe(false)
  })

  it('does not conflict when the workspace equals the upload, the latest revision (any state) or the last sync', () => {
    expect(uploadConflicts(summary('new'), 'new', task(null, null))).toBe(false)
    expect(uploadConflicts(summary('published'), 'new', task('published', null))).toBe(false)
    expect(uploadConflicts(summary('synced'), 'new', task('other', 'synced'))).toBe(false)
  })

  it('conflicts for workspace-only changes', () => {
    expect(uploadConflicts(summary('edited'), 'new', task('published', 'synced'))).toBe(true)
    expect(uploadConflicts(summary('scaffolded'), 'new', task(null, null))).toBe(true)
  })
})

describe('ByteCap', () => {
  it('passes bodies within the cap', async () => {
    const cap = new ByteCap(10)
    const chunks: Buffer[] = []
    await pipeline(Readable.from([Buffer.from('12345'), Buffer.from('67890')]), cap, new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk)
        callback()
      },
    }))
    expect(Buffer.concat(chunks).toString()).toBe('1234567890')
    expect(cap.exceeded).toBe(false)
  })

  it('fails once the cap is exceeded', async () => {
    const cap = new ByteCap(4)
    const sink = new Writable({ write: (_chunk, _encoding, callback) => callback() })
    await expect(pipeline(Readable.from([Buffer.from('123'), Buffer.from('45')]), cap, sink)).rejects.toThrow('exceeds 4 bytes')
    expect(cap.exceeded).toBe(true)
  })
})

describe('assertTaskUploadContentType', () => {
  it('accepts gzip only', () => {
    expect(() => assertTaskUploadContentType('application/gzip')).not.toThrow()
    expect(() => assertTaskUploadContentType('application/x-gzip; charset=binary')).not.toThrow()
    for (const type of [undefined, 'application/json', 'application/octet-stream']) {
      expect(() => assertTaskUploadContentType(type)).toThrow(ApiError)
    }
  })
})
