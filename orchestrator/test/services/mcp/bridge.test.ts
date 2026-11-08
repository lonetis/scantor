import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FILE_CONTENT_MAX_BYTES } from '#shared/schemas/analyses'
import { encodeFileContent } from '../../../server/services/files/content'
import { toToolResult } from '../../../server/services/mcp/bridge'
import { MCP_RESPONSE_CAP_BYTES } from '../../../server/services/mcp/truncate'

// Response mapping of tool calls (docs/mcp.md §4.4, §4.7, §4.8).

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })
}

function texts(result: { content: { type: string; text?: string }[] }): string[] {
  return result.content.map((block) => block.text ?? '')
}

describe('toToolResult', () => {
  it('returns JSON as one pretty-printed text block with untrusted values wrapped and the wait outcome', async () => {
    const result = await toToolResult(json({ id: 's', stateReason: { code: 'user' } }, { headers: { 'scantor-wait': 'timeout' } }), 'getScan')
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(texts(result)[0]!)).toEqual({ id: 's', stateReason: { untrusted_data: { code: 'user' } }, _wait: 'timeout' })
  })

  it('maps 204 to ok', async () => {
    const result = await toToolResult(new Response(null, { status: 204 }), 'deleteTaskFile')
    expect(JSON.parse(texts(result)[0]!)).toEqual({ ok: true, status: 204 })
  })

  it('passes text bodies such as guides through', async () => {
    const result = await toToolResult(new Response('# Guide', { headers: { 'content-type': 'text/markdown' } }), 'getAuthoringGuide')
    expect(texts(result)).toEqual(['# Guide'])
  })

  it('turns REST errors into structured tool errors', async () => {
    const response = json(
      { error: { code: 'invalidState', message: 'scan is completed; pause requires running', details: { state: 'completed', allowed: ['running'] } } },
      { status: 409, headers: { 'retry-after': '5' } },
    )
    const result = await toToolResult(response, 'pauseScan')
    expect(result.isError).toBe(true)
    expect(JSON.parse(texts(result)[0]!)).toEqual({
      error: {
        httpStatus: 409,
        code: 'invalidState',
        message: 'scan is completed; pause requires running',
        details: { state: 'completed', allowed: ['running'] },
        retryAfterSeconds: 5,
      },
    })
  })

  it('handles errors without the envelope', async () => {
    const result = await toToolResult(new Response('Bad Gateway', { status: 502 }), 'getScan')
    expect(JSON.parse(texts(result)[0]!)).toEqual({ error: { httpStatus: 502, code: 'internal', message: 'Bad Gateway' } })
  })

  it('reports redirects instead of following them', async () => {
    const result = await toToolResult(new Response(null, { status: 302, headers: { location: 'https://s3/x' } }), 'getFileDownload')
    expect(JSON.parse(texts(result)[0]!)).toEqual({ redirect: 'https://s3/x' })
  })

  it('sets the cursor of a truncated query_analyses page from the last returned analysis', async () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ id: `s-${index + 1}`, seq: index + 1, result: { text: 'x'.repeat(20_000) } }))
    const result = await toToolResult(json({ items, nextCursor: null }), 'queryAnalyses', { filter: {}, limit: 30 })
    const page = JSON.parse(texts(result)[0]!) as { items: { untrusted_data: { seq: number } }[]; nextCursor: string | null }
    expect(page.items.length).toBeLessThan(30)
    expect(page.nextCursor).toBe(String(page.items.at(-1)?.untrusted_data.seq))

    const sorted = await toToolResult(json({ items, nextCursor: null }), 'queryAnalyses', { filter: {}, sort: { seq: -1 } })
    expect((JSON.parse(texts(sorted)[0]!) as { nextCursor: string | null }).nextCursor).toBeNull()
  })

  it('returns a full inline file page uncut and wrapped, whatever its bytes (docs/api.md §4.15)', async () => {
    const name = `hostile \u0001"name\\.txt`.padEnd(255, '\u0002')
    const contentType = `text/plain; "${'\\'.repeat(240)}`
    const pages = [
      randomBytes(FILE_CONTENT_MAX_BYTES),
      Buffer.alloc(FILE_CONTENT_MAX_BYTES, '"'),
      Buffer.alloc(FILE_CONTENT_MAX_BYTES, 0x01),
      Buffer.from('€'.repeat(FILE_CONTENT_MAX_BYTES / 3)),
    ].map((bytes) => encodeFileContent({ name, size: bytes.length * 2, sha256: 'f'.repeat(64), contentType }, 0, bytes))
    for (const page of pages) {
      const result = await toToolResult(json(page), 'readAnalysisFile')
      expect(result.content, page.encoding).toHaveLength(1)
      const text = texts(result)[0]!
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MCP_RESPONSE_CAP_BYTES)
      const parsed = JSON.parse(text) as {
        content: { untrusted_data: string }
        name: { untrusted_data: string }
        contentType: { untrusted_data: string }
        length: number
        nextOffset: number
      }
      expect(parsed.content.untrusted_data).toBe(page.content)
      expect(parsed.name.untrusted_data).toBe(name)
      expect(parsed.contentType.untrusted_data).toBe(contentType)
      expect(parsed.nextOffset).toBe(parsed.length)
    }
  })

  it('adds the truncation note as a second block', async () => {
    const items = Array.from({ length: 5000 }, (_, seq) => ({ seq, data: 'x'.repeat(100) }))
    const result = await toToolResult(json({ items, nextCursor: null }), 'listAnalyses')
    expect(result.content).toHaveLength(2)
    expect(texts(result)[1]).toMatch(/^\[scantor\] Response truncated/)
  })
})
