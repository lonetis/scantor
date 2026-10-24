import { nodeRoutedContext, openPage, submitLoginForm, workerTenant } from '../helpers/ui-shell-tasks'
import { expect, test as base } from '../fixtures'

// The worker's tenant under a session file of its own, and the dashboard's requests sent from Node (helpers/ui-shell-tasks.ts).
const test = base.extend({ user: [workerTenant, { scope: 'worker' }], context: nodeRoutedContext })

// Smoke test of the browser plumbing: Chromium trusts the test CA, and the login form signs the worker's tenant in.

test.describe('UI plumbing', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('a user signs in with email and password and lands on the overview', { tag: ['@UI-AUTH-001'] }, async ({ page, user }) => {
    await openPage(page, '/')
    await expect(page).toHaveURL(/\/login/)
    await page.getByLabel('Email').fill(user.email)
    await page.getByLabel('Password').fill(user.password)
    // Reserves a limiter slot and waits out a 429 of the shared per-IP budget.
    expect((await submitLoginForm(page)).status()).toBe(200)
    await page.waitForURL((url) => url.pathname !== '/login', { timeout: 15_000 })
    await expect(page).toHaveTitle('Overview · scantor')
  })
})
