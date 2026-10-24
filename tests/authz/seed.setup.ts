import { readFileSync } from 'node:fs'
import type { CreatedApiKey } from '#shared/types/account'
import type { Analysis } from '#shared/types/analyses'
import type { Page } from '#shared/types/common'
import type { Credential } from '#shared/types/credentials'
import type { Export } from '#shared/types/exports'
import type { TestRun } from '#shared/types/test-runs'
import type { Upload } from '#shared/types/uploads'
import type { Worker } from '#shared/types/workers'
import { ApiClient, ok } from '../helpers/api-client'
import {
  fingerprint,
  representationsOfA,
  runFile,
  saveSeed,
  type Seed,
  type SeededUser,
  type SeededWorker,
  type TenantA,
  type TenantB,
} from '../helpers/authz-seed'
import { PRIVATE_GIT_CREDENTIAL } from '../helpers/fixtures-server'
import { stackKeys } from '../helpers/keys'
import { startScan, waitForScanState } from '../helpers/scans'
import { exampleTaskDir, uploadAndPublish } from '../helpers/tasks'
import { createUser, deleteUser, signedInContext } from '../helpers/users'
import { expect, test as setup } from '../fixtures'

// The `authz-setup` project (docs/testing.md §8.5, docs/security.md §7): seeds tenants A and B through the API (one
// sign-in each through the limiter; the admin reuses the global setup session), creates every resource kind of A that
// an operation can address, uses remote-1 as node N1 read-only, derives the tokens of A's (stopped) workers, and writes
// all ids and credentials to this run's seed file (helpers/authz-seed.ts seedFile) together with the fingerprint of A's
// GET representations. The `authz-teardown` project deletes A and B and the admin's matrix key.

/**
 * Creates a user, signs in (one limiter slot), saves the storage state and creates a `default` API key. The user's id
 * goes to `created` first, so a failing seed can remove what it made.
 */
async function seedUser(
  adminApi: ApiClient,
  prefix: string,
  stateFile: string,
  openapi: ApiClient['openapi'],
  created: string[],
): Promise<{ user: SeededUser; api: ApiClient }> {
  const user = await createUser(adminApi, { prefix })
  created.push(user.id)
  const session = await signedInContext(user.email, user.password)
  await session.storageState({ path: stateFile })
  const api = new ApiClient(session, openapi)
  const key = ok(await api.createApiKey(`${prefix}-default`, 1), 'createApiKey')
  return {
    user: { id: user.id, email: user.email, name: user.name, password: user.password, storageState: stateFile, key: key.key, keyId: key.apiKey.id },
    api,
  }
}

/** Polls a test run until it ended (long-polling getTestRun). */
async function waitForTestRun(api: ApiClient, testRunId: string, timeoutMs = 120_000): Promise<TestRun> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const wait = Math.max(1, Math.min(60, Math.ceil((deadline - Date.now()) / 1000)))
    const run = ok(await api.call<TestRun>('getTestRun', { path: { testRunId }, query: { wait, analyses: true } }), 'getTestRun')
    if (['completed', 'failed', 'cancelled'].includes(run.state)) return run
    if (Date.now() > deadline) throw new Error(`test run ${testRunId} is still ${run.state} after ${timeoutMs / 1000} s`)
  }
}

// The seed signs in A and B itself; the worker's own tenant is not needed.
setup.use({ storageState: { cookies: [], origins: [] } })

setup('seed tenants A and B for the authorization matrix', async ({ adminApi, openapi, env }, testInfo) => {
  // The seed builds three images (cached after the first run) and runs a scan and a test run.
  setup.setTimeout(180_000)
  const version = ok(await adminApi.getHealth(), 'getHealth').version
  const adminAccount = ok(await adminApi.getAccount(), 'getAccount')
  const adminKey = ok(await adminApi.call<CreatedApiKey>('createApiKey', { body: { name: 'authz-matrix-admin', expiresInDays: 1 } }), 'createApiKey')

  // Everything the seed creates belongs to A and B or is the admin's key: on a failure they are removed again here,
  // because the teardown only knows what a complete seed wrote.
  const created: string[] = []
  const clients: ApiClient[] = []
  let seeded = false
  try {
    const [seededA, seededB] = await Promise.all([
      seedUser(adminApi, 'authz-a', runFile(testInfo, 'a'), openapi, created),
      seedUser(adminApi, 'authz-b', runFile(testInfo, 'b'), openapi, created),
    ])
    clients.push(seededA.api, seededB.api)
    const aApi = seededA.api
    const bApi = seededB.api

    // Both tenants own a task named `alpha`: the `files` example (template `list`, results with FileRefs). A also owns
    // the `sleep` example for the worker-scope case of the matrix (a scan whose workers stay active), built here in
    // parallel so the matrix never waits for a build. The list upload and the git credential need no build.
    const [alphaA, alphaB, sleepA, upload, credential] = await Promise.all([
      uploadAndPublish(aApi, exampleTaskDir('files'), 'alpha'),
      uploadAndPublish(bApi, exampleTaskDir('files'), 'alpha'),
      uploadAndPublish(aApi, exampleTaskDir('sleep'), 'authz-sleep'),
      aApi
        .call<Upload>('createUpload', {
          body: Buffer.from('a.example\nb.example\n'),
          headers: { 'Content-Type': 'text/plain' },
          query: { name: 'authz-a-list.txt', kind: 'list' },
        })
        .then((r) => ok(r, 'createUpload')),
      aApi
        .call<Credential>('createCredential', {
          body: {
            kind: 'gitToken',
            name: 'authz-a-git',
            host: `git.${env.domain}`,
            username: PRIVATE_GIT_CREDENTIAL.username,
            token: PRIVATE_GIT_CREDENTIAL.token,
          },
        })
        .then((r) => ok(r, 'createCredential')),
    ])

    // A: a completed test run and a completed scan, one analysis with files each, in parallel.
    const [testRun, scan] = await Promise.all([
      (async () => {
        const started = ok(
          await aApi.call<TestRun>('testTask', {
            path: { task: alphaA.task.id },
            body: { scanConfig: { items: ['authz-test-run'] }, limit: 1 },
            query: { wait: 120 },
          }),
          'testTask',
        )
        return waitForTestRun(aApi, started.id)
      })(),
      (async () => {
        const started = await startScan(aApi, { revision: alphaA.revision.id, name: 'authz-a-scan', scanConfig: { items: ['authz-scan'] } })
        return waitForScanState(aApi, started.id, 'completed', 120_000)
      })(),
    ])
    expect(testRun.state, JSON.stringify(testRun.errors)).toBe('completed')
    const testRunFileId = testRun.analyses?.[0]?.files[0]?.id
    expect(testRunFileId, 'the test run analysis stored a file').toBeTruthy()

    // A: a ready export (its job is A's job).
    const exported = ok(await aApi.call<Export>('exportScan', { path: { scanId: scan.id }, body: { format: 'jsonl' }, query: { wait: 120 } }), 'exportScan')
    expect(exported.state).toBe('ready')
    // The workers drain and stop after the completion; the scan's representation (workers summary) and the workers'
    // tokens (a stopped worker's token is refused) are final only then.
    await expect
      .poll(async () => ok(await aApi.getScan(scan.id), 'getScan').workers, {
        timeout: 120_000,
        intervals: [1_000],
        message: 'the workers of A’s scan stopped',
      })
      .toEqual(expect.objectContaining({ active: 0, desired: 0, pending: 0 }))
    const analyses = ok(await aApi.call<Page<Analysis>>('listAnalyses', { path: { scanId: scan.id } }), 'listAnalyses')
    expect(analyses.items).toHaveLength(1)
    const analysis = analyses.items[0]!
    expect(analysis.files.length, 'the analysis stored files').toBeGreaterThan(0)

    // The workers of A's scan (stopped now), with the tokens the orchestrator derived for them.
    const workers = ok(await adminApi.listScanWorkers(scan.id), 'listScanWorkers').items as Worker[]
    expect(workers.length).toBeGreaterThan(0)
    const keys = stackKeys()
    const seededWorkers: SeededWorker[] = workers.map((w) => {
      if (!w.nodeId) throw new Error(`worker ${w.id} of the completed scan has no node`)
      return {
        id: w.id,
        scanId: w.scanId,
        role: w.role,
        nodeId: w.nodeId,
        token: keys.workerToken({ workerId: w.id, scanId: w.scanId, role: w.role, nodeId: w.nodeId }),
      }
    })

    const remote = JSON.parse(readFileSync(env.paths.remoteNode, 'utf8')) as { id: string; name: string; pool: string; token: string }

    const a: TenantA = {
      ...seededA.user,
      taskId: alphaA.task.id,
      taskName: alphaA.task.name,
      revisionId: alphaA.revision.id,
      revisionNumber: alphaA.revision.number,
      testRunId: testRun.id,
      testRunFileId: testRunFileId!,
      scanId: scan.id,
      analysisId: analysis.id,
      fileId: analysis.files[0]!.id,
      exportId: exported.id,
      uploadId: upload.id,
      credentialId: credential.id,
      jobId: exported.jobId,
      workers: seededWorkers,
      sleepTaskId: sleepA.task.id,
      sleepRevisionId: sleepA.revision.id,
    }
    const b: TenantB = {
      ...seededB.user,
      taskId: alphaB.task.id,
      taskName: alphaB.task.name,
      revisionId: alphaB.revision.id,
      revisionNumber: alphaB.revision.number,
    }
    expect(a.taskName).toBe('alpha')
    expect(b.taskName).toBe('alpha')

    // The fingerprint must be stable on its own before B's attempts can be judged by it.
    const representations = await representationsOfA(aApi, a)
    const again = await representationsOfA(aApi, a)
    expect(again, 'A’s representations are stable between two reads').toEqual(representations)

    const seed: Seed = {
      version,
      admin: { id: adminAccount.id, email: adminAccount.email, storageState: env.paths.adminState, key: adminKey.key, keyId: adminKey.apiKey.id },
      a,
      b,
      n1: { id: remote.id, name: remote.name, pool: remote.pool, token: remote.token },
      fingerprint: fingerprint(representations),
      representations,
    }
    await saveSeed(testInfo, seed)
    seeded = true
  } finally {
    for (const client of clients) await client.request.dispose()
    if (!seeded) {
      for (const id of created) await deleteUser(adminApi, id)
      await adminApi.call('deleteApiKey', { path: { keyId: adminKey.apiKey.id } })
    }
  }
})
