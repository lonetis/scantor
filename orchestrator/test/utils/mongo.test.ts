import { describe, expect, it, vi } from 'vitest'
import type { Db, MongoClient } from 'mongodb'
import { collectionsOf, ensureIndexes, ensureReadOnlyUsers, indexDefinitions, QUERY_USER } from '../../server/utils/mongo'
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

describe('ensureReadOnlyUsers', () => {
  /** A client whose admin database knows `existing` users and records every command. */
  function fakeClient(existing: string[] = []) {
    const commands: Record<string, unknown>[] = []
    const client = {
      db: (name: string) => {
        expect(name).toBe('admin')
        return {
          command: async (command: Record<string, unknown>) => {
            commands.push(command)
            if ('usersInfo' in command) return { users: existing.includes(command.usersInfo as string) ? [{}] : [] }
            return { ok: 1 }
          },
        }
      },
    }
    return { client: client as unknown as MongoClient, commands }
  }

  const base = { mongoDb: 'scantor', mongoAnalyticsUser: 'scantor_analytics', mongoAnalyticsPassword: 'analytics-password' }
  const writes = (commands: Record<string, unknown>[]) => commands.filter((command) => !('usersInfo' in command))

  it('creates the analytics user with role read for a read-only mongo-express, without the MongoDB router', async () => {
    const { client, commands } = fakeClient()
    const result = await ensureReadOnlyUsers(client, { ...base, exposeMongo: false, mongoExpressReadonly: true }, 'query-password')
    expect(result).toEqual({ query: 'created', analytics: 'created' })
    expect(writes(commands)).toEqual([
      { createUser: QUERY_USER, pwd: 'query-password', roles: [{ role: 'read', db: 'scantor' }] },
      { createUser: 'scantor_analytics', pwd: 'analytics-password', roles: [{ role: 'read', db: 'scantor' }] },
    ])
  })

  it('updates an existing analytics user while the MongoDB router is exposed', async () => {
    const { client, commands } = fakeClient([QUERY_USER, 'scantor_analytics'])
    const result = await ensureReadOnlyUsers(client, { ...base, exposeMongo: true, mongoExpressReadonly: false }, 'query-password')
    expect(result).toEqual({ query: 'updated', analytics: 'updated' })
    expect(writes(commands).map((command) => command.updateUser)).toEqual([QUERY_USER, 'scantor_analytics'])
  })

  it('ensures only the query user when nothing connects as the analytics user', async () => {
    const { client, commands } = fakeClient()
    const result = await ensureReadOnlyUsers(client, { ...base, exposeMongo: false, mongoExpressReadonly: false }, 'query-password')
    expect(result).toEqual({ query: 'created', analytics: null })
    expect(writes(commands).map((command) => command.createUser)).toEqual([QUERY_USER])
  })
})
