import { describe, expect, it } from 'vitest'
import { toToolResult } from '../../../server/services/mcp/bridge'

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

  it('adds the truncation note as a second block', async () => {
    const items = Array.from({ length: 5000 }, (_, seq) => ({ seq, data: 'x'.repeat(100) }))
    const result = await toToolResult(json({ items, nextCursor: null }), 'listAnalyses')
    expect(result.content).toHaveLength(2)
    expect(texts(result)[1]).toMatch(/^\[scantor\] Response truncated/)
  })
})
