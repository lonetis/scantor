import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { request as playwrightRequest } from '@playwright/test'
import type { Export } from '#shared/types/exports'
import { ok, type ApiClient, type ApiResponse } from '../helpers/api-client'
import { errorCode, errorDetails } from '../helpers/security'
import { withSecurityTenants, type SharedTasks } from '../helpers/security-tenants'
import { expect, test as base, unique } from '../fixtures'

// The tenant fixtures of the security specs (helpers/security-tenants.ts).
const test = withSecurityTenants(base)

// Query API injection (docs/security.md §6.5 Q-1…Q-8): every case of tests/corpora/query-injection through the real
// server, the scope that user filters can only narrow, and the read-only MongoDB user behind the query client.

interface QueryCase {
  id: string
  description: string
  operation: 'queryAnalyses' | 'aggregateAnalyses' | 'exportScan'
  body?: Record<string, unknown>
  /** a raw JSON body (keys such as __proto__ that a JavaScript object literal cannot carry) */
  bodyJson?: string
  expect: { rejected: boolean; path?: string; pathPrefix?: string; scoped?: boolean }
}

const corpus = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'corpora', 'query-injection', 'cases.json'), 'utf8')) as { cases: QueryCase[] }
const rejected = corpus.cases.filter((c) => c.expect.rejected)
const accepted = corpus.cases.filter((c) => !c.expect.rejected)

function send(api: ApiClient, scanId: string, testCase: QueryCase): Promise<ApiResponse> {
  const body = testCase.bodyJson !== undefined ? Buffer.from(testCase.bodyJson) : testCase.body
  const headers: Record<string, string> = testCase.bodyJson !== undefined ? { 'Content-Type': 'application/json' } : {}
  const query = testCase.operation === 'exportScan' ? { wait: 60 } : {}
  return api.call(testCase.operation, { path: { scanId }, body, headers, query })
}

/** The rows a case returns: query/aggregate items, or the lines of a finished export. */
async function rowsOf(testCase: QueryCase, response: ApiResponse): Promise<unknown[]> {
  if (testCase.operation !== 'exportScan') return (response.body as { items: unknown[] }).items
  const exported = response.body as Export
  expect(exported.state, JSON.stringify(exported)).toBe('ready')
  const context = await playwrightRequest.newContext({ extraHTTPHeaders: {} })
  try {
    const download = await context.get(exported.download!.url)
    expect(download.status()).toBe(200)
    const text = await download.text()
    if (exported.format === 'csv') return text.split('\n').filter(Boolean).slice(1)
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown)
  } finally {
    await context.dispose()
  }
}

async function exportCount(api: ApiClient, scanId: string): Promise<number> {
  return ok(await api.call<{ items: Export[] }>('listExports', { query: { scanId, limit: 200 } }), 'listExports').items.length
}

/** A completed one-analysis scan of the shared probe task, one per key; the tests of a worker only read it. */
const probeScan = (shared: SharedTasks, key = 'query') =>
  shared.completedScan(key, async () => ({ revision: (await shared.probe()).revision.ref, taskConfig: { label: `scope ${key}` } }))

test.describe('query injection', () => {
  test('every rejected case of the corpus answers 400 queryRejected with its path', { tag: ['@SEC-011'] }, async ({ api, shared }) => {
    const scan = await probeScan(shared)
    const exportsBefore = await exportCount(api, scan.id)
    for (const testCase of rejected) {
      const response = await send(api, scan.id, testCase)
      expect.soft(response.status, `${testCase.id}: ${JSON.stringify(response.body)}`).toBe(400)
      expect.soft(errorCode(response), testCase.id).toBe('queryRejected')
      const path = errorDetails(response).path
      if (testCase.expect.path !== undefined) expect.soft(path, testCase.id).toBe(testCase.expect.path)
      else expect.soft(String(path), `${testCase.id}: details.path`).toMatch(new RegExp(`^${escapeRegExp(testCase.expect.pathPrefix!)}`))
    }
    // A rejected export never creates an export.
    expect(await exportCount(api, scan.id)).toBe(exportsBefore)
  })

  test('the accepted cases of the corpus succeed on the caller’s scan', { tag: ['@SEC-011'] }, async ({ api, shared }) => {
    const scan = await probeScan(shared)
    for (const testCase of accepted) {
      const response = await send(api, scan.id, testCase)
      expect.soft([200, 201], `${testCase.id}: ${response.status} ${JSON.stringify(response.body)}`).toContain(response.status)
    }
  })

  test(
    'scope-override attempts by B on B’s scan return only that scan’s analyses, never A’s',
    { tag: ['@SEC-012'] },
    async ({ api, otherUser, user, shared, docker }) => {
      // B: two completed scans of its own; the addressed one must not even leak the other.
      const [target, sibling] = await Promise.all([probeScan(shared), probeScan(shared, 'query-sibling')])
      // A: analyses of another user's scan in the same collection (white-box copies of B's analysis under A's ids, so
      // no extra build is needed; removed at the end).
      const victim = randomUUID()
      const copied = await docker.mongosh(
        `const doc = db.analyses.findOne({ scanId: '${target.id}' }); doc._id = '${victim}-0'; doc.scanId = '${victim}'; doc.userId = '${otherUser.id}'; print(db.analyses.insertOne(doc).acknowledged)`,
        { as: 'root' },
      )
      expect(copied).toBe('true')
      try {
        for (const testCase of corpus.cases.filter((c) => c.expect.scoped)) {
          const response = await send(api, target.id, testCase)
          expect([200, 201], `${testCase.id}: ${response.status} ${JSON.stringify(response.body)}`).toContain(response.status)
          const rows = await rowsOf(testCase, response)
          const text = JSON.stringify(rows)
          expect(rows.length, `${testCase.id} returns the addressed scan's analysis`).toBeGreaterThan(0)
          expect(text, testCase.id).toContain(target.id)
          expect(text, `${testCase.id} leaks the other tenant's scan`).not.toContain(victim)
          expect(text, `${testCase.id} leaks the other tenant's id`).not.toContain(otherUser.id)
          expect(text, `${testCase.id} leaks B's other scan`).not.toContain(sibling.id)
        }
        // The documents themselves carry the scope: the addressed scan and its owner.
        const all = ok(
          await api.call<{ items: { scanId: string; userId: string }[] }>('queryAnalyses', {
            path: { scanId: target.id },
            body: { filter: { $or: [{ scanId: { $exists: true } }, { userId: { $ne: '' } }] }, limit: 1000 },
          }),
          'queryAnalyses',
        )
        expect(all.items.length).toBe(1)
        for (const item of all.items) expect(item).toMatchObject({ scanId: target.id, userId: user.id })

        // A's scan id itself stays out of B's reach.
        const foreign = await api.call('queryAnalyses', { path: { scanId: victim }, body: { filter: {} } })
        expect(foreign.status).toBe(404)
        expect(errorCode(foreign)).toBe('notFound')
      } finally {
        await docker.mongosh(`db.analyses.deleteOne({ _id: '${victim}-0', scanId: '${victim}' })`, { as: 'root' })
      }
    },
  )

  test('the read-only query user cannot run scripts or write', { tag: ['@SEC-013'] }, async ({ docker }) => {
    // Connected directly as scantor_query with the password derived from the stack's secret (helpers/keys.ts).
    const identity = await docker.mongosh(
      'const s = db.runCommand({ connectionStatus: 1 }).authInfo; print(JSON.stringify({ users: s.authenticatedUsers.map((u) => u.user), roles: s.authenticatedUserRoles.map((r) => `${r.role}@${r.db}`) }))',
    )
    expect(JSON.parse(identity)).toEqual({ users: ['scantor_query'], roles: ['read@scantor'] })

    const attempt = async (script: string) => {
      const out = await docker.mongosh(
        `try { ${script}; print(JSON.stringify({ ok: true })) } catch (e) { print(JSON.stringify({ ok: false, code: e.code, message: e.message })) }`,
      )
      return JSON.parse(out) as { ok: boolean; code?: number; message?: string }
    }
    const where = await attempt("db.analyses.find({ $where: 'true' }).limit(1).toArray()")
    expect(where).toMatchObject({ ok: false, message: expect.stringMatching(/globalScriptEngine|javascript/i) })
    const fn = await attempt(
      "db.analyses.aggregate([{ $match: { $expr: { $function: { body: 'function () { return true }', args: [], lang: 'js' } } } }]).toArray()",
    )
    expect(fn).toMatchObject({ ok: false, message: expect.stringMatching(/javascript engine/i) })
    const insert = await attempt(`db.analyses.insertOne({ _id: '${unique('probe')}' })`)
    expect(insert).toMatchObject({ ok: false, code: 13 })
    const drop = await attempt('db.getSiblingDB("admin").runCommand({ createUser: "intruder", pwd: "intruder-password", roles: ["root"] })')
    expect(drop).toMatchObject({ ok: false, code: 13 })
  })
})

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
