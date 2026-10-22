import { createApp, send, setResponseStatus, toWebHandler } from 'h3'
import { beforeEach, describe, expect, it } from 'vitest'
import authMiddleware from '../../server/middleware/10.auth'
import { resetBootRegistry } from '../../server/utils/boot'
import { normalizeError } from '../../server/utils/errors'

// The auth middleware while boot is still running (docs/architecture.md §4.1, docs/api.md §1.7, §4.18): `/api/*`
// answers 503 `unavailable` in the JSON envelope, except Traefik's forwardAuth route, which never uses the envelope.

function handler() {
  const app = createApp({
    onError: (error, event) => {
      const normalized = normalizeError(error)
      setResponseStatus(event, normalized.status)
      return send(event, JSON.stringify(normalized.body), 'application/json')
    },
  })
  app.use(authMiddleware)
  return toWebHandler(app)
}

beforeEach(() => {
  resetBootRegistry()
})

describe('auth middleware during boot', () => {
  it('answers 503 with the envelope on API routes', async () => {
    const response = await handler()(new Request('http://localhost/api/scans'))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'unavailable', message: 'the orchestrator is starting' } })
  })

  it('answers the forwardAuth route with a 503 text/plain body', async () => {
    const response = await handler()(new Request('http://localhost/api/tools/forward-auth', { headers: { 'x-forwarded-host': 'rabbitmq.example.com' } }))
    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('Service Unavailable\n')
  })
})
