import { describe, expect, it } from 'vitest'
import { revisionSource } from '../../../server/services/revisions/publish'
import { revisionFieldsFromResult } from '../../../server/services/revisions/build'
import { revisionRef, toApiRevision, toRevisionSummary } from '../../../server/services/revisions/mappers'
import type { RevisionDoc } from '../../../server/types/documents'

// Revision provenance (docs/tasks.md §10) and representations (docs/api.md §2).

const snapshot = { packSha256: 'aaa', packBytes: 10, fileCount: 2 }
const git = { url: 'https://example.org/r.git', ref: 'main', path: 'echo', commit: 'c1', packSha256: 'aaa', pulledAt: new Date() }

describe('revisionSource', () => {
  it('is upload for uploadTask', () => {
    expect(revisionSource({ source: { kind: 'upload' } }, snapshot, true).kind).toBe('upload')
  })

  it('is git when the snapshot equals the content of the last import or pull', () => {
    expect(revisionSource({ source: { kind: 'git', git } }, snapshot, false)).toEqual({
      kind: 'git',
      packSha256: 'aaa',
      packBytes: 10,
      fileCount: 2,
      git: { url: git.url, ref: 'main', path: 'echo', commit: 'c1', dirty: false },
    })
  })

  it('is workspace otherwise, recording dirty git provenance', () => {
    const source = revisionSource({ source: { kind: 'git', git } }, { ...snapshot, packSha256: 'bbb' }, false)
    expect(source.kind).toBe('workspace')
    expect(source.git?.dirty).toBe(true)
    expect(revisionSource({ source: { kind: 'scaffold', template: 'single' } }, snapshot, false)).toEqual({ kind: 'workspace', packSha256: 'aaa', packBytes: 10, fileCount: 2 })
  })
})

describe('revision representation', () => {
  const doc: RevisionDoc = {
    _id: 'c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    userId: 'u',
    taskId: 't',
    taskName: 'echo',
    number: 3,
    state: 'failed',
    message: null,
    source: { kind: 'workspace', packSha256: 'aaa', packBytes: 10, fileCount: 2 },
    snapshotKey: 'snapshots/t/aaa.tar.gz',
    privileged: false,
    buildLogKey: 'build-logs/c1.ndjson',
    errors: [{ phase: 'static', file: 'Dockerfile', line: 3, message: 'bad' }],
    jobId: 'j',
    createdAt: new Date('2026-10-21T09:01:00Z'),
    updatedAt: new Date('2026-10-21T09:01:48Z'),
  }

  it('omits internal keys and adds ref', () => {
    const api = toApiRevision(doc)
    expect(revisionRef(doc)).toBe('echo@3')
    expect(api.ref).toBe('echo@3')
    expect(api).not.toHaveProperty('snapshotKey')
    expect(api).not.toHaveProperty('buildLogKey')
    expect(api).not.toHaveProperty('jobId')
    expect(api.image).toBeNull()
    expect(toRevisionSummary(doc)).toEqual({
      id: doc._id,
      number: 3,
      ref: 'echo@3',
      state: 'failed',
      source: { kind: 'workspace', packSha256: 'aaa' },
      privileged: false,
      errorsCount: 1,
      createdAt: '2026-10-21T09:01:00.000Z',
      finishedAt: null,
    })
  })

  it('copies the BuildResult fields of a pushed image', () => {
    const fields = revisionFieldsFromResult(
      {
        ok: true,
        pack: null,
        manifest: { name: 'echo' },
        settingsDefaults: null,
        language: 'python',
        privileged: false,
        baseImage: { ref: 'scantor-base-python:dev', digest: 'sha256:b' },
        image: { ref: 'localhost:5000/tasks/t:r', id: 'sha256:i', digest: 'sha256:d', bytes: 5, platform: { os: 'linux', arch: 'arm64', variant: 'v8' } },
        description: null,
        errors: [],
        warnings: [],
        durationsMs: {},
      },
      't',
      'r',
    )
    expect(fields.image).toEqual({ repository: 'tasks/t', tag: 'r', digest: 'sha256:d', bytes: 5, platform: { os: 'linux', arch: 'arm64' } })
    expect(fields.language).toBe('python')
    expect(fields.baseImage).toEqual({ ref: 'scantor-base-python:dev', digest: 'sha256:b' })
  })
})
