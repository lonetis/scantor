import { ok } from '../helpers/api-client'
import { withMcpTenants, type SharedScans, type SharedTasks } from '../helpers/mcp-tenant'
import { callOk, callTool, largeResultTaskFiles, unwrap } from '../helpers/mcp-tools'
import { expect, test as base } from '../fixtures'

// The 256 KiB cap of MCP tool results (docs/mcp.md §4.5): the longest fitting prefix of a top-level list with
// `_truncated` and a seq cursor, then strings shortened to 4 KiB, each time with a second text block that says what
// was dropped. The REST API itself is never capped. The task returns results of a configurable size; each worker
// publishes it and runs its two scans once.

const test = withMcpTenants(base)

const CAP_BYTES = 256 * 1024
const NOTE_SUFFIX = 'Narrow it with limit, fields/projection, filter or afterSeq.'
/** 30 analyses of 20 000 characters each: about 600 KB, more than twice the cap. */
const ITEMS = Array.from({ length: 30 }, (_, index) => `item-${String(index).padStart(2, '0')}`)
const ITEM_BYTES = 20_000

const bytes = (text: string) => Buffer.byteLength(text, 'utf8')

interface QueryPage {
  items: unknown[]
  nextCursor: string | null
  _truncated?: { field: string; returned: number; total: number }
}

/** The worker's completed scan of the large-result task with one analysis of `sizeBytes` characters per item. */
async function largeResultScan(sharedTasks: SharedTasks, sharedScans: SharedScans, items: string[], sizeBytes: number): Promise<string> {
  const scan = await sharedScans.get(`limits:${items.length}x${sizeBytes}`, async () => ({
    revision: (await sharedTasks.generated('mcp-large-result', largeResultTaskFiles)).revision.ref,
    scanConfig: { items },
    taskConfig: { size_bytes: sizeBytes },
  }))
  return scan.id
}

const seqOf = (item: unknown, what: string) => unwrap<{ seq: number }>(item, what).seq

test.describe('MCP response cap', () => {
  // In order on one worker, so both tests inspect the same scans.
  test.describe.configure({ mode: 'default' })

  test(
    'a query over large results keeps the longest fitting prefix with a note, and long strings are shortened',
    { tag: ['@MCP-006'] },
    async ({ api, mcpKey, sharedTasks, sharedScans }) => {
      await test.step('query_analyses over 30 results of 20 000 characters', async () => {
        const scanId = await largeResultScan(sharedTasks, sharedScans, ITEMS, ITEM_BYTES)
        const call = await callTool<QueryPage>(mcpKey, 'query_analyses', { scanId, filter: {}, limit: 30 })
        expect(call.result.isError, call.texts.join('\n').slice(0, 500)).toBeFalsy()
        expect(call.texts).toHaveLength(2)
        expect(bytes(call.texts[0]!)).toBeLessThanOrEqual(CAP_BYTES)
        const page = call.json!
        const returned = page.items.length
        expect(returned).toBeGreaterThan(0)
        expect(returned).toBeLessThan(30)
        expect(page._truncated).toEqual({ field: 'items', returned, total: 30 })
        expect(call.texts[1]).toBe(`[scantor] Response truncated to 256 KiB (items: returned ${returned} of 30). ${NOTE_SUFFIX}`)

        // A prefix in seq order, and the longest one: one more item would not fit.
        const seqs = page.items.map((item, index) => seqOf(item, `items[${index}]`))
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
        const next = await callOk<QueryPage>(mcpKey, 'query_analyses', { scanId, filter: {}, limit: 1, afterSeq: seqs.at(-1)! })
        expect(bytes(JSON.stringify({ ...page, items: [...page.items, next.items[0]] }, null, 2))).toBeGreaterThan(CAP_BYTES)

        // afterSeq with the last returned seq continues exactly after the prefix.
        const rest = await callOk<QueryPage>(mcpKey, 'query_analyses', { scanId, filter: {}, projection: { seq: 1 }, limit: 30, afterSeq: seqs.at(-1)! })
        expect(rest._truncated).toBeUndefined()
        expect([...seqs, ...rest.items.map((item, index) => seqOf(item, `rest[${index}]`))]).toHaveLength(30)
        expect(seqOf(rest.items[0], 'rest[0]')).toBe(seqOf(next.items[0], 'next item'))

        // A projection that fits is not truncated and has a single text block.
        const narrow = await callTool<QueryPage>(mcpKey, 'query_analyses', { scanId, filter: {}, projection: { seq: 1, status: 1 }, limit: 30 })
        expect(narrow.texts).toHaveLength(1)
        expect(narrow.json?._truncated).toBeUndefined()
        expect(narrow.json?.items).toHaveLength(30)
      })

      await test.step('get_analysis of one result of 300 000 characters', async () => {
        const scanId = await largeResultScan(sharedTasks, sharedScans, ['big'], 300_000)
        const [item] = (await callOk<QueryPage>(mcpKey, 'query_analyses', { scanId, filter: {}, projection: { seq: 1 } })).items
        const analysisId = `${scanId}-${seqOf(item, 'big item')}`

        // REST returns the whole result.
        const full = ok(await api.call<{ result: { text: string } }>('getAnalysis', { path: { analysisId } }), 'getAnalysis')
        expect(full.result.text).toHaveLength(300_000)

        // MCP shortens the long string to 4 KiB with a marker, keeps valid JSON and appends the note.
        const call = await callTool<{ id: string; result: unknown }>(mcpKey, 'get_analysis', { analysisId })
        expect(call.result.isError).toBeFalsy()
        expect(call.texts).toHaveLength(2)
        expect(bytes(call.texts[0]!)).toBeLessThanOrEqual(CAP_BYTES)
        expect(call.json?.id).toBe(analysisId)
        const text = unwrap<{ item: string; text: string }>(call.json?.result, 'result').text
        expect(text).toBe(`${'x'.repeat(4096)}…[truncated ${300_000 - 4096} bytes]`)
        expect(call.texts[1]).toBe(`[scantor] Response truncated to 256 KiB (strings longer than 4096 bytes shortened). ${NOTE_SUFFIX}`)
      })
    },
  )

  // Product bug: the bridge wraps query_analyses items as {untrusted_data: …} before the cap runs, so the cap finds no
  // `seq` on the last kept item and leaves nextCursor as REST returned it (null when the REST page held every item).
  test.fail(
    'a truncated query sets nextCursor to the seq of the last returned analysis',
    { tag: ['@MCP-006'], annotation: { type: 'issue', description: 'MCP truncation leaves nextCursor unchanged because items are wrapped before the cap' } },
    async ({ mcpKey, sharedTasks, sharedScans }) => {
      const scanId = await largeResultScan(sharedTasks, sharedScans, ITEMS, ITEM_BYTES)
      const page = await callOk<QueryPage>(mcpKey, 'query_analyses', { scanId, filter: {}, limit: 30 })
      expect(page._truncated?.returned).toBeLessThan(30)
      expect(page.nextCursor).toBe(String(seqOf(page.items.at(-1), 'last item')))
    },
  )
})
