import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { APIRequestContext } from '@playwright/test'
import type { CallToolResult, Tool } from '@modelcontextprotocol/client'
import type { CreatedApiKey } from '#shared/types/account'
import type { ItemList, Page } from '#shared/types/common'
import type { Credential } from '#shared/types/credentials'
import type { Export } from '#shared/types/exports'
import type { NodeWithToken } from '#shared/types/nodes'
import type { Scan } from '#shared/types/scans'
import type { Task } from '#shared/types/tasks'
import type { TestRun } from '#shared/types/test-runs'
import type { Upload } from '#shared/types/uploads'
import type { Worker } from '#shared/types/workers'
import { ACTIVE_WORKER_STATES } from '#shared/utils/enums'
import { ApiClient, ok } from '../helpers/api-client'
import {
  buildRequest,
  describe as describeAnswer,
  errorCode,
  FAKE_SETUP_TOKEN,
  idsOfA,
  isAccountScoped,
  isDestructive,
  isOk,
  isRead,
  operationsOf,
  Principals,
  referencesOwned,
  scopeOf,
  send,
  type Answer,
  type PrincipalName,
} from '../helpers/authz-matrix'
import { clientFor, fingerprint, loadSeed, representationsOfA, type Seed } from '../helpers/authz-seed'
import { stackKeys } from '../helpers/keys'
import { connectWithGrant, registerMatrixClient, type McpGrant } from '../helpers/authz-mcp'
import { connectMcpWithKey, DEFAULT_MCP_SCOPES, resultText } from '../helpers/mcp'
import type { OpenApiIndex, OpenApiOperation } from '../helpers/openapi'
import { cancelAndDeleteScan, SMALL_SETTINGS, startScan } from '../helpers/scans'
import { createUser, deleteUser, newApiContext } from '../helpers/users'
import { OWNED_PARAMS, REQUESTS, type Ids } from './requests'
import { expect, test as base, unique } from '../fixtures'

// The generated authorization matrix (docs/security.md §7, docs/testing.md §8.5). Every operation of the live OpenAPI
// document is called by every principal of its scope's row, with the request authz/requests.ts builds for it against
// the resources the authz-setup project seeded (.auth/authz.json): anonymous callers, user B with A's ids, A, the
// admin (session and `default` key), an admin's `editor` key, node and worker tokens, setup tokens and tools cookies.
// The tests are fixed per principal and scope and loop over the operations at run time, so a new operation is covered
// without a new test (and fails until requests.ts has its factory). Reads run first; destructive operations run last
// on throwaway copies; after all of B's attempts the fingerprint of A's GET representations is unchanged.

interface MatrixFixtures {
  seed: Seed
  principals: Principals
}

const test = base.extend<MatrixFixtures>({
  seed: async ({}, use, testInfo) => use(loadSeed(testInfo)),
  principals: async ({ seed }, use) => {
    const principals = new Principals(seed)
    await use(principals)
    await principals.dispose()
  },
})

// The matrix uses the seeded principals only: the worker's own tenant is never created.
test.use({ storageState: { cookies: [], origins: [] } })

const NOT_FOUND = 'notFound'
/** Scan settings whose workers can never be placed (no node is in this pool): such a scan starts but never runs. */
const UNPLACEABLE = { ...SMALL_SETTINGS, nodeSelector: { pool: 'authz-matrix-nowhere' } }

/** Destructive operations in an order that keeps parents alive until their children were tried. */
function destructiveRank(op: OpenApiOperation): number {
  if (op.operationId === 'deleteTask' || op.operationId === 'deleteScan') return 3
  return op.method === 'delete' ? 2 : 1
}
const byDestructiveOrder = (x: OpenApiOperation, y: OpenApiOperation) => destructiveRank(x) - destructiveRank(y) || x.operationId.localeCompare(y.operationId)

/** Owner operations that address or reference A's resources, excluding account-scoped ones when asked. */
function crossTenantOperations(openapi: OpenApiIndex, filter: (op: OpenApiOperation) => boolean): OpenApiOperation[] {
  return operationsOf(openapi, 'owner').filter((op) => referencesOwned(op) && filter(op))
}

async function expectStatus(principal: string, op: OpenApiOperation, answer: Answer, status: number, code?: string): Promise<void> {
  expect.soft(answer.status, `${principal}: ${describeAnswer(op, answer)}`).toBe(status)
  if (code !== undefined) expect.soft(errorCode(answer), `${principal}: ${describeAnswer(op, answer)}`).toBe(code)
}

// ── throwaway copies of A's resources ─────────────────────────────────────────────────────────────────

interface Throwaways {
  ids: Ids
  cleanup(): Promise<void>
}

/**
 * Copies of A's addressable resources, created as A, for destructive cases and for the owner's and the admin's
 * mutations: a scaffold task, a scan of alpha's revision (its workers can never be placed, so it never runs), an export,
 * a list upload, a git credential and an API key. A's completed test run stands in for a copy: the only destructive
 * operation on it, cancelTestRun, cannot change a finished run. Nothing of A's seeded resources is changed by creating
 * the copies, so the fingerprint stays valid. `cleanup` removes whatever is left of them (404 counts as removed).
 */
async function createThrowaways(seed: Seed, openapi: OpenApiIndex): Promise<Throwaways> {
  const a = await clientFor(openapi, { storageState: seed.a.storageState })
  const name = unique('authz-copy')
  const [task, scan, exported, upload, credential, key] = await Promise.all([
    a.call<Task>('createTask', { body: { name, language: 'python' } }).then((r) => ok(r, 'createTask')),
    startScan(a, { revision: seed.a.revisionId, name, scanConfig: { items: ['authz-copy'] }, settings: UNPLACEABLE }),
    a.call<Export>('exportScan', { path: { scanId: seed.a.scanId }, body: { format: 'csv' } }).then((r) => ok(r, 'exportScan')),
    a
      .call<Upload>('createUpload', {
        body: Buffer.from(`${name}.example\n`),
        headers: { 'Content-Type': 'text/plain' },
        query: { name: `${name}.txt`, kind: 'list' },
      })
      .then((r) => ok(r, 'createUpload')),
    a
      .call<Credential>('createCredential', { body: { kind: 'gitToken', name, host: idsOfA(seed).gitHost, username: 'authz', token: 'authz-token' } })
      .then((r) => ok(r, 'createCredential')),
    a.call<CreatedApiKey>('createApiKey', { body: { name: name.slice(0, 32), expiresInDays: 1 } }).then((r) => ok(r, 'createApiKey')),
  ])
  const ids = idsOfA(seed, {
    task: task.id,
    scanId: scan.id,
    exportId: exported.id,
    uploadId: upload.id,
    credentialId: credential.id,
    keyId: key.apiKey.id,
  })
  return {
    ids,
    cleanup: async () => {
      // Only what keeps the platform busy is waited for: the copy scan is cancelled (its workers never ran). Every other
      // deletion is fired at once; a task still held by its scan (409 taskInUse) is left to A's purge at the teardown.
      try {
        await cancelAndDeleteScan(a, scan.id)
        const answers = await Promise.all([
          a.call('deleteExport', { path: { exportId: exported.id } }),
          a.call('deleteUpload', { path: { uploadId: upload.id } }),
          a.call('deleteCredential', { path: { credentialId: credential.id } }),
          a.call('deleteApiKey', { path: { keyId: key.apiKey.id } }),
          a.call('deleteTask', { path: { task: task.id } }),
        ])
        for (const answer of answers) expect([200, 202, 204, 404, 409], `cleanup of a copy answered ${answer.status}`).toContain(answer.status)
      } finally {
        await a.request.dispose()
      }
    },
  }
}

/** The copies still exist and were not acted on (read as A). */
async function expectThrowawaysIntact(seed: Seed, openapi: OpenApiIndex, ids: Ids): Promise<void> {
  const a = await clientFor(openapi, { storageState: seed.a.storageState })
  try {
    expect((await a.call('getTask', { path: { task: ids.task } })).status).toBe(200)
    expect((await a.call('readTaskFile', { path: { task: ids.task }, query: { path: 'scantor.yaml' } })).status, 'the manifest of the copy').toBe(200)
    const scan = await a.call<Scan>('getScan', { path: { scanId: ids.scanId } })
    expect(scan.status).toBe(200)
    expect(['cancelled', 'deleting', 'deleted']).not.toContain(scan.body.state)
    const run = await a.call<TestRun>('getTestRun', { path: { testRunId: ids.testRunId } })
    expect(run.status).toBe(200)
    expect(run.body.state, 'A’s test run is still completed').toBe('completed')
    expect((await a.call('getExport', { path: { exportId: ids.exportId } })).status).toBe(200)
    expect((await a.call('getUpload', { path: { uploadId: ids.uploadId } })).status).toBe(200)
    const credentials = ok(await a.call<ItemList<Credential>>('listCredentials'), 'listCredentials')
    expect(credentials.items.map((c) => c.id)).toContain(ids.credentialId)
    const keys = ok(await a.call<ItemList<{ id: string }>>('listApiKeys'), 'listApiKeys')
    expect(keys.items.map((k) => k.id)).toContain(ids.keyId)
  } finally {
    await a.request.dispose()
  }
}

/** Pages through a list (newest first, 200 per page) until `found` matches an item or the list ends. */
async function findInList<T>(
  client: ApiClient,
  operationId: string,
  query: Record<string, string | number>,
  found: (item: T) => boolean,
): Promise<T | undefined> {
  let cursor: string | undefined
  for (let page = 0; page < 100; page++) {
    const body = ok(await client.call<Page<T>>(operationId, { query: { ...query, limit: 200, cursor }, validate: false }), operationId)
    const hit = body.items.find(found)
    if (hit || !body.nextCursor) return hit
    cursor = body.nextCursor
  }
  throw new Error(`${operationId}: more than 100 pages`)
}

// ── the matrix ────────────────────────────────────────────────────────────────────────────────────────

test.describe('authorization matrix', () => {
  test('authz/requests.ts covers every operation of the document', { tag: ['@AUTHZ-001', '@AUTHZ-002'] }, ({ openapi, seed }) => {
    const ids = idsOfA(seed)
    const problems: string[] = []
    for (const op of openapi.operations.values()) {
      try {
        buildRequest(op, ids)
      } catch (error) {
        problems.push(String((error as Error).message))
      }
    }
    expect(problems).toEqual([])
    expect(
      Object.keys(REQUESTS).filter((id) => !openapi.operations.has(id)),
      'factories of operations the document does not have',
    ).toEqual([])
    for (const op of openapi.operations.values()) {
      for (const param of op.parameters.filter((p) => p.in === 'path')) {
        if (['userId', 'nodeId', 'template', 'language', 'guide'].includes(param.name)) continue
        expect.soft(OWNED_PARAMS.has(param.name), `{${param.name}} of ${op.operationId} is classified as an owned resource`).toBe(true)
      }
    }
  })

  test('every owner-scope operation answers 401 to anonymous callers', { tag: ['@AUTHZ-001'] }, async ({ openapi, seed, principals }) => {
    const ids = idsOfA(seed)
    const operations = operationsOf(openapi, 'owner')
    expect(operations.length).toBeGreaterThan(50)
    for (const name of ['anonymous', 'invalidBearer', 'invalidApiKey'] as const) {
      const context = await principals.get(name)
      for (const op of operations) await expectStatus(name, op, await send(context, op, buildRequest(op, ids)), 401, 'unauthorized')
    }
  })

  test(
    'machine credentials are never user principals on owner and admin operations',
    { tag: ['@AUTHZ-001', '@AUTHZ-008'] },
    async ({ openapi, seed, principals }) => {
      const ids = idsOfA(seed, { userId: randomUUID(), nodeId: randomUUID() })
      for (const name of ['nodeToken', 'workerToken', 'setupToken'] as const) {
        const context = await principals.get(name)
        for (const op of [...operationsOf(openapi, 'owner'), ...operationsOf(openapi, 'admin')]) {
          await expectStatus(name, op, await send(context, op, buildRequest(op, ids)), 401, 'unauthorized')
        }
      }
    },
  )

  test.describe('user B with A’s ids', () => {
    // Reads, then mutations of A's real resources, then destructive operations on copies, then the fingerprint:
    // in this order, in one worker, and each test still runs when an earlier one failed.
    test.describe.configure({ mode: 'default' })

    test('B’s reads of A’s resources answer 404', { tag: ['@AUTHZ-002'] }, async ({ openapi, seed, principals }) => {
      const ids = idsOfA(seed)
      const reads = crossTenantOperations(openapi, (op) => isRead(op))
      expect(reads.map((op) => op.operationId)).toEqual(
        expect.arrayContaining(['getTask', 'getRevision', 'getScan', 'getAnalysis', 'getFileDownload', 'getTestRun', 'getExport', 'getUpload', 'getJob']),
      )
      for (const name of ['bSession', 'bKey'] as const) {
        const context = await principals.get(name)
        for (const op of reads) await expectStatus(name, op, await send(context, op, buildRequest(op, ids)), 404, NOT_FOUND)
      }
    })

    test('B’s mutations of A’s resources answer 404', { tag: ['@AUTHZ-002'] }, async ({ openapi, seed, principals }) => {
      const ids = idsOfA(seed)
      const mutations = crossTenantOperations(openapi, (op) => !isRead(op) && !isDestructive(op))
      expect(mutations.map((op) => op.operationId)).toEqual(
        expect.arrayContaining(['updateCredential', 'writeTaskFiles', 'publishRevision', 'pauseScan', 'scaleScan', 'restartScan', 'exportScan', 'testTask']),
      )
      for (const name of ['bSession', 'bKey'] as const) {
        const context = await principals.get(name)
        for (const op of mutations) await expectStatus(name, op, await send(context, op, buildRequest(op, ids)), 404, NOT_FOUND)
      }
    })

    test(
      'B’s destructive operations on copies of A’s resources answer 404 and leave them intact',
      { tag: ['@AUTHZ-002'] },
      async ({ openapi, seed, principals }) => {
        const copies = await createThrowaways(seed, openapi)
        try {
          const destructive = crossTenantOperations(openapi, (op) => isDestructive(op)).sort(byDestructiveOrder)
          expect(destructive.map((op) => op.operationId)).toEqual(
            expect.arrayContaining([
              'deleteTask',
              'deleteTaskFile',
              'deleteScan',
              'cancelScan',
              'retryFailedAnalyses',
              'cancelTestRun',
              'deleteExport',
              'deleteUpload',
              'deleteCredential',
              'deleteApiKey',
            ]),
          )
          for (const name of ['bSession', 'bKey'] as const) {
            const context = await principals.get(name)
            for (const op of destructive) await expectStatus(name, op, await send(context, op, buildRequest(op, copies.ids)), 404, NOT_FOUND)
          }
          await expectThrowawaysIntact(seed, openapi, copies.ids)
        } finally {
          await copies.cleanup()
        }
      },
    )

    test('A’s representations are unchanged after all of B’s attempts', { tag: ['@AUTHZ-002'] }, async ({ openapi, seed }) => {
      const a = await clientFor(openapi, { storageState: seed.a.storageState })
      try {
        const now = await representationsOfA(a, seed.a)
        expect(now).toEqual(seed.representations)
        expect(fingerprint(now)).toBe(seed.fingerprint)
      } finally {
        await a.request.dispose()
      }
    })
  })

  test('A reads and acts on its own resources with its session and its key', { tag: ['@AUTHZ-002', '@AUTHZ-009'] }, async ({ openapi, seed, principals }) => {
    const ids = idsOfA(seed)
    for (const name of ['aSession', 'aKey'] as const) {
      const context = await principals.get(name)
      for (const op of operationsOf(openapi, 'owner').filter((op) => isRead(op))) {
        const answer = await send(context, op, buildRequest(op, ids, 'safe'))
        expect.soft(isOk(answer.status), `${name}: ${describeAnswer(op, answer)}`).toBe(true)
      }
    }
    const copies = await createThrowaways(seed, openapi)
    try {
      const context = await principals.get('aSession')
      const keyContext = await principals.get('aKey')
      const mutations = operationsOf(openapi, 'owner').filter((op) => !isRead(op))
      for (const op of mutations.filter((op) => !isDestructive(op)).concat(mutations.filter(isDestructive).sort(byDestructiveOrder))) {
        if (op.operationId === 'stopEditor' || op.operationId === 'createEditorSession') continue
        const sessionOnly = op.extensions['x-session-only'] === true
        const answer = await send(context, op, buildRequest(op, copies.ids, 'safe'))
        if (op.parameters.some((p) => p.in === 'path' && p.name === 'clientId')) {
          // A has authorized no OAuth application (there is no copy to act on): its own unknown app is 404.
          await expectStatus('aSession', op, answer, 404, NOT_FOUND)
        } else {
          // removeAccountPassword answers 409 for A, whose password is its only credential.
          expect.soft(isOk(answer.status), `aSession: ${describeAnswer(op, answer)}`).toBe(true)
        }
        if (sessionOnly) await expectStatus('aKey', op, await send(keyContext, op, buildRequest(op, copies.ids, 'safe')), 403, 'sessionRequired')
      }
    } finally {
      await copies.cleanup()
    }
  })

  // ── admins ────────────────────────────────────────────────────────────────────────────────────────

  test('an admin reads every resource of A by id, with a session and a default key', { tag: ['@AUTHZ-003'] }, async ({ openapi, seed, principals }) => {
    const ids = idsOfA(seed)
    const reads = crossTenantOperations(openapi, (op) => isRead(op) && !isAccountScoped(op) && REQUESTS[op.operationId]?.bodyRefs !== true)
    expect(reads.length).toBeGreaterThan(20)
    for (const name of ['adminSession', 'adminKey'] as const) {
      const context = await principals.get(name)
      for (const op of reads) {
        const answer = await send(context, op, buildRequest(op, ids))
        expect.soft(isOk(answer.status), `${name}: ${describeAnswer(op, answer)}`).toBe(true)
      }
      const task = await send(context, openapi.get('getTask'), buildRequest(openapi.get('getTask'), ids))
      expect((task.json as Task).userId, 'the admin reads A’s task').toBe(seed.a.id)
    }
  })

  test('an admin acts on A’s resources by id', { tag: ['@AUTHZ-003'] }, async ({ openapi, seed, principals }) => {
    const copies = await createThrowaways(seed, openapi)
    try {
      const all = crossTenantOperations(openapi, (op) => !isRead(op) && !isAccountScoped(op) && REQUESTS[op.operationId]?.bodyRefs !== true)
      const ordered = all.filter((op) => !isDestructive(op)).concat(all.filter(isDestructive).sort(byDestructiveOrder))
      expect(ordered.map((op) => op.operationId)).toEqual(
        expect.arrayContaining(['writeTaskFiles', 'updateCredential', 'pauseScan', 'cancelScan', 'deleteScan', 'deleteTask']),
      )
      const context = await principals.get('adminSession')
      for (const op of ordered) {
        const answer = await send(context, op, buildRequest(op, copies.ids, 'safe'))
        expect.soft(isOk(answer.status), `adminSession: ${describeAnswer(op, answer)}`).toBe(true)
      }
      // The admin's writes landed on A's copies: the credential was renamed and the task deleted.
      const a = await clientFor(openapi, { storageState: seed.a.storageState })
      try {
        expect((await a.call('getTask', { path: { task: copies.ids.task } })).status).toBe(404)
        expect((await a.call('getUpload', { path: { uploadId: copies.ids.uploadId } })).status).toBe(404)
      } finally {
        await a.request.dispose()
      }
    } finally {
      await copies.cleanup()
    }
  })

  test('list operations return every user’s items to an admin', { tag: ['@AUTHZ-003'] }, async ({ openapi, seed }) => {
    for (const credential of [{ storageState: seed.admin.storageState }, { bearer: seed.admin.key }]) {
      const admin = await clientFor(openapi, credential)
      try {
        expect(await findInList<Task>(admin, 'listTasks', {}, (t) => t.id === seed.a.taskId), 'A’s task').toBeTruthy()
        expect(await findInList<Task>(admin, 'listTasks', {}, (t) => t.id === seed.b.taskId), 'B’s task').toBeTruthy()
        expect(await findInList<{ id: string }>(admin, 'listScans', {}, (s) => s.id === seed.a.scanId), 'A’s scan').toBeTruthy()
        expect(await findInList<{ id: string }>(admin, 'listJobs', {}, (j) => j.id === seed.a.jobId), 'A’s job').toBeTruthy()
        expect(await findInList<{ id: string }>(admin, 'listExports', {}, (e) => e.id === seed.a.exportId), 'A’s export').toBeTruthy()
      } finally {
        await admin.request.dispose()
      }
    }
  })

  // product bug: listUploads and listCredentials stay caller-scoped for admins
  test.fail(
    'upload and credential lists return every user’s items to an admin',
    {
      tag: ['@AUTHZ-003'],
      annotation: {
        type: 'issue',
        description:
          'listUploads and listCredentials filter by the caller’s userId for admins too, unlike every other list (docs/api.md §1: admins get everything)',
      },
    },
    async ({ openapi, seed }) => {
      const admin = await clientFor(openapi, { storageState: seed.admin.storageState })
      try {
        // The admin reaches both by id (owner and admins may read them, docs/data-model.md §5) ...
        expect((await admin.call('getUpload', { path: { uploadId: seed.a.uploadId }, validate: false })).status).toBe(200)
        // ... but the lists leave them out.
        expect.soft(await findInList<{ id: string }>(admin, 'listUploads', {}, (u) => u.id === seed.a.uploadId), 'A’s upload in listUploads').toBeTruthy()
        const credentials = ok(await admin.call<ItemList<Credential>>('listCredentials', { validate: false }), 'listCredentials')
        expect
          .soft(
            credentials.items.map((c) => c.id),
            'A’s credential in listCredentials',
          )
          .toContain(seed.a.credentialId)
      } finally {
        await admin.request.dispose()
      }
    },
  )

  test('a userId filter is admin-only except for the caller’s own id', { tag: ['@AUTHZ-004'] }, async ({ openapi, seed, principals }) => {
    const lists = ['listTasks', 'listScans', 'listJobs'].map((id) => openapi.get(id))
    for (const op of lists)
      expect(
        op.parameters.map((p) => p.name),
        op.operationId,
      ).toContain('userId')
    for (const name of ['bSession', 'bKey'] as const) {
      const context = await principals.get(name)
      for (const op of lists) {
        await expectStatus(name, op, await send(context, op, { query: { userId: seed.a.id } }), 403, 'adminRequired')
        const own = await send(context, op, { query: { userId: seed.b.id } })
        expect.soft(own.status, `${name} with its own id: ${describeAnswer(op, own)}`).toBe(200)
      }
    }
    const admin = await clientFor(openapi, { storageState: seed.admin.storageState })
    const b = await clientFor(openapi, { storageState: seed.b.storageState })
    try {
      const tasks = ok(await admin.call<Page<Task>>('listTasks', { query: { userId: seed.a.id, limit: 200 }, validate: false }), 'listTasks')
      expect(tasks.items.map((t) => t.id)).toContain(seed.a.taskId)
      expect(new Set(tasks.items.map((t) => t.userId))).toEqual(new Set([seed.a.id]))
      const scans = ok(
        await admin.call<Page<{ id: string; userId: string }>>('listScans', { query: { userId: seed.a.id, limit: 200 }, validate: false }),
        'listScans',
      )
      expect(scans.items.map((s) => s.id)).toContain(seed.a.scanId)
      expect(new Set(scans.items.map((s) => s.userId))).toEqual(new Set([seed.a.id]))
      const jobs = ok(await admin.call<Page<{ id: string }>>('listJobs', { query: { userId: seed.a.id, limit: 200 }, validate: false }), 'listJobs')
      expect(jobs.items.map((j) => j.id)).toContain(seed.a.jobId)
      const jobsOfB = ok(await b.call<Page<{ id: string }>>('listJobs', { query: { limit: 200 }, validate: false }), 'listJobs').items.map((j) => j.id)
      for (const id of jobsOfB)
        expect(
          jobs.items.map((j) => j.id),
          'B’s jobs are not listed for A',
        ).not.toContain(id)
    } finally {
      await admin.request.dispose()
      await b.request.dispose()
    }
  })

  test('no list B receives contains any of A’s ids', { tag: ['@AUTHZ-005'] }, async ({ openapi, seed, principals }) => {
    const { a } = seed
    const secretsOfA = [
      a.id,
      a.taskId,
      a.revisionId,
      a.scanId,
      a.analysisId,
      a.testRunId,
      a.exportId,
      a.uploadId,
      a.credentialId,
      a.jobId,
      a.keyId,
      ...a.workers.map((w) => w.id),
    ]
    const lists: [string, Record<string, string>][] = [
      ['listTasks', {}],
      ['listScans', {}],
      ['listRevisions', { task: seed.b.taskId }],
      ['listTestRuns', { task: seed.b.taskId }],
      ['listUploads', {}],
      ['listExports', {}],
      ['listJobs', {}],
      ['listCredentials', {}],
      ['listApiKeys', {}],
      ['listOAuthApps', {}],
    ]
    for (const name of ['bSession', 'bKey'] as const) {
      const context = await principals.get(name)
      for (const [operationId, path] of lists) {
        const op = openapi.get(operationId)
        const answer = await send(context, op, { path, query: op.parameters.some((p) => p.name === 'limit') ? { limit: 200 } : {} })
        expect.soft(answer.status, `${name}: ${describeAnswer(op, answer)}`).toBe(200)
        for (const id of secretsOfA) expect.soft(answer.text, `${name}: ${operationId} lists A’s ${id}`).not.toContain(id)
      }
      // The lists are B's own, not empty by accident.
      const tasks = await send(context, openapi.get('listTasks'), { query: { limit: 200 } })
      expect((tasks.json as Page<Task>).items.map((t) => t.id)).toContain(seed.b.taskId)
      const revisions = await send(context, openapi.get('listRevisions'), { path: { task: seed.b.taskId } })
      expect(revisions.text).toContain(seed.b.revisionId)
    }
  })

  test('task names and revision references resolve only among the caller’s tasks', { tag: ['@AUTHZ-006'] }, async ({ openapi, seed }) => {
    const b = await clientFor(openapi, { storageState: seed.b.storageState })
    const admin = await clientFor(openapi, { storageState: seed.admin.storageState })
    try {
      expect(ok(await b.getTask('alpha'), 'getTask').id).toBe(seed.b.taskId)
      for (const revision of ['1', 'latest', seed.b.revisionId]) {
        expect(
          ok(await b.call<{ id: string }>('getRevision', { path: { task: 'alpha', revision }, validate: false }), 'getRevision').id,
          `alpha/${revision}`,
        ).toBe(seed.b.revisionId)
      }
      expect((await b.call('getRevision', { path: { task: 'alpha', revision: seed.a.revisionId } })).status, 'A’s revision id under B’s alpha').toBe(404)
      // Body references: B's `alpha@1` starts B's revision, never A's. The scans' workers can never be placed (a pool
      // without nodes), so nothing runs and the cancel is immediate.
      const references = ['alpha@1', 'alpha@latest', 'alpha']
      const started = await Promise.all(
        references.map((revision) =>
          b.call<Scan>('startScan', { body: { revision, scanConfig: { items: ['authz-names'] }, settings: UNPLACEABLE }, validate: false }),
        ),
      )
      try {
        references.forEach((reference, i) => {
          expect(started[i]!.status, `${reference}: ${JSON.stringify(started[i]!.body)}`).toBe(201)
          expect(started[i]!.body.revision.id, reference).toBe(seed.b.revisionId)
          expect(started[i]!.body.userId).toBe(seed.b.id)
        })
      } finally {
        await Promise.all(started.filter((r) => r.status === 201).map((r) => cancelAndDeleteScan(b, r.body.id)))
      }

      // An admin's name lookups are the admin's own: there is no `alpha` of the admin.
      expect((await admin.call('getTask', { path: { task: 'alpha' } })).status).toBe(404)
      expect((await admin.call('getRevision', { path: { task: 'alpha', revision: 'latest' } })).status).toBe(404)
      expect((await admin.call('listTaskFiles', { path: { task: 'alpha' } })).status).toBe(404)
      const adminStart = await admin.call('startScan', { body: { revision: 'alpha@1', settings: SMALL_SETTINGS } })
      expect(adminStart.status).toBe(404)
      // By id the admin reaches either tenant's task.
      expect(ok(await admin.call<Task>('getTask', { path: { task: seed.a.taskId }, validate: false }), 'getTask').userId).toBe(seed.a.id)
      expect(ok(await admin.call<Task>('getTask', { path: { task: seed.b.taskId }, validate: false }), 'getTask').userId).toBe(seed.b.id)
    } finally {
      await b.request.dispose()
      await admin.request.dispose()
    }
  })

  test('a create that references another user’s document answers 404, also for admins', { tag: ['@AUTHZ-007'] }, async ({ openapi, seed, principals }) => {
    const ids = idsOfA(seed)
    const creates = [...openapi.operations.values()].filter((op) => REQUESTS[op.operationId]?.bodyRefs === true)
    expect(creates.map((op) => op.operationId).sort()).toEqual(['estimateTemplate', 'importGitTask', 'startScan'])
    const references: { label: string; op: string; body: Record<string, unknown> }[] = [
      { label: 'A’s revision id', op: 'startScan', body: { revision: seed.a.revisionId, scanConfig: { items: ['x'] }, settings: UNPLACEABLE } },
      { label: 'A’s task id as a revision reference', op: 'startScan', body: { revision: seed.a.taskId, scanConfig: { items: ['x'] }, settings: UNPLACEABLE } },
      {
        label: 'A’s upload in the scan config',
        op: 'startScan',
        body: { revision: seed.b.revisionId, scanConfig: { upload: seed.a.uploadId }, settings: UNPLACEABLE },
      },
      { label: 'A’s credential', op: 'importGitTask', body: buildRequest(openapi.get('importGitTask'), ids).body as Record<string, unknown> },
      { label: 'A’s upload', op: 'estimateTemplate', body: { scanConfig: { upload: seed.a.uploadId } } },
    ]
    for (const name of ['bSession', 'bKey', 'adminSession', 'adminKey'] as const) {
      const context = await principals.get(name)
      for (const reference of references) {
        // B's own revision in a scan with A's upload: only B may use B's revision, so the admin case uses the admin's
        // view of the same body (B's revision is not the admin's own document either).
        const op = openapi.get(reference.op)
        const answer = await send(context, op, { path: { template: 'list' }, body: reference.body })
        await expectStatus(`${name} (${reference.label})`, op, answer, 404, NOT_FOUND)
        if (answer.status === 201 && op.operationId === 'startScan') {
          const leaked = await clientFor(openapi, name.startsWith('admin') ? { storageState: seed.admin.storageState } : { storageState: seed.b.storageState })
          await cancelAndDeleteScan(leaked, (answer.json as Scan).id, { waitForJob: true })
          await leaked.request.dispose()
        }
      }
    }
    // The control: with the caller's own upload the same estimate works.
    const b = await clientFor(openapi, { storageState: seed.b.storageState })
    try {
      const upload = ok(
        await b.call<Upload>('createUpload', {
          body: Buffer.from('b.example\n'),
          headers: { 'Content-Type': 'text/plain' },
          query: { name: 'authz-b.txt', kind: 'list' },
        }),
        'createUpload',
      )
      expect((await b.call('estimateTemplate', { path: { template: 'list' }, body: { scanConfig: { upload: upload.id } }, validate: false })).status).toBe(200)
      await b.call('deleteUpload', { path: { uploadId: upload.id } })
    } finally {
      await b.request.dispose()
    }
  })

  test('an admin performs every admin-scope operation', { tag: ['@AUTHZ-008'] }, async ({ openapi, seed, principals, adminApi }) => {
    const user = await createUser(adminApi, { prefix: 'authz-admin-target' })
    const node = ok(await adminApi.call<NodeWithToken>('createNode', { body: { name: unique('authz-admin-target'), pool: unique('authz') } }), 'createNode')
    try {
      const ids = idsOfA(seed, { userId: user.id, nodeId: node.node.id })
      const operations = operationsOf(openapi, 'admin').sort((x, y) => (isDestructive(x) ? 1 : 0) - (isDestructive(y) ? 1 : 0))
      // deleteUser and deleteNode end the targets, so they run last.
      const last = (op: OpenApiOperation) => (op.operationId === 'deleteUser' || op.operationId === 'deleteNode' ? 1 : 0)
      for (const op of operations.sort((x, y) => last(x) - last(y))) {
        for (const name of ['adminSession', 'adminKey'] as const) {
          if (name === 'adminKey' && (op.operationId === 'deleteUser' || op.operationId === 'deleteNode')) continue
          const answer = await send(await principals.get(name), op, buildRequest(op, ids, 'safe'))
          if (op.extensions['x-session-only'] === true && name === 'adminKey') await expectStatus(name, op, answer, 403, 'sessionRequired')
          else expect.soft(isOk(answer.status), `${name}: ${describeAnswer(op, answer)}`).toBe(true)
        }
      }
    } finally {
      await deleteUser(adminApi, user.id)
      await adminApi.deleteNode(node.node.id)
    }
  })

  // A's role changes for the editor-key case (A is promoted to an admin and demoted again): the cases that need A
  // to be a plain user run before it, in order, in one worker.
  test.describe('A as a plain user and as an admin with an editor key', () => {
    test.describe.configure({ mode: 'default' })

    test(
      'every admin-scope operation answers 401 to anonymous callers and 403 adminRequired to non-admins',
      { tag: ['@AUTHZ-008'] },
      async ({ openapi, seed, principals, adminApi }) => {
        const operations = operationsOf(openapi, 'admin')
        expect(operations.map((op) => op.operationId)).toEqual(
          expect.arrayContaining(['listUsers', 'getMetrics', 'createToolsSession', 'listNodes', 'banUser', 'rotateNodeToken']),
        )
        // Throwaway targets, so a missing check could never touch a real user or node; and nonexistent ids.
        const user = await createUser(adminApi, { prefix: 'authz-target' })
        const node = ok(await adminApi.call<NodeWithToken>('createNode', { body: { name: unique('authz-target'), pool: unique('authz') } }), 'createNode')
        try {
          const targets = [idsOfA(seed, { userId: user.id, nodeId: node.node.id }), idsOfA(seed, { userId: randomUUID(), nodeId: randomUUID() })]
          for (const ids of targets) {
            for (const op of operations)
              await expectStatus('anonymous', op, await send(await principals.get('anonymous'), op, buildRequest(op, ids)), 401, 'unauthorized')
            for (const name of ['aSession', 'aKey', 'bSession', 'bKey'] as const) {
              const context = await principals.get(name)
              for (const op of operations) await expectStatus(name, op, await send(context, op, buildRequest(op, ids)), 403, 'adminRequired')
            }
          }
          // Unchanged: the throwaway user is not banned and the node's token was not rotated.
          expect(ok(await adminApi.getUser(user.id), 'getUser').banned).toBe(false)
          const listed = ok(await adminApi.listNodes(), 'listNodes').items.find((n) => n.id === node.node.id)
          expect(listed?.state).toBe(node.node.state)
        } finally {
          await deleteUser(adminApi, user.id)
          await adminApi.deleteNode(node.node.id)
        }
      },
    )

    test(
      'session-only operations answer 403 sessionRequired to API keys and are no MCP tools',
      { tag: ['@AUTHZ-009'] },
      async ({ openapi, seed, principals }) => {
        const sessionOnly = [...openapi.operations.values()].filter((op) => op.extensions['x-session-only'] === true)
        expect(sessionOnly.map((op) => op.operationId).sort()).toEqual(['createApiKey', 'createToolsSession', 'removeAccountPassword', 'setAccountPassword'])
        const ids = idsOfA(seed)
        for (const name of ['aKey', 'bKey', 'adminKey'] as const) {
          const context = await principals.get(name)
          for (const op of sessionOnly) {
            // A non-admin's key fails the admin check of createToolsSession first.
            const expected = op.operationId === 'createToolsSession' && name !== 'adminKey' ? 'adminRequired' : 'sessionRequired'
            await expectStatus(name, op, await send(context, op, buildRequest(op, ids)), 403, expected)
          }
        }
        for (const op of sessionOnly) expect(op.extensions['x-mcp'], `${op.operationId} is not an MCP tool`).toBe(false)
        const mcp = await connectMcpWithKey(seed.b.key)
        try {
          const names = (await mcp.listTools()).tools.map((t) => t.name)
          for (const op of sessionOnly) expect(names).not.toContain(snakeCase(op.operationId))
          // Not a tool, so not callable either: the server answers the call with a protocol error.
          await expect(mcp.callTool({ name: 'create_api_key', arguments: { name: 'x' } })).rejects.toThrow(/create_api_key not found/)
        } finally {
          await mcp.close()
        }
      },
    )

    test('an admin’s editor key carries no admin power', { tag: ['@AUTHZ-010'] }, async ({ openapi, seed, adminApi, docker }) => {
      test.setTimeout(180_000)
      const a = await clientFor(openapi, { storageState: seed.a.storageState })
      let editorKey: APIRequestContext | undefined
      let promoted = false
      try {
        // Starting A's editor mints A's `editor` key, handed to the container as SCANTOR_TOKEN (docs/editor.md §7).
        await expect
          .poll(async () => (await a.call('createEditorSession', { body: {}, validate: false })).status, {
            timeout: 120_000,
            message: 'createEditorSession of A',
          })
          .toBe(201)
        let key = ''
        await expect
          .poll(
            async () => {
              // The container appears a moment after the session; until then inspect fails.
              const inspect = await docker.inspect<{ Config: { Env: string[] } }>(`scantor-editor-${seed.a.id}`).catch(() => null)
              key = inspect?.Config.Env.find((e) => e.startsWith('SCANTOR_TOKEN='))?.slice('SCANTOR_TOKEN='.length) ?? ''
              return key
            },
            { timeout: 120_000, message: 'A’s editor container carries its key' },
          )
          .toMatch(/^sk_scantor_editor_[A-Za-z]{64}$/)
        editorKey = await newApiContext({ headers: { Authorization: `Bearer ${key}` } })

        // A is an admin for this case (docs/security.md §7 case 4); the user record is cached for up to 30 s.
        ok(await adminApi.call('updateUser', { path: { userId: seed.a.id }, body: { role: 'admin' } }), 'updateUser')
        promoted = true
        await expect
          .poll(async () => (await a.call('listUsers', { validate: false })).status, { timeout: 60_000, message: 'A’s session has admin power' })
          .toBe(200)

        const ids = idsOfA(seed, { userId: randomUUID(), nodeId: randomUUID() })
        for (const op of operationsOf(openapi, 'admin'))
          await expectStatus('editor key', op, await send(editorKey, op, buildRequest(op, ids)), 403, 'adminRequired')
        const createSession = openapi.get('createEditorSession')
        await expectStatus('editor key', createSession, await send(editorKey, createSession, { body: {} }), 403, 'forbidden')
        for (const op of [...openapi.operations.values()].filter((o) => o.extensions['x-session-only'] === true && scopeOf(o) === 'owner')) {
          await expectStatus('editor key', op, await send(editorKey, op, buildRequest(op, ids)), 403, 'sessionRequired')
        }
        // B's task and revision: A's admin session reads them, A's editor key gets 404 like any other user.
        const ofB = idsOfA(seed, { task: seed.b.taskId, revision: seed.b.revisionId })
        const taskReads = crossTenantOperations(
          openapi,
          (o) => isRead(o) && o.parameters.filter((p) => p.in === 'path').every((p) => p.name === 'task' || p.name === 'revision'),
        )
        expect(taskReads.map((op) => op.operationId)).toEqual(expect.arrayContaining(['getTask', 'getRevision', 'listTaskFiles', 'readTaskFile']))
        for (const op of taskReads) {
          await expectStatus('editor key', op, await send(editorKey, op, buildRequest(op, ofB)), 404, NOT_FOUND)
          const asAdmin = await send(a.request, op, buildRequest(op, ofB))
          expect.soft(isOk(asAdmin.status), `A’s admin session: ${describeAnswer(op, asAdmin)}`).toBe(true)
        }

        // Plain-user behaviour on owner routes: its own account and tasks, no userId filter, no admin tools.
        const account = await send(editorKey, openapi.get('getAccount'), {})
        expect(account.status).toBe(200)
        expect((account.json as { id: string }).id).toBe(seed.a.id)
        const listTasks = openapi.get('listTasks')
        const tasks = await send(editorKey, listTasks, { query: { limit: 200 } })
        expect(tasks.status).toBe(200)
        expect(new Set((tasks.json as Page<Task>).items.map((t) => t.userId))).toEqual(new Set([seed.a.id]))
        await expectStatus('editor key', listTasks, await send(editorKey, listTasks, { query: { userId: seed.b.id } }), 403, 'adminRequired')
        const info = await send(editorKey, openapi.get('getInstanceInfo'), {})
        expect(info.status).toBe(200)
        expect(info.json as Record<string, unknown>).not.toHaveProperty('adminTools')
      } finally {
        await editorKey?.dispose()
        if (promoted) {
          ok(await adminApi.call('updateUser', { path: { userId: seed.a.id }, body: { role: 'user' } }), 'updateUser')
          await expect
            .poll(async () => (await a.call('listUsers', { validate: false })).status, { timeout: 60_000, message: 'A is a plain user again' })
            .toBe(403)
        }
        const stopped = await a.call('stopEditor')
        expect([200, 202, 204]).toContain(stopped.status)
        await a.request.dispose()
      }
    })
  })

  test('public operations answer the same to every principal', { tag: ['@AUTHZ-011'] }, async ({ openapi, principals }) => {
    const publicOps = operationsOf(openapi, 'public')
    expect(publicOps.map((op) => op.operationId).sort()).toEqual(['getHealth', 'getSetupStatus'])
    const everyone: PrincipalName[] = [
      'anonymous',
      'aSession',
      'aKey',
      'adminSession',
      'adminKey',
      'nodeToken',
      'workerToken',
      'setupToken',
      'invalidBearer',
      'invalidApiKey',
    ]
    const reference = new Map<string, Answer>()
    for (const name of everyone) {
      const context = await principals.get(name)
      for (const op of publicOps) {
        const answer = await send(context, op, {})
        expect.soft(answer.status, `${name}: ${describeAnswer(op, answer)}`).toBe(200)
        const first = reference.get(op.operationId)
        if (!first) reference.set(op.operationId, answer)
        else if (op.operationId === 'getHealth')
          expect.soft(Object.keys(answer.json as object).sort(), `${name}: getHealth`).toEqual(Object.keys(first.json as object).sort())
        else expect.soft(answer.json, `${name}: ${op.operationId}`).toEqual(first.json)
      }
      for (const path of ['/api/docs', '/api/docs/openapi.json']) {
        const response = await context.get(path, { maxRedirects: 0 })
        expect.soft(response.status(), `${name}: ${path}`).toBe(200)
        if (path.endsWith('.json')) expect.soft(((await response.json()) as { openapi: string }).openapi, `${name}: ${path}`).toMatch(/^3\.1/)
        else expect.soft(response.headers()['content-type'], `${name}: ${path}`).toMatch(/^text\/html/)
      }
    }
  })

  // ── machine credentials ───────────────────────────────────────────────────────────────────────────

  test('node-scope operations reject every credential but a node token', { tag: ['@AUTHZ-012'] }, async ({ openapi, seed, principals }) => {
    const ids = idsOfA(seed)
    const operations = operationsOf(openapi, 'node')
    expect(operations.map((op) => op.operationId).sort()).toEqual([
      'createRegistryToken',
      'getNodeAssignments',
      'getRegistryToken',
      'nodeHello',
      'postNodeStatus',
      'postWorkerLogs',
    ])
    for (const name of ['anonymous', 'aSession', 'aKey', 'adminSession', 'adminKey', 'workerToken', 'setupToken', 'invalidBearer'] as const) {
      const context = await principals.get(name)
      for (const op of operations) {
        const answer = await send(context, op, buildRequest(op, ids))
        expect.soft(answer.status, `${name}: ${describeAnswer(op, answer)}`).toBe(401)
        // The registry token routes answer in the registry's own error format (docs/api.md §6).
        if (op.path === '/api/registry/token')
          expect.soft((answer.json as { errors?: { code: string }[] })?.errors?.[0]?.code, `${name}: ${op.operationId}`).toBe('UNAUTHORIZED')
        else expect.soft(errorCode(answer), `${name}: ${op.operationId}`).toBe('unauthorized')
      }
    }
  })

  test('a node token works for its own node and never for another node’s workers', { tag: ['@AUTHZ-012'] }, async ({ openapi, seed, adminApi }) => {
    const worker = seed.a.workers[0]!
    const workerBefore = ok(await adminApi.listScanWorkers(seed.a.scanId), 'listScanWorkers').items.find((w) => w.id === worker.id) as Worker
    // N1 (remote-1), read-only: its token authenticates, a registry token grants nothing for A's repository (N1 runs
    // none of its workers), and a request with a foreign instance id cannot take over its lease.
    const n1 = await newApiContext({ headers: { Authorization: `Bearer ${seed.n1.token}` } })
    try {
      const basic = `Basic ${Buffer.from(`node:${seed.n1.token}`).toString('base64')}`
      const token = await send(n1, openapi.get('getRegistryToken'), {
        query: { service: 'scantor-registry', scope: `repository:tasks/${seed.a.taskId}:pull` },
        headers: { Authorization: basic },
      })
      expect(token.status, token.text).toBe(200)
      const jwt = (token.json as { token: string }).token
      const claims = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as { sub: string; access: { name: string; actions: string[] }[] }
      expect(claims.sub).toBe(`node:${seed.n1.id}`)
      expect(claims.access.filter((a) => a.name === `tasks/${seed.a.taskId}` && a.actions.length > 0)).toEqual([])
      const foreign = idsOfA(seed, { instanceId: `${randomUUID()}:authz` })
      const assignments = await send(n1, openapi.get('getNodeAssignments'), buildRequest(openapi.get('getNodeAssignments'), foreign))
      expect(assignments.status, assignments.text).toBe(409)
      expect(errorCode(assignments)).toBe('nodeInstanceConflict')
    } finally {
      await n1.dispose()
    }

    // A throwaway node T (cordoned, in a pool of its own, so nothing is ever placed on it) plays a node in full.
    const created = ok(await adminApi.call<NodeWithToken>('createNode', { body: { name: unique('authz-node'), pool: unique('authz-pool') } }), 'createNode')
    const t = await newApiContext({ headers: { Authorization: `Bearer ${created.token}` } })
    try {
      expect((await adminApi.call('updateNode', { path: { nodeId: created.node.id }, body: { cordoned: true } })).status).toBe(200)
      const ids = idsOfA(seed, { instanceId: `${randomUUID()}:authz`, workerId: worker.id })
      const hello = await send(t, openapi.get('nodeHello'), buildRequest(openapi.get('nodeHello'), ids))
      expect(hello.status, hello.text).toBe(200)
      expect((hello.json as { node: { id: string } }).node.id).toBe(created.node.id)
      const assignments = await send(t, openapi.get('getNodeAssignments'), buildRequest(openapi.get('getNodeAssignments'), ids))
      expect(assignments.status, assignments.text).toBe(200)
      expect((assignments.json as { workers: unknown[] }).workers).toEqual([])
      // A status report and a log answer about A's worker (placed on another node) are ignored or refused.
      const status = await send(t, openapi.get('postNodeStatus'), buildRequest(openapi.get('postNodeStatus'), ids))
      expect(status.status, status.text).toBe(200)
      const logs = await send(t, openapi.get('postWorkerLogs'), buildRequest(openapi.get('postWorkerLogs'), ids))
      expect(logs.status, logs.text).toBe(404)
      const workerAfter = ok(await adminApi.listScanWorkers(seed.a.scanId), 'listScanWorkers').items.find((w) => w.id === worker.id) as Worker
      expect(workerAfter.state).toBe(workerBefore.state)
      expect(workerAfter.nodeId).toBe(workerBefore.nodeId)
      expect(workerAfter.container).toEqual(workerBefore.container)
    } finally {
      await t.dispose()
      const deleted = await adminApi.deleteNode(created.node.id)
      expect([200, 202, 204]).toContain(deleted.status)
    }
  })

  test(
    'worker-scope operations accept only an active worker’s token, and runners never use scheduler routes',
    { tag: ['@AUTHZ-013'] },
    async ({ openapi, seed, principals, adminApi }) => {
      test.setTimeout(180_000)
      const operations = operationsOf(openapi, 'worker')
      const schedulerRoutes = ['schedulerCheckpoint', 'schedulerDone', 'schedulerResolved']
      expect(operations.map((op) => op.operationId)).toEqual(expect.arrayContaining(schedulerRoutes))
      const ids = idsOfA(seed)
      // Everything but a worker token: 401 (the seeded worker's token is a stopped worker's).
      for (const name of ['anonymous', 'aSession', 'aKey', 'adminSession', 'adminKey', 'nodeToken', 'setupToken', 'invalidBearer', 'workerToken'] as const) {
        const context = await principals.get(name)
        for (const op of operations) await expectStatus(name, op, await send(context, op, buildRequest(op, ids)), 401, 'unauthorized')
      }

      // A running scan whose scheduler waits on backpressure while its one runner sleeps through its first analysis, so
      // both workers stay active for the whole test: the scan queue accepts SCANTOR_SCAN_QUEUE_MAX_READY messages plus
      // the publisher's unconfirmed window (docs/queue.md §10), far fewer than 100 000.
      const a = await clientFor(openapi, { storageState: seed.a.storageState })
      const name = unique('authz-sleep')
      let scanId: string | undefined
      try {
        scanId = (await startScan(a, { revision: seed.a.sleepRevisionId, name, taskConfig: { seconds: 3600 }, scanConfig: { times: 100_000 }, confirm: true }))
          .id
        // A worker token is valid in every active state of a placed worker (docs/auth.md §10.2), so the test needs
        // both workers placed, not running.
        let workers: Worker[] = []
        const active = (w: Worker) => (ACTIVE_WORKER_STATES as readonly string[]).includes(w.state) && Boolean(w.nodeId)
        await expect
          .poll(
            async () => {
              workers = ok(await adminApi.listScanWorkers(scanId!), 'listScanWorkers').items as Worker[]
              return [...new Set(workers.filter(active).map((w) => w.role))].sort()
            },
            { timeout: 120_000, intervals: [1_000], message: 'the scheduler and the runner are placed' },
          )
          .toEqual(['runner', 'scheduler'])
        const keys = stackKeys()
        const tokenOf = (role: string) => {
          const w = workers.find((x) => x.role === role && active(x))!
          return keys.workerToken({ workerId: w.id, scanId: w.scanId, role: w.role, nodeId: w.nodeId! })
        }
        const runner = await newApiContext({ headers: { Authorization: `Bearer ${tokenOf('runner')}` } })
        const scheduler = await newApiContext({ headers: { Authorization: `Bearer ${tokenOf('scheduler')}` } })
        try {
          const bootstrap = openapi.get('runtimeBootstrap')
          for (const [role, context] of [
            ['runner', runner],
            ['scheduler', scheduler],
          ] as const) {
            const answer = await send(context, bootstrap, buildRequest(bootstrap, ids))
            expect(answer.status, `${role}: ${describeAnswer(bootstrap, answer)}`).toBe(200)
          }
          for (const operationId of schedulerRoutes) {
            const op = openapi.get(operationId)
            await expectStatus('runner', op, await send(runner, op, buildRequest(op, ids)), 403, 'forbidden')
            // The scheduler passes the role check; epoch 0 is stale (or the body is refused), never 401 or 403.
            const answer = await send(scheduler, op, buildRequest(op, ids))
            expect.soft(isOk(answer.status), `scheduler: ${describeAnswer(op, answer)}`).toBe(true)
          }
          for (const op of operations.filter((o) => !schedulerRoutes.includes(o.operationId) && o.operationId !== 'runtimeReportError')) {
            const answer = await send(runner, op, buildRequest(op, ids))
            expect.soft(isOk(answer.status), `runner: ${describeAnswer(op, answer)}`).toBe(true)
          }
          // Once the scan is cancelled its workers stop, and their tokens with them.
          ok(await a.cancelScan(scanId), 'cancelScan')
          await expect
            .poll(async () => (await send(runner, bootstrap, buildRequest(bootstrap, ids))).status, {
              timeout: 120_000,
              message: 'the runner token after the cancel',
            })
            .toBe(401)
        } finally {
          await runner.dispose()
          await scheduler.dispose()
        }
      } finally {
        // A's purge at the teardown removes the cancelled scan.
        if (scanId) await cancelAndDeleteScan(a, scanId)
        await a.request.dispose()
      }
    },
  )

  test('forwardAuth succeeds only with an admin’s tools cookie', { tag: ['@AUTHZ-014'] }, async ({ env, seed, adminApi }) => {
    const rawdata = `https://traefik.${env.domain}/api/rawdata`
    const sessionCookie = (state: string) =>
      (JSON.parse(readFileSync(state, 'utf8')) as { cookies: { name: string; value: string }[] }).cookies.map((c) => `${c.name}=${c.value}`).join('; ')
    // Tools cookies minted with the stack's key (helpers/keys.ts) for B, whom no case ever promotes (A is an admin for a
    // moment in the editor-key case, and the user cache keeps a role for up to 30 s), and for the admin: forwardAuth
    // checks the current role of the cookie's user, whatever the cookie claims.
    const now = Math.floor(Date.now() / 1000)
    const mint = (sub: string) => stackKeys().toolsCookie({ iss: 'scantor', aud: 'tools', sub, role: 'admin', iat: now, exp: now + 600, jti: randomUUID() })
    const forged = mint(seed.b.id)
    const session = await adminApi.call('createToolsSession', { query: { target: 'traefik' } })
    expect(session.status).toBe(302)
    const adminCookie = /scantor_tools=([^;\n]+)/.exec(session.headers['set-cookie'] ?? '')?.[1]
    expect(adminCookie).toBeTruthy()

    const rejected: [string, Record<string, string>][] = [
      ['anonymous', {}],
      ['A’s session cookie', { Cookie: sessionCookie(seed.a.storageState) }],
      ['the admin’s session cookie', { Cookie: sessionCookie(seed.admin.storageState) }],
      ['A’s API key', { Authorization: `Bearer ${seed.a.key}` }],
      ['the admin’s API key', { Authorization: `Bearer ${seed.admin.key}` }],
      ['a tools cookie of a non-admin', { Cookie: `scantor_tools=${forged}` }],
    ]
    const context = await newApiContext()
    try {
      for (const [label, headers] of rejected) {
        const response = await context.get(rawdata, { headers, maxRedirects: 0 })
        expect.soft(response.status(), label).toBe(401)
        expect.soft(response.headers()['content-type'], label).toMatch(/^text\/plain/)
      }
      const allowed = await context.get(rawdata, { headers: { Cookie: `scantor_tools=${adminCookie}` }, maxRedirects: 0 })
      expect(allowed.status()).toBe(200)
      // The control for the non-admin's cookie: the same minting for the admin is accepted, so its 401 is the role check.
      const minted = await context.get(rawdata, { headers: { Cookie: `scantor_tools=${mint(seed.admin.id)}` }, maxRedirects: 0 })
      expect(minted.status(), 'a minted tools cookie of the admin').toBe(200)
      // Called directly on the dashboard host, the forwarded host is not a tool host: even the admin's cookie gets 401.
      const direct = await context.get('/api/tools/forward-auth', {
        headers: { Cookie: `scantor_tools=${adminCookie}`, 'X-Forwarded-Host': `traefik.${env.domain}` },
        maxRedirects: 0,
      })
      expect(direct.status()).toBe(401)
      expect(direct.headers()['content-type']).toMatch(/^text\/plain/)
    } finally {
      await context.dispose()
    }
  })

  // ── injection, setup ──────────────────────────────────────────────────────────────────────────────

  test('a malformed path id answers 404 on every operation', { tag: ['@API-007'] }, async ({ openapi, seed, principals }) => {
    const ids = idsOfA(seed)
    const malformed = ['not-a-uuid', '../', '{"$ne": null}', '..%2f', `${seed.a.taskId}x`]
    const analysis = [`${seed.a.scanId}-x`, `x-1`, `${seed.a.scanId}-12345678901234567`, `${seed.a.scanId}--1`]
    for (const scope of ['owner', 'admin'] as const) {
      const context = await principals.get(scope === 'owner' ? 'aSession' : 'adminSession')
      for (const op of operationsOf(openapi, scope)) {
        for (const param of op.parameters.filter((p) => p.in === 'path')) {
          // `{task}` also takes names: a slug that names no task is just as unknown.
          const values = param.name === 'analysisId' ? [...malformed, ...analysis] : malformed
          for (const value of values) {
            const spec = buildRequest(op, ids)
            const answer = await send(context, op, { ...spec, path: { ...spec.path, [param.name]: value } })
            await expectStatus(`${param.name}=${JSON.stringify(value)}`, op, answer, 404, NOT_FOUND)
          }
        }
      }
    }
  })

  test('every setup request but the status answers 409 setupCompleted once a user exists', { tag: ['@SETUP-004'] }, async ({ openapi, seed, principals }) => {
    const setupOps = operationsOf(openapi, 'setup')
    expect(setupOps.map((op) => op.operationId).sort()).toEqual(['createSetupAdmin', 'createSetupPasskeyToken'])
    const ids = idsOfA(seed)
    for (const name of ['anonymous', 'setupToken', 'aSession', 'aKey', 'adminSession', 'adminKey', 'nodeToken', 'workerToken', 'invalidBearer'] as const) {
      const context = await principals.get(name)
      for (const op of setupOps) await expectStatus(name, op, await send(context, op, buildRequest(op, ids)), 409, 'setupCompleted')
      for (const [method, path] of [
        ['POST', '/api/setup/status'],
        ['POST', '/api/setup/unknown'],
        ['GET', '/api/setup/admin'],
      ] as const) {
        const response = await context.fetch(path, {
          method,
          data: method === 'POST' ? {} : undefined,
          headers: { 'X-Scantor-Setup-Token': FAKE_SETUP_TOKEN },
          maxRedirects: 0,
        })
        expect.soft(response.status(), `${name}: ${method} ${path}`).toBe(409)
        expect.soft(((await response.json()) as { error: { code: string } }).error.code, `${name}: ${method} ${path}`).toBe('setupCompleted')
      }
    }
    const status = await (await principals.get('anonymous')).get('/api/setup/status')
    expect(status.status()).toBe(200)
    expect(((await status.json()) as { needsSetup: boolean }).needsSetup).toBe(false)
  })

  // ── the MCP half ──────────────────────────────────────────────────────────────────────────────────

  test.describe('MCP', () => {
    test(
      'B’s read/write OAuth session lists the read and write tools, and every call with A’s ids is a 404',
      { tag: ['@AUTHZ-015'] },
      async ({ openapi, seed }) => {
        const session = await newApiContext({ storageState: seed.b.storageState })
        const copies = await createThrowaways(seed, openapi)
        let connection: McpGrant | undefined
        try {
          // One dynamic registration (limiter) and the consent of "Read and write" with B's session.
          connection = await connectWithGrant(session, await registerMatrixClient(), DEFAULT_MCP_SCOPES)
          expect(connection.scope.split(' ').sort()).toEqual(DEFAULT_MCP_SCOPES.split(' ').sort())
          const { tools } = await connection.client.listTools()
          expect(tools.map((t) => t.name).sort()).toEqual(expectedTools(openapi, 'write'))
          expect(tools.map((t) => t.name)).not.toContain('list_nodes')
          const called: string[] = []
          for (const tool of tools) {
            const op = operationOf(openapi, tool.name)
            if (!referencesOwned(op)) continue
            called.push(tool.name)
            // Destructive tools act on A's copies, the others on A's seeded resources.
            const ids = isDestructive(op) ? copies.ids : idsOfA(seed)
            const result = (await connection.client.callTool(
              { name: tool.name, arguments: toolArguments(tool, buildRequest(op, ids)) },
              { timeout: 60_000 },
            )) as CallToolResult
            expect.soft(result.isError, `${tool.name}: ${resultText(result)}`).toBe(true)
            expect.soft(mcpError(result)?.httpStatus, `${tool.name}: ${resultText(result)}`).toBe(404)
          }
          expect(called, 'the tools that address A’s resources').toEqual(
            expect.arrayContaining(['get_task', 'get_scan', 'query_analyses', 'start_scan', 'cancel_scan']),
          )
          await expectThrowawaysIntact(seed, openapi, copies.ids)
        } finally {
          await connection?.close()
          await session.dispose()
          await copies.cleanup()
        }
      },
    )

    test('a read-only OAuth token sees no write tools, and a non-admin never gets list_nodes', { tag: ['@AUTHZ-015'] }, async ({ openapi, seed }) => {
      const session = await newApiContext({ storageState: seed.b.storageState })
      const connections: McpGrant[] = []
      try {
        const client = await registerMatrixClient()
        const readOnly = await connectWithGrant(session, client, 'offline_access scantor:read')
        connections.push(readOnly)
        expect(readOnly.scope.split(' ')).not.toContain('scantor:write')
        const readTools = (await readOnly.client.listTools()).tools.map((t) => t.name).sort()
        expect(readTools).toEqual(expectedTools(openapi, 'read'))
        expect(readTools).not.toContain('start_scan')
        // A write tool is not callable with a read-only grant either, not even on B's own task: nothing is written.
        const file = 'authz-read-only.txt'
        const write = await readOnly.client
          .callTool({ name: 'write_task_files', arguments: { task: seed.b.taskId, files: { [file]: 'written with a read-only grant\n' } } })
          .then(
            (result) => result as CallToolResult,
            (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
          )
        if (write instanceof Error) expect(write.message).toMatch(/write_task_files/)
        else expect(write.isError, resultText(write)).toBe(true)
        const b = await clientFor(openapi, { storageState: seed.b.storageState })
        try {
          expect((await b.call('readTaskFile', { path: { task: seed.b.taskId }, query: { path: file } })).status, 'the file was not written').toBe(404)
        } finally {
          await b.request.dispose()
        }

        // scantor:admin requested and consented to by a non-admin: stripped, so no admin tool.
        const askedAdmin = await connectWithGrant(session, client, `${DEFAULT_MCP_SCOPES} scantor:admin`)
        connections.push(askedAdmin)
        expect(askedAdmin.scope.split(' '), 'scantor:admin is stripped for a non-admin').not.toContain('scantor:admin')
        const names = (await askedAdmin.client.listTools()).tools.map((t) => t.name)
        expect(names).not.toContain('list_nodes')
        expect(names.sort()).toEqual(expectedTools(openapi, 'write'))
      } finally {
        for (const connection of connections) await connection.close()
        await session.dispose()
      }
    })
  })
})

// ── MCP helpers ───────────────────────────────────────────────────────────────────────────────────────

/** docs/mcp.md §4.1: tool names are snake_case(operationId). */
function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

/** The MCP tools of a level (docs/mcp.md §3.2): read = GET and x-read-only; write adds the rest; admin adds admin-only. */
function expectedTools(openapi: OpenApiIndex, level: 'read' | 'write' | 'admin'): string[] {
  return [...openapi.operations.values()]
    .filter((op) => op.extensions['x-mcp'] === true)
    .filter((op) => {
      if (op.extensions['x-admin-only'] === true) return level === 'admin'
      return isRead(op) || level !== 'read'
    })
    .map((op) => snakeCase(op.operationId))
    .sort()
}

function operationOf(openapi: OpenApiIndex, tool: string): OpenApiOperation {
  const op = [...openapi.operations.values()].find((o) => snakeCase(o.operationId) === tool)
  if (!op) throw new Error(`no operation for the MCP tool ${tool}`)
  return op
}

/** Tool arguments from a REST request: path and query parameters, and the body as `body` or merged, as the schema says. */
function toolArguments(tool: Tool, spec: ReturnType<typeof buildRequest>): Record<string, unknown> {
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>
  const args: Record<string, unknown> = { ...spec.path, ...spec.query }
  if (spec.body !== undefined && !Buffer.isBuffer(spec.body)) {
    if ('body' in properties) args.body = spec.body
    else Object.assign(args, spec.body as Record<string, unknown>)
  }
  for (const key of Object.keys(args)) if (!(key in properties)) delete args[key]
  return args
}

function mcpError(result: CallToolResult): { httpStatus: number; code: string } | undefined {
  try {
    return (JSON.parse(resultText(result)) as { error?: { httpStatus: number; code: string } }).error
  } catch {
    return undefined
  }
}
