import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { isPushGateEvent, LineSplitter, parsePipelineEvent } from '../../../server/services/pipeline/events'

describe('pipeline events', () => {
  it('parses events and rejects other lines', () => {
    expect(parsePipelineEvent('{"v":1,"seq":0,"at":"x","phase":"pack","type":"log","text":"t"}')?.phase).toBe('pack')
    expect(parsePipelineEvent('{"seq":0,"phase":"pack","type":"other"}')).toBeNull()
    expect(parsePipelineEvent('plain text')).toBeNull()
    expect(parsePipelineEvent('[1]')).toBeNull()
  })

  it('recognises the push gate event', () => {
    expect(isPushGateEvent({ v: 1, seq: 4, at: '', phase: 'push', type: 'log', text: 'waiting for push gate' })).toBe(true)
    expect(isPushGateEvent({ v: 1, seq: 4, at: '', phase: 'build', type: 'log', text: 'waiting for push gate' })).toBe(false)
  })

  it('splits lines across chunks and drops oversized lines', async () => {
    const oversized: number[] = []
    const splitter = new LineSplitter(8, (length) => oversized.push(length))
    const lines: string[] = []
    splitter.on('data', (line: string) => lines.push(line))
    await new Promise<void>((resolve) => {
      splitter.on('end', resolve)
      Readable.from([Buffer.from('ab\r\ncd'), Buffer.from('ef\n0123456789012'), Buffer.from('345\nlast')]).pipe(splitter)
    })
    expect(lines).toEqual(['ab', 'cdef', 'last'])
    expect(oversized.length).toBe(1)
  })
})
