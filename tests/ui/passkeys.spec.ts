import type { Page } from '@playwright/test'
import { ok } from '../helpers/api-client'
import { reserve } from '../helpers/limiter'
import { openPage, freshTenantHandle, nodeRoutedContext, workerTenant } from '../helpers/ui-shell-tasks'
import { expect, test as base } from '../fixtures'

// The worker's tenant and fresh users under session files of their own (sign-ins wait out a 429), and the dashboard's
// requests sent from Node (helpers/ui-shell-tasks.ts).
const test = base.extend({ user: [workerTenant, { scope: 'worker' }], freshUserHandle: freshTenantHandle, context: nodeRoutedContext })

// Passkeys (docs/ui.md §5.1, §5.17, docs/auth.md §2): adding, renaming and removing passkeys on the account page, the
// password of a passkey account, and signing in with a passkey. Everything runs on `freshUser` with a CDP virtual
// authenticator (`webauthn`); passkey sign-ins reserve a limiter slot first.

test.use({ pageUser: 'fresh' })

function section(page: Page, heading: string) {
  return page.locator('section', { has: page.getByRole('heading', { name: heading, exact: true }) })
}

test.describe('passkeys', () => {
  test(
    'add, rename and remove passkeys; remove and set the password; the last way to sign in stays',
    { tag: ['@UI-ACCT-005', '@UI-ACCT-004'] },
    async ({ page, webauthn, freshApi }) => {
      await openPage(page, '/account')
      const passkeys = section(page, 'Passkeys')
      const password = section(page, 'Password')
      const rows = passkeys.getByRole('list', { name: 'Your passkeys' }).locator('li[data-row-id]')
      await expect(passkeys.getByText('No passkeys yet.')).toBeVisible()
      await expect(password.getByRole('button', { name: 'Remove password' })).toHaveCount(0)

      // Add a named passkey.
      await expect(passkeys.getByLabel('New passkey name')).toHaveAttribute('placeholder', 'e.g. MacBook Touch ID')
      await passkeys.getByLabel('New passkey name').fill('Laptop key')
      await passkeys.getByRole('button', { name: 'Add passkey' }).click()
      await expect(passkeys.getByRole('status')).toHaveText('Passkey added')
      await expect(rows).toHaveCount(1)
      await expect(rows.first()).toContainText('Laptop key')
      await expect(rows.first()).toContainText(/added (just now|\d+ min ago)/)
      await expect(rows.first().getByText(/^(synced|device-bound)$/)).toBeVisible()
      expect(await webauthn.listCredentials()).toHaveLength(1)
      expect(ok(await freshApi.getAccount(), 'getAccount').credentials.passkeyCount).toBe(1)

      // Rename inline.
      await passkeys.getByRole('button', { name: 'Rename passkey Laptop key' }).click()
      await passkeys.getByRole('textbox', { name: 'New name for Laptop key' }).fill('Work key')
      await passkeys.getByRole('button', { name: 'Save name of Laptop key' }).click()
      await expect(rows.first()).toContainText('Work key')
      await expect(passkeys.getByRole('button', { name: 'Rename passkey Work key' })).toBeVisible()

      // With a password and a passkey, the password can be removed after a second confirmation.
      const remove = password.getByRole('button', { name: 'Remove password' })
      await remove.click()
      await expect(password.getByRole('button', { name: 'Confirm: remove password' })).toBeVisible()
      await password.getByRole('button', { name: 'Keep password' }).click()
      await expect(remove).toBeVisible()
      expect(ok(await freshApi.getAccount(), 'getAccount').credentials.hasPassword).toBe(true)
      await remove.click()
      await password.getByRole('button', { name: 'Confirm: remove password' }).click()
      await expect(password.getByRole('status')).toHaveText('Password removed; sign in with a passkey from now on')
      expect(ok(await freshApi.getAccount(), 'getAccount').credentials.hasPassword).toBe(false)

      // A passkey-only account: the last passkey cannot be removed, and a password can be set.
      const removePasskey = passkeys.getByRole('button', { name: 'Remove passkey Work key' })
      await expect(removePasskey).toBeDisabled()
      await expect(removePasskey).toHaveAttribute('title', 'Your last way to sign in cannot be removed')
      await expect(password.getByRole('button', { name: 'Remove password' })).toHaveCount(0)
      await expect(password.getByText('Your account has no password; you sign in with a passkey.')).toBeVisible()
      await password.getByLabel(/^New password\*?$/).fill('a-new-password-123')
      await password.getByLabel('Confirm new password').fill('a-new-password-123')
      await password.getByRole('button', { name: 'Set password' }).click()
      await expect(password.getByRole('status')).toHaveText('Password set')
      expect(ok(await freshApi.getAccount(), 'getAccount').credentials.hasPassword).toBe(true)
      await expect(password.getByRole('button', { name: 'Change password' })).toBeVisible()

      // With a password again, the passkey is removable in two steps.
      await expect(removePasskey).toBeEnabled()
      await removePasskey.click()
      await expect(passkeys.getByRole('button', { name: 'Confirm remove passkey Work key' })).toBeVisible()
      await passkeys.getByRole('button', { name: 'Keep passkey Work key' }).click()
      await expect(rows).toHaveCount(1)
      await passkeys.getByRole('button', { name: 'Remove passkey Work key' }).click()
      await passkeys.getByRole('button', { name: 'Confirm remove passkey Work key' }).click()
      await expect(passkeys.getByRole('status')).toHaveText('Passkey removed')
      await expect(passkeys.getByText('No passkeys yet.')).toBeVisible()
      expect(ok(await freshApi.getAccount(), 'getAccount').credentials.passkeyCount).toBe(0)

      // A passkey without a name.
      await passkeys.getByRole('button', { name: 'Add passkey' }).click()
      await expect(passkeys.getByRole('status')).toHaveText('Passkey added')
      await expect(rows.first()).toContainText('Unnamed passkey')
    },
  )

  test(
    '"Sign in with passkey" signs in with the virtual authenticator and lands on the redirect target',
    { tag: ['@UI-AUTH-005'] },
    async ({ page, webauthn, freshUser }) => {
      await openPage(page, '/account')
      const passkeys = section(page, 'Passkeys')
      await passkeys.getByLabel('New passkey name').fill('Sign-in key')
      await passkeys.getByRole('button', { name: 'Add passkey' }).click()
      await expect(passkeys.getByRole('status')).toHaveText('Passkey added')
      expect(await webauthn.listCredentials()).toHaveLength(1)

      await page.getByTestId('user-menu').click()
      await page.getByRole('menuitem', { name: 'Sign out' }).click()
      await expect(page).toHaveURL(/\/login$/)

      await openPage(page, `/login?redirect=${encodeURIComponent('/templates')}`)
      const button = page.getByRole('button', { name: 'Sign in with passkey' })
      await expect(button).toBeVisible()
      await reserve('/passkey/verify-authentication')
      await button.click()
      await expect(page).toHaveURL((url) => url.pathname === '/templates', { timeout: 15_000 })
      await expect(page.getByTestId('user-menu')).toContainText(freshUser.email)
    },
  )
})
