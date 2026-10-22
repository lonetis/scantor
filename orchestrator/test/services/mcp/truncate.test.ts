import { describe, expect, it } from 'vitest'
import { capJson, capText, cutUtf8, MCP_RESPONSE_CAP_BYTES } from '../../../server/services/mcp/truncate'

// The 256 KiB response cap (docs/mcp.md §4.5).

const bytes = (text: string) => Buffer.byteLength(text, 'utf8')

describe('capJson', () => {
  it('returns small values unchanged and pretty-printed', () => {
    expect(capJson({ a: 1 })).toEqual({ text: '{\n  "a": 1\n}' })
  })

  it('keeps the longest fitting prefix of items with _truncated and a seq cursor', () => {
    const items = Array.from({ length: 2000 }, (_, seq) => ({ seq, payload: 'x'.repeat(200) }))
    const result = capJson({ items, nextCursor: '1999' })
    expect(bytes(result.text)).toBeLessThanOrEqual(MCP_RESPONSE_CAP_BYTES)
    const parsed = JSON.parse(result.text) as { items: { seq: number }[]; _truncated: { field: string; returned: number; total: number }; nextCursor: string }
    const returned = parsed.items.length
    expect(returned).toBeGreaterThan(100)
    expect(returned).toBeLessThan(2000)
    expect(parsed._truncated).toEqual({ field: 'items', returned, total: 2000 })
    expect(parsed.nextCursor).toBe(String(returned - 1))
    expect(result.note).toMatch(/^\[scantor\] Response truncated to 256 KiB \(items: returned \d+ of 2000\)/)
    const oneMore = capJson({ items: items.slice(0, returned + 1), nextCursor: null }, MCP_RESPONSE_CAP_BYTES)
    expect(JSON.parse(oneMore.text).items.length).toBe(returned)
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
