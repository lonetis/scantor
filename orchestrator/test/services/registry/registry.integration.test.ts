import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createRouter, defineEventHandler, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registryGcLastSuccess, runRegistryGc } from '../../../server/services/registry/gc'
import { handleRegistryTokenEvent } from '../../../server/services/registry/handler'
import { registryJwks } from '../../../server/services/registry/jwt'
import type { RegistryAccess } from '../../../server/services/registry/scopes'
import { issueRegistryToken, type RegistryTokenDeps } from '../../../server/services/registry/token'
import type { JobDoc, LockDoc } from '../../../server/types/documents'
import { createKeyring } from '../../../server/utils/keys'
import { FakeCollection } from '../../helpers/fake-collection'
import {
  ALPINE_IMAGE,
  discoverEnvironment,
  type Environment,
  integrationEnabled,
  NODE_IMAGE,
  REGISTRY_IMAGE,
  requireImages,
  startLoopbackForwarder,
  TestContainers,
  waitFor,
} from '../nodes/integration'
import { recordingLogger } from '../nodes/helpers'

/*
 * The registry token flow end to end (docs/api.md §6, docs/auth.md §10.4, docs/nodes.md §10, security.md MC-5,
 * MC-8): a real registry:3.1.2 configured like docker-compose.prod.yml with the JWKS of the derived signing key, the
 * token realm served by the same handler as /api/registry/token, and the host's Docker daemon pushing and pulling
 * with per-call X-Registry-Auth credentials, exactly like the build pipeline and the node daemon:
 *
 *   - the orchestrator credential pushes task images, lists the catalog and deletes manifests;
 *   - a node pulls the repository of its assignment and nothing else, and can never push;
 *   - an unknown or revoked node token is refused by the realm.
 *
 * Runs only inside a container with the Docker socket (see ../nodes/integration.ts). The registry runs in the Docker
 * host's network namespace and the realm is forwarded to this container from the host's loopback, so the daemon
 * reaches both over loopback, which it never sends through an HTTP proxy.
 */

const keys = createKeyring('registry integration test secret')
const NODE_1 = randomUUID()
const NODE_1_TOKEN = `snt_${'n'.repeat(43)}`
const REVOKED_TOKEN = `snt_${'r'.repeat(43)}`
const TASK_A = `tasks/${randomUUID()}`
const TASK_B = `tasks/${randomUUID()}`

interface Issued {
  subject: string
  access: RegistryAccess[]
}

describe.skipIf(!integrationEnabled)('registry token flow against registry:3.1.2', () => {
  let env: Environment
  let containers: TestContainers
  let server: Server
  /** the realm as configured in the registry and called by the Docker daemon (through the loopback forwarder) */
  let realm: string
  /** the same endpoint as this container serves it */
  let serverUrl: string
  let registryName: string
  /** registry host for the Docker daemon: its own loopback (plain HTTP is allowed there) */
  let registryHost: string
  /** registry URL for this process: the container on the shared network */
  let registryUrl: string
  const issued: Issued[] = []
  const flows: string[] = []
  const localTags: string[] = []
  const digests: Record<string, string> = {}

  const deps: RegistryTokenDeps = {
    signingKey: () => keys.registrySigningKey(),
    orchestratorPassword: () => keys.registryPushPassword(),
    nodeOf: async (token) => (token === NODE_1_TOKEN ? NODE_1 : null),
    nodeRepositories: async (nodeId) => new Set(nodeId === NODE_1 ? [TASK_A] : []),
  }

  beforeAll(async () => {
    env = await discoverEnvironment()
    await requireImages(env.docker, [REGISTRY_IMAGE, ALPINE_IMAGE, NODE_IMAGE])
    containers = new TestContainers(env)

    const log = recordingLogger()
    const router = createRouter()
    const handle = (flow: 'get' | 'post') =>
      defineEventHandler(async (event) => {
        flows.push(flow)
        const body = await handleRegistryTokenEvent(event, flow, deps, log)
        const token = typeof body.access_token === 'string' ? body.access_token : null
        if (token) {
          const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sub: string; access: RegistryAccess[] }
          issued.push({ subject: claims.sub, access: claims.access })
        }
        return body
      })
    router.get('/api/registry/token', handle('get'))
    router.post('/api/registry/token', handle('post'))
    const app = createApp()
    app.use(router)
    server = createServer(toNodeListener(app))
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
    serverUrl = `http://${env.ownAddress}:${(server.address() as AddressInfo).port}/api/registry/token`
    const realmPort = await startLoopbackForwarder(containers, 'realm', { host: env.ownAddress, port: (server.address() as AddressInfo).port })
    realm = `http://127.0.0.1:${realmPort}/api/registry/token`

    // The registry runs in the Docker host's network namespace: the daemon pushes and pulls over its own loopback
    // (plain HTTP is allowed there), and this container reaches it through the network gateway.
    const port = 40_000 + Math.floor(Math.random() * 10_000)
    const jwks = JSON.stringify(registryJwks(keys.registrySigningKey()))
    const registry = await containers.run('registry', {
      Image: REGISTRY_IMAGE,
      Entrypoint: ['sh', '-c', 'mkdir -p /run/scantor/registry-auth && printf "%s" "$JWKS" > /run/scantor/registry-auth/jwks.json && exec /entrypoint.sh /etc/distribution/config.yml'],
      HostConfig: { NetworkMode: 'host' },
      Env: [
        `JWKS=${jwks}`,
        `REGISTRY_HTTP_ADDR=:${port}`,
        `REGISTRY_HTTP_DEBUG_ADDR=127.0.0.1:${port + 1}`,
        `REGISTRY_HTTP_SECRET=${keys.registryHttpSecret()}`,
        'OTEL_TRACES_EXPORTER=none',
        'REGISTRY_LOG_LEVEL=info',
        'REGISTRY_HTTP_RELATIVEURLS=true',
        'REGISTRY_STORAGE_DELETE_ENABLED=true',
        `REGISTRY_AUTH_TOKEN_REALM=${realm}`,
        'REGISTRY_AUTH_TOKEN_SERVICE=scantor-registry',
        'REGISTRY_AUTH_TOKEN_ISSUER=scantor',
        'REGISTRY_AUTH_TOKEN_JWKS=/run/scantor/registry-auth/jwks.json',
      ],
    })
    registryName = registry.name
    registryHost = `127.0.0.1:${port}`
    registryUrl = `http://${env.gateway}:${port}`
    await waitFor('the registry', async () => (await fetch(`${registryUrl}/v2/`)).status === 401, 60_000, 500)
  }, 180_000)

  afterAll(async () => {
    for (const tag of localTags) await env?.docker.getImage(tag).remove().catch(() => undefined)
    await containers?.removeAll()
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  })

  function authconfig(username: string, password: string) {
    return { username, password, serveraddress: registryHost }
  }

  /** Runs a pull or push stream to its end; returns its error message or null, and the pushed manifest digest. */
  async function follow(stream: NodeJS.ReadableStream): Promise<{ error: string | null; digest: string | null }> {
    const events = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      env.docker.modem.followProgress(stream, (error: Error | null, output: Record<string, unknown>[]) => (error ? reject(error) : resolve(output)))
    })
    const failure = events.find((event) => event.error || event.errorDetail)
    // The classic store reports {aux: {Digest}}; the containerd store a status line "<tag>: digest: sha256:… size: …".
    const digests = events.flatMap((event) => {
      const aux = (event.aux as { Digest?: string } | undefined)?.Digest
      const status = /digest: (sha256:[0-9a-f]{64})/.exec(String(event.status ?? ''))?.[1]
      return [aux, status].filter((value): value is string => Boolean(value))
    })
    return { error: failure ? String(failure.error ?? JSON.stringify(failure.errorDetail)) : null, digest: digests[0] ?? null }
  }

  async function push(repository: string, username: string, password: string, tagName = 'r1') {
    const tag = `${registryHost}/${repository}:${tagName}`
    await env.docker.getImage(ALPINE_IMAGE).tag({ repo: `${registryHost}/${repository}`, tag: tagName })
    localTags.push(tag)
    return follow(await env.docker.getImage(tag).push({ authconfig: authconfig(username, password) }))
  }

  async function pull(reference: string, username: string, password: string) {
    try {
      return await follow(await (env.docker.pull(reference, { authconfig: authconfig(username, password) }) as Promise<NodeJS.ReadableStream>))
    } catch (error) {
      return { error: (error as Error).message, digest: null }
    }
  }

  async function removeLocal(reference: string): Promise<void> {
    await env.docker.getImage(reference).remove({ noprune: false }).catch(() => undefined)
  }

  async function tokenFor(username: string, password: string, scopes: string[]): Promise<string> {
    const outcome = await issueRegistryToken({ credential: { username, password }, service: 'scantor-registry', scopes, grantType: null }, deps)
    if (outcome.status !== 200) throw new Error(`token request failed with ${outcome.status}`)
    return String(outcome.body.token)
  }

  const manifestAccept = 'application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json'

  it('challenges anonymous requests with the realm and service', async () => {
    const response = await fetch(`${registryUrl}/v2/`)
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe(`Bearer realm="${realm}",service="scantor-registry"`)
  })

  it('serves both token flows over HTTP', async () => {
    const form = new URLSearchParams({ grant_type: 'password', service: 'scantor-registry', username: 'node', password: NODE_1_TOKEN, scope: `repository:${TASK_A}:pull` })
    const posted = await fetch(serverUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(5000) })
    expect(posted.status).toBe(200)
    expect(await posted.json()).toEqual({ access_token: expect.any(String), expires_in: 300, issued_at: expect.any(String) })
    const basic = `Basic ${Buffer.from(`node:${NODE_1_TOKEN}`).toString('base64')}`
    const got = await fetch(`${serverUrl}?service=scantor-registry&scope=repository:${TASK_A}:pull`, { headers: { authorization: basic }, signal: AbortSignal.timeout(5000) })
    expect(got.status).toBe(200)
    expect(got.headers.get('cache-control')).toBe('no-store')
    const refused = await fetch(serverUrl, { headers: { authorization: `Basic ${Buffer.from(`node:${REVOKED_TOKEN}`).toString('base64')}` }, signal: AbortSignal.timeout(5000) })
    expect(refused.status).toBe(401)
    expect(await refused.json()).toEqual({ errors: [{ code: 'UNAUTHORIZED', message: expect.any(String) }] })
  })

  it('pushes task images with the orchestrator credential through the Docker daemon', async () => {
    const before = flows.length
    for (const repository of [TASK_A, TASK_B]) {
      const result = await push(repository, 'orchestrator', keys.registryPushPassword())
      expect(result.error, repository).toBeNull()
      expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
      digests[repository] = result.digest!
    }
    // The daemon called the realm (containerd's image store uses the POST flow, the classic store GET).
    expect(flows.length).toBeGreaterThan(before)
    expect(issued.some((entry) => entry.subject === 'orchestrator' && entry.access.some((access) => access.name === TASK_A && access.actions.includes('push')))).toBe(true)
  }, 120_000)

  it('lets a node pull the repository of its assignment by digest', async () => {
    const reference = `${registryHost}/${TASK_A}@${digests[TASK_A]}`
    await removeLocal(`${registryHost}/${TASK_A}:r1`)
    await removeLocal(reference)
    issued.length = 0
    const result = await pull(reference, 'node', NODE_1_TOKEN)
    expect(result.error).toBeNull()
    localTags.push(reference)
    expect(issued).toContainEqual({ subject: `node:${NODE_1}`, access: [{ type: 'repository', name: TASK_A, actions: ['pull'] }] })
  }, 120_000)

  it('refuses a node pull of a repository that is not assigned to it', async () => {
    const reference = `${registryHost}/${TASK_B}@${digests[TASK_B]}`
    await removeLocal(`${registryHost}/${TASK_B}:r1`)
    await removeLocal(reference)
    issued.length = 0
    const result = await pull(reference, 'node', NODE_1_TOKEN)
    expect(result.error).toMatch(/denied|insufficient_scope|unauthorized|authorization failed|401|403/i)
    // The realm answered, but the token omitted the repository.
    expect(issued.filter((entry) => entry.subject === `node:${NODE_1}`).flatMap((entry) => entry.access)).toEqual([])
  }, 120_000)

  it('never lets a node push, not even a new tag of its own repository', async () => {
    const ownRepository = await push(TASK_A, 'node', NODE_1_TOKEN, 'from-node')
    expect(ownRepository.error).toMatch(/denied|insufficient_scope|unauthorized|authorization failed|401|403/i)
    const otherRepository = await push(`tasks/${randomUUID()}`, 'node', NODE_1_TOKEN)
    expect(otherRepository.error).toMatch(/denied|insufficient_scope|unauthorized|authorization failed|401|403/i)
  }, 120_000)

  it('refuses unknown or revoked node tokens at the realm', async () => {
    const reference = `${registryHost}/${TASK_A}@${digests[TASK_A]}`
    await removeLocal(reference)
    const result = await pull(reference, 'node', REVOKED_TOKEN)
    expect(result.error).toMatch(/denied|unauthorized|authorization failed|401/i)
  }, 120_000)

  it('scopes node tokens to their repositories on the registry API', async () => {
    const token = await tokenFor('node', NODE_1_TOKEN, [`repository:${TASK_A}:pull`, `repository:${TASK_B}:pull`])
    const headers = { authorization: `Bearer ${token}`, accept: manifestAccept }
    expect((await fetch(`${registryUrl}/v2/${TASK_A}/manifests/${digests[TASK_A]}`, { headers })).status).toBe(200)
    const denied = await fetch(`${registryUrl}/v2/${TASK_B}/manifests/${digests[TASK_B]}`, { headers })
    expect(denied.status).toBe(401)
    expect(denied.headers.get('www-authenticate')).toContain('insufficient_scope')
    const catalog = await fetch(`${registryUrl}/v2/_catalog`, { headers: { authorization: `Bearer ${await tokenFor('node', NODE_1_TOKEN, ['registry:catalog:*'])}` } })
    expect(catalog.status).toBe(401)
  })

  it('gives the orchestrator credential the catalog and manifest deletion', async () => {
    const catalogToken = await tokenFor('orchestrator', keys.registryPushPassword(), ['registry:catalog:*'])
    const catalog = await fetch(`${registryUrl}/v2/_catalog`, { headers: { authorization: `Bearer ${catalogToken}` } })
    expect(catalog.status).toBe(200)
    expect(((await catalog.json()) as { repositories: string[] }).repositories).toEqual(expect.arrayContaining([TASK_A, TASK_B]))

    const deleteToken = await tokenFor('orchestrator', keys.registryPushPassword(), [`repository:${TASK_B}:pull,delete`])
    const headers = { authorization: `Bearer ${deleteToken}`, accept: manifestAccept }
    expect((await fetch(`${registryUrl}/v2/${TASK_B}/manifests/${digests[TASK_B]}`, { method: 'DELETE', headers })).status).toBe(202)
    expect((await fetch(`${registryUrl}/v2/${TASK_B}/manifests/${digests[TASK_B]}`, { headers })).status).toBe(404)
  })

  it('collects garbage in the registry under the registryGc lock', async () => {
    const locks = new FakeCollection<LockDoc>('locks')
    const jobs = new FakeCollection<JobDoc>('jobs')
    const result = await runRegistryGc({ locks: locks.asCollection(), jobs: jobs.asCollection(), log: recordingLogger(), signal: new AbortController().signal, container: registryName })
    expect(result).toBe('collected')
    expect(registryGcLastSuccess()).toBeInstanceOf(Date)
    expect(locks.docs).toEqual([])
    // The remaining repository is intact after the collection.
    const token = await tokenFor('node', NODE_1_TOKEN, [`repository:${TASK_A}:pull`])
    expect((await fetch(`${registryUrl}/v2/${TASK_A}/manifests/${digests[TASK_A]}`, { headers: { authorization: `Bearer ${token}`, accept: manifestAccept } })).status).toBe(200)
  }, 120_000)
})
