import { randomBytes } from 'node:crypto'
import type { Page } from '@playwright/test'
import { ThrowawayOrchestrator } from '../helpers/orchestrator'
import { withSecurityTenants } from '../helpers/security-tenants'
import { expect, test as base } from '../fixtures'

// The fixtures of the security specs (helpers/security-tenants.ts): `throwawayInfra` for the throwaway orchestrators.
const test = withSecurityTenants(base)

// The setup page (docs/ui.md §5.2, docs/auth.md §7) against throwaway zero-user orchestrators (docs/testing.md §8.6)
// that the browser reaches on a published loopback port: the token from the log, the password and passkey paths, the
// token removed from the address bar, and nothing secret left in browser storage.

// A signed-out browser: no tenant of the shared stack (and no sign-in there) is involved.
test.use({ storageState: { cookies: [], origins: [] } })

const TOKEN_KEY = 'scantor-setup-token'
const WRONG_TOKEN_MESSAGE = 'The setup token is missing or wrong. Restarting the orchestrator prints a new one.'

/** Everything the page keeps in browser storage: local and session storage, readable cookies and IndexedDB records. */
async function browserStorage(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const out: unknown[] = []
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)!
        out.push([key, storage.getItem(key)])
      }
    }
    out.push(document.cookie)
    const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : []
    for (const info of databases) {
      if (!info.name) continue
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(info.name!)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      for (const store of Array.from(db.objectStoreNames)) {
        const records = await new Promise<unknown[]>((resolve, reject) => {
          const request = db.transaction(store).objectStore(store).getAll()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        out.push([info.name, store, records])
      }
      db.close()
    }
    return JSON.stringify(out)
  })
}

async function expectStorageWithout(page: Page, secrets: string[], where: string): Promise<void> {
  const storage = await browserStorage(page)
  for (const secret of secrets) expect(storage.includes(secret), `${where}: browser storage holds a secret`).toBe(false)
  expect(storage, where).not.toMatch(/sst_[A-Za-z0-9_-]{20,}|spk_[A-Za-z0-9_-]{20,}|sk_scantor_/)
}

const sessionToken = (page: Page) => page.evaluate((key) => window.sessionStorage.getItem(key), TOKEN_KEY)
const heading = (page: Page) => page.getByRole('heading', { name: 'Create the first admin' })

test.describe('setup page', () => {
  let orchestrator: ThrowawayOrchestrator | undefined

  test.afterEach(async () => {
    await orchestrator?.dispose()
    orchestrator = undefined
  })

  test(
    'the setup link token leaves the address bar and the history at once and survives a reload',
    { tag: ['@UI-AUTH-007'] },
    async ({ page, throwawayInfra }) => {
      orchestrator = await ThrowawayOrchestrator.start({ name: 'ui-setup-link', infra: throwawayInfra, publish: true })
      await orchestrator.waitReady()
      const token = await orchestrator.waitForSetupToken()
      const base = orchestrator.publicUrl

      await page.goto(`${base}/api/health`)
      await page.goto(`${base}/setup?token=${token}`)
      await expect(heading(page)).toBeVisible()
      await expect(page.getByRole('textbox', { name: 'Name' })).toBeVisible()
      await expect(page).toHaveURL(`${base}/setup`)
      expect(await sessionToken(page)).toBe(token)

      // The history entry itself was replaced: back and forward never show the token again.
      await page.goBack()
      await expect(page).toHaveURL(`${base}/api/health`)
      await page.goForward()
      await expect(page).toHaveURL(`${base}/setup`)
      await expect(heading(page)).toBeVisible()

      await page.reload()
      await expect(page.getByRole('textbox', { name: 'Name' })).toBeVisible()
      await expect(page).toHaveURL(`${base}/setup`)
      expect(await sessionToken(page)).toBe(token)
    },
  )

  test('without a token the page shows where the link is printed and a paste field', { tag: ['@UI-AUTH-008'] }, async ({ page, throwawayInfra }) => {
    // An IP-literal public URL: passkeys are off, so the form has no Password | Passkey choice.
    orchestrator = await ThrowawayOrchestrator.start({ name: 'ui-setup-paste', infra: throwawayInfra, publish: true, publicHost: '127.0.0.1' })
    await orchestrator.waitReady()
    const token = await orchestrator.waitForSetupToken()

    await page.goto(`${orchestrator.publicUrl}/setup`)
    await expect(heading(page)).toBeVisible()
    await expect(page.getByText('Open the setup link printed in the orchestrator log:')).toBeVisible()
    await expect(page.getByText('docker logs scantor-orchestrator 2>&1 | grep /setup')).toBeVisible()
    const paste = page.getByRole('textbox', { name: 'Or paste the setup token' })
    const use = page.getByRole('button', { name: 'Use token' })
    await expect(use).toBeDisabled()
    await paste.fill('   ')
    await expect(use).toBeDisabled()
    await paste.fill(token)
    await expect(use).toBeEnabled()
    await use.click()

    await expect(page.getByRole('textbox', { name: 'Name' })).toBeVisible()
    await expect(page.getByRole('radiogroup', { name: 'Sign-in method' })).toHaveCount(0)
    expect(await sessionToken(page)).toBe(token)
  })

  test(
    'a wrong token shows the restart hint, every route leads to /setup until setup, and password setup signs the admin in',
    { tag: ['@UI-AUTH-011', '@UI-AUTH-009', '@UI-SEC-006'] },
    async ({ page, browser, throwawayInfra }) => {
      orchestrator = await ThrowawayOrchestrator.start({ name: 'ui-setup-password', infra: throwawayInfra, publish: true })
      await orchestrator.waitReady()
      const token = await orchestrator.waitForSetupToken()
      const base = orchestrator.publicUrl

      // While no user exists, protected routes and the login page lead to /setup.
      for (const path of ['/', '/scans', '/login']) {
        await page.goto(`${base}${path}`)
        await expect(page, path).toHaveURL(`${base}/setup`)
      }

      // A wrong token: the form is shown, the server refuses it with the restart hint.
      const wrong = `sst_${randomBytes(32).toString('base64url')}`
      await page.goto(`${base}/setup?token=${wrong}`)
      const password = `${randomBytes(12).toString('base64url')}-Pw1`
      await page.getByRole('textbox', { name: 'Name' }).fill('First Admin')
      await page.getByRole('textbox', { name: 'Email' }).fill('Setup.Admin@Example.TEST')
      await page.getByLabel('Password', { exact: true }).fill(password)
      await page.getByLabel('Confirm password').fill(password)
      await page.getByRole('button', { name: 'Create admin and sign in' }).click()
      await expect(page.getByTestId('setup-error')).toHaveText(WRONG_TOKEN_MESSAGE)

      // Another token: back to the paste field.
      await page.getByRole('button', { name: 'Use a different setup token' }).click()
      expect(await sessionToken(page)).toBeNull()
      await page.getByRole('textbox', { name: 'Or paste the setup token' }).fill(token)
      await page.getByRole('button', { name: 'Use token' }).click()

      // A mismatching confirmation is caught in the form.
      await page.getByRole('textbox', { name: 'Name' }).fill('First Admin')
      await page.getByRole('textbox', { name: 'Email' }).fill('Setup.Admin@Example.TEST')
      await page.getByLabel('Password', { exact: true }).fill(password)
      await page.getByLabel('Confirm password').fill(`${password}x`)
      await page.getByRole('button', { name: 'Create admin and sign in' }).click()
      await expect(page.getByText('The passwords do not match')).toBeVisible()
      expect((await (await orchestrator.context()).get('/api/setup/status').then((r) => r.json())) as { needsSetup: boolean }).toMatchObject({
        needsSetup: true,
      })

      await page.getByLabel('Confirm password').fill(password)
      await page.getByRole('button', { name: 'Create admin and sign in' }).click()
      await page.waitForURL(`${base}/`, { timeout: 30_000 })
      expect(await sessionToken(page)).toBeNull()
      const account = await page.request.get(`${base}/api/account`)
      expect(account.status()).toBe(200)
      expect(await account.json()).toMatchObject({ email: 'setup.admin@example.test', name: 'First Admin', role: 'admin' })
      await expectStorageWithout(page, [token, wrong, password], 'after password setup')

      // Setup is over: the page sends a signed-out browser to /login.
      const other = await browser.newContext({ storageState: { cookies: [], origins: [] } })
      try {
        const signedOut = await other.newPage()
        await signedOut.goto(`${base}/setup?token=${token}`)
        await expect(signedOut).toHaveURL(`${base}/login`)
        expect(await sessionToken(signedOut)).toBeNull()
      } finally {
        await other.close()
      }
    },
  )

  test(
    'with passkeys enabled the passkey path registers "Primary passkey" and signs the admin in',
    { tag: ['@UI-AUTH-010', '@UI-SEC-006'] },
    async ({ page, webauthn, throwawayInfra }) => {
      orchestrator = await ThrowawayOrchestrator.start({ name: 'ui-setup-passkey', infra: throwawayInfra, publish: true })
      await orchestrator.waitReady()
      const token = await orchestrator.waitForSetupToken()
      const base = orchestrator.publicUrl

      await page.goto(`${base}/setup?token=${token}`)
      const methods = page.getByRole('radiogroup', { name: 'Sign-in method' })
      await expect(methods.getByRole('radio', { name: 'Password' })).toHaveAttribute('aria-checked', 'true')
      await methods.getByRole('radio', { name: 'Passkey' }).click()
      await expect(methods.getByRole('radio', { name: 'Passkey' })).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0)

      const issued = page.waitForResponse((response) => response.url().endsWith('/api/setup/admin-passkey-token') && response.status() === 201)
      await page.getByRole('textbox', { name: 'Name' }).fill('Passkey Admin')
      await page.getByRole('textbox', { name: 'Email' }).fill('passkey.admin@example.test')
      await page.getByRole('button', { name: 'Create admin with passkey' }).click()
      const passkeyToken = ((await (await issued).json()) as { token: string }).token
      await page.waitForURL(`${base}/`, { timeout: 30_000 })

      expect(await webauthn.listCredentials()).toHaveLength(1)
      const passkeys = await page.request.get(`${base}/api/auth/passkey/list-user-passkeys`)
      expect(passkeys.status()).toBe(200)
      expect(((await passkeys.json()) as { name: string }[]).map((passkey) => passkey.name)).toEqual(['Primary passkey'])
      expect(await (await page.request.get(`${base}/api/account`)).json()).toMatchObject({ email: 'passkey.admin@example.test', role: 'admin' })
      expect(await sessionToken(page)).toBeNull()
      await expectStorageWithout(page, [token, passkeyToken], 'after passkey setup')
    },
  )
})
