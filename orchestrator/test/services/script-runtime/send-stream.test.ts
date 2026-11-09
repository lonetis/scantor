import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, defineEventHandler, send, setResponseStatus, toNodeListener } from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ScanDoc } from '../../../server/types/documents'
import { parseConfig, setConfigForTesting } from '../../../server/utils/config'
import { normalizeError } from '../../../server/utils/errors'
import type { CachedUser } from '../../../server/utils/user-cache'
import { FakeCollection } from '../../helpers/fake-collection'
import { analysis, OWNER, RUN, SCAN, SCRIPT, scan, streamableAnalyses } from './helpers'

// The analysis stream on a real listener (docs/scripts.md): NDJSON with backpressure through sendStream, one of the
// run's read slots held until the response closes (also when the client goes away), 429 beyond four.

let gate: Promise<void> = Promise.resolve()
const analyses = streamableAnalyses({ beforeFind: () => gate })
const scriptRuns = new FakeCollection('scriptRuns')
const scans = new FakeCollection<ScanDoc>('scans')

vi.mock('../../../server/utils/mongo', () => ({ useCollections: () => ({ scriptRuns: scriptRuns.asCollection(), scans: scans.asCollection() }) }))
vi.mock('../../../server/services/query/execute', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/query/execute')>()),
  queryAnalysesCollection: async () => analyses.collection,
}))
vi.mock('../../../server/utils/user-cache', async (importOriginal) => {
  const owner: CachedUser = { id: OWNER, email: 'o@x', name: 'o', role: 'user', banned: false, banExpires: null, canRunPrivileged: false, maxWorkers: 0 }
  return { ...(await importOriginal<typeof import('../../../server/utils/user-cache')>()), getCachedUser: async () => owner }
})

const { planStream, sendAnalysisStream } = await import('../../../server/services/script-runtime/stream')
const { activeRunReads } = await import('../../../server/services/script-runtime/limiter')

const principal = { kind: 'scriptRun' as const, scriptRun: { id: RUN, userId: OWNER, scriptId: SCRIPT, scanIds: [SCAN], limit: null } }
let server: Server
let base: string

beforeAll(async () => {
  setConfigForTesting(parseConfig({ SCANTOR_S3_INTERNAL_URL: 'http://rustfs:9000' }).config)
  await scriptRuns.insertOne({ _id: RUN, userId: OWNER, state: 'running' })
  await scans.insertOne(scan({ state: 'running' }))
  for (const seq of [0, 1, 2]) {
    await analyses.fake.insertOne(
      analysis(seq, {
        files: [{ id: 'f1', name: 'a.txt', size: 1, sha256: 'a'.repeat(64), contentType: 'text/plain', key: `files/${SCAN}/${seq}/e/f1/a.txt` }],
      }),
    )
  }
  const app = createApp({
    onError: (error, event) => {
      const normalized = normalizeError(error)
      setResponseStatus(event, normalized.status)
      return send(event, JSON.stringify(normalized.body), 'application/json')
    },
  })
  app.use(
    '/stream',
    defineEventHandler(async (event) => {
      await sendAnalysisStream(event, principal, scan(), planStream(scan(), { fileUrls: true }, null), { queryMaxTimeMs: 1000, queryMaxDocs: 100 })
    }),
  )
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  setConfigForTesting(null)
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
})

afterEach(() => {
  gate = Promise.resolve()
})

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}

describe('sendAnalysisStream', () => {
  it('answers NDJSON with presigned internal URLs and releases the read slot at the end', async () => {
    const response = await fetch(`${base}/stream`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/x-ndjson')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const lines = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, { seq?: number; f1?: string }>)
    expect(lines.filter((line) => 'analysis' in line).map((line) => line.analysis!.seq)).toEqual([0, 1, 2])
    expect(lines[0]!.urls!.f1).toMatch(new RegExp(`^http://rustfs:9000/scantor/files/${SCAN}/0/e/f1/a\\.txt\\?X-Amz-Algorithm=AWS4-HMAC-SHA256&`))
    expect(lines.at(-1)).toEqual({ end: { afterSeq: 2, count: 3, limited: false } })
    await waitFor(() => activeRunReads(RUN) === 0)
  })

  it('refuses a fifth concurrent stream of the run with 429 and frees the slot of a client that went away', async () => {
    let open!: () => void
    gate = new Promise((resolve) => {
      open = resolve
    })
    const clients = [1, 2, 3, 4].map(() => new AbortController())
    const pending = clients.map((client) => fetch(`${base}/stream`, { signal: client.signal }).catch(() => null))
    await waitFor(() => activeRunReads(RUN) === 4)
    const refused = await fetch(`${base}/stream`)
    expect(refused.status).toBe(429)
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('tooManyRequests')
    for (const client of clients) client.abort()
    await Promise.all(pending)
    open()
    await waitFor(() => activeRunReads(RUN) === 0)
  })
})
