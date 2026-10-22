import { describe, expect, it, vi } from 'vitest'
import type { Db } from 'mongodb'
import { collectionsOf, ensureIndexes, indexDefinitions } from '../../server/utils/mongo'
import { useLogger } from '../../server/utils/logger'

// Indexes of docs/data-model.md §4 and the idempotent ensure logic.

describe('indexDefinitions', () => {
  const definitions = indexDefinitions({ eventsTtlDays: 30 })
  const keys = (collection: string) => definitions.filter((d) => d.collection === collection).map((d) => ({ key: d.key, options: d.options ?? {} }))

  it('declares the unique and TTL indexes of the data model', () => {
    expect(keys('tasks')).toContainEqual({ key: { userId: 1, name: 1 }, options: { unique: true } })
    expect(keys('revisions')).toContainEqual({ key: { taskId: 1, number: 1 }, options: { unique: true } })
    expect(keys('analyses')).toContainEqual({ key: { scanId: 1, seq: 1 }, options: { unique: true } })
    expect(keys('testRunAnalyses')).toContainEqual({ key: { testRunId: 1, seq: 1 }, options: { unique: true } })
    expect(keys('scans')).toContainEqual({ key: { purgeAfter: 1 }, options: { expireAfterSeconds: 0 } })
    expect(keys('events')).toContainEqual({ key: { at: 1 }, options: { expireAfterSeconds: 30 * 86_400 } })
    expect(keys('jobs')).toContainEqual({ key: { kind: 1, 'subject.id': 1 }, options: { unique: true, partialFilterExpression: { active: true } } })
    expect(keys('nodes')).toContainEqual({
      key: { tokenHash: 1 },
      options: { unique: true, partialFilterExpression: { tokenHash: { $type: 'string' } } },
    })
    expect(keys('nodes')).toContainEqual({ key: { builtIn: 1 }, options: { unique: true, partialFilterExpression: { builtIn: true } } })
    expect(keys('uploads')).toContainEqual({ key: { userId: 1, sha256: 1 }, options: { unique: true } })
    expect(keys('credentials')).toContainEqual({ key: { userId: 1, name: 1 }, options: { unique: true } })
  })

  it('has no standalone userId index on analyses (data-model decision 2)', () => {
    expect(keys('analyses').map((d) => d.key)).toEqual([
      { scanId: 1, seq: 1 },
      { scanId: 1, status: 1, seq: 1 },
    ])
  })

  it('indexes every scantor collection except locks and meta', () => {
    const indexed = new Set(definitions.map((d) => d.collection))
    for (const name of ['tasks', 'revisions', 'testRuns', 'testRunAnalyses', 'scans', 'analyses', 'workers', 'nodes', 'credentials', 'uploads', 'events', 'jobs', 'exports', 'editors']) {
      expect(indexed.has(name as never), name).toBe(true)
    }
  })
})

describe('ensureIndexes', () => {
  function fakeDb(existing: Record<string, { key: Record<string, number>; expireAfterSeconds?: number }[]>) {
    const created: Record<string, unknown[]> = {}
    const commands: unknown[] = []
    const db = {
      collection: (name: string) => ({
        collectionName: name,
        listIndexes: () => ({
          toArray: async () => {
            if (!(name in existing)) throw Object.assign(new Error('ns not found'), { code: 26 })
            return existing[name]
          },
        }),
        createIndexes: vi.fn(async (specs: unknown[]) => {
          created[name] = specs
        }),
      }),
      command: vi.fn(async (command: unknown) => {
        commands.push(command)
      }),
    }
    return { db: db as unknown as Db, created, commands }
  }

  it('creates missing indexes and updates changed TTLs with collMod', async () => {
    const { db, created, commands } = fakeDb({
      events: [
        { key: { _id: 1 } },
        { key: { at: 1 }, expireAfterSeconds: 7 * 86_400 },
        { key: { scanId: 1, at: -1 } },
        { key: { userId: 1, at: -1 } },
        { key: { nodeId: 1, at: -1 } },
      ],
    })
    await ensureIndexes(db, { eventsTtlDays: 30 }, useLogger('test'))
    expect(commands).toEqual([{ collMod: 'events', index: { keyPattern: { at: 1 }, expireAfterSeconds: 30 * 86_400 } }])
    expect(created.events).toBeUndefined()
    expect(created.tasks).toEqual([{ key: { userId: 1, name: 1 }, unique: true }, { key: { userId: 1, createdAt: -1, _id: -1 } }])
  })

  it('maps collections to their documented names', () => {
    const names = Object.fromEntries(
      Object.entries(collectionsOf({ collection: (name: string) => ({ name }) } as unknown as Db)).map(([key, value]) => [key, (value as unknown as { name: string }).name]),
    )
    expect(names).toMatchObject({ testRunAnalyses: 'testRunAnalyses', authUsers: 'user', authApiKeys: 'apikey', meta: 'meta' })
  })
})
