import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLoopbackListener, isLoopbackListenerSocket, setLoopbackHandler, useLoopbackOrigin } from '../../server/utils/loopback'

// The private loopback listener of the MCP bridge (docs/mcp.md §4.3): 127.0.0.1 with an ephemeral port, serving the
// handler it was given, and the only listener whose connections may carry internal capabilities.

/** A handler that reports whether its request arrived on the loopback listener. */
function reportingHandler(seen: boolean[]) {
  return (req: IncomingMessage, res: ServerResponse) => {
    seen.push(isLoopbackListenerSocket(req.socket))
    res.setHeader('content-type', 'text/plain')
    res.end(req.socket.remoteAddress ?? '')
  }
}

let other: Server | null = null

afterEach(async () => {
  await closeLoopbackListener()
  setLoopbackHandler(null)
  if (other) await new Promise<void>((resolve) => other!.close(() => resolve()))
  other = null
})

describe('loopback listener', () => {
  it('refuses to start without a handler', async () => {
    setLoopbackHandler(null)
    await expect(useLoopbackOrigin()).rejects.toThrow('no request handler')
  })

  it('serves the handler on 127.0.0.1 with an ephemeral port, started once', async () => {
    const seen: boolean[] = []
    setLoopbackHandler(reportingHandler(seen))
    const [origin, again] = await Promise.all([useLoopbackOrigin(), useLoopbackOrigin()])
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(again).toBe(origin)
    const response = await fetch(`${origin}/api/health`)
    expect(await response.text()).toMatch(/127\.0\.0\.1$/)
    expect(seen).toEqual([true])
  })

  it('does not recognise connections of other listeners', async () => {
    const seen: boolean[] = []
    setLoopbackHandler(reportingHandler(seen))
    await useLoopbackOrigin()
    other = createServer(reportingHandler(seen))
    await new Promise<void>((resolve) => other!.listen(0, '127.0.0.1', resolve))
    await (await fetch(`http://127.0.0.1:${(other.address() as AddressInfo).port}/`)).text()
    expect(seen).toEqual([false])
    expect(isLoopbackListenerSocket(undefined)).toBe(false)
  })

  it('closes its connections and starts a new listener on the next use', async () => {
    setLoopbackHandler(reportingHandler([]))
    const first = await useLoopbackOrigin()
    await closeLoopbackListener()
    await expect(fetch(`${first}/`)).rejects.toThrow()
    const second = await useLoopbackOrigin()
    expect((await fetch(`${second}/`)).status).toBe(200)
  })
})
