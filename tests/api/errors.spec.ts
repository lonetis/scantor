import { randomUUID } from 'node:crypto'
import type { Page } from '#shared/types/common'
import type { Upload } from '#shared/types/uploads'
import { ok, type ApiClient, type ApiResponse } from '../helpers/api-client'
import {
  createKey,
  dashboardListenerUrl,
  deleteKey,
  expandTemplate,
  operationsWithScope,
  parseByteSize,
  pathParams,
  rawRequest,
  sessionCookieOf,
  setApiKeyCreatedAt,
  stackValue,
  UUID_PATTERN,
  withAuthTenants,
} from '../helpers/api-auth'
import { expect, test as base, unique } from '../fixtures'

const test = withAuthTenants(base)

// REST conventions shared by every /api route (docs/api.md §1, docs/auth.md §5.4–§5.5): request ids, the error
// envelope, deny by default, strict validation of bodies and query strings, body caps, malformed ids, cursor
// pagination and the dashboard listener's 421 for the editor host.

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

function expectError(response: ApiResponse, status: number, code: string): ErrorBody['error'] {
  expect(response.status, response.raw.toString('utf8').slice(0, 500)).toBe(status)
  const body = response.body as ErrorBody
  expect(body.error.code).toBe(code)
  return body.error
}

/** A request through the client's context (paths outside the OpenAPI document, raw bodies). */
async function fetchRaw(client: ApiClient, path: string, options: Parameters<ApiClient['request']['fetch']>[1] = {}): Promise<ApiResponse> {
  const response = await client.request.fetch(path, { maxRedirects: 0, ...options })
  const raw = await response.body()
  const headers = response.headers()
  const body = (headers['content-type'] ?? '').includes('json') && raw.length > 0 ? (JSON.parse(raw.toString('utf8')) as unknown) : {}
  return { status: response.status(), headers, body, raw }
}

test.describe('request ids', () => {
  test('a valid incoming X-Request-Id is echoed and any other value is replaced by a uuid', { tag: ['@API-001'] }, async ({ anonApi, api }) => {
    const valid = ['abc', 'Trace.id_1:2-3', 'x'.repeat(128)]
    const invalid = ['x'.repeat(129), 'has space', 'a/b', 'a,b', '<script>', 'a"b']
    // A public route, an authenticated one, a 401 and a 404: every /api response carries the header.
    const requests: [ApiClient, string, number][] = [
      [anonApi, '/api/health', 200],
      [api, '/api/account', 200],
      [anonApi, '/api/account', 401],
      [api, `/api/scans/${randomUUID()}`, 404],
    ]
    for (const [client, path, status] of requests) {
      for (const id of valid) {
        const response = await fetchRaw(client, path, { headers: { 'X-Request-Id': id } })
        expect(response.status, `${path} with ${id}`).toBe(status)
        expect(response.headers['x-request-id'], `${path} echoes ${id}`).toBe(id)
      }
      for (const id of invalid) {
        const response = await fetchRaw(client, path, { headers: { 'X-Request-Id': id } })
        expect(response.headers['x-request-id'], `${path} replaces ${JSON.stringify(id)}`).toMatch(UUID_PATTERN)
      }
      const generated = await fetchRaw(client, path)
      expect(generated.headers['x-request-id'], `${path} without an id`).toMatch(UUID_PATTERN)
    }
    // Generated ids are unique per request.
    const first = await fetchRaw(anonApi, '/api/health')
    const second = await fetchRaw(anonApi, '/api/health')
    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id'])
  })
})

test.describe('error envelope', () => {
  test('errors use the envelope with JSON and no-store', { tag: ['@API-002'] }, async ({ anonApi, api }) => {
    const cases: [ApiResponse, number, string][] = [
      [await anonApi.getAccount(), 401, 'unauthorized'],
      [await api.call('getScan', { path: { scanId: randomUUID() } }), 404, 'notFound'],
      [await api.call('updateAccount', { body: { name: '' } }), 400, 'validationFailed'],
      [await api.call('getMetrics'), 403, 'adminRequired'],
      [await fetchRaw(api, '/api/account', { method: 'PUT' }), 405, 'methodNotAllowed'],
    ]
    for (const [response, status, code] of cases) {
      const error = expectError(response, status, code)
      expect(typeof error.message, code).toBe('string')
      expect(error.message.length, code).toBeGreaterThan(0)
      expect(Object.keys(response.body as object), code).toEqual(['error'])
      expect(response.headers['content-type'], code).toMatch(/^application\/json/)
      expect(response.headers['cache-control'], code).toBe('no-store')
    }
    const validation = expectError(await api.call('updateAccount', { body: { name: '' } }), 400, 'validationFailed')
    expect(validation.details?.issues).toEqual([expect.objectContaining({ path: 'name', message: expect.any(String) })])
  })

  test('an unexpected failure is 500 internal with the request id and no internal message', { tag: ['@API-002'] }, async ({ api }) => {
    // White-box: a key document of the tenant whose createdAt is not a date makes listApiKeys fail unexpectedly.
    const key = await createKey(api, unique('corrupt').slice(0, 32))
    try {
      await setApiKeyCreatedAt(key.apiKey.id, 'corrupt')
      const response = await api.call('listApiKeys', { headers: { 'X-Request-Id': 'api-002-unexpected' } })
      const error = expectError(response, 500, 'internal')
      expect(error.message).toBe('unexpected server error')
      expect(error.details).toEqual({ requestId: 'api-002-unexpected' })
      expect(response.headers['x-request-id']).toBe('api-002-unexpected')
      expect(response.headers['cache-control']).toBe('no-store')
      const text = response.raw.toString('utf8')
      for (const leak of ['Invalid time value', 'RangeError', 'stack', 'not-a-date', '.ts:', 'node_modules']) expect(text).not.toContain(leak)
    } finally {
      await setApiKeyCreatedAt(key.apiKey.id, 'now')
      await deleteKey(api, key.apiKey.id)
    }
  })
})

test.describe('deny by default', () => {
  test('a path without an operation is 404 and a wrong method is 405 with Allow', { tag: ['@API-003'] }, async ({ api, adminApi }) => {
    for (const path of ['/api/nope', '/api/accounts', `/api/scans/${randomUUID()}/nope`, '/api/account/password/extra', '/api/auth2/x']) {
      const error = expectError(await fetchRaw(api, path), 404, 'notFound')
      expect(error.message, path).toContain('no operation')
    }
    // One trailing slash is tolerated.
    expect((await fetchRaw(api, '/api/account/')).status).toBe(200)
    expect((await fetchRaw(adminApi, '/api/users/')).status).toBe(200)

    const put = await fetchRaw(api, '/api/account', { method: 'PUT', data: {} })
    const error = expectError(put, 405, 'methodNotAllowed')
    expect([...(error.details?.allowed as string[])].sort()).toEqual(['GET', 'PATCH'])
    expect(put.headers['allow']?.split(/,\s*/).sort()).toEqual(['GET', 'PATCH'])

    const deleteInfo = await fetchRaw(api, '/api/info', { method: 'DELETE' })
    expect(expectError(deleteInfo, 405, 'methodNotAllowed').details?.allowed).toEqual(['GET'])
    expect(deleteInfo.headers['allow']).toBe('GET')
  })

  test('the orchestrator never routes an empty interior segment to an operation', { tag: ['@API-003'] }, async ({ env }) => {
    // Traefik merges duplicate slashes before routing, so the case is checked on the dashboard listener itself.
    const cookie = sessionCookieOf(env.paths.adminState)
    const headers = { Host: env.domain, Cookie: `${cookie.name}=${cookie.value}` }
    const control = await rawRequest(`${dashboardListenerUrl()}/api/users?limit=1`, { headers })
    expect(control.status, control.text()).toBe(200)
    for (const path of ['/api//users', '/api//users/', '/api/users//', '/api//users/x']) {
      const response = await rawRequest(`${dashboardListenerUrl()}${path}`, { headers })
      expect(response.status, `${path}: ${response.text()}`).toBe(404)
      expect(response.json<ErrorBody>().error.code).toBe('notFound')
    }
  })
})

test.describe('request validation', () => {
  test('unknown keys in a body or the query string are validationFailed', { tag: ['@API-004'] }, async ({ api, user }) => {
    const body = expectError(await api.call('updateAccount', { body: { name: user.name, bogus: true, other: 1 } }), 400, 'validationFailed')
    expect(body.details?.issues).toEqual(
      expect.arrayContaining([
        { path: 'bogus', message: 'unknown field' },
        { path: 'other', message: 'unknown field' },
      ]),
    )
    const query = expectError(await api.call('listApiKeys', { query: { bogus: '1' } }), 400, 'validationFailed')
    expect(query.details?.issues).toEqual([{ path: 'bogus', message: 'unknown field' }])
    const listQuery = expectError(await api.call('listScans', { query: { limit: 5, sortBy: 'name' } }), 400, 'validationFailed')
    expect(listQuery.details?.issues).toEqual([{ path: 'sortBy', message: 'unknown field' }])
    // Nothing changed.
    expect(ok(await api.getAccount(), 'getAccount').name).toBe(user.name)
  })

  test('bodies must be JSON: 415 for other types, 400 for malformed JSON, an empty body is {}', { tag: ['@API-005'] }, async ({ api, user }) => {
    const textBody = await fetchRaw(api, '/api/account', { method: 'PATCH', headers: { 'Content-Type': 'text/plain' }, data: 'name=x' })
    expectError(textBody, 415, 'unsupportedMediaType')
    const formBody = await fetchRaw(api, '/api/account', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: Buffer.from('name=x'),
    })
    expectError(formBody, 415, 'unsupportedMediaType')
    const malformed = await fetchRaw(api, '/api/account', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, data: Buffer.from('{"name":') })
    expectError(malformed, 400, 'badRequest')

    // An empty body is validated as {}: the required name is missing, whatever the declared type.
    for (const contentType of ['application/json', 'text/plain']) {
      const empty = await fetchRaw(api, '/api/account', { method: 'PATCH', headers: { 'Content-Type': contentType } })
      const error = expectError(empty, 400, 'validationFailed')
      expect(error.details?.issues, contentType).toEqual([expect.objectContaining({ path: 'name' })])
    }
    // A route whose body is optional accepts an empty body ({} is valid) and goes on to its own checks.
    expectError(await fetchRaw(api, `/api/scans/${randomUUID()}/pause`, { method: 'POST' }), 404, 'notFound')
    expect(ok(await api.getAccount(), 'getAccount').name).toBe(user.name)
  })
})

test.describe('body caps', () => {
  const maxRequestBytes = () => parseByteSize(stackValue('SCANTOR_MAX_REQUEST_BYTES'))

  test('a JSON body above SCANTOR_MAX_REQUEST_BYTES is 413 by declared length', { tag: ['@API-006'] }, async ({ api, user }) => {
    const limit = maxRequestBytes()
    const body = Buffer.from(`{"name":"${'a'.repeat(limit - 10)}"}`)
    expect(body.length).toBeGreaterThan(limit)
    const response = await fetchRaw(api, '/api/account', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, data: body })
    const error = expectError(response, 413, 'payloadTooLarge')
    expect(error.details).toEqual({ limit, actual: body.length })
    expect(ok(await api.getAccount(), 'getAccount').name).toBe(user.name)
  })

  test('a chunked JSON body without Content-Length is 413 by actual size', { tag: ['@API-006'] }, async ({ user, env }) => {
    const limit = maxRequestBytes()
    const body = Buffer.from(`{"name":"${'a'.repeat(limit)}"}`)
    const response = await rawRequest(`${env.publicUrl}/api/account`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${user.apiKey}`, 'Content-Type': 'application/json' },
      body,
      chunked: true,
    })
    expect(response.status, response.text().slice(0, 300)).toBe(413)
    const error = response.json<ErrorBody>().error
    expect(error.code).toBe('payloadTooLarge')
    expect(error.details).toEqual({ limit, actual: body.length })

    // Below the cap the same chunked request is read and validated normally.
    const small = await rawRequest(`${env.publicUrl}/api/account`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${user.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: user.name }),
      chunked: true,
    })
    expect(small.status, small.text()).toBe(200)
  })

  test('machine routes have their own caps: 1 MiB for the runtime, 2 MiB for node status and logs', { tag: ['@API-006'] }, async ({ anonApi }) => {
    // The cap applies before authentication: at the cap the request reaches the credential check (401).
    const cases: [string, number][] = [
      ['/api/runtime/state', 1024 ** 2],
      ['/api/runtime/analyses/status', 1024 ** 2],
      ['/api/node/status', 2 * 1024 ** 2],
      [`/api/node/workers/${randomUUID()}/logs`, 2 * 1024 ** 2],
    ]
    for (const [path, limit] of cases) {
      const over = await fetchRaw(anonApi, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, data: Buffer.alloc(limit + 1, 0x20) })
      expect(expectError(over, 413, 'payloadTooLarge').details, path).toEqual({ limit, actual: limit + 1 })
      const at = await fetchRaw(anonApi, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, data: Buffer.alloc(limit, 0x20) })
      expectError(at, 401, 'unauthorized')
    }
  })
})

test.describe('path ids', () => {
  // Encoded into one path segment each ('../' travels as ..%2F).
  const MALFORMED = ['not-a-uuid', '../', '{"$ne": null}', '12345678-1234-1234-1234-1234567890ab-x', '%00']
  // Otherwise valid input for the operations with required query or body fields, so only the path id is wrong.
  const VALID_INPUT: Record<string, { query?: Record<string, string>; data?: unknown }> = {
    readTaskFile: { query: { path: 'scantor.yaml' } },
    deleteTaskFile: { query: { path: 'scantor.yaml' } },
    writeTaskFiles: { data: { files: { 'a.txt': 'x' } } },
    queryAnalyses: { data: { filter: {} } },
    aggregateAnalyses: { data: { pipeline: [] } },
    exportScan: { data: { format: 'jsonl' } },
    setUserPassword: { data: { password: 'a-valid-password' } },
  }

  async function expectNotFoundEverywhere(client: ApiClient, scopes: string[], bad: string[]) {
    const problems: string[] = []
    for (const op of operationsWithScope(client.openapi, scopes)) {
      for (const name of pathParams(op.path)) {
        for (const value of [...bad, ...(name === 'analysisId' ? ['abc', `${randomUUID()}-x`, `${randomUUID()}--1`, `${randomUUID()}-1.5`] : [])]) {
          const path = expandTemplate(op.path, { [name]: value })
          const method = op.method.toUpperCase()
          const input = VALID_INPUT[op.operationId] ?? (method === 'GET' || method === 'DELETE' ? {} : { data: {} })
          const response = await fetchRaw(client, path, { method, params: input.query, data: input.data })
          const code = (response.body as Partial<ErrorBody>).error?.code
          if (response.status !== 404 || code !== 'notFound')
            problems.push(`${method} ${path} (${op.operationId}, ${name}=${JSON.stringify(value)}) → ${response.status} ${code}`)
        }
      }
    }
    expect(problems).toEqual([])
  }

  test('a malformed path id is 404 notFound on every owner operation', { tag: ['@API-007'] }, async ({ api }) => {
    await expectNotFoundEverywhere(api, ['owner'], MALFORMED)
  })

  test('a malformed path id is 404 notFound on every admin operation', { tag: ['@API-007'] }, async ({ adminApi }) => {
    await expectNotFoundEverywhere(adminApi, ['admin'], MALFORMED)
  })
})

test.describe('query values', () => {
  test('booleans accept only true/false and integers must be decimal', { tag: ['@API-008'] }, async ({ api }) => {
    const job = randomUUID()
    for (const wait of ['60s', '1.5', '0x10', '1e2', ' 5', '-1', '121', 'true']) {
      const error = expectError(await api.call('getJob', { path: { jobId: job }, query: { wait } }), 400, 'validationFailed')
      expect(error.details?.issues, `wait=${wait}`).toEqual([expect.objectContaining({ path: 'wait' })])
    }
    // Valid values pass validation and reach the lookup.
    for (const wait of ['0', '1']) expectError(await api.call('getJob', { path: { jobId: job }, query: { wait } }), 404, 'notFound')

    const task = unique('no-such-task')
    for (const recursive of ['yes', '1', 'TRUE', 'True', '']) {
      const error = expectError(await api.call('listTaskFiles', { path: { task }, query: { recursive } }), 400, 'validationFailed')
      expect(error.details?.issues, `recursive=${recursive}`).toEqual([expect.objectContaining({ path: 'recursive' })])
    }
    for (const recursive of ['true', 'false']) expectError(await api.call('listTaskFiles', { path: { task }, query: { recursive } }), 404, 'notFound')
  })
})

test.describe('pagination', () => {
  test('cursor pages are newest first without overlap, limit defaults to 50 and allows 200', { tag: ['@API-009'] }, async ({ api }) => {
    test.setTimeout(180_000)
    const marker = unique('page')
    const created: string[] = []
    try {
      for (let i = 0; i < 51; i++) {
        const response = await api.call<Upload>('createUpload', {
          query: { name: `${marker}-${i}.txt` },
          body: Buffer.from(`${marker} ${i}\n`),
          headers: { 'Content-Type': 'text/plain' },
        })
        expect(response.status, response.raw.toString('utf8')).toBe(201)
        created.push(response.body.id)
      }

      const first = ok(await api.call<Page<Upload>>('listUploads'), 'listUploads')
      expect(first.items).toHaveLength(50)
      expect(first.nextCursor).toEqual(expect.any(String))

      // Walk every page with a small limit: newest first, no overlap, every created upload once, last page null.
      const seen: Upload[] = []
      let cursor: string | undefined
      for (let pages = 0; ; pages++) {
        expect(pages, 'pages').toBeLessThan(1000)
        const page = ok(await api.call<Page<Upload>>('listUploads', { query: { limit: 20, cursor } }), 'listUploads')
        expect(page.items.length).toBeLessThanOrEqual(20)
        seen.push(...page.items)
        if (page.nextCursor === null) break
        expect(page.items).toHaveLength(20)
        cursor = page.nextCursor
      }
      const ids = seen.map((u) => u.id)
      expect(new Set(ids).size, 'no item appears twice').toBe(ids.length)
      expect(ids.filter((id) => created.includes(id)).sort()).toEqual([...created].sort())
      const times = seen.map((u) => Date.parse(u.createdAt))
      expect(times, 'newest first').toEqual([...times].sort((a, b) => b - a))
      // Mine come out in reverse creation order.
      expect(ids.filter((id) => created.includes(id))).toEqual([...created].reverse())

      expect(ok(await api.call<Page<Upload>>('listUploads', { query: { limit: 200 } }), 'listUploads').items.length).toBeGreaterThanOrEqual(51)
      for (const limit of ['201', '0', '-1', 'ten']) {
        const error = expectError(await api.call('listUploads', { query: { limit } }), 400, 'validationFailed')
        expect(error.details?.issues, `limit=${limit}`).toEqual([expect.objectContaining({ path: 'limit' })])
      }
      const tampered = [
        Buffer.from(JSON.stringify({ t: 'yesterday', i: created[0] })).toString('base64url'),
        Buffer.from('not json').toString('base64url'),
        `${first.nextCursor!.slice(0, -4)}AAAA`,
        'x',
      ]
      for (const bad of tampered) {
        const error = expectError(await api.call('listUploads', { query: { cursor: bad } }), 400, 'validationFailed')
        expect(error.details?.issues, `cursor=${bad}`).toEqual([expect.objectContaining({ path: 'cursor' })])
      }
    } finally {
      for (const uploadId of created) {
        const response = await api.call('deleteUpload', { path: { uploadId } })
        expect([204, 404], uploadId).toContain(response.status)
      }
    }
  })
})

test.describe('listeners', () => {
  test('the dashboard listener answers 421 for the editor host', { tag: ['@API-011'] }, async ({ env }) => {
    const editorHost = new URL(env.editorUrl).host
    for (const path of ['/api/health', '/api/info', '/', '/mcp', '/api/auth/get-session']) {
      const response = await rawRequest(`${dashboardListenerUrl()}${path}`, { headers: { Host: editorHost } })
      expect(response.status, path).toBe(421)
      expect(response.headers['content-type'], path).toMatch(/^text\/plain/)
      expect(response.text(), path).toContain('Misdirected Request')
    }
    // The same listener serves its own host.
    const own = await rawRequest(`${dashboardListenerUrl()}/api/health`, { headers: { Host: env.domain } })
    expect(own.status).toBe(200)
  })
})
