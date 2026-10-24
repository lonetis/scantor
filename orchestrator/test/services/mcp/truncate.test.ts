import { describe, expect, it } from 'vitest'
import { capJson, capText, cutUtf8, isSeqPaginated, MCP_RESPONSE_CAP_BYTES, seqCursorOf } from '../../../server/services/mcp/truncate'
import { wrapUntrusted } from '../../../server/services/mcp/untrusted'

// The 256 KiB response cap (docs/mcp.md §4.5).

const bytes = (text: string) => Buffer.byteLength(text, 'utf8')

describe('capJson', () => {
  it('returns small values unchanged and pretty-printed', () => {
    expect(capJson({ a: 1 })).toEqual({ text: '{\n  "a": 1\n}' })
  })

  it('keeps the longest fitting prefix of items with _truncated and a seq cursor', () => {
    const items = Array.from({ length: 2000 }, (_, seq) => ({ seq, payload: 'x'.repeat(200) }))
    const result = capJson({ items, nextCursor: '1999' }, { seqCursor: true })
    expect(bytes(result.text)).toBeLessThanOrEqual(MCP_RESPONSE_CAP_BYTES)
    const parsed = JSON.parse(result.text) as { items: { seq: number }[]; _truncated: { field: string; returned: number; total: number }; nextCursor: string }
    const returned = parsed.items.length
    expect(returned).toBeGreaterThan(100)
    expect(returned).toBeLessThan(2000)
    expect(parsed._truncated).toEqual({ field: 'items', returned, total: 2000 })
    expect(parsed.nextCursor).toBe(String(returned - 1))
    expect(result.note).toMatch(/^\[scantor\] Response truncated to 256 KiB \(items: returned \d+ of 2000\)/)
    const oneMore = capJson({ items: items.slice(0, returned + 1), nextCursor: null }, { cap: MCP_RESPONSE_CAP_BYTES, seqCursor: true })
    expect(JSON.parse(oneMore.text).items.length).toBe(returned)
  })

  it('takes the cursor from the last kept item although the rendered items are wrapped as untrusted data', () => {
    // Regression: the bridge wrapped query_analyses items before the cap, so the cap found no seq on the last kept
    // item and kept the REST nextCursor (null when the REST page held every item).
    const items = Array.from({ length: 30 }, (_, index) => ({ id: `scan-${index + 1}`, seq: index + 1, result: { text: 'x'.repeat(20_000) } }))
    const present = (value: unknown) => wrapUntrusted('queryAnalyses', value)
    const result = capJson({ items, nextCursor: null }, { present, seqCursor: true })
    expect(bytes(result.text)).toBeLessThanOrEqual(MCP_RESPONSE_CAP_BYTES)
    const parsed = JSON.parse(result.text) as { items: { untrusted_data: { seq: number } }[]; nextCursor: string; _truncated: { returned: number } }
    const returned = parsed.items.length
    expect(returned).toBeGreaterThan(0)
    expect(returned).toBeLessThan(30)
    expect(parsed._truncated.returned).toBe(returned)
    expect(parsed.items.at(-1)?.untrusted_data.seq).toBe(returned)
    expect(parsed.nextCursor).toBe(String(returned))
    // The wrapping counts against the cap: one more wrapped item would not fit.
    const longer = { ...parsed, items: [...parsed.items, { untrusted_data: items[returned] }] }
    expect(bytes(JSON.stringify(longer, null, 2))).toBeGreaterThan(MCP_RESPONSE_CAP_BYTES)
  })

  it('leaves nextCursor alone for lists that are not paginated by seq', () => {
    const items = Array.from({ length: 2000 }, (_, seq) => ({ seq, payload: 'x'.repeat(200) }))
    expect(JSON.parse(capJson({ items, nextCursor: null }).text).nextCursor).toBeNull()
    expect(JSON.parse(capJson({ items, nextCursor: 'opaque' }).text).nextCursor).toBe('opaque')
  })

  it('does not invent a cursor for lists that are not paginated by seq', () => {
    const entries = Array.from({ length: 3000 }, (_, index) => ({ path: `file-${index}`, data: 'y'.repeat(100) }))
    const parsed = JSON.parse(capJson({ entries, truncated: false }).text)
    expect(parsed.nextCursor).toBeUndefined()
    expect(parsed._truncated.field).toBe('entries')
  })

  it('shortens long strings when no array helps', () => {
    const result = capJson({ result: { body: 'z'.repeat(300 * 1024) }, logTail: 'ok' })
    const parsed = JSON.parse(result.text) as { result: { body: string }; logTail: string }
    expect(parsed.result.body).toMatch(/^z{4096}…\[truncated \d+ bytes\]$/)
    expect(parsed.logTail).toBe('ok')
    expect(result.note).toContain('strings longer than 4096 bytes shortened')
  })

  it('cuts the text as a last resort and says it is not valid JSON', () => {
    const many = Object.fromEntries(Array.from({ length: 100_000 }, (_, index) => [`k${index}`, index]))
    const result = capJson(many)
    expect(bytes(result.text)).toBeLessThanOrEqual(MCP_RESPONSE_CAP_BYTES)
    expect(result.note).toContain('hard cut; the text is not valid JSON')
  })
})

describe('seq cursors', () => {
  it('reads the seq, else the seq suffix of the analysis id', () => {
    expect(seqCursorOf({ seq: 17, id: 'x-3' })).toBe('17')
    expect(seqCursorOf({ id: '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f-42', error: { type: 'timeout' } })).toBe('42')
    expect(seqCursorOf({ id: '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f' })).toBeNull()
    expect(seqCursorOf({ status: 'failed' })).toBeNull()
    expect(seqCursorOf(null)).toBeNull()
  })

  it('applies to query_analyses without sort only', () => {
    expect(isSeqPaginated('queryAnalyses', { filter: {} })).toBe(true)
    expect(isSeqPaginated('queryAnalyses', { filter: {}, sort: { seq: -1 } })).toBe(false)
    expect(isSeqPaginated('listScans', {})).toBe(false)
  })
})

describe('capText and cutUtf8', () => {
  it('never splits a UTF-8 sequence', () => {
    expect(cutUtf8('ééé', 3)).toBe('é')
    expect(cutUtf8('abc', 10)).toBe('abc')
    const capped = capText('€'.repeat(100_000))
    expect(bytes(capped.text)).toBeLessThanOrEqual(MCP_RESPONSE_CAP_BYTES)
    expect(capped.text.endsWith('€')).toBe(true)
    expect(capped.note).toBeDefined()
  })
})
