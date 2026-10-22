import { request as httpRequest } from 'node:http'
import type { Socket } from 'node:net'

/*
 * code-server's `GET /healthz` over the user's socket (docs/editor.md §6.2 step 7, §6.4): no auth, no heartbeat side
 * effect, 200 `{"status":"alive",…}` while the server runs. Used for readiness after a start and by the reaper.
 */

export type HealthProbeResult = { healthy: true } | { healthy: false; reason: string }

/** Probes `/healthz` through a connection from `connect` (the safe socket connect); never rejects. */
export function probeEditorHealth(connect: () => Socket, timeoutMs: number): Promise<HealthProbeResult> {
  return new Promise((resolve) => {
    let socket: Socket
    try {
      socket = connect()
    } catch (error) {
      resolve({ healthy: false, reason: (error as Error).message })
      return
    }
    const request = httpRequest({
      createConnection: () => socket,
      method: 'GET',
      path: '/healthz',
      headers: { host: 'localhost', connection: 'close' },
      timeout: timeoutMs,
    })
    request.on('response', (response) => {
      response.resume()
      resolve(response.statusCode === 200 ? { healthy: true } : { healthy: false, reason: `GET /healthz answered ${response.statusCode}` })
    })
    request.on('timeout', () => request.destroy(new Error(`GET /healthz timed out after ${timeoutMs} ms`)))
    request.on('error', (error) => {
      socket.destroy()
      resolve({ healthy: false, reason: error.message })
    })
    request.end()
  })
}
