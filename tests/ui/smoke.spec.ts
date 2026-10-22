import { browserSignIn } from '../helpers/users'
import { expect, test } from '../fixtures'

// Smoke test of the browser plumbing: Chromium trusts the test CA, and the login form signs the worker's tenant in.

test.describe('UI plumbing', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('a user signs in with email and password and lands on the overview', { tag: ['@F2.1'] }, async ({ page, user }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/login/)
    await browserSignIn(page, user)
    await expect(page).toHaveTitle('Overview · scantor')
  })
})
