import { PassThrough, type Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScriptDoc } from '../../../server/types/documents'
import { ApiError } from '../../../server/utils/errors'
import { FakeCollection } from '../../helpers/fake-collection'

// Script upload (docs/scripts.md, docs/api.md uploadScript): the conflict rule without revisions (the folder hash
// against the uploaded hash and lastSyncSha256), the commit expectation, creation by manifest name with rollback,
// the manifest as the source of language and description, and the manifest file named by a bare manifestInvalid.

type UserPrincipal = import('../../../server/utils/principal').UserPrincipal

const store = { scripts: new FakeCollection<ScriptDoc>('scripts', [{ keys: ['userId', 'name'] }]) }
const helper = {
  manifest: { name: 'csp', language: 'python', description: 'counts CSP headers' } as Record<string, unknown>,
  uploaded: 'sha-uploaded',
  current: null as { packSha256: string; fileCount: number; bytes: number } | null,
  commitError: null as Error | null,
  extractKinds: [] as (string | undefined)[],
  commits: [] as { script?: string; expect: string }[],
  discarded: [] as string[],
}

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => Object.fromEntries(Object.entries(store).map(([name, collection]) => [name, collection.asCollection()])),
}))
vi.mock('../../../server/services/helpers/ops', () => ({
  extract: async (_userId: string, stagingId: string, stdin: Readable, options: { kind?: string } = {}) => {
    helper.extractKinds.push(options.kind)
    for await (const chunk of stdin) void chunk
    return { staging: stagingId, manifest: helper.manifest, summary: { packSha256: helper.uploaded, fileCount: 3, bytes: 300 } }
  },
  snapshotHash: async () => helper.current,
  commit: async (_userId: string, input: { script?: string; expect: string }) => {
    helper.commits.push({ script: input.script, expect: input.expect })
    if (helper.commitError) throw helper.commitError
    return {
      script: input.script,
      changed: true,
      previousPackSha256: helper.current?.packSha256 ?? null,
      workspace: { packSha256: helper.uploaded, fileCount: 3, bytes: 300 },
    }
  },
  discard: async (_userId: string, stagingId: string) => {
    helper.discarded.push(stagingId)
  },
}))

const { assertScriptUploadContentType, scriptCommitExpectation, scriptUploadConflicts, uploadScript } = await import('../../../server/services/scripts/upload')
const { newScriptDoc } = await import('../../../server/services/scripts/store')
const { mapHelperError } = await import('../../../server/services/helpers/protocol')

const USER_ID = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const alice = { kind: 'user', via: 'session', user: { id: USER_ID }, isAdmin: false } as unknown as UserPrincipal

function body(): PassThrough {
  const stream = new PassThrough()
  stream.end(Buffer.from('tar.gz bytes'))
  return stream
}

async function upload(force = false) {
  return uploadScript(alice, { body: body(), maxBytes: 1024 ** 2, force })
}

function summary(packSha256: string) {
  return { packSha256, fileCount: 1, bytes: 1 }
}

function scriptWith(lastSyncSha256: string | null): Pick<ScriptDoc, 'workspace'> {
  return { workspace: { packSha256: null, fileCount: 0, bytes: 0, checkedAt: null, lastSyncSha256 } }
}

async function existingScript(lastSyncSha256: string | null): Promise<ScriptDoc> {
  const doc = newScriptDoc({ userId: USER_ID, name: 'csp', language: 'python', description: 'old', source: { kind: 'scaffold' } })
  doc.workspace.lastSyncSha256 = lastSyncSha256
  await store.scripts.insertOne(doc)
  return doc
}

beforeEach(() => {
  store.scripts.docs.length = 0
  helper.manifest = { name: 'csp', language: 'python', description: 'counts CSP headers' }
  helper.uploaded = 'sha-uploaded'
  helper.current = null
  helper.commitError = null
  helper.extractKinds.length = 0
  helper.commits.length = 0
  helper.discarded.length = 0
})

describe('scriptUploadConflicts', () => {
  it('never conflicts when the folder does not exist', () => {
    expect(scriptUploadConflicts(null, 'new', scriptWith(null))).toBe(false)
  })

  it('does not conflict when the folder equals the upload or the last upload', () => {
    expect(scriptUploadConflicts(summary('new'), 'new', scriptWith(null))).toBe(false)
    expect(scriptUploadConflicts(summary('synced'), 'new', scriptWith('synced'))).toBe(false)
  })

  it('conflicts for changes that exist only in the folder, including an untouched scaffold', () => {
    expect(scriptUploadConflicts(summary('edited'), 'new', scriptWith('synced'))).toBe(true)
    expect(scriptUploadConflicts(summary('scaffolded'), 'new', scriptWith(null))).toBe(true)
  })
})

describe('scriptCommitExpectation', () => {
  it('expects the decided hash, absent without a folder, and anything for new scripts or force', () => {
    expect(scriptCommitExpectation(summary('h'), { created: false, force: false })).toBe('h')
    expect(scriptCommitExpectation(null, { created: false, force: false })).toBe('absent')
    expect(scriptCommitExpectation(summary('h'), { created: true, force: false })).toBe('any')
    expect(scriptCommitExpectation(summary('h'), { created: false, force: true })).toBe('any')
  })
})

describe('assertScriptUploadContentType', () => {
  it('accepts gzip only', () => {
    expect(() => assertScriptUploadContentType('application/gzip')).not.toThrow()
    expect(() => assertScriptUploadContentType('application/x-gzip; charset=binary')).not.toThrow()
    for (const type of [undefined, 'application/json', 'application/octet-stream']) {
      expect(() => assertScriptUploadContentType(type)).toThrow(ApiError)
    }
  })
})

describe('uploadScript', () => {
  it('creates a script named by the manifest, extracts with --kind script and records the uploaded hash', async () => {
    const outcome = await upload()
    expect(outcome.created).toBe(true)
    expect(helper.extractKinds).toEqual(['script'])
    expect(helper.commits).toEqual([{ script: 'csp', expect: 'any' }])
    expect(outcome.script).toMatchObject({
      userId: USER_ID,
      name: 'csp',
      language: 'python',
      description: 'counts CSP headers',
      source: { kind: 'upload' },
      workspace: { packSha256: 'sha-uploaded', fileCount: 3, bytes: 300, lastSyncSha256: 'sha-uploaded' },
    })
    expect(store.scripts.docs).toHaveLength(1)
    expect(helper.discarded).toEqual([])
  })

  it('replaces an unchanged folder of an existing script, expecting its current hash, and takes the manifest description', async () => {
    const script = await existingScript('sha-synced')
    helper.current = summary('sha-synced')
    const outcome = await upload()
    expect(outcome).toMatchObject({ created: false, script: { _id: script._id, description: 'counts CSP headers', source: { kind: 'scaffold' } } })
    expect(helper.commits).toEqual([{ script: 'csp', expect: 'sha-synced' }])
    expect(store.scripts.docs[0]).toMatchObject({ workspace: { lastSyncSha256: 'sha-uploaded' } })
  })

  it('answers 409 workspaceDirty for changes that exist only in the folder and discards the staging directory', async () => {
    await existingScript('sha-synced')
    helper.current = summary('sha-edited')
    await expect(upload()).rejects.toMatchObject({ code: 'workspaceDirty', details: { current: 'sha-edited', uploaded: 'sha-uploaded' } })
    expect(helper.commits).toEqual([])
    expect(helper.discarded).toHaveLength(1)
    expect(store.scripts.docs[0]).toMatchObject({ workspace: { lastSyncSha256: 'sha-synced' } })
  })

  it('replaces such changes with force', async () => {
    await existingScript('sha-synced')
    helper.current = summary('sha-edited')
    await expect(upload(true)).resolves.toMatchObject({ created: false })
    expect(helper.commits).toEqual([{ script: 'csp', expect: 'any' }])
  })

  it('removes the new script again when the commit fails', async () => {
    helper.commitError = new ApiError('payloadTooLarge', 'the workspace is full')
    await expect(upload()).rejects.toMatchObject({ code: 'payloadTooLarge' })
    expect(store.scripts.docs).toHaveLength(0)
    expect(helper.discarded).toHaveLength(1)
  })

  it('refuses a script that is being deleted', async () => {
    const script = await existingScript(null)
    await store.scripts.updateOne({ _id: script._id }, { $set: { deletingAt: new Date() } })
    await expect(upload()).rejects.toMatchObject({ code: 'alreadyExists' })
    expect(helper.commits).toEqual([])
  })

  it('refuses a manifest language without script support, naming scantor-script.yaml', async () => {
    helper.manifest = { name: 'csp', language: 'go' }
    await expect(upload()).rejects.toMatchObject({
      code: 'manifestInvalid',
      details: { errors: [{ phase: 'static', file: 'scantor-script.yaml' }] },
    })
    expect(store.scripts.docs).toHaveLength(0)
  })
})

describe('mapHelperError for script folders', () => {
  it('names the script manifest in a manifestInvalid without structured errors', () => {
    const bare = { code: 'manifestInvalid', message: 'scantor-script.yaml is missing' }
    expect(mapHelperError('extract', bare, [], { kind: 'script' }).details).toEqual({
      errors: [{ phase: 'static', file: 'scantor-script.yaml', message: 'scantor-script.yaml is missing' }],
    })
    expect(mapHelperError('extract', bare).details).toEqual({ errors: [{ phase: 'static', file: 'scantor.yaml', message: 'scantor-script.yaml is missing' }] })
  })
})
