import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventDoc } from '../../server/types/documents'
import { publishEvents, registerEventSink, resetEventSinks } from '../../server/utils/event-sinks'

// Event sinks (server/utils/event-sinks.ts): written events reach every sink that accepts them, without delaying or
// failing the writer.

function event(type: string): EventDoc {
  return { _id: type, at: new Date(), type, level: 'info', userId: null, message: type }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => resetEventSinks())

describe('event sinks', () => {
  it('hands each sink only the events it accepts, after the writer returned', async () => {
    const consumed: string[][] = []
    registerEventSink({ name: 'a', accept: (e) => e.type.startsWith('scan.'), consume: async (events) => void consumed.push(events.map((e) => e.type)) })
    registerEventSink({ name: 'b', accept: () => false, consume: async () => void consumed.push(['never']) })
    publishEvents([event('scan.created'), event('node.online'), event('scan.scaled')])
    expect(consumed).toEqual([])
    await flush()
    expect(consumed).toEqual([['scan.created', 'scan.scaled']])
  })

  it('never throws when a sink fails, synchronously or not', async () => {
    const consume = vi.fn(async () => {})
    registerEventSink({
      name: 'throws-in-accept',
      accept: () => {
        throw new Error('boom')
      },
      consume,
    })
    registerEventSink({
      name: 'rejects',
      accept: () => true,
      consume: async () => {
        throw new Error('boom')
      },
    })
    registerEventSink({
      name: 'throws',
      accept: () => true,
      consume: () => {
        throw new Error('boom')
      },
    })
    registerEventSink({ name: 'ok', accept: () => true, consume })
    expect(() => publishEvents([event('scan.created')])).not.toThrow()
    await flush()
    expect(consume).toHaveBeenCalledOnce()
  })

  it('refuses a second sink of the same name', () => {
    registerEventSink({ name: 'a', accept: () => true, consume: async () => {} })
    expect(() => registerEventSink({ name: 'a', accept: () => true, consume: async () => {} })).toThrow('registered twice')
  })
})
