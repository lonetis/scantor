import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ApiKey } from '#shared/types/account'
import type { Credential } from '#shared/types/credentials'
import type { ItemList } from '#shared/types/common'
import type { TestInfo } from '@playwright/test'
import { ApiClient, type ApiResponse } from './api-client'
import { env } from './env'
import type { OpenApiIndex } from './openapi'
import { newApiContext } from './users'

// The seeded principals and resources of the authorization matrix (docs/security.md §7, docs/testing.md §8.5): the
// `authz-setup` project (authz/seed.setup.ts) writes them to .auth/authz.json, the matrix reads them, and the
// `authz-teardown` project deletes them. Also the fingerprint of A's GET representations that must survive every one
// of B's attempts unchanged.

/**
 * The files of one run: .auth/authz-<run>-<name>.json, where <run> is a hash of the run's output directory, which
 * `just test-exec` makes unique per run and which the setup, matrix and teardown projects share. Concurrent runs
 * against the kept-alive stack therefore never read or delete each other's tenants.
 */
export function runFile(testInfo: TestInfo, name: string): string {
  const run = createHash('sha256').update(testInfo.project.outputDir).digest('hex').slice(0, 12)
  return join(env.paths.auth, `authz-${run}-${name}.json`)
}

/** The seed of this run (.auth/authz-<run>-seed.json; it holds credentials, so it never goes into test-results). */
export const seedFile = (testInfo: TestInfo) => runFile(testInfo, 'seed')

/** A seeded user: session (storage state), password and `default` API key. */
export interface SeededUser {
  id: string
  email: string
  name: string
  password: string
  storageState: string
  key: string
  keyId: string
}

/** A worker of A's completed scan, with its token derived by helpers/keys.ts (the worker is stopped). */
export interface SeededWorker {
  id: string
  scanId: string
  role: string
  nodeId: string
  token: string
}

/** A's resources (docs/security.md §7): task `alpha` with a ready revision, test run, scan, export, upload, … */
export interface TenantA extends SeededUser {
  taskId: string
  taskName: string
  revisionId: string
  revisionNumber: number
  testRunId: string
  testRunFileId: string
  scanId: string
  analysisId: string
  fileId: string
  exportId: string
  uploadId: string
  credentialId: string
  jobId: string
  workers: SeededWorker[]
  /** the `sleep` example, for scans whose workers stay active (the worker-scope case) */
  sleepTaskId: string
  sleepRevisionId: string
}

/** B owns a task with the same name `alpha` (name lookups are caller-scoped). */
export interface TenantB extends SeededUser {
  taskId: string
  taskName: string
  revisionId: string
  revisionNumber: number
}

export interface Seed {
  version: string
  admin: { id: string; email: string; storageState: string; key: string; keyId: string }
  a: TenantA
  b: TenantB
  /** remote-1, used read-only as node N1 */
  n1: { id: string; name: string; pool: string; token: string }
  /** fingerprint of A's GET representations right after seeding, and the representations (for a diff) */
  fingerprint: string
  representations: Record<string, unknown>
}

export async function saveSeed(testInfo: TestInfo, seed: Seed): Promise<void> {
  await writeFile(seedFile(testInfo), JSON.stringify(seed, null, 2), { mode: 0o600 })
}

const cache = new Map<string, Seed>()
/** The seed authz/seed.setup.ts wrote for this run (the `authz` project depends on it). */
export function loadSeed(testInfo: TestInfo): Seed {
  const file = seedFile(testInfo)
  let seed = cache.get(file)
  if (!seed) {
    seed = JSON.parse(readFileSync(file, 'utf8')) as Seed
    cache.set(file, seed)
  }
  return seed
}

/** A client on a new request context with a storage state or an Authorization header; dispose its `request`. */
export async function clientFor(
  openapi: OpenApiIndex,
  credential: { storageState?: string; bearer?: string; headers?: Record<string, string> } = {},
): Promise<ApiClient> {
  const headers = { ...credential.headers, ...(credential.bearer ? { Authorization: `Bearer ${credential.bearer}` } : {}) }
  return new ApiClient(await newApiContext({ storageState: credential.storageState, headers }), openapi)
}

/**
 * Keys whose values change without any write to the resource: caches, presigned links, request bookkeeping, and the
 * reconciler's final recount of a terminal scan two minutes after its completion (`stats.recountedAt`; a recount that
 * changed a count would still show in the counters).
 */
const VOLATILE_KEYS = new Set(['checkedAt', 'lastRequest', 'download', 'serverTime', 'recountedAt'])

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) if (!VOLATILE_KEYS.has(key)) out[key] = normalize((value as Record<string, unknown>)[key])
  return out
}

function part(response: ApiResponse): unknown {
  const body = (response.headers['content-type'] ?? '').includes('json') ? normalize(response.body) : response.raw.toString('base64')
  return { status: response.status, body }
}

/**
 * The task without `updatedAt`: getTaskWorkspace, a read that A and the admin legitimately call in parallel tests,
 * refreshes the cached `tasks.workspace` and with it `updatedAt` (docs/api.md §4.6). Every write B could make shows in
 * the workspace summary, the file list, the manifest or the revisions instead.
 */
function taskPart(response: ApiResponse): unknown {
  const value = part(response) as { status: number; body: unknown }
  if (value.body && typeof value.body === 'object') delete (value.body as Record<string, unknown>).updatedAt
  return value
}

/**
 * A's GET representations, read as A: task, revision, manifest and file list, scan, analysis, test run, export, upload,
 * credential, job and API key. Normalized (volatile keys dropped) so that only real changes alter the fingerprint.
 */
export async function representationsOfA(api: ApiClient, a: TenantA): Promise<Record<string, unknown>> {
  const task = { task: a.taskId }
  const credentials = await api.call<ItemList<Credential>>('listCredentials')
  const keys = await api.call<ItemList<ApiKey>>('listApiKeys')
  return {
    task: taskPart(await api.call('getTask', { path: task })),
    revision: part(await api.call('getRevision', { path: { ...task, revision: a.revisionId } })),
    revisions: part(await api.call('listRevisions', { path: task })),
    manifest: part(await api.call('readTaskFile', { path: task, query: { path: 'scantor.yaml' } })),
    files: part(await api.call('listTaskFiles', { path: task, query: { recursive: true } })),
    scan: part(await api.call('getScan', { path: { scanId: a.scanId } })),
    analysis: part(await api.call('getAnalysis', { path: { analysisId: a.analysisId } })),
    testRun: part(await api.call('getTestRun', { path: { testRunId: a.testRunId }, query: { analyses: true } })),
    export: part(await api.call('getExport', { path: { exportId: a.exportId } })),
    upload: part(await api.call('getUpload', { path: { uploadId: a.uploadId } })),
    credential: normalize(credentials.body.items?.find((c) => c.id === a.credentialId) ?? null),
    job: part(await api.call('getJob', { path: { jobId: a.jobId } })),
    apiKey: normalize(keys.body.items?.find((k) => k.id === a.keyId) ?? null),
  }
}

export function fingerprint(representations: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(representations)).digest('hex')
}
