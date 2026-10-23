import { parse as parseYaml } from 'yaml'
import type { Event } from '#shared/types/events'
import type { InstanceInfo } from '#shared/types/instance'
import type { Node, NodeJoin, NodeWithToken } from '#shared/types/nodes'
import { ok } from '../helpers/api-client'
import { NodeTracker } from '../helpers/api-platform-nodes'
import { withPlatformAdmin, withWorkerTenant } from '../helpers/api-platform-tenant'
import { temporaryApiKey } from '../helpers/api-platform-users'
import { scantor } from '../helpers/cli'
import { stackEnv } from '../helpers/docker'
import { expect, test as base, unique } from '../fixtures'

// Node administration (docs/api.md §4.17, docs/nodes.md §4): listing, creating, joining, updating, rotating and
// revoking nodes as the admin. Every node a test creates is deleted by the `nodes` fixture; the built-in node and
// remote-1 are shared and only read (requests against the built-in node are either refused or repeat its current
// values).

const test = base.extend<{ nodes: NodeTracker }>({
  // An admin of the worker and a tenant with a uniquely named session (helpers/api-platform-tenant.ts).
  adminApi: [async ({ openapi }, use) => withPlatformAdmin(openapi, use), { scope: 'worker', timeout: 150_000 }],
  user: [
    async ({ adminApi, openapi }, use, workerInfo) => withWorkerTenant(adminApi, openapi, `w${workerInfo.workerIndex}`, use),
    { scope: 'worker', timeout: 150_000 },
  ],
  nodes: async ({ adminApi, openapi }, use) => {
    const tracker = new NodeTracker(adminApi, openapi)
    await use(tracker)
    await tracker.dispose()
  },
})

const TOKEN_PATTERN = /^snt_[A-Za-z0-9_-]{43}$/

function issuePaths(body: unknown): string[] {
  const issues = (body as { error?: { details?: { issues?: { path: string }[] } } }).error?.details?.issues ?? []
  return issues.map((issue) => String(issue.path))
}

test.describe('listing nodes', () => {
  test('lists the built-in node first, the others by name, and never their secrets', { tag: ['@NODE-001'] }, async ({ adminApi, api, nodes }) => {
    const pool = unique('pool-list')
    const base = unique('list')
    const second = ok(await nodes.create({ name: `${base}-b`, pool, labels: { zone: 'b' } }), 'createNode')
    const first = ok(await nodes.create({ name: `${base}-a`, pool }), 'createNode')

    const all = ok(await adminApi.listNodes(), 'listNodes').items
    expect(all[0]?.builtIn, 'the built-in node comes first').toBe(true)
    const others = all.slice(1).map((node) => node.name)
    expect(others).toEqual([...others].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    for (const node of all) {
      expect(node).toEqual(
        expect.objectContaining({
          state: expect.any(String),
          pool: expect.any(String),
          labels: expect.any(Object),
          cordoned: expect.any(Boolean),
          activeWorkers: expect.any(Number),
        }),
      )
      expect(node).toHaveProperty('maxWorkers')
      expect(node).toHaveProperty('info')
      expect(node).not.toHaveProperty('tokenHash')
      if (node.instance) expect(Object.keys(node.instance).sort()).toEqual(['lastSeenAt', 'startedAt', 'version'])
    }

    const builtin = all[0]!
    expect(builtin.info).toEqual(
      expect.objectContaining({
        os: expect.any(String),
        arch: expect.any(String),
        cpus: expect.any(Number),
        memoryBytes: expect.any(Number),
        diskFreeBytes: expect.any(Number),
        maxWorkers: expect.any(Number),
        egressDenyApplied: expect.any(Boolean),
        dindMode: expect.stringMatching(/^(disabled|sysbox|privileged)$/),
      }),
    )

    // Filters: by pool (only this test's nodes, sorted by name), by state within the pool.
    const inPool = ok(await adminApi.listNodes({ pool }), 'listNodes').items
    expect(inPool.map((node) => node.id)).toEqual([first.node.id, second.node.id])
    expect(inPool[1]!.labels).toEqual({ zone: 'b' })
    expect(ok(await adminApi.listNodes({ pool, state: 'pending' }), 'listNodes').items).toHaveLength(2)
    expect(ok(await adminApi.listNodes({ pool, state: 'online' }), 'listNodes').items).toEqual([])
    const pending = ok(await adminApi.listNodes({ state: 'pending' }), 'listNodes').items
    expect(pending.every((node) => node.state === 'pending')).toBe(true)

    // An online node shows its reported info and lease, but neither the token hash nor the instance id.
    const fake = await nodes.fake({ pool })
    await fake.online()
    const online = ok(await adminApi.listNodes({ pool, state: 'online' }), 'listNodes').items
    expect(online.map((node) => node.id)).toEqual([fake.id])
    expect(online[0]!.info).toEqual(expect.objectContaining({ os: fake.info.os, arch: fake.info.arch, cpus: 8, maxWorkers: 8, egressDenyApplied: true }))
    expect(online[0]!.instance).not.toBeNull()
    const serialized = JSON.stringify(online)
    expect(serialized).not.toContain(fake.daemon.instanceId)
    expect(serialized).not.toContain(fake.daemon.engineId)
    expect(serialized).not.toContain('tokenHash')

    const denied = await api.listNodes()
    expect(denied.status).toBe(403)
    expect(denied.body).toMatchObject({ error: { code: 'adminRequired' } })
  })
})

test.describe('creating nodes', () => {
  test('creates a pending node in pool shared whose token is shown only once', { tag: ['@NODE-002'] }, async ({ adminApi, api, nodes }) => {
    const name = unique('create')
    const response = await nodes.create({ name })
    expect(response.status).toBe(201)
    const created = response.body
    expect(created.node).toMatchObject({
      name,
      builtIn: false,
      state: 'pending',
      pool: 'shared',
      labels: {},
      maxWorkers: null,
      cordoned: false,
      endpointProfile: 'public',
    })
    expect(created.token).toMatch(TOKEN_PATTERN)
    expect(created.node.tokenPrefix).toBe(created.token.slice(0, 8))
    expect(created.join.env.SCANTOR_NODE_TOKEN).toBe(created.token)

    // No later read returns the token again.
    const node = ok(await adminApi.call<Node>('getNode', { path: { nodeId: created.node.id } }), 'getNode')
    const join = ok(await adminApi.call<NodeJoin>('getNodeJoin', { path: { nodeId: created.node.id } }), 'getNodeJoin')
    const listed = ok(await adminApi.listNodes(), 'listNodes')
    for (const later of [node, join, listed]) expect(JSON.stringify(later)).not.toContain(created.token)

    const custom = ok(
      await nodes.create({ name: unique('create-custom'), pool: unique('pool'), labels: { region: 'eu', 'disk.type': 'ssd' }, maxWorkers: 4 }),
      'createNode',
    )
    expect(custom.node).toMatchObject({ labels: { region: 'eu', 'disk.type': 'ssd' }, maxWorkers: 4, state: 'pending' })
    expect(custom.token).not.toBe(created.token)

    const denied = await api.createNode({ name: unique('create-denied') })
    expect(denied.status).toBe(403)
    expect(denied.body).toMatchObject({ error: { code: 'adminRequired' } })
  })

  test('rejects reserved, duplicate and malformed names and oversized labels', { tag: ['@NODE-003'] }, async ({ nodes }) => {
    const builtin = await nodes.create({ name: 'builtin' })
    expect(builtin.status).toBe(400)
    expect(builtin.body).toMatchObject({ error: { code: 'validationFailed' } })
    expect(issuePaths(builtin.body)).toContain('name')

    const name = unique('dup')
    expect((await nodes.create({ name })).status).toBe(201)
    const duplicate = await nodes.create({ name })
    expect(duplicate.status).toBe(409)
    expect(duplicate.body).toMatchObject({ error: { code: 'alreadyExists' } })

    for (const bad of ['Upper-Case', 'under_score', '-leading', 'trailing-', 'x'.repeat(65)]) {
      const response = await nodes.create({ name: bad })
      expect(response.status, bad).toBe(400)
      expect(response.body, bad).toMatchObject({ error: { code: 'validationFailed' } })
    }

    const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v']))
    const badKey = { 'Not A Key': 'v' }
    const longValue = { region: 'x'.repeat(64) }
    for (const labels of [tooMany, badKey, longValue]) {
      const response = await nodes.create({ name: unique('labels'), labels })
      expect(response.status, JSON.stringify(labels).slice(0, 60)).toBe(400)
      expect(response.body).toMatchObject({ error: { code: 'validationFailed' } })
    }

    // The limits themselves are allowed: 32 keys with values of 63 characters.
    const atLimit = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`key-${i}`, 'v'.repeat(63)]))
    const accepted = await nodes.create({ name: unique('labels-max'), pool: unique('pool'), labels: atLimit })
    expect(accepted.status).toBe(201)
    expect(Object.keys(accepted.body.node.labels)).toHaveLength(32)
  })
})

test.describe('join instructions', () => {
  test('the join snippet runs the daemon image with the public URL and the new token', { tag: ['@NODE-004'] }, async ({ adminApi, env, nodes }) => {
    const created = ok(await nodes.create({ name: unique('join'), pool: unique('pool') }), 'createNode')
    const stack = stackEnv()
    const info = ok(await adminApi.call<InstanceInfo>('getInstanceInfo'), 'getInstanceInfo')
    const tag = /^\d+\.\d+\.\d+$/.test(info.version) ? info.version : stack.SCANTOR_IMAGE_TAG
    const image = `${stack.SCANTOR_IMAGE_PREFIX ?? ''}scantor:${tag}`
    expect(image).toBe(info.cliImage)

    expect(created.join.dockerRun).toBe(
      'docker run -d --name scantor-node --restart unless-stopped -v /var/run/docker.sock:/var/run/docker.sock ' +
        `-e SCANTOR_URL=${env.publicUrl} -e SCANTOR_NODE_TOKEN=${created.token} ${image} node`,
    )
    expect(created.join.env).toEqual({ SCANTOR_URL: env.publicUrl, SCANTOR_NODE_TOKEN: created.token })

    const compose = parseYaml(created.join.compose) as {
      services: Record<string, { image: string; command: string[]; environment: string[]; volumes: string[] }>
    }
    const services = Object.values(compose.services)
    expect(services).toHaveLength(1)
    const service = services[0]!
    expect(service.image).toBe(image)
    expect(service.command).toEqual(['node'])
    expect(service.environment).toEqual(expect.arrayContaining([`SCANTOR_URL=${env.publicUrl}`, `SCANTOR_NODE_TOKEN=${created.token}`]))
    expect(service.volumes).toContain('/var/run/docker.sock:/var/run/docker.sock')
  })

  test('the join instructions of an existing node carry a token placeholder', { tag: ['@NODE-005'] }, async ({ adminApi, env, nodes }) => {
    const created = ok(await nodes.create({ name: unique('join-get'), pool: unique('pool') }), 'createNode')
    const join = ok(await adminApi.call<NodeJoin>('getNodeJoin', { path: { nodeId: created.node.id } }), 'getNodeJoin')
    expect(join.env).toEqual({ SCANTOR_URL: env.publicUrl, SCANTOR_NODE_TOKEN: '${SCANTOR_NODE_TOKEN}' })
    expect(join.dockerRun).toBe(created.join.dockerRun.replace(created.token, '${SCANTOR_NODE_TOKEN}'))
    expect(join.compose).toBe(created.join.compose.replace(created.token, '${SCANTOR_NODE_TOKEN}'))
    expect(JSON.stringify(join)).not.toContain(created.token)

    const missing = await adminApi.call('getNodeJoin', { path: { nodeId: '00000000-0000-4000-8000-000000000000' } })
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ error: { code: 'notFound' } })
  })
})

test.describe('updating nodes', () => {
  test('changes name, pool, labels, worker cap and cordon; validates the body', { tag: ['@NODE-006'] }, async ({ adminApi, nodes }) => {
    const created = ok(await nodes.create({ name: unique('update'), pool: unique('pool'), maxWorkers: 3 }), 'createNode')
    const other = ok(await nodes.create({ name: unique('update-other'), pool: unique('pool') }), 'createNode')
    const nodeId = created.node.id
    const update = (body: unknown) => adminApi.call<Node>('updateNode', { path: { nodeId }, body })

    const renamed = unique('renamed')
    const pool = unique('pool-new')
    const updated = ok(await update({ name: renamed, pool, labels: { tier: 'gold' }, maxWorkers: 7, cordoned: true }), 'updateNode')
    expect(updated).toMatchObject({ id: nodeId, name: renamed, pool, labels: { tier: 'gold' }, maxWorkers: 7, cordoned: true })
    expect(ok(await adminApi.call<Node>('getNode', { path: { nodeId } }), 'getNode')).toMatchObject({ name: renamed, pool, maxWorkers: 7, cordoned: true })

    const uncapped = ok(await update({ maxWorkers: null, cordoned: false }), 'updateNode')
    expect(uncapped).toMatchObject({ maxWorkers: null, cordoned: false, name: renamed, labels: { tier: 'gold' } })

    const empty = await update({})
    expect(empty.status).toBe(400)
    expect(empty.body).toMatchObject({ error: { code: 'validationFailed' } })

    const taken = await update({ name: other.node.name })
    expect(taken.status).toBe(409)
    expect(taken.body).toMatchObject({ error: { code: 'alreadyExists' } })

    const reserved = await update({ name: 'builtin' })
    expect(reserved.status).toBe(400)
    expect(reserved.body).toMatchObject({ error: { code: 'validationFailed' } })

    const unknown = await adminApi.call('updateNode', { path: { nodeId: '00000000-0000-4000-8000-000000000000' }, body: { cordoned: true } })
    expect(unknown.status).toBe(404)
  })

  test('the built-in node keeps its name but accepts its other attributes', { tag: ['@NODE-006'] }, async ({ adminApi }) => {
    const builtin = ok(await adminApi.listNodes(), 'listNodes').items.find((node) => node.builtIn)!
    const rename = await adminApi.call('updateNode', { path: { nodeId: builtin.id }, body: { name: unique('not-builtin') } })
    expect(rename.status).toBe(409)
    expect(rename.body).toMatchObject({ error: { code: 'builtInNode' } })

    // The shared built-in node must not change: the other attributes are accepted with their current values.
    const same = { pool: builtin.pool, labels: builtin.labels, maxWorkers: builtin.maxWorkers, cordoned: builtin.cordoned }
    const accepted = ok(await adminApi.call<Node>('updateNode', { path: { nodeId: builtin.id }, body: same }), 'updateNode')
    expect(accepted).toMatchObject({ name: builtin.name, ...same })
  })
})

test.describe('node tokens', () => {
  test('rotating replaces the token at once and brings a revoked node back to pending', { tag: ['@NODE-008'] }, async ({ adminApi, nodes }) => {
    const fake = await nodes.fake()
    await fake.online()
    const oldToken = fake.daemon.token

    const rotated = await adminApi.call<NodeWithToken>('rotateNodeToken', { path: { nodeId: fake.id } })
    expect(rotated.status).toBe(200)
    expect(rotated.body.token).toMatch(TOKEN_PATTERN)
    expect(rotated.body.token).not.toBe(oldToken)
    expect(rotated.body.node.id).toBe(fake.id)
    expect(rotated.body.node.tokenPrefix).toBe(rotated.body.token.slice(0, 8))
    expect(rotated.body.node.tokenRotatedAt).not.toBeNull()
    expect(rotated.body.join.env.SCANTOR_NODE_TOKEN).toBe(rotated.body.token)
    expect(rotated.body.join.dockerRun).toContain(`-e SCANTOR_NODE_TOKEN=${rotated.body.token} `)
    await fake.stopHeartbeat()

    // The old token is refused on every node route; the new one joins at once.
    for (const response of [await fake.daemon.hello(fake.info), await fake.daemon.status(fake.info, []), await fake.daemon.assignments()]) {
      expect(response.status).toBe(401)
      expect(response.body).toMatchObject({ error: { code: 'unauthorized' } })
    }
    fake.daemon.token = rotated.body.token
    expect((await fake.daemon.hello(fake.info)).status).toBe(200)

    const events = ok(
      await adminApi.call<{ items: Event[] }>('listNodeEvents', { path: { nodeId: fake.id }, query: { type: 'node.tokenRotated' } }),
      'listNodeEvents',
    )
    expect(events.items).toHaveLength(1)
    expect(events.items[0]).toMatchObject({ type: 'node.tokenRotated', nodeId: fake.id })

    // A revoked node returns to pending with a fresh token.
    const revoked = ok(await adminApi.call<Node>('revokeNodeToken', { path: { nodeId: fake.id } }), 'revokeNodeToken')
    expect(revoked.state).toBe('revoked')
    const back = ok(await adminApi.call<NodeWithToken>('rotateNodeToken', { path: { nodeId: fake.id } }), 'rotateNodeToken')
    expect(back.node.state).toBe('pending')
    fake.daemon.token = back.token
    const hello = await fake.daemon.hello(fake.info)
    expect(hello.status).toBe(200)
    expect(ok(await adminApi.call<Node>('getNode', { path: { nodeId: fake.id } }), 'getNode').state).toBe('online')
    expect(
      ok(await adminApi.call<{ items: Event[] }>('listNodeEvents', { path: { nodeId: fake.id }, query: { type: 'node.tokenRotated' } }), 'listNodeEvents')
        .items,
    ).toHaveLength(2)
  })
})

test.describe('the built-in node', () => {
  test('cannot be rotated, revoked or deleted', { tag: ['@NODE-010'] }, async ({ adminApi }) => {
    const builtin = ok(await adminApi.listNodes(), 'listNodes').items.find((node) => node.builtIn)!
    for (const operationId of ['rotateNodeToken', 'revokeNodeToken', 'deleteNode']) {
      const response = await adminApi.call(operationId, { path: { nodeId: builtin.id } })
      expect(response.status, operationId).toBe(409)
      expect(response.body, operationId).toMatchObject({ error: { code: 'builtInNode' } })
    }
    const after = ok(await adminApi.call<Node>('getNode', { path: { nodeId: builtin.id } }), 'getNode')
    expect(after).toMatchObject({ state: 'online', tokenRotatedAt: builtin.tokenRotatedAt })
  })

  test('scantor nodes exits 2 for rotate, revoke and delete of the built-in node', { tag: ['@NODE-010'] }, async ({ adminApi }) => {
    const key = await temporaryApiKey(adminApi, unique('nodes-cli'))
    try {
      for (const args of [
        ['nodes', 'token', 'rotate', 'builtin'],
        ['nodes', 'token', 'revoke', 'builtin'],
        ['nodes', 'delete', 'builtin'],
      ]) {
        const result = await scantor([...args, '-o', 'json'], { token: key.key, timeoutMs: 60_000 })
        expect(result.exitCode, `${args.join(' ')}: ${result.stdout}${result.stderr}`).toBe(2)
        expect(result.stdout + result.stderr).toContain('builtInNode')
      }
      const listed = await scantor(['nodes', 'list', '-o', 'json'], { token: key.key, timeoutMs: 60_000 })
      expect(listed.exitCode, listed.stderr).toBe(0)
      expect(JSON.stringify(listed.json)).toContain('"builtIn":true')
    } finally {
      await key.dispose()
    }
    const builtin = ok(await adminApi.listNodes(), 'listNodes').items.find((node) => node.builtIn)!
    expect(builtin.state).toBe('online')
  })

  test('is online in pool shared with the configured worker capacity and a clock offset near 0', { tag: ['@NODE-012'] }, async ({ adminApi }) => {
    const builtin = ok(await adminApi.listNodes(), 'listNodes').items.find((node) => node.builtIn)!
    expect(builtin).toMatchObject({ name: 'builtin', builtIn: true, endpointProfile: 'internal', pool: 'shared', state: 'online' })
    expect(builtin.info?.maxWorkers).toBe(Number(stackEnv().SCANTOR_BUILTIN_NODE_MAX_WORKERS))
    expect(builtin.lastSeenAt).not.toBeNull()
    expect(Date.now() - Date.parse(builtin.lastSeenAt!)).toBeLessThan(60_000)
    expect(typeof builtin.info?.clockOffsetMs).toBe('number')
    expect(Math.abs(builtin.info!.clockOffsetMs!)).toBeLessThan(2_000)
  })
})
