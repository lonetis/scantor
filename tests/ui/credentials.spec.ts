import type { Page } from '@playwright/test'
import type { Credential } from '#shared/types/credentials'
import { ok } from '../helpers/api-client'
import { GIT_REPOS, GIT_URL, PRIVATE_GIT_CREDENTIAL } from '../helpers/fixtures-server'
import { expectToast } from '../helpers/ui'
import {
  createCredential,
  deleteCredentialsNamed,
  deleteTaskAndWait,
  listCredentials,
  openPage,
  nodeRoutedContext,
  workerTenant,
} from '../helpers/ui-shell-tasks'
import { expect, test as base, unique } from '../fixtures'

// The worker's tenant under a session file of its own, and the dashboard's requests sent from Node (helpers/ui-shell-tasks.ts).
const test = base.extend({ user: [workerTenant, { scope: 'worker' }], context: nodeRoutedContext })

// Git credentials (docs/ui.md §5.19): the table, create, edit (an empty token keeps the stored one), two-step delete,
// and a saved credential in the git import form that makes the import of a private repository work.

const GIT_HOST = new URL(GIT_URL).host

function credentialRow(page: Page, id: string) {
  return page.getByLabel('Git credentials', { exact: true }).locator(`tr[data-row-id="${id}"]`)
}

test.describe('git credentials page', () => {
  test('the table lists name, host, username, the token as ••••last4, last use and creation', { tag: ['@UI-ACCT-013'] }, async ({ page, api }) => {
    const name = unique('listed')
    try {
      const credential = await createCredential(api, { name, host: 'git.example.test:8443', username: 'robot', token: 'secret-token-9876' })
      await openPage(page, '/account/credentials')
      const table = page.getByLabel('Git credentials', { exact: true })
      for (const header of ['Name', 'Host', 'Username', 'Token', 'Last used', 'Created']) {
        await expect(table.getByRole('columnheader', { name: header, exact: true })).toBeVisible()
      }
      const cells = credentialRow(page, credential.id).getByRole('cell')
      await expect(cells.nth(0)).toHaveText(name)
      await expect(cells.nth(1)).toHaveText('git.example.test:8443')
      await expect(cells.nth(2)).toHaveText('robot')
      await expect(cells.nth(3)).toHaveText('••••9876')
      await expect(cells.nth(4)).toHaveText('never')
      await expect(cells.nth(5).locator('time')).toHaveText(/just now|min ago/)
      await expect(page.getByText('secret-token-9876')).toHaveCount(0)
    } finally {
      await deleteCredentialsNamed(api, [name])
    }
  })

  test('creates, edits (keeping the token when the field is empty) and deletes in two steps', { tag: ['@UI-ACCT-014'] }, async ({ page, api }) => {
    const name = unique('cred')
    const renamed = unique('renamed')
    const taken = unique('taken')
    try {
      await createCredential(api, { name: taken, host: 'git.example.test', token: 'tok-taken-0000' })
      await openPage(page, '/account/credentials')
      await page.getByRole('button', { name: 'New credential' }).click()
      let dialog = page.getByRole('dialog', { name: 'New credential' })
      await expect(dialog.getByLabel('Username')).toHaveValue('x-access-token')
      const token = dialog.getByRole('textbox', { name: 'Token' })
      await expect(token).toHaveAttribute('type', 'password')
      await dialog.getByRole('textbox', { name: /^Name\*?$/ }).fill(name)
      await dialog.getByLabel('Host').fill('https://git.example.test/org')
      await token.fill('tok-new-1111')
      await dialog.getByRole('button', { name: 'Create credential' }).click()
      await expect(dialog.getByText('must be host[:port] without scheme, credentials or path')).toBeVisible()
      await dialog.getByLabel('Host').fill('git.example.test')
      await dialog.getByRole('button', { name: 'Show value of token' }).click()
      await expect(token).toHaveAttribute('type', 'text')
      await dialog.getByRole('button', { name: 'Create credential' }).click()
      await expectToast(page, `Credential ${name} saved`)
      await expect(dialog).toBeHidden()

      const created = (await listCredentials(api)).find((credential) => credential.name === name) as Credential
      expect(created).toEqual(expect.objectContaining({ host: 'git.example.test', username: 'x-access-token', last4: '1111' }))
      await expect(credentialRow(page, created.id).getByRole('cell').nth(3)).toHaveText('••••1111')

      // A duplicate name is reported in the form.
      await page.getByRole('button', { name: 'New credential' }).click()
      dialog = page.getByRole('dialog', { name: 'New credential' })
      await dialog.getByRole('textbox', { name: /^Name\*?$/ }).fill(taken)
      await dialog.getByLabel('Host').fill('git.example.test')
      await dialog.getByRole('textbox', { name: 'Token' }).fill('tok-dupe-2222')
      await dialog.getByRole('button', { name: 'Create credential' }).click()
      await expect(dialog.getByText('A credential with this name already exists.')).toBeVisible()
      await dialog.getByRole('button', { name: 'Cancel' }).click()

      // Editing with an empty token keeps the stored one.
      await page.getByRole('button', { name: `Edit credential ${name}` }).click()
      dialog = page.getByRole('dialog', { name: `Edit ${name}` })
      await expect(dialog.getByRole('textbox', { name: 'Token' })).toHaveValue('')
      await expect(dialog.getByText('Leave empty to keep the stored token.')).toBeVisible()
      await dialog.getByRole('textbox', { name: /^Name\*?$/ }).fill(renamed)
      const patch = page.waitForRequest((r) => r.method() === 'PATCH' && new URL(r.url()).pathname === `/api/credentials/${created.id}`)
      await dialog.getByRole('button', { name: 'Save credential' }).click()
      expect((await patch).postDataJSON()).toEqual({ name: renamed })
      await expectToast(page, `Credential ${renamed} saved`)
      const edited = (await listCredentials(api)).find((credential) => credential.id === created.id)!
      expect(edited).toEqual(expect.objectContaining({ name: renamed, last4: '1111' }))
      await expect(credentialRow(page, created.id).getByRole('cell').nth(0)).toHaveText(renamed)

      // A new host needs the token again: the API never sends a stored token to another host.
      await page.getByRole('button', { name: `Edit credential ${renamed}` }).click()
      dialog = page.getByRole('dialog', { name: `Edit ${renamed}` })
      await dialog.getByLabel('Host').fill('git2.example.test')
      await expect(dialog.getByText('Required for a new host: the token is sent only to the host it was saved for.')).toBeVisible()
      await dialog.getByRole('button', { name: 'Save credential' }).click()
      await expect(dialog.getByText('required', { exact: true })).toBeVisible()
      await dialog.getByRole('textbox', { name: 'Token' }).fill('tok-moved-3333')
      const moved = page.waitForRequest((r) => r.method() === 'PATCH' && new URL(r.url()).pathname === `/api/credentials/${created.id}`)
      await dialog.getByRole('button', { name: 'Save credential' }).click()
      expect((await moved).postDataJSON()).toEqual({ host: 'git2.example.test', token: 'tok-moved-3333' })
      await expectToast(page, `Credential ${renamed} saved`)
      expect((await listCredentials(api)).find((credential) => credential.id === created.id)).toEqual(
        expect.objectContaining({ host: 'git2.example.test', last4: '3333' }),
      )

      // Delete in two steps.
      await page.getByRole('button', { name: `Delete credential ${renamed}` }).click()
      const confirm = page.getByRole('button', { name: `Confirm deleting credential ${renamed}` })
      await expect(confirm).toBeVisible()
      expect((await listCredentials(api)).some((credential) => credential.id === created.id)).toBe(true)
      await confirm.click()
      await expectToast(page, `Credential ${renamed} deleted`)
      await expect(credentialRow(page, created.id)).toHaveCount(0)
      expect((await listCredentials(api)).some((credential) => credential.id === created.id)).toBe(false)
    } finally {
      await deleteCredentialsNamed(api, [name, renamed, taken])
    }
  })

  test('a saved credential is offered in the git import form and imports a private repository', { tag: ['@UI-ACCT-015'] }, async ({ page, api, tasks }) => {
    test.setTimeout(180_000)
    const name = unique('private')
    tasks.track('git-private')
    try {
      // Without the credential the private repository cannot be read.
      const denied = await api.call<{ error: { code: string } }>('importGitTask', { body: { url: GIT_REPOS.private } })
      expect(denied.status).toBe(422)
      expect(denied.body.error.code).toBe('gitFailed')

      await createCredential(api, { name, host: GIT_HOST, username: PRIVATE_GIT_CREDENTIAL.username, token: PRIVATE_GIT_CREDENTIAL.token })
      await openPage(page, '/tasks/new')
      await page
        .getByRole('list', { name: 'Task source' })
        .getByRole('button', { name: /^Import from git/ })
        .click()
      await page.getByRole('textbox', { name: 'Repository URL' }).fill(GIT_REPOS.private)
      await page.getByRole('combobox', { name: 'Git credential' }).click()
      await page.getByRole('option', { name: `${name} (${GIT_HOST})` }).click()
      await page.getByRole('button', { name: 'Import', exact: true }).click()
      await expect(page).toHaveURL((url) => /^\/tasks\/[0-9a-f-]{36}$/.test(url.pathname), { timeout: 60_000 })
      const task = ok(await api.getTask('git-private'), 'getTask')
      expect(new URL(page.url()).pathname).toBe(`/tasks/${task.id}`)
      expect(task.source.git?.url).toBe(GIT_REPOS.private)

      // The credential records its use.
      const used = (await listCredentials(api)).find((credential) => credential.name === name)!
      expect(used.lastUsedAt).not.toBeNull()
    } finally {
      await deleteTaskAndWait(api, 'git-private')
      await deleteCredentialsNamed(api, [name])
    }
  })
})
