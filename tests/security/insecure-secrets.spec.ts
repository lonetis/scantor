import { randomBytes, randomUUID } from 'node:crypto'
import { request as playwrightRequest } from '@playwright/test'
import { CONTAINERS, docker } from '../helpers/docker'
import { Keys, stackKeys, verifyVectors } from '../helpers/keys'
import { connectAsScan } from '../helpers/amqp'
import { ApiClient } from '../helpers/api-client'
import { ThrowawayInfra, ThrowawayOrchestrator, type LogLine } from '../helpers/orchestrator'
import { containerImage, errorCode, mapLimit, mcpRequest, oauthAuthorize, pollFor, runScantorShell, sha256Hex, waitForRunningWorker } from '../helpers/security'
import { unique } from '../helpers/unique'
import { SMALL_SETTINGS } from '../helpers/scans'
import { withSecurityTenants } from '../helpers/security-tenants'
import { expect, test as base } from '../fixtures'

// The tenant fixtures of the security specs (helpers/security-tenants.ts).
const test = withSecurityTenants(base)

// The startup guard and the security-relevant configuration (docs/security.md CFG-2, CFG-7, §10) against throwaway
// orchestrators (docs/testing.md §8.6), the recovery after a SCANTOR_SECRET change, and the key derivations the
// helpers share with the stack (docs/architecture.md §9).

// Only the derived-credential tests need the worker's tenant; the others must not sign in on the shared stack.
test.use({ storageState: { cookies: [], origins: [] } })

const random = (bytes = 9) => randomBytes(bytes).toString('base64url')
/** A value of the given length that cannot appear in a log by chance. */
const shortSecret = (length: number) => `q${random(24)}`.slice(0, length)
const insecure = () => `${random()}-insecure-dev`

const GUARD_ABORT = (names: string[]) => `refusing to start: insecure secrets in a public deployment: ${names.join(', ')} (run \`just init\`)`
const SAME_ORIGIN = 'SCANTOR_EDITOR_URL must have its own origin (it equals the origin of SCANTOR_PUBLIC_URL)'

/** Every value of `env` must be absent from the logs. */
function expectNoValues(logs: string, values: string[]): void {
  for (const value of values) expect(logs.includes(value), `the log contains the value ${value.slice(0, 4)}…`).toBe(false)
}

function lineWith(lines: LogLine[], fields: Partial<LogLine>): LogLine | undefined {
  return lines.find((line) => Object.entries(fields).every(([key, value]) => line[key] === value))
}

test.describe('startup guard', () => {
  interface AbortCase {
    trigger: string
    env: Record<string, string>
    offenders: string[]
  }

  const abortCases: AbortCase[] = [
    {
      trigger: 'a public SCANTOR_PUBLIC_URL',
      env: {
        SCANTOR_PUBLIC_URL: 'https://scantor.example.test',
        SCANTOR_EDITOR_URL: 'https://editor.scantor.example.test',
        SCANTOR_RABBITMQ_PASSWORD: insecure(),
        // A variable the orchestrator never reads still counts (any value ending in -insecure-dev).
        THIRD_PARTY_API_TOKEN: insecure(),
      },
      offenders: ['SCANTOR_RABBITMQ_PASSWORD', 'THIRD_PARTY_API_TOKEN'],
    },
    {
      trigger: 'a public SCANTOR_EDITOR_URL',
      env: { SCANTOR_EDITOR_URL: 'https://editor.example.test', SCANTOR_SECRET: shortSecret(15) },
      offenders: ['SCANTOR_SECRET'],
    },
    {
      trigger: 'COMPOSE_PROFILES with traefik',
      env: { COMPOSE_PROFILES: 'mongo-express,traefik', SCANTOR_ADMIN_EMAIL: 'guard@example.test', SCANTOR_ADMIN_PASSWORD: shortSecret(12) },
      offenders: ['SCANTOR_ADMIN_PASSWORD'],
    },
    {
      trigger: 'a public SCANTOR_BIND_ADDRESS',
      env: { SCANTOR_BIND_ADDRESS: '0.0.0.0', SCANTOR_S3_SECRET_KEY: insecure(), SCANTOR_MONGO_EXPRESS_SECRET: shortSecret(8) },
      offenders: ['SCANTOR_MONGO_EXPRESS_SECRET', 'SCANTOR_S3_SECRET_KEY'],
    },
    {
      trigger: 'a public SCANTOR_ADMIN_BIND_ADDRESS',
      // The analytics password is a core secret only while the MongoDB router is exposed.
      env: { SCANTOR_ADMIN_BIND_ADDRESS: '192.0.2.10', SCANTOR_EXPOSE_MONGO: 'true', SCANTOR_MONGO_ANALYTICS_PASSWORD: shortSecret(10) },
      offenders: ['SCANTOR_MONGO_ANALYTICS_PASSWORD'],
    },
  ]

  for (const { trigger, env, offenders } of abortCases) {
    test(`public mode by ${trigger} with insecure secrets exits 1 and names only the variables`, { tag: ['@SEC-018'] }, async () => {
      const orchestrator = await ThrowawayOrchestrator.start({ name: 'guard', infra: false, env })
      try {
        const { exitCode, ranMs } = await orchestrator.waitExit(30_000)
        expect(exitCode).toBe(1)
        expect(ranMs).toBeLessThan(30_000)
        const lines = await orchestrator.logLines()
        expect(lineWith(lines, { level: 'error', msg: GUARD_ABORT(offenders) }), JSON.stringify(lines)).toBeDefined()
        expect(lineWith(lines, { msg: 'configuration loaded' })).toBeUndefined()
        expectNoValues(
          await orchestrator.logs(),
          offenders.map((name) => env[name]!),
        )
      } finally {
        await orchestrator.dispose()
      }
    })
  }

  test(
    'with SCANTOR_ALLOW_INSECURE_DEFAULTS=true a public deployment starts with a warning per name; all-loopback settings start with an info line',
    { tag: ['@SEC-019'] },
    async ({ throwawayInfra: infra }) => {
      const offenders = { SCANTOR_MONGO_EXPRESS_PASSWORD: shortSecret(9), THIRD_PARTY_API_TOKEN: insecure() }
      // Public (a non-loopback bind address) with offenders, allowed by the override: it boots completely.
      const allowed = await ThrowawayOrchestrator.start({
        name: 'guard-allow',
        infra,
        env: { ...offenders, SCANTOR_BIND_ADDRESS: '0.0.0.0', SCANTOR_ALLOW_INSECURE_DEFAULTS: 'true' },
      })
      try {
        await allowed.waitReady()
        const lines = await allowed.logLines()
        const warnings = lines.filter((line) => line.msg === 'insecure secret allowed by SCANTOR_ALLOW_INSECURE_DEFAULTS')
        expect(warnings.map((line) => [line.level, line.variable])).toEqual([
          ['warn', 'SCANTOR_MONGO_EXPRESS_PASSWORD'],
          ['warn', 'THIRD_PARTY_API_TOKEN'],
        ])
        expect(lineWith(lines, { msg: 'configuration loaded' })).toMatchObject({ publicMode: true })
        expect(lines.filter((line) => line.level === 'error')).toEqual([])
        expectNoValues(await allowed.logs(), Object.values(offenders))
      } finally {
        await allowed.dispose()
      }

      // The same offenders in an all-loopback deployment without Traefik: one info line, and it boots.
      const local = await ThrowawayOrchestrator.start({ name: 'guard-local', infra, env: offenders })
      try {
        await local.waitReady()
        const lines = await local.logLines()
        expect(lineWith(lines, { level: 'info', msg: 'development secrets in use: SCANTOR_MONGO_EXPRESS_PASSWORD, THIRD_PARTY_API_TOKEN' })).toBeDefined()
        expect(lineWith(lines, { msg: 'configuration loaded' })).toMatchObject({ publicMode: false })
        expect(lines.filter((line) => line.msg === 'insecure secret allowed by SCANTOR_ALLOW_INSECURE_DEFAULTS')).toEqual([])
        expectNoValues(await local.logs(), Object.values(offenders))
      } finally {
        await local.dispose()
      }
    },
  )

  test('an editor URL with the origin of the public URL always exits 1, even with the override', { tag: ['@SEC-020'] }, async () => {
    const cases: Record<string, string>[] = [
      // all-loopback, with the override: the same origin is fatal on its own
      { SCANTOR_PUBLIC_URL: 'http://localhost:3000', SCANTOR_EDITOR_URL: 'http://LOCALHOST:3000/', SCANTOR_ALLOW_INSECURE_DEFAULTS: 'true' },
      // public, the default port spelled out
      { SCANTOR_PUBLIC_URL: 'https://scantor.example.test', SCANTOR_EDITOR_URL: 'https://scantor.example.test:443', SCANTOR_ALLOW_INSECURE_DEFAULTS: 'true' },
      // without the override
      { SCANTOR_PUBLIC_URL: 'http://127.0.0.1:3000', SCANTOR_EDITOR_URL: 'http://127.0.0.1:3000' },
    ]
    await mapLimit(cases, 3, async (env) => {
      const orchestrator = await ThrowawayOrchestrator.start({ name: 'guard-origin', infra: false, env })
      try {
        const { exitCode, ranMs } = await orchestrator.waitExit(30_000)
        expect(exitCode, JSON.stringify(env)).toBe(1)
        expect(ranMs).toBeLessThan(30_000)
        const lines = await orchestrator.logLines()
        expect(lineWith(lines, { level: 'error', msg: SAME_ORIGIN }), JSON.stringify(lines)).toBeDefined()
        expect(lineWith(lines, { msg: 'configuration loaded' })).toBeUndefined()
      } finally {
        await orchestrator.dispose()
      }
    })
  })

  test('invalid security-relevant settings abort startup and name the variable', { tag: ['@SEC-021'] }, async () => {
    const cases: { variable: string; value: string; problem: RegExp; env?: Record<string, string> }[] = [
      { variable: 'SCANTOR_PUBLIC_URL', value: 'https://scantor.example.test/app', problem: /must not contain a path/ },
      { variable: 'SCANTOR_EDITOR_URL', value: 'https://editor.example.test/?embed=1', problem: /must not contain a query/ },
      { variable: 'SCANTOR_PUBLIC_URL', value: `https://admin:${random()}@scantor.example.test`, problem: /must not contain credentials/ },
      { variable: 'SCANTOR_S3_PUBLIC_URL', value: 'ftp://s3.example.test', problem: /must use/ },
      { variable: 'SCANTOR_BIND_ADDRESS', value: '0.0.0.0.0', problem: /must be an IP address/ },
      { variable: 'SCANTOR_ADMIN_BIND_ADDRESS', value: 'localhost', problem: /must be an IP address/ },
      { variable: 'SCANTOR_ALLOW_INSECURE_DEFAULTS', value: 'yes', problem: /invalid boolean/ },
      { variable: 'SCANTOR_ALLOW_INSECURE_TRANSPORT', value: 'TRUE', problem: /invalid boolean/ },
      { variable: 'SCANTOR_TRUST_PROXY', value: '1', problem: /invalid boolean/ },
      { variable: 'SCANTOR_MCP_ALLOWED_REDIRECT_ORIGINS', value: 'http://app.example.test', problem: /must use https/ },
      { variable: 'SCANTOR_MCP_ALLOWED_REDIRECT_ORIGINS', value: 'https://app.example.test/callback', problem: /origin without path/ },
    ]
    await mapLimit(cases, 4, async ({ variable, value, problem }) => {
      const orchestrator = await ThrowawayOrchestrator.start({ name: 'config', infra: false, env: { [variable]: value } })
      try {
        const { exitCode, ranMs } = await orchestrator.waitExit(30_000)
        expect(exitCode, `${variable}=${value}`).toBe(1)
        expect(ranMs).toBeLessThan(30_000)
        const lines = await orchestrator.logLines()
        const issue = lineWith(lines, { level: 'error', msg: 'invalid configuration', variable })
        expect(issue, `${variable}=${value}: ${JSON.stringify(lines)}`).toBeDefined()
        expect(String(issue!.problem)).toMatch(problem)
        expect(lineWith(lines, { msg: 'configuration loaded' })).toBeUndefined()
      } finally {
        await orchestrator.dispose()
      }
    })

    // The node daemon validates its own security-relevant settings the same way: a bad egress deny list.
    const image = await containerImage(CONTAINERS.node)
    const token = `snt_${randomBytes(32).toString('base64url')}`
    for (const deny of ['10.0.0.0/33', '169.254.0.0/16,metadata.internal']) {
      const result = await docker(
        [
          'run',
          '--rm',
          '--name',
          unique('scantor-test-egress'),
          '--label',
          'scantor.test=true',
          '--network',
          'none',
          '-e',
          'SCANTOR_URL=https://scantor.example.test',
          '-e',
          `SCANTOR_NODE_TOKEN=${token}`,
          '-e',
          `SCANTOR_NODE_EGRESS_DENY=${deny}`,
          image,
          'node',
        ],
        { allowFailure: true, timeoutMs: 30_000 },
      )
      expect(result.exitCode, deny).not.toBe(0)
      expect(result.stderr).toMatch(/invalid node configuration: SCANTOR_NODE_EGRESS_DENY: invalid CIDR/)
      expect(result.stderr).not.toContain(token)
    }
  })
})

test.describe('SCANTOR_SECRET change', () => {
  /** The registry key files the orchestrator writes into the registry auth volume at every boot. */
  async function registryKeyFiles(infra: ThrowawayInfra): Promise<{ jwks: string; httpSecret: string }> {
    const { stdout } = await runScantorShell('cat /r/jwks.json; echo; echo ----; cat /r/http-secret', {
      mounts: [`type=volume,src=${infra.registryAuthVolume},dst=/r,readonly`],
    })
    const [jwks, httpSecret] = stdout.split('\n----\n')
    return { jwks: jwks!.trim(), httpSecret: httpSecret!.trim() }
  }

  async function builtinTokenHash(orchestrator: ThrowawayOrchestrator): Promise<string> {
    return orchestrator.mongosh('print(db.nodes.findOne({ builtIn: true }).tokenHash)')
  }

  async function jwksKids(orchestrator: ThrowawayOrchestrator): Promise<string[]> {
    const context = await orchestrator.context()
    const response = await context.get('/api/auth/jwks')
    expect(response.status()).toBe(200)
    return ((await response.json()) as { keys: { kid: string }[] }).keys.map((key) => key.kid)
  }

  test(
    'boot recovers: OAuth signing keys, the built-in node token and the registry keys are rewritten; API keys and node tokens survive; git credentials and scan secrets are undecryptable',
    { tag: ['@SEC-022'] },
    async ({ openapi, throwawayInfra, shared, docker: inner }) => {
      test.setTimeout(180_000)
      // A ready revision with a writeOnly field for the throwaway: the shared probe revision of the stack and its task
      // (a scan starts only on a revision whose task exists), copied white-box into the throwaway's database (the
      // throwaway cannot push images to the stack's registry).
      const { revision: probe } = await shared.probe()
      const copyJson = await inner.mongosh(
        `const revision = db.revisions.findOne({ _id: '${probe.id}' }); print(EJSON.stringify({ revision, task: db.tasks.findOne({ _id: revision.taskId }) }, undefined, undefined, { relaxed: false }))`,
      )
      expect(probe.description?.secretPaths.taskConfig).toEqual(['/token'])
      const password = random(18)
      const oldSecret = random(24)
      let orchestrator = await ThrowawayOrchestrator.start({
        name: 'rotate',
        infra: throwawayInfra,
        env: { SCANTOR_SECRET: oldSecret, SCANTOR_ADMIN_EMAIL: 'rotate@example.test', SCANTOR_ADMIN_PASSWORD: password },
      })
      try {
        await orchestrator.waitReady()
        const infra = orchestrator.infra!
        const admin = await orchestrator.context()
        expect((await admin.post('/api/auth/sign-in/email', { data: { email: 'rotate@example.test', password } })).status()).toBe(200)
        const api = new ApiClient(admin, openapi)

        const apiKey = (await api.createApiKey('rotation')).body.key
        const created = await api.createNode({ name: unique('rotation-node') })
        expect(created.status).toBe(201)
        const nodeToken = created.body.token
        const credential = await api.call<{ id: string }>('createCredential', {
          body: { kind: 'gitToken', name: 'fixtures', host: 'git.scantor.localhost', username: 'scantor-test', token: `glpat-${random()}` },
        })
        expect(credential.status).toBe(201)
        // A scan whose task config holds a writeOnly secret, encrypted with the old secret.
        const adminId = (await api.getAccount()).body.id
        const copied = await orchestrator.mongosh(
          `const { revision, task } = EJSON.parse(${JSON.stringify(copyJson)}); revision.userId = '${adminId}'; task.userId = '${adminId}'; ` +
            `print(db.tasks.insertOne(task).acknowledged && db.revisions.insertOne(revision).acknowledged)`,
        )
        expect(copied).toBe('true')
        const scanSecret = `scan-secret-${random()}`
        const secretScan = await api.startScan({ revision: probe.id, taskConfig: { token: scanSecret }, settings: SMALL_SETTINGS })
        expect(secretScan.status, JSON.stringify(secretScan.body)).toBe(201)
        expect(secretScan.body.taskConfig).toMatchObject({ token: '***' })

        const oldKids = await jwksKids(orchestrator)
        expect(oldKids).toHaveLength(1)
        const oldBuiltin = await builtinTokenHash(orchestrator)
        expect(oldBuiltin).toBe(sha256Hex(new Keys(oldSecret).builtinNodeToken()))
        const oldRegistry = await registryKeyFiles(infra)
        const sessionCookie = (await admin.storageState()).cookies.map((c) => `${c.name}=${c.value}`).join('; ')
        expect(sessionCookie).toContain('session_token')

        // A redeploy on the same database, bucket and registry volume with a new secret.
        const newSecret = random(24)
        orchestrator = await orchestrator.redeploy({ SCANTOR_SECRET: newSecret })
        await orchestrator.waitReady()

        // OAuth signing keys the new secret cannot decrypt are deleted at boot, and a new key is minted.
        expect(await orchestrator.logLines()).toContainEqual(
          expect.objectContaining({ level: 'warn', msg: 'deleted OAuth signing keys that the current SCANTOR_SECRET cannot decrypt', count: 1 }),
        )
        const newKids = await jwksKids(orchestrator)
        expect(newKids).toHaveLength(1)
        expect(newKids[0]).not.toBe(oldKids[0])

        // The built-in node token hash and the registry signing key and HTTP secret are rewritten.
        expect(await builtinTokenHash(orchestrator)).toBe(sha256Hex(new Keys(newSecret).builtinNodeToken()))
        const newRegistry = await registryKeyFiles(infra)
        expect(newRegistry.jwks).not.toBe(oldRegistry.jwks)
        expect(newRegistry.httpSecret).not.toBe(oldRegistry.httpSecret)
        expect(newRegistry.httpSecret).not.toContain(oldSecret)

        // The old session is gone (sessions are signed with the secret); API keys and node tokens are hashes and survive.
        const stale = await orchestrator.context({ Cookie: sessionCookie })
        expect((await stale.get('/api/account')).status()).toBe(401)
        const byKey = await orchestrator.context({ Authorization: `Bearer ${apiKey}` })
        expect((await byKey.get('/api/account')).status()).toBe(200)
        const nodeAuth = `Basic ${Buffer.from(`node:${nodeToken}`).toString('base64')}`
        const registryToken = await (
          await orchestrator.context()
        ).get('/api/registry/token', {
          params: { service: 'scantor-registry' },
          headers: { Authorization: nodeAuth },
        })
        expect(registryToken.status(), await registryToken.text()).toBe(200)

        // The git credential's ciphertext no longer decrypts; using it reports that instead of sending a broken token.
        const keyApi = new ApiClient(byKey, openapi)
        const imported = await keyApi.call('importGitTask', {
          body: { url: 'https://git.scantor.localhost/private.git', credentialId: credential.body.id },
        })
        expect(imported.status, JSON.stringify(imported.body)).toBe(400)
        expect(errorCode(imported)).toBe('badRequest')
        expect(JSON.stringify(imported.body)).toContain('can no longer be decrypted (SCANTOR_SECRET changed)')

        // The scan's writeOnly secret no longer decrypts either: the scan still reads masked, but it cannot be
        // restarted (or bootstrapped), and the failure is logged as a decryption failure, never with the value.
        const scanNow = await keyApi.getScan(secretScan.body.id)
        expect(scanNow.status).toBe(200)
        expect(scanNow.body.taskConfig).toMatchObject({ token: '***' })
        const restarted = await keyApi.call('restartScan', { path: { scanId: secretScan.body.id }, body: {} })
        expect(restarted.status, JSON.stringify(restarted.body)).toBeGreaterThanOrEqual(400)
        expect(restarted.status).not.toBe(404)
        const scansAfter = (await keyApi.listScans({ limit: 200 })).body as { items: { id: string }[] }
        expect(scansAfter.items.map((scan) => scan.id)).toEqual([secretScan.body.id])
        const logs = await orchestrator.logs()
        expect(logs).toMatch(/cannot be decrypted with the current SCANTOR_SECRET/)
        expect(logs).not.toContain(scanSecret)
      } finally {
        await orchestrator.dispose()
      }
    },
  )

  test('MCP OAuth works again after the secret change', { tag: ['@SEC-022'] }, async ({ throwawayInfra }) => {
    const password = random(18)
    let orchestrator = await ThrowawayOrchestrator.start({
      name: 'rotate-oauth',
      infra: throwawayInfra,
      env: { SCANTOR_ADMIN_EMAIL: 'oauth@example.test', SCANTOR_ADMIN_PASSWORD: password },
    })
    try {
      await orchestrator.waitReady()
      const before = await orchestrator.context()
      expect((await before.post('/api/auth/sign-in/email', { data: { email: 'oauth@example.test', password } })).status()).toBe(200)
      const first = await oauthAuthorize(before, orchestrator.publicUrl)
      expect((await mcpRequest(before, `${orchestrator.baseUrl}/mcp`, first.accessToken, 'initialize', mcpInitialize())).status).toBe(200)

      orchestrator = await orchestrator.redeploy({ SCANTOR_SECRET: random(24) })
      await orchestrator.waitReady()
      const after = await orchestrator.context()
      // The old access token was signed with a deleted key.
      expect((await mcpRequest(after, `${orchestrator.baseUrl}/mcp`, first.accessToken, 'initialize', mcpInitialize())).status).toBe(401)
      expect((await after.post('/api/auth/sign-in/email', { data: { email: 'oauth@example.test', password } })).status()).toBe(200)
      const second = await oauthAuthorize(after, orchestrator.publicUrl)
      expect((await mcpRequest(after, `${orchestrator.baseUrl}/mcp`, second.accessToken, 'initialize', mcpInitialize())).status).toBe(200)
    } finally {
      await orchestrator.dispose()
    }
  })
})

function mcpInitialize(): Record<string, unknown> {
  return { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'scantor-security-tests', version: '1.0.0' } }
}

test.describe('secrets derived from SCANTOR_SECRET', () => {
  test('the derivations match the shared vectors', { tag: ['@SEC-023'] }, async () => {
    expect(verifyVectors()).toEqual([])
  })

  test(
    'the credentials the helpers derive from the stack secret work against the stack',
    { tag: ['@SEC-023'] },
    async ({ env, adminApi, api, docker: inner, shared, scans }) => {
      test.setTimeout(180_000)
      const keys = stackKeys()
      const bare = await playwrightRequest.newContext({ baseURL: env.publicUrl, extraHTTPHeaders: {} })
      try {
        // The registry push credential (catalog access is reserved to it) and the built-in node token.
        const basic = (user: string, secret: string) => `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`
        for (const [user, secret, scope] of [
          ['orchestrator', keys.registryPushPassword(), 'registry:catalog:*'],
          ['node', keys.builtinNodeToken(), undefined],
        ] as const) {
          const response = await bare.get('/api/registry/token', {
            params: { service: 'scantor-registry', ...(scope ? { scope } : {}) },
            headers: { Authorization: basic(user, secret) },
          })
          expect(response.status(), `${user}: ${await response.text()}`).toBe(200)
          const payload = JSON.parse(Buffer.from(((await response.json()) as { token: string }).token.split('.')[1]!, 'base64url').toString('utf8')) as {
            access: { type: string; name: string; actions: string[] }[]
          }
          if (scope) expect(payload.access).toContainEqual({ type: 'registry', name: 'catalog', actions: ['*'] })
        }
        const wrong = await bare.get('/api/registry/token', {
          params: { service: 'scantor-registry' },
          headers: { Authorization: basic('orchestrator', new Keys(`${env.secret}x`).registryPushPassword()) },
        })
        expect(wrong.status()).toBe(401)

        // The read-only MongoDB user.
        const user = await inner.mongosh('print(db.runCommand({ connectionStatus: 1 }).authInfo.authenticatedUsers.map((u) => u.user).join(","))')
        expect(user).toBe('scantor_query')

        // The tools cookie of the seeded admin, minted by the helper, passes forwardAuth.
        const adminId = (await adminApi.getAccount()).body.id
        const now = Math.floor(Date.now() / 1000)
        const cookie = keys.toolsCookie({ iss: 'scantor', aud: 'tools', sub: adminId, role: 'admin', iat: now, exp: now + 600, jti: randomUUID() })
        const tools = await bare.get(`https://traefik.${env.domain}/api/rawdata`, { headers: { Cookie: `scantor_tools=${cookie}` } })
        expect(tools.status()).toBe(200)

        // A running scan: its RabbitMQ user and the worker token of its runner.
        const { revision } = await shared.probe()
        const scan = await scans.start({
          revision: revision.ref,
          taskConfig: { mode: 'hang' },
          settings: { ...SMALL_SETTINGS, timeoutMs: 120_000, maxAttempts: 1 },
        })
        const worker = await waitForRunningWorker(api, scan.id, 'runner')
        const session = await connectAsScan(scan.id)
        await session.close()
        const token = keys.workerToken({ workerId: worker.id, scanId: scan.id, role: worker.role, nodeId: worker.nodeId! })
        const bootstrap = await bare.get('/api/runtime/bootstrap', { headers: { Authorization: `Bearer ${token}` } })
        expect(bootstrap.status(), await bootstrap.text()).toBe(200)
        expect(await bootstrap.json()).toMatchObject({ worker: { id: worker.id, role: 'runner', scanId: scan.id }, scan: { id: scan.id } })
      } finally {
        await bare.dispose()
      }
    },
  )

  // The editor is account-level state: a fresh user's (docs/testing.md §7.7).
  test(
    'the editor cookie the helpers derive opens the running editor',
    { tag: ['@SEC-023', '@SEC-007'] },
    async ({ env, freshApi: api, freshUser: user, docker: inner }) => {
      test.setTimeout(180_000)
      const started = await api.call<{ editor: { startedAt: string } }>('createEditorSession', { body: {} })
      expect(started.status, JSON.stringify(started.body)).toBe(201)
      try {
        let last: unknown
        const editor = await pollFor(
          async () => {
            const current = (await api.call<{ state: string; startedAt: string; error: string | null }>('getEditor')).body
            last = current
            return current.state === 'running' ? current : undefined
          },
          120_000,
          () => `the editor is not running: ${JSON.stringify(last)}`,
          2000,
        )
        const startedAtMs = Date.parse(editor.startedAt)
        // The editor container carries the managed labels of its kind.
        const container = await inner.inspect<{ Config: { Labels: Record<string, string> } }>(`scantor-editor-${user.id}`)
        expect(container.Config.Labels).toMatchObject({
          'traefik.enable': 'false',
          'com.docker.compose.project': 'scantor-managed',
          'com.docker.compose.service': '',
          'scantor.managed': 'true',
          'scantor.kind': 'editor',
          'scantor.user': user.id,
        })
        const keys = stackKeys()
        const bare = await playwrightRequest.newContext({ extraHTTPHeaders: {} })
        try {
          const valid = keys.editorCookie(user.id, startedAtMs, Date.now() + 600_000)
          const forged = new Keys(`${env.secret}x`).editorCookie(user.id, startedAtMs, Date.now() + 600_000)
          // code-server's own health endpoint, reached through the editor proxy only with a valid cookie.
          const denied = await bare.get(`${env.editorUrl}/healthz`, { headers: { Cookie: `scantor_editor=${forged}` }, maxRedirects: 0 })
          expect(denied.status()).toBe(401)
          await expect
            .poll(async () => (await bare.get(`${env.editorUrl}/healthz`, { headers: { Cookie: `scantor_editor=${valid}` }, maxRedirects: 0 })).status(), {
              timeout: 60_000,
            })
            .toBe(200)
          const health = await bare.get(`${env.editorUrl}/healthz`, { headers: { Cookie: `scantor_editor=${valid}` }, maxRedirects: 0 })
          expect(await health.json()).toMatchObject({ status: expect.stringMatching(/alive|expired/) })
        } finally {
          await bare.dispose()
        }
      } finally {
        expect((await api.call('stopEditor')).status).toBe(204)
      }
    },
  )
})
