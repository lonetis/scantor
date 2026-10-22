import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RabbitmqManagement, RabbitmqManagementError } from '../../server/utils/rabbitmq-management'

// The RabbitMQ management client (docs/queue.md §3, §4). RabbitMQ 4.4 answers PUT /api/user-limits/… with 406 when
// the request carries `Accept: application/json`, so only reads ask for JSON.

interface Seen {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

const seen: Seen[] = []
let server: Server
let management: RabbitmqManagement

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      if (req.method === 'PUT' && req.headers.accept === 'application/json') {
        res.statusCode = 406
        res.end('Not Acceptable')
      } else if (req.url === '/api/users') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify([{ name: 'scantor', tags: ['administrator'] }]))
      } else if (req.url?.startsWith('/api/queues/scantor/missing')) {
        res.statusCode = 404
        res.end()
      } else {
        res.statusCode = 204
        res.end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  management = new RabbitmqManagement({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, username: 'admin', password: 'secret' })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('RabbitmqManagement', () => {
  it('asks for JSON on reads only', async () => {
    seen.length = 0
    expect(await management.listUsers()).toEqual([{ name: 'scantor', tags: ['administrator'] }])
    await management.putUserLimit('scan-1', 'max-connections', 4)
    await management.deleteUser('scan-1')
    // Without an explicit Accept header, fetch sends `*/*`, which RabbitMQ accepts on every write.
    expect(seen.map((request) => [request.method, request.headers.accept])).toEqual([
      ['GET', 'application/json'],
      ['PUT', '*/*'],
      ['DELETE', '*/*'],
    ])
    expect(seen[1]).toMatchObject({ url: '/api/user-limits/scan-1/max-connections', body: '{"value":4}' })
    expect(seen[1]!.headers['content-type']).toBe('application/json')
    expect(seen[0]!.headers.authorization).toBe(`Basic ${Buffer.from('admin:secret').toString('base64')}`)
  })

  it('treats 404 as done where requested and reports other failures', async () => {
    await expect(management.getQueue('scantor', 'missing')).resolves.toBeNull()
    const failing = new RabbitmqManagement({ baseUrl: 'http://127.0.0.1:1', username: 'a', password: 'b', timeoutMs: 1000 })
    await expect(failing.listUsers()).rejects.toThrow()
    await expect(management.request('PUT', '/vhosts/x', {}).then(() => 'ok')).resolves.toBe('ok')
    expect(new RabbitmqManagementError(406, '/x', 'Not Acceptable').message).toBe('RabbitMQ management /x: HTTP 406 Not Acceptable')
  })
})
