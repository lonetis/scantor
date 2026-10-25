import { setBannedFlag } from '../helpers/api-auth'
import { ok } from '../helpers/api-client'
import {
  expectStorageWithout,
  fulfillJson,
  freshTenantHandle,
  nodeRoutedContext,
  openPage,
  recordApiRequests,
  submitLoginForm,
  workerTenant,
} from '../helpers/ui-shell-tasks'
import { createUser, deleteUser } from '../helpers/users'
import { expect, test as base, unique } from '../fixtures'

// The worker's tenant and fresh users under session files of their own (sign-ins wait out a 429), and the dashboard's
// requests sent from Node (helpers/ui-shell-tasks.ts).
const test = base.extend({ user: [workerTenant, { scope: 'worker' }], freshUserHandle: freshTenantHandle, context: nodeRoutedContext })

// Sign-in page, route guard, redirect handling and session loss (docs/ui.md §4.1, §5.1, §8). Every sign-in through the
// form, wrong passwords included, first reserves a slot of the shared limiter (docs/testing.md §9).

const notifications = (page: import('@playwright/test').Page) => page.getByRole('region', { name: /notifications/i }).locator('li[data-state="open"]')

test.describe('sign-in page', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test(
    'a protected route redirects to /login with its path and query and returns there after sign-in',
    { tag: ['@UI-AUTH-001', '@UI-NAV-012', '@UI-SEC-006'] },
    async ({ page, user }) => {
      const target = '/tasks?language=go'
      await openPage(page, target)
      await expect(page).toHaveURL((url) => url.pathname === '/login' && url.searchParams.get('redirect') === target)
      await expect(page).toHaveTitle('Sign in · scantor')

      const email = page.getByLabel('Email')
      await expect(email).toHaveAttribute('autocomplete', 'username webauthn')
      await expect(email).toHaveAttribute('type', 'email')
      await expect(page.getByLabel('Password')).toHaveAttribute('autocomplete', 'current-password webauthn')

      // Client-side validation: errors appear without any request to better-auth.
      const requests = recordApiRequests(page)
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await expect(page.getByText('Enter a valid email address')).toBeVisible()
      await expect(page.getByText('Enter your password')).toBeVisible()
      await email.fill('not-an-email')
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await expect(page.getByText('Enter a valid email address')).toBeVisible()
      expect(requests.filter((request) => request.url.pathname.startsWith('/api/auth/sign-in'))).toEqual([])

      await email.fill(user.email)
      await page.getByLabel('Password').fill(user.password)
      expect((await submitLoginForm(page)).status()).toBe(200)
      await page.waitForURL((url) => url.pathname !== '/login', { timeout: 15_000 })
      expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(target)
      await expect(page).toHaveTitle('Tasks · scantor')
      // The password typed into the form never reaches browser storage.
      await expectStorageWithout(page, [user.password])
    },
  )

  test('wrong credentials show an inline alert and no toast; a 429 asks to wait a minute', { tag: ['@UI-AUTH-002'] }, async ({ page, user }) => {
    await openPage(page, '/login')
    await page.getByLabel('Email').fill(user.email)
    await page.getByLabel('Password').fill(`${user.password}-wrong`)
    expect((await submitLoginForm(page)).status()).toBe(401)
    const alert = page.getByTestId('login-error')
    await expect(alert).toHaveText(/Invalid email or password/)
    await expect(alert).toHaveAttribute('role', 'alert')
    await expect(notifications(page)).toHaveCount(0)
    await expect(page).toHaveURL(/\/login$/)

    // better-auth's rate limit (10 sign-ins per minute per IP) cannot be reached safely on the shared stack.
    await page.route('**/api/auth/sign-in/email', (route) =>
      fulfillJson(route, { code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Please try again later.' }, 429),
    )
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(alert).toHaveText(/Too many attempts, try again in a minute/)
    await expect(notifications(page)).toHaveCount(0)
  })

  test('a banned user sees "Your account is banned" on sign-in and on /login?banned=1', { tag: ['@UI-AUTH-003'] }, async ({ page, adminApi }) => {
    await openPage(page, '/login?banned=1')
    await expect(page.getByTestId('login-error')).toHaveText(/Your account is banned/)

    const banned = await createUser(adminApi, { prefix: 'banned' })
    try {
      ok(await adminApi.call('banUser', { path: { userId: banned.id }, body: { reason: 'ui test', cancelScans: true } }), 'banUser')
      await openPage(page, '/login')
      await expect(page.getByTestId('login-error')).toHaveCount(0)
      await page.getByLabel('Email').fill(banned.email)
      await page.getByLabel('Password').fill(banned.password)
      expect((await submitLoginForm(page)).status()).toBe(403)
      await expect(page.getByTestId('login-error')).toHaveText(/Your account is banned/)
      await expect(page).toHaveURL(/\/login$/)
    } finally {
      await deleteUser(adminApi, banned.id)
    }
  })

  test('a redirect to another origin falls back to the overview after sign-in', { tag: ['@UI-NAV-013'] }, async ({ page, user, env }) => {
    await openPage(page, `/login?redirect=${encodeURIComponent('https://evil.example/steal')}`)
    await page.getByLabel('Email').fill(user.email)
    await page.getByLabel('Password').fill(user.password)
    expect((await submitLoginForm(page)).status()).toBe(200)
    await expect(page).toHaveURL((url) => url.origin === env.publicUrl && url.pathname === '/' && url.search === '')
    await expect(page).toHaveTitle('Overview · scantor')
  })
})

test.describe('signed-in visits to /login', () => {
  test('a valid session goes straight to the redirect target', { tag: ['@UI-AUTH-004'] }, async ({ page }) => {
    await openPage(page, `/login?redirect=${encodeURIComponent('/templates?x=1')}`)
    await expect(page).toHaveURL((url) => url.pathname === '/templates' && url.search === '?x=1')
    await expect(page).toHaveTitle('Templates · scantor')
  })

  // The same check runs for the form sign-in above; a valid session follows the redirect without a sign-in.
  const unsafe: [string, string][] = [
    ['a protocol-relative URL', '//evil.example/x'],
    ['a backslash path', '/\\evil.example'],
    ['an absolute https URL', 'https://evil.example/'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a control character', '/tasks\nx'],
    ['a value over 2048 characters', `/tasks?q=${'a'.repeat(2050)}`],
  ]
  for (const [label, redirect] of unsafe) {
    test(`a redirect with ${label} falls back to /`, { tag: ['@UI-NAV-013'] }, async ({ page, env }) => {
      await openPage(page, `/login?redirect=${encodeURIComponent(redirect)}`)
      await expect(page).toHaveURL((url) => url.origin === env.publicUrl && url.pathname === '/' && url.search === '')
      await expect(page).toHaveTitle('Overview · scantor')
    })
  }

  test('a 401 from the API on a protected page navigates to /login with the current path', { tag: ['@UI-NAV-017'] }, async ({ page }) => {
    await openPage(page, '/tasks?language=python')
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
    // The session disappears (as when it is revoked from another browser); the next API call answers 401.
    await page.context().clearCookies()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page).toHaveURL((url) => url.pathname === '/login' && url.searchParams.get('redirect') === '/tasks?language=python')
  })
})

test.describe('session loss', () => {
  test.use({ pageUser: 'fresh' })

  test(
    'a user banned while signed in gets 401 on the next API call, lands on /login?redirect= and sees the ban on signing in',
    { tag: ['@UI-NAV-018'] },
    async ({ page, freshUser, freshApi, adminApi }) => {
      await openPage(page, '/tasks')
      await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
      ok(await adminApi.call('banUser', { path: { userId: freshUser.id }, body: { reason: unique('ui-ban'), cancelScans: false } }), 'banUser')
      // The ban deleted the session first (docs/auth.md §5.7): the next call answers 401, not 403 banned.
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await expect(page).toHaveURL((url) => url.pathname === '/login' && url.searchParams.get('redirect') === '/tasks')
      expect((await freshApi.getAccount()).status).toBe(401)
      // Signing in again shows the ban (UI-AUTH-003) and stays on the login page.
      await page.getByLabel('Email').fill(freshUser.email)
      await page.getByLabel('Password').fill(freshUser.password)
      expect((await submitLoginForm(page)).status()).toBe(403)
      await expect(page.getByTestId('login-error')).toHaveText(/Your account is banned/)
      await expect(page).toHaveURL((url) => url.pathname === '/login')
      // Protected pages keep redirecting to the login page.
      await openPage(page, '/scans')
      await expect(page).toHaveURL((url) => url.pathname === '/login' && url.searchParams.get('redirect') === '/scans')
    },
  )

  test(
    'a user whose session outlives the ban gets 403 banned, is signed out and lands on /login?banned=1 with "Your account is banned"',
    { tag: ['@UI-NAV-018'] },
    async ({ page, freshUser, freshApi }) => {
      await openPage(page, '/tasks')
      await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
      // Only the banned flag, as before banUser deleted the sessions: the session is read fresh and answers 403 banned.
      await setBannedFlag(freshUser.id, true)
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await expect(page).toHaveURL((url) => url.pathname === '/login' && url.searchParams.get('banned') === '1')
      await expect(page.getByTestId('login-error')).toHaveText(/Your account is banned/)
      // The page signed the session out.
      expect((await freshApi.getAccount()).status).toBe(401)
    },
  )

  test(
    'signing out from the user menu ends the session and protected pages redirect to /login',
    { tag: ['@UI-NAV-009'] },
    async ({ page, freshUser, freshApi }) => {
      await openPage(page, '/')
      const menu = page.getByTestId('user-menu')
      await expect(menu).toContainText(freshUser.email)
      await expect(menu).toContainText(freshUser.name)
      // Initials from the name `fresh-<worker>-<time>-<rand>`: the first letters of its first two parts.
      const initials = freshUser.name
        .split(/[\s@._-]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]!.toUpperCase())
        .join('')
      await expect(menu.locator('[aria-hidden="true"]').first()).toHaveText(initials)
      await expect(menu.locator('[data-slot="label"]').filter({ hasText: /^admin$/ })).toHaveCount(0)

      await menu.click()
      const items = page.getByRole('menuitem')
      await expect(items).toHaveText(['Account', 'CLI & MCP access', 'Sign out'])
      await page.getByRole('menuitem', { name: 'Account' }).click()
      await expect(page).toHaveURL(/\/account$/)

      await page.getByTestId('user-menu').click()
      await page.getByRole('menuitem', { name: 'CLI & MCP access' }).click()
      await expect(page).toHaveURL(/\/account\/access$/)

      await page.getByTestId('user-menu').click()
      await page.getByRole('menuitem', { name: 'Sign out' }).click()
      await expect(page).toHaveURL(/\/login$/)
      // The session ended on the server, not only in this browser.
      expect((await freshApi.getAccount()).status).toBe(401)
      await openPage(page, '/scans')
      await expect(page).toHaveURL((url) => url.pathname === '/login' && url.searchParams.get('redirect') === '/scans')
    },
  )
})

test.describe('admin user menu', () => {
  test.use({ role: 'admin' })

  test('the user menu shows the admin badge for admins', { tag: ['@UI-NAV-009'] }, async ({ page, env }) => {
    await openPage(page, '/')
    const menu = page.getByTestId('user-menu')
    await expect(menu).toContainText(env.admin.email)
    await expect(menu.locator('[data-slot="label"]').filter({ hasText: /^admin$/ })).toBeVisible()
  })
})
