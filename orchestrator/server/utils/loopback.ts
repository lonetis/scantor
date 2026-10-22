import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

/*
 * The loopback listener (docs/mcp.md §4.3, docs/auth.md §5.2): a private HTTP listener on 127.0.0.1 with an
 * ephemeral port that serves this process's Nitro app (server/plugins/00.boot.ts sets the handler). The MCP bridge
 * sends its REST calls and the JWKS fetch here rather than to the public listener, so they reach this process
 * whatever the public listener is: `nuxt dev` runs the app in a worker behind a unix socket (requests there have no
 * peer address, and the dev port is not necessarily 3000), and the production port is configurable. Internal
 * capabilities are accepted only on connections of this listener.
 */

export const LOOPBACK_HOST = '127.0.0.1'

let handler: RequestListener | null = null
let server: Server | null = null
let listening: Promise<string> | null = null
const ownSockets = new WeakSet<Socket>()

/** Sets the request listener the loopback listener serves (this process's Nitro app). */
export function setLoopbackHandler(listener: RequestListener | null): void {
  handler = listener
}

async function start(listener: RequestListener): Promise<string> {
  const created = createServer(listener)
  created.on('connection', (socket) => ownSockets.add(socket))
  await new Promise<void>((resolve, reject) => {
    created.once('error', reject)
    created.listen(0, LOOPBACK_HOST, () => {
      created.off('error', reject)
      resolve()
    })
  })
  // The listener never keeps the process alive on its own; Nitro's `close` hook closes it.
  created.unref()
  server = created
  const { port } = created.address() as AddressInfo
  return `http://${LOOPBACK_HOST}:${port}`
}

/** The origin of the loopback listener (`http://127.0.0.1:<port>`); the listener starts on first use. */
export function useLoopbackOrigin(): Promise<string> {
  if (!listening) {
    if (!handler) return Promise.reject(new Error('the loopback listener has no request handler'))
    listening = start(handler).catch((error: unknown) => {
      listening = null
      throw error
    })
  }
  return listening
}

/** True when a request arrived on a connection of the loopback listener. */
export function isLoopbackListenerSocket(socket: Socket | null | undefined): boolean {
  return !!socket && ownSockets.has(socket)
}

/** Closes the loopback listener and its connections (Nitro `close`); the next use starts a new one. */
export async function closeLoopbackListener(): Promise<void> {
  const pending = listening
  listening = null
  if (pending) await pending.catch(() => undefined)
  const current = server
  server = null
  if (!current) return
  current.closeAllConnections()
  await new Promise<void>((resolve, reject) => current.close((error) => (error ? reject(error) : resolve())))
}
