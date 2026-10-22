import { type Collection, type CreateIndexesOptions, type Db, type IndexSpecification, MongoClient } from 'mongodb'
import type {
  AnalysisDoc,
  AuthApiKeyDoc,
  AuthUserDoc,
  CredentialDoc,
  EditorDoc,
  EventDoc,
  ExportDoc,
  JobDoc,
  LockDoc,
  MetaDoc,
  NodeDoc,
  RevisionDoc,
  ScanDoc,
  TaskDoc,
  TestRunAnalysisDoc,
  TestRunDoc,
  UploadDoc,
  WorkerDoc,
} from '../types/documents'
import { type Config, useConfig } from './config'
import { useKeys } from './keys'
import { withLock } from './locks'
import { type Logger, useLogger } from './logger'

// MongoDB access (docs/data-model.md): one MongoClient on the replica set `rs0`, shared by better-auth and scantor;
// typed accessors for every collection; the exact indexes of the data model, ensured at boot; schema migrations
// under the `migrations` lock; and the read-only user `scantor_query` plus its own client for user queries
// (docs/api.md §5.2). Boot step 2 of docs/architecture.md §4.1 is `connectMongo` + `prepareDatabase`.

export const QUERY_USER = 'scantor_query'
export const SCHEMA_VERSION = 1

export interface ScantorCollections {
  tasks: Collection<TaskDoc>
  revisions: Collection<RevisionDoc>
  testRuns: Collection<TestRunDoc>
  testRunAnalyses: Collection<TestRunAnalysisDoc>
  scans: Collection<ScanDoc>
  analyses: Collection<AnalysisDoc>
  workers: Collection<WorkerDoc>
  nodes: Collection<NodeDoc>
  credentials: Collection<CredentialDoc>
  uploads: Collection<UploadDoc>
  events: Collection<EventDoc>
  jobs: Collection<JobDoc>
  locks: Collection<LockDoc>
  exports: Collection<ExportDoc>
  editors: Collection<EditorDoc>
  meta: Collection<MetaDoc>
  /** better-auth `user`, read directly for listings only */
  authUsers: Collection<AuthUserDoc>
  /** better-auth `apikey`, read directly for listings only */
  authApiKeys: Collection<AuthApiKeyDoc>
}

/** MongoDB collection names: scantor's plural camelCase names and the singular better-auth models it reads. */
export const COLLECTION_NAMES = {
  tasks: 'tasks',
  revisions: 'revisions',
  testRuns: 'testRuns',
  testRunAnalyses: 'testRunAnalyses',
  scans: 'scans',
  analyses: 'analyses',
  workers: 'workers',
  nodes: 'nodes',
  credentials: 'credentials',
  uploads: 'uploads',
  events: 'events',
  jobs: 'jobs',
  locks: 'locks',
  exports: 'exports',
  editors: 'editors',
  meta: 'meta',
  authUsers: 'user',
  authApiKeys: 'apikey',
} as const satisfies Record<keyof ScantorCollections, string>

export function collectionsOf(db: Db): ScantorCollections {
  return {
    tasks: db.collection<TaskDoc>(COLLECTION_NAMES.tasks),
    revisions: db.collection<RevisionDoc>(COLLECTION_NAMES.revisions),
    testRuns: db.collection<TestRunDoc>(COLLECTION_NAMES.testRuns),
    testRunAnalyses: db.collection<TestRunAnalysisDoc>(COLLECTION_NAMES.testRunAnalyses),
    scans: db.collection<ScanDoc>(COLLECTION_NAMES.scans),
    analyses: db.collection<AnalysisDoc>(COLLECTION_NAMES.analyses),
    workers: db.collection<WorkerDoc>(COLLECTION_NAMES.workers),
    nodes: db.collection<NodeDoc>(COLLECTION_NAMES.nodes),
    credentials: db.collection<CredentialDoc>(COLLECTION_NAMES.credentials),
    uploads: db.collection<UploadDoc>(COLLECTION_NAMES.uploads),
    events: db.collection<EventDoc>(COLLECTION_NAMES.events),
    jobs: db.collection<JobDoc>(COLLECTION_NAMES.jobs),
    locks: db.collection<LockDoc>(COLLECTION_NAMES.locks),
    exports: db.collection<ExportDoc>(COLLECTION_NAMES.exports),
    editors: db.collection<EditorDoc>(COLLECTION_NAMES.editors),
    meta: db.collection<MetaDoc>(COLLECTION_NAMES.meta),
    authUsers: db.collection<AuthUserDoc>(COLLECTION_NAMES.authUsers),
    authApiKeys: db.collection<AuthApiKeyDoc>(COLLECTION_NAMES.authApiKeys),
  }
}

// ── indexes ─────────────────────────────────────────────────────────────────

export interface IndexSpec {
  key: IndexSpecification & Record<string, 1 | -1>
  options?: CreateIndexesOptions
}

export interface IndexDefinition extends IndexSpec {
  collection: keyof ScantorCollections
}

const TTL_NOW = { expireAfterSeconds: 0 }

/** Every scantor index of docs/data-model.md §4 (better-auth creates its own indexes lazily). */
export function indexDefinitions(config: Pick<Config, 'eventsTtlDays'>): IndexDefinition[] {
  return [
    { collection: 'tasks', key: { userId: 1, name: 1 }, options: { unique: true } },
    { collection: 'tasks', key: { userId: 1, createdAt: -1, _id: -1 } },

    { collection: 'revisions', key: { taskId: 1, number: 1 }, options: { unique: true } },
    { collection: 'revisions', key: { taskId: 1, state: 1, number: -1 } },
    { collection: 'revisions', key: { taskId: 1, 'source.packSha256': 1 } },
    { collection: 'revisions', key: { userId: 1, createdAt: -1 } },

    { collection: 'testRuns', key: { taskId: 1, createdAt: -1 } },
    { collection: 'testRuns', key: { userId: 1, createdAt: -1 } },
    { collection: 'testRuns', key: { expiresAt: 1 }, options: TTL_NOW },

    { collection: 'testRunAnalyses', key: { testRunId: 1, seq: 1 }, options: { unique: true } },
    { collection: 'testRunAnalyses', key: { expiresAt: 1 }, options: TTL_NOW },

    { collection: 'scans', key: { userId: 1, createdAt: -1, _id: -1 } },
    { collection: 'scans', key: { state: 1, updatedAt: 1 } },
    { collection: 'scans', key: { 'task.id': 1, state: 1 } },
    { collection: 'scans', key: { 'revision.id': 1 } },
    { collection: 'scans', key: { uploadIds: 1 } },
    { collection: 'scans', key: { purgeAfter: 1 }, options: TTL_NOW },

    { collection: 'analyses', key: { scanId: 1, seq: 1 }, options: { unique: true } },
    { collection: 'analyses', key: { scanId: 1, status: 1, seq: 1 } },

    { collection: 'workers', key: { scanId: 1, role: 1, state: 1 } },
    { collection: 'workers', key: { nodeId: 1, state: 1 } },
    { collection: 'workers', key: { userId: 1, state: 1 } },
    { collection: 'workers', key: { expiresAt: 1 }, options: TTL_NOW },

    { collection: 'nodes', key: { name: 1 }, options: { unique: true } },
    {
      collection: 'nodes',
      key: { tokenHash: 1 },
      options: { unique: true, partialFilterExpression: { tokenHash: { $type: 'string' } } },
    },
    { collection: 'nodes', key: { builtIn: 1 }, options: { unique: true, partialFilterExpression: { builtIn: true } } },
    { collection: 'nodes', key: { state: 1 } },

    { collection: 'credentials', key: { userId: 1, name: 1 }, options: { unique: true } },

    { collection: 'uploads', key: { userId: 1, sha256: 1 }, options: { unique: true } },
    { collection: 'uploads', key: { userId: 1, createdAt: -1 } },

    { collection: 'events', key: { scanId: 1, at: -1 }, options: { partialFilterExpression: { scanId: { $exists: true } } } },
    { collection: 'events', key: { userId: 1, at: -1 } },
    { collection: 'events', key: { nodeId: 1, at: -1 }, options: { partialFilterExpression: { nodeId: { $exists: true } } } },
    { collection: 'events', key: { at: 1 }, options: { expireAfterSeconds: config.eventsTtlDays * 86_400 } },

    { collection: 'jobs', key: { state: 1, kind: 1, notBefore: 1, createdAt: 1 } },
    { collection: 'jobs', key: { state: 1, 'lease.expiresAt': 1 } },
    { collection: 'jobs', key: { kind: 1, 'subject.id': 1 }, options: { unique: true, partialFilterExpression: { active: true } } },
    { collection: 'jobs', key: { userId: 1, createdAt: -1 } },
    { collection: 'jobs', key: { expiresAt: 1 }, options: TTL_NOW },

    { collection: 'exports', key: { userId: 1, createdAt: -1 } },
    { collection: 'exports', key: { scanId: 1 } },
    { collection: 'exports', key: { expiresAt: 1 }, options: TTL_NOW },

    { collection: 'editors', key: { state: 1, lastActivityAt: 1 } },
  ]
}

function sameKey(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Creates the indexes of one collection idempotently. An index whose key pattern already exists is kept (its name
 * may differ); TTL durations that come from the environment are applied with `collMod` when they changed
 * (docs/data-model.md §1).
 */
export async function ensureCollectionIndexes(db: Db, name: string, specs: IndexSpec[], log: Logger = useLogger('mongo')): Promise<void> {
  const collection = db.collection(name)
  const existing = await collection
    .listIndexes()
    .toArray()
    .catch((error: unknown) => {
      if ((error as { code?: number }).code === 26) return [] // NamespaceNotFound: collection not created yet
      throw error
    })
  const toCreate: IndexSpec[] = []
  for (const spec of specs) {
    const ttl = spec.options?.expireAfterSeconds
    const current = existing.find((index) => sameKey(index.key as Record<string, unknown>, spec.key))
    if (current && ttl !== undefined && current.expireAfterSeconds !== ttl) {
      await db.command({ collMod: name, index: { keyPattern: spec.key, expireAfterSeconds: ttl } })
      log.info('updated TTL index', { collection: name, key: spec.key, expireAfterSeconds: ttl })
      continue
    }
    if (!current) toCreate.push(spec)
  }
  if (toCreate.length > 0) await collection.createIndexes(toCreate.map((spec) => ({ key: spec.key, ...spec.options })))
}

/** Creates every scantor index of docs/data-model.md §4 idempotently. */
export async function ensureIndexes(db: Db, config: Pick<Config, 'eventsTtlDays'>, log: Logger = useLogger('mongo')): Promise<void> {
  const byCollection = new Map<string, IndexSpec[]>()
  for (const { collection, ...spec } of indexDefinitions(config)) {
    const name = COLLECTION_NAMES[collection]
    byCollection.set(name, [...(byCollection.get(name) ?? []), spec])
  }
  for (const [name, specs] of byCollection) await ensureCollectionIndexes(db, name, specs, log)
}

// ── migrations ──────────────────────────────────────────────────────────────

export interface Migration {
  /** the schema version this migration produces */
  version: number
  name: string
  up(db: Db, log: Logger): Promise<void>
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    // The initial schema needs no data changes: collections and indexes are created by ensureIndexes.
    async up() {},
  },
]

/** Adds a migration; versions must be strictly increasing (register at module load or in a boot plugin). */
export function registerMigration(migration: Migration): void {
  const last = migrations.at(-1)
  if (last && migration.version <= last.version) {
    throw new Error(`migration ${migration.version} (${migration.name}) must follow version ${last.version}`)
  }
  migrations.push(migration)
}

/** Runs pending migrations under the `migrations` lock and records the schema version in `meta`. */
export async function runMigrations(db: Db, log: Logger = useLogger('mongo')): Promise<number> {
  const { locks, meta } = collectionsOf(db)
  return withLock(
    locks,
    'migrations',
    async () => {
      const current = (await meta.findOne({ _id: 'schema' }))?.version ?? 0
      let version = current
      for (const migration of migrations) {
        if (migration.version <= version) continue
        log.info('running migration', { version: migration.version, name: migration.name })
        await migration.up(db, log)
        version = migration.version
        await meta.updateOne({ _id: 'schema' }, { $set: { version, updatedAt: new Date() } }, { upsert: true })
      }
      if (version > SCHEMA_VERSION && version !== current) log.warn('schema version is newer than this build expects', { version })
      return version
    },
    { logger: log },
  )
}

// ── users ───────────────────────────────────────────────────────────────────

/** Creates or updates a MongoDB user with role `read` on the application database (in the `admin` database). */
async function ensureReadOnlyUser(client: MongoClient, appDb: string, user: string, password: string): Promise<'created' | 'updated'> {
  const admin = client.db('admin')
  const info = (await admin.command({ usersInfo: user })) as { users: unknown[] }
  const roles = [{ role: 'read', db: appDb }]
  if (info.users.length === 0) {
    await admin.command({ createUser: user, pwd: password, roles })
    return 'created'
  }
  await admin.command({ updateUser: user, pwd: password, roles })
  return 'updated'
}

// ── process state ───────────────────────────────────────────────────────────

interface MongoState {
  client: MongoClient
  db: Db
  collections: ScantorCollections
}

let state: MongoState | null = null
let queryState: Promise<{ client: MongoClient; db: Db }> | null = null

function createClient(config: Config, username: string, password: string): MongoClient {
  return new MongoClient(config.mongoUrl, {
    auth: { username, password },
    appName: 'scantor-orchestrator',
    serverSelectionTimeoutMS: 10_000,
  })
}

/** Connects the shared client and waits until the replica set has a writable primary (boot step 2). */
export async function connectMongo(options: { timeoutMs?: number; log?: Logger } = {}): Promise<MongoState> {
  if (state) return state
  const config = useConfig()
  const log = options.log ?? useLogger('mongo')
  const client = createClient(config, config.mongoUser, config.mongoPassword)
  const deadline = Date.now() + (options.timeoutMs ?? 120_000)
  for (let attempt = 1; ; attempt++) {
    try {
      await client.connect()
      const hello = (await client.db('admin').command({ hello: 1 })) as { isWritablePrimary?: boolean; setName?: string }
      if (hello.isWritablePrimary) break
      throw new Error(`connected, but not a writable primary (replica set ${hello.setName ?? 'unknown'})`)
    } catch (error) {
      if (Date.now() > deadline) {
        await client.close().catch(() => undefined)
        throw new Error(`MongoDB is not available: ${(error as Error).message}`, { cause: error })
      }
      log.warn('waiting for MongoDB primary', { attempt, err: error })
      await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 500 * attempt)))
    }
  }
  const db = client.db(config.mongoDb)
  state = { client, db, collections: collectionsOf(db) }
  return state
}

/**
 * Boot step 2 after connecting: migrations under the `migrations` lock, every index, the read-only query user
 * and, when SCANTOR_EXPOSE_MONGO=true, the read-only analytics user.
 */
export async function prepareDatabase(log: Logger = useLogger('mongo')): Promise<void> {
  const { client, db } = useMongo()
  const config = useConfig()
  const version = await runMigrations(db, log)
  await ensureIndexes(db, config, log)
  const query = await ensureReadOnlyUser(client, config.mongoDb, QUERY_USER, useKeys().mongoQueryPassword())
  log.info('database ready', { schemaVersion: version, queryUser: query })
  if (config.exposeMongo) {
    const analytics = await ensureReadOnlyUser(client, config.mongoDb, config.mongoAnalyticsUser, config.mongoAnalyticsPassword)
    log.info('analytics user ensured', { user: config.mongoAnalyticsUser, result: analytics })
  }
}

/** The shared client and database. Throws before boot step 2 has connected. */
export function useMongo(): MongoState {
  if (!state) throw new Error('MongoDB is not connected yet')
  return state
}

/** Typed accessors of every scantor collection. */
export function useCollections(): ScantorCollections {
  return useMongo().collections
}

/** The client of the read-only `scantor_query` user, used only for user queries and exports (docs/api.md §5.2). */
export function useQueryMongo(): Promise<{ client: MongoClient; db: Db }> {
  queryState ??= (async () => {
    const config = useConfig()
    const client = createClient(config, QUERY_USER, useKeys().mongoQueryPassword())
    await client.connect()
    return { client, db: client.db(config.mongoDb) }
  })().catch((error: unknown) => {
    queryState = null
    throw error
  })
  return queryState
}

/** True when MongoDB answers a ping within a short timeout. */
export async function mongoReachable(): Promise<boolean> {
  if (!state) return false
  try {
    await state.db.command({ ping: 1 }, { timeoutMS: 3000 })
    return true
  } catch {
    return false
  }
}

export async function closeMongo(): Promise<void> {
  const query = queryState
  queryState = null
  if (query) await (await query.catch(() => null))?.client.close()
  if (state) {
    const { client } = state
    state = null
    await client.close()
  }
}
