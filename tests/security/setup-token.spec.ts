import { randomBytes } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import type { Account } from '#shared/types/account'
import type { InstanceInfo } from '#shared/types/instance'
import type { User } from '#shared/types/users'
import type { ApiClient } from '../helpers/api-client'
import { ThrowawayOrchestrator } from '../helpers/orchestrator'
import { errorCode } from '../helpers/security'
import { withSecurityTenants } from '../helpers/security-tenants'
import { expect, test as base } from '../fixtures'

// The tenant fixtures of the security specs (helpers/security-tenants.ts).
const test = withSecurityTenants(base)

// First-admin setup (docs/auth.md §7, security.md CFG-5) and passkey availability (docs/auth.md §4.4) against throwaway
// orchestrators (docs/testing.md §8.6). Sign-ins against a throwaway count only against that orchestrator's own
// in-memory rate limit, never against the shared stack's budget, so they do not go through helpers/limiter.ts.

interface SetupStatus {
  needsSetup: boolean
  passkeysEnabled: boolean
  mcpUrl: string | null
}

interface ErrorBody {
  error: { code: string; message: string; details?: { issues?: { path: string; message: string }[] } }
}

const strongPassword = () => randomBytes(18).toString('base64url')

function createSetupAdmin(api: ApiClient, token: string | undefined, body: Record<string, unknown>) {
  return api.call<User>('createSetupAdmin', { headers: token === undefined ? {} : { 'X-Scantor-Setup-Token': token }, body })
}

function createSetupPasskeyToken(api: ApiClient, token: string | undefined, body: Record<string, unknown>) {
  return api.call<{ token: string; expiresIn: number }>('createSetupPasskeyToken', {
    headers: token === undefined ? {} : { 'X-Scantor-Setup-Token': token },
    body,
  })
}

async function setupStatus(api: ApiClient): Promise<SetupStatus> {
  const response = await api.call<SetupStatus>('getSetupStatus')
  expect(response.status).toBe(200)
  return response.body
}

/** Signs in on a throwaway (its own rate limit, not the stack's); returns the session context and the status. */
async function signInTo(orchestrator: ThrowawayOrchestrator, email: string, password: string): Promise<{ session: APIRequestContext; status: number }> {
  const session = await orchestrator.context()
  const response = await session.post('/api/auth/sign-in/email', { data: { email, password } })
  return { session, status: response.status() }
}

// Only the shared-stack describe needs the worker's tenant; a signed-out storage state keeps the tenant (and its
// sign-in on the shared stack) out of the throwaway tests.
test.use({ storageState: { cookies: [], origins: [] } })

const admin = { email: 'First.Admin@Example.TEST', name: 'First Admin', password: 'correct horse battery' }

test.describe('setup token', () => {
  let orchestrator: ThrowawayOrchestrator | undefined

  test.afterEach(async () => {
    await orchestrator?.dispose()
    orchestrator = undefined
  })

  test(
    'a zero-user orchestrator logs a setup link whose token creates the first admin once',
    { tag: ['@SETUP-002', '@SETUP-003', '@SETUP-004', '@SETUP-005'] },
    async ({ openapi, throwawayInfra }) => {
      orchestrator = await ThrowawayOrchestrator.start({ name: 'setup', infra: throwawayInfra })
      await orchestrator.waitReady()
      const anon = await orchestrator.api(openapi)

      // The one unredacted line: the setup link with a fresh sst_ token.
      const token = await orchestrator.waitForSetupToken()
      expect(token).toMatch(/^sst_[A-Za-z0-9_-]{43}$/)
      const setupLines = (await orchestrator.logLines()).filter((line) => (line.msg ?? '').startsWith('[setup] no users exist'))
      expect(setupLines).toHaveLength(1)
      expect(setupLines[0]!.msg).toBe(`[setup] no users exist; open ${orchestrator.publicUrl}/setup?token=${token} to create the first admin`)
      expect(setupLines[0]!.level).toBe('warn')

      expect(await setupStatus(anon)).toEqual({ needsSetup: true, passkeysEnabled: true, mcpUrl: `${orchestrator.publicUrl}/mcp` })

      // Without or with a wrong token: 401 setupTokenInvalid.
      for (const wrong of [undefined, '', `sst_${'A'.repeat(43)}`, token.slice(0, -1), `${token}x`]) {
        const response = await createSetupAdmin(anon, wrong, admin)
        expect(response.status, `token ${JSON.stringify(wrong)}`).toBe(401)
        expect(errorCode(response)).toBe('setupTokenInvalid')
      }

      // The body is validated: email, name 1–100, password 8–128.
      const invalid: [string, Record<string, unknown>][] = [
        ['email', { ...admin, email: 'not-an-email' }],
        ['name', { ...admin, name: '' }],
        ['name', { ...admin, name: 'n'.repeat(101) }],
        ['password', { ...admin, password: 'p'.repeat(7) }],
        ['password', { ...admin, password: 'p'.repeat(129) }],
      ]
      for (const [path, body] of invalid) {
        const response = await createSetupAdmin(anon, token, body)
        expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(400)
        expect(errorCode(response)).toBe('validationFailed')
        expect((response.body as unknown as ErrorBody).error.details?.issues?.map((issue) => issue.path)).toContain(path)
      }
      expect((await setupStatus(anon)).needsSetup).toBe(true)

      // The logged token creates an admin (email stored lowercased, never privileged) at the bounds of name and password …
      const password = 'p'.repeat(128)
      const created = await createSetupAdmin(anon, token, { ...admin, name: 'n'.repeat(100), password })
      expect(created.status, JSON.stringify(created.body)).toBe(201)
      expect(created.body).toMatchObject({ email: admin.email.toLowerCase(), name: 'n'.repeat(100), role: 'admin', canRunPrivileged: false })
      expect((await setupStatus(anon)).needsSetup).toBe(false)

      // … and is then discarded: every setup mutation answers 409, whatever token or principal comes with it.
      for (const response of [
        await createSetupAdmin(anon, token, { ...admin, email: 'second@example.test' }),
        await createSetupAdmin(anon, undefined, admin),
        await createSetupAdmin(anon, `sst_${'B'.repeat(43)}`, admin),
        await createSetupAdmin(anon, token, { email: 'bad', name: '', password: '' }),
        await createSetupPasskeyToken(anon, token, { email: 'second@example.test', name: 'Second' }),
        await createSetupPasskeyToken(anon, undefined, { email: 'second@example.test', name: 'Second' }),
      ]) {
        expect(response.status).toBe(409)
        expect(errorCode(response)).toBe('setupCompleted')
      }

      // A signed-in admin, with or without the old token, is no setup principal either.
      const { session, status } = await signInTo(orchestrator, admin.email.toLowerCase(), password)
      expect(status).toBe(200)
      for (const headers of [{}, { 'X-Scantor-Setup-Token': token }] as Record<string, string>[]) {
        const asAdmin = await session.post('/api/setup/admin', { headers, data: { ...admin, email: 'third@example.test' } })
        expect(asAdmin.status()).toBe(409)
        expect(((await asAdmin.json()) as ErrorBody).error.code).toBe('setupCompleted')
      }
      expect((await setupStatus(anon)).needsSetup).toBe(false)

      // The token never reaches the logs outside the setup line, also not after the setup page was opened with it and
      // after it travelled in request headers.
      expect((await anon.request.get(`/setup?token=${token}`)).status()).toBe(200)
      const leaks = (await orchestrator.logs()).split('\n').filter((line) => line.includes(token) && !line.includes('[setup] no users exist'))
      expect(leaks).toEqual([])
    },
  )

  test('every restart logs a new setup token and voids the previous one', { tag: ['@SETUP-002', '@SETUP-006'] }, async ({ openapi, throwawayInfra }) => {
    orchestrator = await ThrowawayOrchestrator.start({ name: 'setup-restart', infra: throwawayInfra })
    await orchestrator.waitReady()
    const first = await orchestrator.waitForSetupToken()

    await orchestrator.restart()
    await orchestrator.waitReady()
    await expect.poll(async () => (await orchestrator!.setupTokens()).length, { timeout: 30_000 }).toBe(2)
    const [previous, current] = await orchestrator.setupTokens()
    expect(previous).toBe(first)
    expect(current).toMatch(/^sst_[A-Za-z0-9_-]{43}$/)
    expect(current).not.toBe(first)

    const anon = await orchestrator.api(openapi)
    const stale = await createSetupPasskeyToken(anon, first, { email: 'passkey@example.test', name: 'Passkey Admin' })
    expect(stale.status).toBe(401)
    expect(errorCode(stale)).toBe('setupTokenInvalid')
    const fresh = await createSetupPasskeyToken(anon, current, { email: 'passkey@example.test', name: 'Passkey Admin' })
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(201)
    expect(fresh.body).toEqual({ token: expect.stringMatching(/^spk_[A-Za-z0-9_-]{43}$/), expiresIn: 300 })
    // A passkey setup token creates nothing by itself.
    expect((await setupStatus(anon)).needsSetup).toBe(true)
  })
})

test.describe('setup on the shared stack', () => {
  test('every setup mutation answers 409 setupCompleted to every principal', { tag: ['@SETUP-004'] }, async ({ anonApi, api, apiKeyApi, adminApi }) => {
    const status = await anonApi.call<SetupStatus>('getSetupStatus')
    expect(status.status).toBe(200)
    expect(status.body.needsSetup).toBe(false)
    for (const [principal, client] of Object.entries({ anonymous: anonApi, session: api, apiKey: apiKeyApi, admin: adminApi })) {
      for (const token of [undefined, `sst_${'C'.repeat(43)}`]) {
        for (const response of [
          await createSetupAdmin(client, token, { email: 'intruder@example.test', name: 'Intruder', password: strongPassword() }),
          await createSetupPasskeyToken(client, token, { email: 'intruder@example.test', name: 'Intruder' }),
        ]) {
          expect(response.status, `${principal} with token ${token}`).toBe(409)
          expect(errorCode(response)).toBe('setupCompleted')
        }
      }
    }
  })
})

test.describe('passkey-first admin', () => {
  // A signed-out browser; like the ui project, without the forced Origin header (Chromium refuses it on subresources).
  test.use({ storageState: { cookies: [], origins: [] }, extraHTTPHeaders: {} })

  let orchestrator: ThrowawayOrchestrator | undefined

  test.afterEach(async () => {
    await orchestrator?.dispose()
    orchestrator = undefined
  })

  test(
    'a passkey setup token is single use, creates the admin with the default maxWorkers, and an aborted ceremony creates nobody',
    { tag: ['@SETUP-006'] },
    async ({ openapi, page, webauthn, throwawayInfra }) => {
      orchestrator = await ThrowawayOrchestrator.start({ name: 'setup-passkey', infra: throwawayInfra, publish: true, env: { SCANTOR_USER_MAX_WORKERS: '7' } })
      await orchestrator.waitReady()
      const token = await orchestrator.waitForSetupToken()
      const anon = await orchestrator.api(openapi)

      // An aborted ceremony: registration options are generated for the passkey setup token, but no attestation is ever
      // verified. No user exists afterwards and setup is still open.
      const aborted = await createSetupPasskeyToken(anon, token, { email: 'aborted@example.test', name: 'Aborted' })
      expect(aborted.status).toBe(201)
      const options = await anon.request.get('/api/auth/passkey/generate-register-options', { params: { context: aborted.body.token } })
      expect(options.status(), await options.text()).toBe(200)
      expect(((await options.json()) as { user: { name: string; displayName: string } }).user).toMatchObject({
        name: 'aborted@example.test',
        displayName: 'Aborted',
      })
      expect((await setupStatus(anon)).needsSetup).toBe(true)

      // The setup page's passkey path: the WebAuthn registration with the spk_ token creates the admin and signs in.
      const issued = page.waitForResponse((response) => response.url().endsWith('/api/setup/admin-passkey-token') && response.status() === 201)
      await page.goto(`${orchestrator.publicUrl}/setup?token=${token}`)
      await page.getByRole('radio', { name: 'Passkey' }).click()
      await page.getByLabel('Name').fill('Passkey Admin')
      await page.getByLabel('Email').fill('Passkey.Admin@Example.TEST')
      await page.getByRole('button', { name: 'Create admin with passkey' }).click()
      const passkeyToken = ((await (await issued).json()) as { token: string }).token
      await page.waitForURL(`${orchestrator.publicUrl}/`, { timeout: 30_000 })
      expect(await webauthn.listCredentials()).toHaveLength(1)

      const account = await page.request.get(`${orchestrator.publicUrl}/api/account`)
      expect(account.status()).toBe(200)
      expect((await account.json()) as Account).toMatchObject({
        email: 'passkey.admin@example.test',
        name: 'Passkey Admin',
        role: 'admin',
        canRunPrivileged: false,
        maxWorkers: 7,
        credentials: { hasPassword: false, passkeyCount: 1 },
      })
      expect((await setupStatus(anon)).needsSetup).toBe(false)

      // The consumed token, like the aborted one, can never start another registration.
      for (const context of [passkeyToken, aborted.body.token]) {
        const reused = await anon.request.get('/api/auth/passkey/generate-register-options', { params: { context } })
        expect(reused.status(), `context ${context.slice(0, 8)}…`).toBe(401)
      }
      const users = await orchestrator.mongosh('print(db.user.countDocuments({}))')
      expect(Number(users)).toBe(1)
    },
  )
})

test.describe('first admin from the environment', () => {
  let orchestrator: ThrowawayOrchestrator | undefined

  test.afterEach(async () => {
    await orchestrator?.dispose()
    orchestrator = undefined
  })

  test(
    'SCANTOR_ADMIN_EMAIL and SCANTOR_ADMIN_PASSWORD create the first admin at boot and are ignored once a user exists',
    { tag: ['@SETUP-007'] },
    async ({ openapi, throwawayInfra }) => {
      const password = strongPassword()
      orchestrator = await ThrowawayOrchestrator.start({
        name: 'setup-env',
        infra: throwawayInfra,
        env: { SCANTOR_ADMIN_EMAIL: 'Boot.Admin@Example.TEST', SCANTOR_ADMIN_PASSWORD: password },
      })
      await orchestrator.waitReady()
      await orchestrator.waitForLog((line) => line.msg === '[setup] created first admin boot.admin@example.test')
      expect(await orchestrator.setupTokens()).toEqual([])
      expect((await setupStatus(await orchestrator.api(openapi))).needsSetup).toBe(false)

      const first = await signInTo(orchestrator, 'boot.admin@example.test', password)
      expect(first.status).toBe(200)
      const account = await first.session.get('/api/account')
      expect((await account.json()) as Account).toMatchObject({ email: 'boot.admin@example.test', role: 'admin', canRunPrivileged: false })

      // A redeploy with another password and another email: nothing is reset and nobody is created.
      orchestrator = await orchestrator.redeploy({ SCANTOR_ADMIN_PASSWORD: strongPassword(), SCANTOR_ADMIN_EMAIL: 'other.admin@example.test' })
      await orchestrator.waitReady()
      await orchestrator.waitForLog((line) => line.msg === '[setup] users exist; SCANTOR_ADMIN_EMAIL and SCANTOR_ADMIN_PASSWORD are ignored')
      expect((await signInTo(orchestrator, 'boot.admin@example.test', orchestrator.env.SCANTOR_ADMIN_PASSWORD!)).status).toBe(401)
      expect((await signInTo(orchestrator, 'other.admin@example.test', orchestrator.env.SCANTOR_ADMIN_PASSWORD!)).status).toBe(401)
      expect((await signInTo(orchestrator, 'boot.admin@example.test', password)).status).toBe(200)
      expect(Number(await orchestrator.mongosh('print(db.user.countDocuments({}))'))).toBe(1)
    },
  )

  for (const [only, missing] of [
    ['SCANTOR_ADMIN_EMAIL', 'SCANTOR_ADMIN_PASSWORD'],
    ['SCANTOR_ADMIN_PASSWORD', 'SCANTOR_ADMIN_EMAIL'],
  ] as const) {
    test(`only ${only} aborts startup`, { tag: ['@SETUP-007'] }, async () => {
      const value = only === 'SCANTOR_ADMIN_EMAIL' ? 'lonely.admin@example.test' : strongPassword()
      orchestrator = await ThrowawayOrchestrator.start({ name: 'setup-env-half', infra: false, env: { [only]: value } })
      const { exitCode, ranMs } = await orchestrator.waitExit(30_000)
      expect(exitCode).toBe(1)
      expect(ranMs).toBeLessThan(30_000)
      const lines = await orchestrator.logLines()
      expect(lines).toContainEqual(
        expect.objectContaining({
          level: 'error',
          msg: 'invalid configuration',
          variable: missing,
          problem: 'SCANTOR_ADMIN_EMAIL and SCANTOR_ADMIN_PASSWORD must be set together',
        }),
      )
      expect(lines.some((line) => (line.msg ?? '').startsWith('[setup]'))).toBe(false)
    })
  }
})

test.describe('passkey availability', () => {
  let orchestrator: ThrowawayOrchestrator | undefined

  test.afterEach(async () => {
    await orchestrator?.dispose()
    orchestrator = undefined
  })

  test('a plain-http public URL on another host disables passkeys everywhere', { tag: ['@AUTH-014'] }, async ({ openapi, throwawayInfra }) => {
    orchestrator = await ThrowawayOrchestrator.start({
      name: 'passkeys-http',
      infra: throwawayInfra,
      env: { SCANTOR_PUBLIC_URL: 'http://scantor.example.test:3000', SCANTOR_EDITOR_URL: 'http://editor.scantor.example.test:3000' },
    })
    await orchestrator.waitReady()
    const anon = await orchestrator.api(openapi)
    const status = await setupStatus(anon)
    expect(status.passkeysEnabled).toBe(false)
    expect(status.needsSetup).toBe(true)

    const token = await orchestrator.waitForSetupToken()
    const passkeyToken = await createSetupPasskeyToken(anon, token, { email: 'passkey@example.test', name: 'Passkey Admin' })
    expect(passkeyToken.status).toBe(400)
    expect(errorCode(passkeyToken)).toBe('passkeysDisabled')

    const password = strongPassword()
    expect((await createSetupAdmin(anon, token, { email: 'admin@example.test', name: 'Admin', password })).status).toBe(201)
    const { session, status: signedIn } = await signInTo(orchestrator, 'admin@example.test', password)
    expect(signedIn).toBe(200)
    const info = (await (await session.get('/api/info')).json()) as InstanceInfo
    expect(info.features.passkeys).toBe(false)
    // The passkey plugin is not registered at all.
    expect((await session.get('/api/auth/passkey/generate-register-options')).status()).toBe(404)
  })

  for (const publicUrl of ['http://127.0.0.1:3000', 'https://10.0.0.5']) {
    test(`an IP-literal public URL disables passkeys (${publicUrl})`, { tag: ['@AUTH-014'] }, async ({ openapi, throwawayInfra }) => {
      const editorUrl = publicUrl.startsWith('https') ? 'https://10.0.0.6' : 'http://127.0.0.1:3001'
      orchestrator = await ThrowawayOrchestrator.start({
        name: 'passkeys-ip',
        infra: throwawayInfra,
        env: { SCANTOR_PUBLIC_URL: publicUrl, SCANTOR_EDITOR_URL: editorUrl },
      })
      await orchestrator.waitReady()
      const anon = await orchestrator.api(openapi)
      expect((await setupStatus(anon)).passkeysEnabled).toBe(false)
      const token = await orchestrator.waitForSetupToken()
      const passkeyToken = await createSetupPasskeyToken(anon, token, { email: 'passkey@example.test', name: 'Passkey Admin' })
      expect(passkeyToken.status).toBe(400)
      expect(errorCode(passkeyToken)).toBe('passkeysDisabled')
    })
  }

  test('a SCANTOR_PASSKEY_RP_ID that is not a registrable suffix of the host aborts startup', { tag: ['@AUTH-014'] }, async () => {
    orchestrator = await ThrowawayOrchestrator.start({
      name: 'passkeys-rpid',
      infra: false,
      env: { SCANTOR_PUBLIC_URL: 'https://scantor.example.test', SCANTOR_EDITOR_URL: 'https://editor.example.test', SCANTOR_PASSKEY_RP_ID: 'example.org' },
    })
    const { exitCode, ranMs } = await orchestrator.waitExit(30_000)
    expect(exitCode).toBe(1)
    expect(ranMs).toBeLessThan(30_000)
    expect(await orchestrator.logLines()).toContainEqual(
      expect.objectContaining({ level: 'error', msg: 'invalid configuration', variable: 'SCANTOR_PASSKEY_RP_ID' }),
    )
  })

  test('an http *.localhost public URL keeps passkeys enabled and MCP on API keys only', { tag: ['@AUTH-014'] }, async ({ openapi, throwawayInfra }) => {
    orchestrator = await ThrowawayOrchestrator.start({
      name: 'passkeys-localhost',
      infra: throwawayInfra,
      env: { SCANTOR_PUBLIC_URL: 'http://scantor.localhost:3000', SCANTOR_EDITOR_URL: 'http://editor.scantor.localhost:3000' },
    })
    await orchestrator.waitReady(60_000)
    const anon = await orchestrator.api(openapi)
    expect(await setupStatus(anon)).toEqual({ needsSetup: true, passkeysEnabled: true, mcpUrl: 'http://scantor.localhost:3000/mcp' })
    // @better-auth/mcp accepts plain http only for localhost and loopback IPs: OAuth stays off instead of failing the boot.
    expect((await anon.request.get('/.well-known/oauth-authorization-server')).status()).toBe(404)
    const challenge = await anon.request.post('/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } })
    expect(challenge.status()).toBe(401)
    expect(challenge.headers()['www-authenticate'] ?? '').not.toContain('resource_metadata')
  })
})
