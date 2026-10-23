import { createPublicKey, randomBytes, randomUUID, verify, type JsonWebKey } from 'node:crypto'
import { request, type APIRequestContext } from '@playwright/test'
import type { Worker } from '#shared/types/workers'
import { ok, type ApiClient } from '../helpers/api-client'
import { withPlatformScans, withPlatformTasks } from '../helpers/api-platform-cleanup'
import {
  decodeJwt,
  NodeTracker,
  registryTokenGet,
  registryTokenPost,
  settingsOn,
  taskRepository,
  withEchoTask,
  type FakeNode,
  type RegistryAnswer,
  type RegistryClaims,
} from '../helpers/api-platform-nodes'
import { withLazyTenant, withPlatformAdmin, withWorkerTenant } from '../helpers/api-platform-tenant'
import { CONTAINERS, innerDocker } from '../helpers/docker'
import { stackKeys } from '../helpers/keys'
import type { UploadedTask } from '../helpers/tasks'
import { expect, test as base } from '../fixtures'

// The registry token realm (docs/api.md §6, docs/auth.md §10.4, docs/nodes.md §10): Docker daemons trade a Basic
// credential for a short-lived ES256 JWT, either with `GET ?service&scope` or with an OAuth2 password grant form.
// Node grants follow the node's current assignments, so every test places the workers of a scan on its own fake node
// (a unique pool, helpers/api-platform-nodes.ts) and checks the grant against the registry itself where it matters.
// The realm is called like a Docker daemon calls it: no cookies, no Origin.

const test = base.extend<{ nodes: NodeTracker; realm: APIRequestContext; registry: APIRequestContext }, { echo: UploadedTask }>({
  // An admin of the worker and a tenant with a uniquely named session (helpers/api-platform-tenant.ts).
  adminApi: [async ({ openapi }, use) => withPlatformAdmin(openapi, use), { scope: 'worker', timeout: 150_000 }],
  user: [
    async ({ adminApi, openapi }, use, workerInfo) => withWorkerTenant(adminApi, openapi, `w${workerInfo.workerIndex}`, use),
    { scope: 'worker', timeout: 150_000 },
  ],
  // tasks and scans that never wait for the stack's deletion jobs (helpers/api-platform-cleanup.ts).
  tasks: async ({ api }, use) => withPlatformTasks(api, use),
  scans: async ({ api, tasks: _tasks }, use) => withPlatformScans(api, use),
  freshUserHandle: async ({ adminApi, openapi }, use) => withLazyTenant(adminApi, openapi, 'fresh', use),
  nodes: async ({ adminApi, openapi }, use) => {
    const tracker = new NodeTracker(adminApi, openapi)
    await use(tracker)
    await tracker.dispose()
  },
  echo: [async ({ user, openapi }, use) => withEchoTask(user.storageState, openapi, use), { scope: 'worker', timeout: 180_000 }],
  realm: async ({ env }, use) => {
    const context = await request.newContext({ baseURL: env.publicUrl })
    await use(context)
    await context.dispose()
  },
  registry: async ({ env }, use) => {
    const context = await request.newContext({ baseURL: `https://registry.${env.domain}` })
    await use(context)
    await context.dispose()
  },
})

// Placement on a fake node takes up to a minute while the shared stack is busy.
test.describe.configure({ timeout: 180_000 })

const SERVICE = 'scantor-registry'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISSUED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

const pull = (repository: string) => `repository:${repository}:pull`
const nodeCredential = (node: FakeNode) => ({ username: 'node', password: node.daemon.token })
const orchestratorCredential = () => ({ username: 'orchestrator', password: stackKeys().registryPushPassword() })

/** The JWT of a successful answer (`access_token`, which both flows return). */
function tokenOf(answer: RegistryAnswer): string {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const token = answer.body.access_token
  if (typeof token !== 'string') throw new Error(`no access_token in ${JSON.stringify(answer.body)}`)
  return token
}

function claimsOf(answer: RegistryAnswer): RegistryClaims {
  return decodeJwt(tokenOf(answer)).claims
}

/** A registry error answer: exactly `{errors: [{code, message}]}` as JSON, never the scantor envelope. */
function expectRegistryError(answer: RegistryAnswer, status: number, code: string, label: string): void {
  expect(answer.status, label).toBe(status)
  expect(answer.headers['content-type'], label).toMatch(/^application\/json/)
  expect(answer.body, label).toEqual({ errors: [{ code, message: expect.any(String) }] })
  expect((answer.body.errors as { message: string }[])[0]!.message.length, label).toBeGreaterThan(0)
}

/** Places the scheduler and the runner of a new scan of `task` on `node` and returns the scan id. */
async function scanOn(
  scans: { start(body: { revision: string; settings?: Record<string, unknown> }): Promise<{ id: string }> },
  node: FakeNode,
  task: UploadedTask,
): Promise<string> {
  const scan = await scans.start({ revision: task.revision.id, settings: settingsOn(node) })
  const placed = await node.waitForScanWorkers(scan.id)
  node.reportRunning(placed.scheduler, ...placed.runners)
  await node.report()
  return scan.id
}

/** `HEAD /v2/<repository>/manifests/<digest>` on the registry with a bearer token (or none). */
async function headManifest(registry: APIRequestContext, repository: string, digest: string, token: string | null) {
  const response = await registry.fetch(`/v2/${repository}/manifests/${digest}`, {
    method: 'HEAD',
    headers: { Accept: MANIFEST_TYPES, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    maxRedirects: 0,
  })
  return { status: response.status(), headers: response.headers() }
}

async function workersOf(api: ApiClient, scanId: string): Promise<Worker[]> {
  return ok(await api.listScanWorkers(scanId), 'listScanWorkers').items
}

/** The public signing key the registry trusts (its JWKS), by kid. */
async function registryJwks(): Promise<Map<string, JsonWebKey>> {
  const result = await innerDocker.exec(CONTAINERS.registry, ['cat', '/run/scantor/registry-auth/jwks.json'])
  expect(result.exitCode, result.stderr).toBe(0)
  const jwks = JSON.parse(result.stdout) as { keys: (JsonWebKey & { kid: string })[] }
  return new Map(jwks.keys.map((key) => [key.kid, key]))
}

test.describe('token flows', () => {
  test(
    'GET with a node credential returns an ES256 token for its assigned repository',
    { tag: ['@REG-001'] },
    async ({ echo, env, nodes, realm, registry, scans }) => {
      const node = await nodes.fake()
      await node.online()
      await scanOn(scans, node, echo)
      const repository = taskRepository(echo.task.id)

      const before = Math.floor(Date.now() / 1000)
      const answer = await registryTokenGet(realm, nodeCredential(node), {
        scopes: [pull(repository)],
        extra: { account: 'node', client_id: 'docker', offline_token: 'true' },
      })
      const token = tokenOf(answer)
      expect(answer.headers['cache-control']).toBe('no-store')
      expect(Object.keys(answer.body).sort()).toEqual(['access_token', 'expires_in', 'issued_at', 'token'])
      expect(answer.body.token).toBe(token)
      expect(answer.body.expires_in).toBe(300)
      expect(answer.body.issued_at).toMatch(ISSUED_AT)
      expect(Math.abs(Date.parse(answer.body.issued_at as string) / 1000 - before)).toBeLessThan(30)
      expect(answer.body).not.toHaveProperty('refresh_token')

      const { header, claims } = decodeJwt(token)
      expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: expect.any(String) })
      expect(claims).toEqual({
        iss: 'scantor',
        sub: `node:${node.id}`,
        aud: SERVICE,
        iat: expect.any(Number),
        nbf: expect.any(Number),
        exp: expect.any(Number),
        jti: expect.stringMatching(UUID),
        access: [{ type: 'repository', name: repository, actions: ['pull'] }],
      })
      expect(claims.exp - claims.iat).toBe(300)
      expect(claims.nbf).toBeLessThanOrEqual(claims.iat)
      expect(Math.abs(claims.iat - before)).toBeLessThan(30)

      // The signature verifies with the key of the registry's JWKS (ES256: raw r‖s of 64 bytes).
      const jwk = (await registryJwks()).get(header.kid as string)
      expect(jwk, `the registry's JWKS has the kid ${String(header.kid)}`).toBeDefined()
      const [encodedHeader, encodedClaims, signature] = token.split('.') as [string, string, string]
      const raw = Buffer.from(signature, 'base64url')
      expect(raw).toHaveLength(64)
      const signed = verify(
        'sha256',
        Buffer.from(`${encodedHeader}.${encodedClaims}`),
        { key: createPublicKey({ key: jwk!, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
        raw,
      )
      expect(signed).toBe(true)

      // A fresh jti every time.
      expect(claimsOf(await registryTokenGet(realm, nodeCredential(node), { scopes: [pull(repository)] })).jti).not.toBe(claims.jti)

      // The registry trusts the token for the pull it grants, and points unauthenticated clients at the realm.
      const digest = echo.revision.image!.digest
      const pulled = await headManifest(registry, repository, digest, token)
      expect(pulled.status).toBe(200)
      expect(pulled.headers['docker-content-digest']).toBe(digest)
      const anonymous = await headManifest(registry, repository, digest, null)
      expect(anonymous.status).toBe(401)
      expect(anonymous.headers['www-authenticate']).toContain(`realm="${env.publicUrl}/api/registry/token"`)
      expect(anonymous.headers['www-authenticate']).toContain(`service="${SERVICE}"`)
    },
  )

  test('POST with a password grant form returns an access token', { tag: ['@REG-002'] }, async ({ echo, nodes, realm, scans }) => {
    const node = await nodes.fake()
    await node.online()
    await scanOn(scans, node, echo)
    const repository = taskRepository(echo.task.id)
    const form = (extra: Record<string, string> = {}) =>
      new URLSearchParams({ grant_type: 'password', service: SERVICE, client_id: 'containerd-client', username: 'node', password: node.daemon.token, ...extra })

    const answer = await registryTokenPost(realm, form({ scope: pull(repository) }))
    const token = tokenOf(answer)
    expect(answer.headers['cache-control']).toBe('no-store')
    expect(Object.keys(answer.body).sort()).toEqual(['access_token', 'expires_in', 'issued_at'])
    expect(answer.body.expires_in).toBe(300)
    expect(answer.body.issued_at).toMatch(ISSUED_AT)
    const { header, claims } = decodeJwt(token)
    expect(header).toMatchObject({ alg: 'ES256', typ: 'JWT' })
    expect(claims).toMatchObject({
      iss: 'scantor',
      aud: SERVICE,
      sub: `node:${node.id}`,
      access: [{ type: 'repository', name: repository, actions: ['pull'] }],
    })
    expect(claims.exp - claims.iat).toBe(300)

    // containerd sends several scopes space-separated in one value; each is considered on its own.
    const other = taskRepository(randomUUID())
    const spaced = claimsOf(await registryTokenPost(realm, form({ scope: `${pull(other)} ${pull(repository)}` })))
    expect(spaced.access).toEqual([{ type: 'repository', name: repository, actions: ['pull'] }])

    // The form may leave the credential to a Basic header.
    const basic = `Basic ${Buffer.from(`node:${node.daemon.token}`).toString('base64')}`
    const viaHeader = await registryTokenPost(realm, new URLSearchParams({ grant_type: 'password', service: SERVICE, scope: pull(repository) }), {
      Authorization: basic,
    })
    expect(claimsOf(viaHeader)).toMatchObject({ sub: `node:${node.id}`, access: [{ name: repository, actions: ['pull'] }] })

    // The orchestrator credential works the same way.
    const orchestrator = await registryTokenPost(
      realm,
      new URLSearchParams({
        grant_type: 'password',
        service: SERVICE,
        username: 'orchestrator',
        password: stackKeys().registryPushPassword(),
        scope: pull(repository),
      }),
    )
    expect(claimsOf(orchestrator)).toMatchObject({ sub: 'orchestrator', access: [{ name: repository, actions: ['pull'] }] })
  })
})

test.describe('granted access', () => {
  test('a node gets pull on the repositories of its own assignments only', { tag: ['@REG-003'] }, async ({ echo, nodes, realm, registry, scans, tasks }) => {
    test.setTimeout(180_000)
    const second = await tasks.example('echo')
    const n1 = await nodes.fake()
    const n2 = await nodes.fake()
    const idle = await nodes.fake()
    await Promise.all([n1.online(), n2.online(), idle.online()])
    await scanOn(scans, n1, echo)
    await scanOn(scans, n2, second)
    const a = taskRepository(echo.task.id)
    const b = taskRepository(second.task.id)

    const requested = [
      `repository:${a}:pull,push,delete,*`,
      pull(b),
      'registry:catalog:*',
      pull(taskRepository(randomUUID())),
      'repository:library/alpine:pull',
    ]
    const forN1 = claimsOf(await registryTokenGet(realm, nodeCredential(n1), { scopes: requested }))
    expect(forN1.access).toEqual([{ type: 'repository', name: a, actions: ['pull'] }])
    const forN2 = claimsOf(await registryTokenGet(realm, nodeCredential(n2), { scopes: requested }))
    expect(forN2.access).toEqual([{ type: 'repository', name: b, actions: ['pull'] }])
    const forIdle = claimsOf(await registryTokenGet(realm, nodeCredential(idle), { scopes: requested }))
    expect(forIdle.access).toEqual([])

    // Without a scope (docker login), the token grants nothing; both flows.
    expect(claimsOf(await registryTokenGet(realm, nodeCredential(n1))).access).toEqual([])
    expect(
      claimsOf(await registryTokenPost(realm, new URLSearchParams({ grant_type: 'password', service: SERVICE, username: 'node', password: n1.daemon.token })))
        .access,
    ).toEqual([])

    // The registry enforces the grant: N1's token pulls A but not B, and pushes nothing.
    const token = tokenOf(await registryTokenGet(realm, nodeCredential(n1), { scopes: [pull(a), pull(b)] }))
    expect((await headManifest(registry, a, echo.revision.image!.digest, token)).status).toBe(200)
    expect((await headManifest(registry, b, second.revision.image!.digest, token)).status).toBe(401)
    const push = await registry.post(`/v2/${a}/blobs/uploads/`, { headers: { Authorization: `Bearer ${token}` }, maxRedirects: 0 })
    expect(push.status()).toBe(401)
  })

  test(
    'the orchestrator credential gets push, delete and the catalog, which no node gets',
    { tag: ['@REG-004'] },
    async ({ echo, nodes, realm, registry, scans }) => {
      const repository = taskRepository(echo.task.id)
      const answer = await registryTokenGet(realm, orchestratorCredential(), {
        scopes: [`repository:${repository}:pull,push,delete`, 'registry:catalog:*', 'repository:library/alpine:pull,push', 'repository:other/thing:pull'],
      })
      const claims = claimsOf(answer)
      expect(claims.sub).toBe('orchestrator')
      expect(claims.access).toEqual([
        { type: 'repository', name: repository, actions: ['pull', 'push', 'delete'] },
        { type: 'registry', name: 'catalog', actions: ['*'] },
      ])

      // The catalog lists repositories in order: the entry after a prefix of A's name is A.
      const catalogToken = tokenOf(await registryTokenGet(realm, orchestratorCredential(), { scopes: ['registry:catalog:*'] }))
      const catalog = await registry.get(`/v2/_catalog?n=1&last=${encodeURIComponent(repository.slice(0, -1))}`, {
        headers: { Authorization: `Bearer ${catalogToken}` },
      })
      expect(catalog.status()).toBe(200)
      expect(((await catalog.json()) as { repositories: string[] }).repositories).toEqual([repository])

      // A node with assignments asks for the catalog and push in vain; the registry refuses its token for the catalog.
      const node = await nodes.fake()
      await node.online()
      await scanOn(scans, node, echo)
      const nodeClaims = claimsOf(
        await registryTokenGet(realm, nodeCredential(node), { scopes: ['registry:catalog:*', `repository:${repository}:push,delete`] }),
      )
      expect(nodeClaims.access).toEqual([])
      const nodeToken = tokenOf(await registryTokenGet(realm, nodeCredential(node), { scopes: ['registry:catalog:*', pull(repository)] }))
      expect((await registry.get('/v2/_catalog', { headers: { Authorization: `Bearer ${nodeToken}` } })).status()).toBe(401)
      expect((await registry.get('/v2/_catalog')).status()).toBe(401)
    },
  )
})

test.describe('errors', () => {
  test('errors use the registry format: 401, DENIED, UNSUPPORTED and SIZE_INVALID', { tag: ['@REG-005'] }, async ({ adminApi, echo, nodes, realm }) => {
    const repository = taskRepository(echo.task.id)
    const node = await nodes.fake()
    await node.online()
    const scopes = [pull(repository)]

    // Invalid credentials of every shape.
    const basicHeader = (value: string) => ({ Authorization: `Basic ${Buffer.from(value).toString('base64')}` })
    const unauthorized: [string, RegistryAnswer][] = [
      ['no credential', await registryTokenGet(realm, null, { scopes })],
      ['unknown node token', await registryTokenGet(realm, { username: 'node', password: `snt_${randomBytes(32).toString('base64url')}` }, { scopes })],
      ['node token under another user name', await registryTokenGet(realm, { username: 'admin', password: node.daemon.token }, { scopes })],
      ['wrong orchestrator password', await registryTokenGet(realm, { username: 'orchestrator', password: randomBytes(32).toString('base64url') }, { scopes })],
      [
        'an API key as the password',
        await registryTokenGet(realm, { username: 'node', password: `sk_scantor_${randomBytes(24).toString('base64url')}` }, { scopes }),
      ],
    ]
    const bearer = await realm.get(`/api/registry/token?service=${SERVICE}&scope=${encodeURIComponent(pull(repository))}`, {
      headers: { Authorization: `Bearer ${node.daemon.token}` },
    })
    const noColon = await realm.get(`/api/registry/token?service=${SERVICE}`, { headers: basicHeader(node.daemon.token) })
    for (const [label, response] of [
      ['a Bearer header', bearer],
      ['Basic without a colon', noColon],
    ] as const) {
      unauthorized.push([label, { status: response.status(), headers: response.headers(), body: (await response.json()) as Record<string, unknown> }])
    }
    unauthorized.push([
      'POST with a wrong password',
      await registryTokenPost(
        realm,
        new URLSearchParams({ grant_type: 'password', service: SERVICE, username: 'node', password: 'snt_wrong', scope: pull(repository) }),
      ),
    ])
    for (const [label, answer] of unauthorized) expectRegistryError(answer, 401, 'UNAUTHORIZED', label)

    // A revoked node: its token is refused at once.
    expect(claimsOf(await registryTokenGet(realm, nodeCredential(node), { scopes })).sub).toBe(`node:${node.id}`)
    await node.stopHeartbeat()
    expect((await adminApi.call('revokeNodeToken', { path: { nodeId: node.id } })).status).toBe(200)
    expectRegistryError(await registryTokenGet(realm, nodeCredential(node), { scopes }), 401, 'UNAUTHORIZED', 'revoked node')

    // Valid credentials, but an unknown service or an unsupported grant type.
    expectRegistryError(await registryTokenGet(realm, orchestratorCredential(), { service: 'docker-hub', scopes }), 400, 'DENIED', 'unknown service (GET)')
    const orchestratorForm = (extra: Record<string, string>) =>
      new URLSearchParams({ service: SERVICE, username: 'orchestrator', password: stackKeys().registryPushPassword(), scope: pull(repository), ...extra })
    expectRegistryError(await registryTokenPost(realm, orchestratorForm({ grant_type: 'password', service: 'other' })), 400, 'DENIED', 'unknown service (POST)')
    for (const grant of ['client_credentials', 'refresh_token', 'authorization_code']) {
      expectRegistryError(await registryTokenPost(realm, orchestratorForm({ grant_type: grant })), 400, 'UNSUPPORTED', `grant_type ${grant}`)
    }

    // A form over 64 KiB, even with a valid credential.
    const padded = Buffer.from(`${orchestratorForm({ grant_type: 'password' }).toString()}&pad=${'a'.repeat(64 * 1024)}`)
    expect(padded.length).toBeGreaterThan(64 * 1024)
    expectRegistryError(await registryTokenPost(realm, padded), 400, 'SIZE_INVALID', 'oversized form')
    // Just below the cap the same form is answered normally.
    const fitting = Buffer.from(`${orchestratorForm({ grant_type: 'password' }).toString()}&pad=${'a'.repeat(60 * 1024)}`)
    expect(claimsOf(await registryTokenPost(realm, fitting)).sub).toBe('orchestrator')
  })
})

test.describe('grant lifetime', () => {
  test('the grant ends with the scan', { tag: ['@REG-006'] }, async ({ api, echo, nodes, realm, scans }) => {
    const node = await nodes.fake()
    await node.online()
    const scanId = await scanOn(scans, node, echo)
    const repository = taskRepository(echo.task.id)
    const granted = () => registryTokenGet(realm, nodeCredential(node), { scopes: [pull(repository)] }).then(claimsOf)
    expect((await granted()).access).toEqual([{ type: 'repository', name: repository, actions: ['pull'] }])

    // Cancel: the workers leave the desired set; once the node reports their containers removed they are stopped.
    ok(await api.cancelScan(scanId), 'cancelScan')
    for (const workerId of [...node.reports.keys()]) node.reports.set(workerId, { workerId, state: 'removed' })
    await expect
      .poll(
        async () => {
          await node.report()
          return (await workersOf(api, scanId)).map((worker) => worker.state)
        },
        { timeout: 60_000, message: 'the cancelled scan stops its workers' },
      )
      .toEqual(['stopped', 'stopped'])
    expect((await granted()).access).toEqual([])
  })

  test(
    'the grant ends when the worker is lost and the credential ends with a revoke',
    { tag: ['@REG-006'] },
    async ({ adminApi, api, echo, nodes, realm, scans }) => {
      const node = await nodes.fake()
      await node.online()
      const scanId = await scanOn(scans, node, echo)
      const repository = taskRepository(echo.task.id)
      const answer = () => registryTokenGet(realm, nodeCredential(node), { scopes: [pull(repository)] })
      expect(claimsOf(await answer()).access).toEqual([{ type: 'repository', name: repository, actions: ['pull'] }])

      // The daemon goes silent: after SCANTOR_NODE_OFFLINE_AFTER the node is offline and its workers are lost, while its
      // token stays valid; the next token no longer grants the pull.
      await node.stopHeartbeat()
      await expect
        .poll(async () => (await workersOf(api, scanId)).filter((worker) => worker.nodeId === node.id).map((worker) => worker.state), {
          timeout: 120_000,
          intervals: [2000, 5000],
          message: 'the silent node loses its workers',
        })
        .toEqual(['lost', 'lost'])
      const afterLoss = await answer()
      expect(claimsOf(afterLoss)).toMatchObject({ sub: `node:${node.id}`, access: [] })

      // A revoked node gets no token at all.
      expect((await adminApi.call('revokeNodeToken', { path: { nodeId: node.id } })).status).toBe(200)
      expectRegistryError(await answer(), 401, 'UNAUTHORIZED', 'revoked node')
    },
  )
})
