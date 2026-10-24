import type { Page } from '@playwright/test'
import { ok } from '../helpers/api-client'
import {
  alertBox,
  deleteApiKeysNamed,
  expectStorageWithout,
  fulfillError,
  fulfillJson,
  openPage,
  reloadPage,
  signedInContextWithRetry,
  freshTenantHandle,
  nodeRoutedContext,
  workerTenant,
} from '../helpers/ui-shell-tasks'
import { expect, test as base, unique } from '../fixtures'

// The worker's tenant and fresh users under session files of their own (sign-ins wait out a 429), and the dashboard's
// requests sent from Node (helpers/ui-shell-tasks.ts).
const test = base.extend({ user: [workerTenant, { scope: 'worker' }], freshUserHandle: freshTenantHandle, context: nodeRoutedContext })

// The account page (docs/ui.md §5.17): sections that load and fail independently, the profile, the password and the
// sessions. Account-level changes run on `freshUser`; the worker's tenant only reads. The editor section is covered with
// the editor (ui/editor.spec.ts) and the passkeys section in ui/passkeys.spec.ts.

function section(page: Page, heading: string) {
  return page.locator('section', { has: page.getByRole('heading', { name: heading, exact: true }) })
}

test.describe('account page of the tenant', () => {
  test(
    'has Profile, Password, Passkeys, Sessions and Editor sections that load and fail on their own',
    { tag: ['@UI-ACCT-001', '@UI-ACCT-006'] },
    async ({ page, user }) => {
      await page.route('**/api/auth/list-sessions', (route) => fulfillJson(route, { message: 'sessions are down' }, 500))
      await openPage(page, '/account')
      for (const heading of ['Profile', 'Password', 'Passkeys', 'Sessions', 'Editor']) {
        await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
      }
      // The sessions failure stays inside its section.
      await expect(section(page, 'Sessions').getByRole('alert')).toHaveText(/sessions are down|Sessions could not be loaded/)
      await expect(section(page, 'Profile').getByRole('textbox', { name: 'Email' })).toHaveValue(user.email)
      await expect(section(page, 'Password').getByRole('button', { name: 'Change password' })).toBeVisible()

      // A session older than 24 h may not list sessions (better-auth answers 403): the section asks for a fresh sign-in.
      await page.unroute('**/api/auth/list-sessions')
      await page.route('**/api/auth/list-sessions', (route) => fulfillJson(route, { code: 'SESSION_NOT_FRESH', message: 'Session is not fresh' }, 403))
      await reloadPage(page)
      await expect(section(page, 'Sessions').getByRole('alert')).toHaveText(
        'Sign out and in again to manage your sessions (this needs a sign-in from the last 24 hours).',
      )
    },
  )

  test('a failed account load offers "Retry"', { tag: ['@UI-ACCT-001'] }, async ({ page, user }) => {
    let failing = true
    await page.route('**/api/account', (route) =>
      failing && route.request().method() === 'GET' ? fulfillError(route, { status: 503, code: 'unavailable', message: 'try again soon' }) : route.fallback(),
    )
    await openPage(page, '/account')
    const alert = alertBox(page, 'Your account could not be loaded')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText('try again soon')
    // The other sections still render.
    await expect(page.getByRole('heading', { name: 'Sessions', exact: true })).toBeVisible()

    failing = false
    await alert.getByRole('button', { name: 'Retry' }).click()
    await expect(alertBox(page, 'Your account could not be loaded')).toHaveCount(0)
    await expect(section(page, 'Profile').getByRole('textbox', { name: 'Name' })).toHaveValue(user.name)
  })

  test('revealing an API key leaves it out of browser storage', { tag: ['@UI-SEC-006'] }, async ({ page, api }) => {
    const name = unique('key').slice(0, 32)
    try {
      await openPage(page, '/account/access')
      await page.getByRole('button', { name: 'Create key' }).click()
      const create = page.getByRole('dialog', { name: 'Create API key' })
      await create.getByRole('textbox', { name: 'Name' }).fill(name)
      await create.getByRole('button', { name: 'Create API key' }).click()
      const reveal = page.getByTestId('secret-reveal')
      const key = (await reveal.getByTestId('secret-value').innerText()).trim()
      expect(key).toMatch(/^sk_scantor_/)
      await expectStorageWithout(page, [key])
      await page
        .getByRole('dialog', { name: `API key ${name}` })
        .getByRole('button', { name: 'Done' })
        .click()
      await expect(reveal).toHaveCount(0)
      await expectStorageWithout(page, [key])
      await reloadPage(page)
      await expect(page.getByLabel('API keys', { exact: true }).getByText(name)).toBeVisible()
      await expectStorageWithout(page, [key])
    } finally {
      await deleteApiKeysNamed(api, [name])
    }
  })
})

test.describe('account changes', () => {
  test.use({ pageUser: 'fresh' })

  test('the profile saves the name, changes the email and shows role and limits', { tag: ['@UI-ACCT-002'] }, async ({ page, freshUser, freshApi }) => {
    await openPage(page, '/account')
    const profile = section(page, 'Profile')
    const nameInput = profile.getByRole('textbox', { name: 'Name' })
    await expect(nameInput).toHaveValue(freshUser.name)
    const account = ok(await freshApi.getAccount(), 'getAccount')

    const facts = profile.locator('dl')
    await expect(facts.locator('dt', { hasText: 'Role' }).locator('xpath=following-sibling::dd[1]')).toHaveText('user')
    await expect(facts.locator('dt', { hasText: 'Privileged tasks' }).locator('xpath=following-sibling::dd[1]')).toHaveText(
      account.canRunPrivileged ? 'allowed' : 'not allowed',
    )
    await expect(facts.locator('dt', { hasText: 'Worker limit' }).locator('xpath=following-sibling::dd[1]')).toHaveText(
      account.maxWorkers === 0 ? 'unlimited' : new Intl.NumberFormat('en-US').format(account.maxWorkers),
    )
    await expect(facts.locator('dt', { hasText: 'Member since' }).locator('xpath=following-sibling::dd[1]').locator('time')).toHaveText(/just now|min ago/)

    const newName = `Renamed ${unique('name')}`
    await nameInput.fill(newName)
    await profile.getByRole('button', { name: 'Save name' }).click()
    await expect(profile.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible()
    expect(ok(await freshApi.getAccount(), 'getAccount').name).toBe(newName)

    const emailInput = profile.getByRole('textbox', { name: 'Email' })
    const changeEmail = profile.getByRole('button', { name: 'Change email' })
    await expect(changeEmail).toBeDisabled()
    await emailInput.fill('not-an-email')
    await changeEmail.click()
    await expect(profile.getByText('Enter a valid email address')).toBeVisible()
    const newEmail = `${unique('changed')}@scantor.test`
    await emailInput.fill(newEmail)
    // The cleared error shifts the button up; a click during the shift misses it.
    await expect(profile.getByText('Enter a valid email address')).toHaveCount(0)
    await changeEmail.click()
    await expect(profile.getByRole('status').filter({ hasText: 'Email changed' })).toBeVisible()
    expect(ok(await freshApi.getAccount(), 'getAccount').email).toBe(newEmail)
    await expect(page.getByTestId('user-menu')).toContainText(newName)
  })

  test('changing the password checks the current one and signs out other sessions by default', { tag: ['@UI-ACCT-003'] }, async ({ page, freshUser }) => {
    const other = await signedInContextWithRetry(freshUser.email, freshUser.password)
    try {
      await openPage(page, '/account')
      const password = section(page, 'Password')
      const revoke = password.getByRole('checkbox', { name: 'Sign out my other sessions' })
      await expect(revoke).toBeChecked()
      const newPassword = `${freshUser.password}-new`

      await password.getByLabel('Current password').fill(freshUser.password)
      await password.getByLabel(/^New password\*?$/).fill(newPassword)
      await password.getByLabel('Confirm new password').fill(`${newPassword}-typo`)
      await password.getByRole('button', { name: 'Change password' }).click()
      await expect(password.getByText('The passwords do not match')).toBeVisible()

      await password.getByLabel('Current password').fill(`${freshUser.password}-wrong`)
      await password.getByLabel('Confirm new password').fill(newPassword)
      // The cleared error shifts the button up; a click during the shift misses it.
      await expect(password.getByText('The passwords do not match')).toHaveCount(0)
      await password.getByRole('button', { name: 'Change password' }).click()
      await expect(password.getByRole('alert')).toBeVisible()
      await expect(password.getByRole('status')).toHaveCount(0)
      expect((await other.get('/api/account')).status()).toBe(200)

      await password.getByLabel('Current password').fill(freshUser.password)
      const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/auth/change-password')
      await password.getByRole('button', { name: 'Change password' }).click()
      expect((await request).postDataJSON()).toEqual({ currentPassword: freshUser.password, newPassword, revokeOtherSessions: true })
      await expect(password.getByRole('status')).toHaveText('Password changed')
      await expect(password.getByLabel('Current password')).toHaveValue('')
      // The other session ended; this browser stays signed in.
      expect((await other.get('/api/account')).status()).toBe(401)
      await reloadPage(page)
      await expect(page).toHaveURL(/\/account$/)
      await expect(section(page, 'Password').getByRole('button', { name: 'Change password' })).toBeVisible()
    } finally {
      await other.dispose()
    }
  })

  test(
    'the sessions section lists sessions with this browser first and signs out one or all others',
    { tag: ['@UI-ACCT-006'] },
    async ({ page, freshUser }) => {
      const others = [await signedInContextWithRetry(freshUser.email, freshUser.password), await signedInContextWithRetry(freshUser.email, freshUser.password)]
      try {
        await openPage(page, '/account')
        const sessions = section(page, 'Sessions')
        const rows = sessions.getByRole('list', { name: 'Your sessions' }).getByRole('listitem')
        await expect(rows).toHaveCount(3)
        await expect(rows.first().getByText('this browser', { exact: true })).toBeVisible()
        await expect(rows.nth(1).getByText('this browser', { exact: true })).toHaveCount(0)
        for (const row of await rows.all()) await expect(row).toContainText(/signed in (just now|\d+ min ago)/)

        await rows
          .nth(1)
          .getByRole('button', { name: /^Sign out session / })
          .click()
        await expect(sessions.getByRole('status')).toHaveText('Session signed out')
        await expect(rows).toHaveCount(2)
        const statuses = await Promise.all(others.map(async (context) => (await context.get('/api/account')).status()))
        expect(statuses.sort()).toEqual([200, 401])

        await sessions.getByRole('button', { name: 'Sign out other sessions' }).click()
        await expect(sessions.getByRole('status')).toHaveText(/Session signed out|Other sessions signed out/)
        await expect(rows).toHaveCount(1)
        await expect(rows.first().getByText('this browser', { exact: true })).toBeVisible()
        await expect(sessions.getByRole('button', { name: 'Sign out other sessions' })).toBeDisabled()
        for (const context of others) expect((await context.get('/api/account')).status()).toBe(401)
        // This browser stays signed in.
        await reloadPage(page)
        await expect(page).toHaveURL(/\/account$/)
      } finally {
        for (const context of others) await context.dispose()
      }
    },
  )
})
