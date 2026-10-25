import type { Locator, Page } from '@playwright/test'
import type { JobAccepted } from '#shared/types/common'
import type { Job } from '#shared/types/jobs'
import type { User } from '#shared/types/users'
import { ok, type ApiClient } from '../helpers/api-client'
import { env } from '../helpers/env'
import { expectToast } from '../helpers/ui'
import {
  deleteUsersByEmail,
  expectToastAnywhere,
  findUserByEmail,
  fulfillJson,
  nodeRoutedContext,
  openPage,
  patchJsonResponse,
  reloadPage,
  signedInContextWithRetry,
  workerTenant,
} from '../helpers/ui-shell-tasks'
import { createUser, deleteUser, type TestUser } from '../helpers/users'
import { expect, test as base, unique } from '../fixtures'

// The worker's tenant under a session file of its own, and the dashboard's requests sent from Node (helpers/ui-shell-tasks.ts).
const test = base.extend({ user: [workerTenant, { scope: 'worker' }], context: nodeRoutedContext })

// The users page (docs/ui.md §5.16). Every test creates its own users (deleted afterwards) and finds them through the
// search, so other users of the shared stack never matter; the seeded admin's own row is only read.

// The seeded admin's saved session; overriding the storage state also spares the worker's tenant (and its sign-in).
test.use({ role: 'admin', storageState: env.paths.adminState })

function userRow(page: Page, id: string): Locator {
  return page.getByLabel('Users', { exact: true }).locator(`tr[data-row-id="${id}"]`)
}

function userRows(page: Page): Locator {
  return page.getByLabel('Users', { exact: true }).locator('tbody tr[data-row-id]')
}

async function search(page: Page, text: string): Promise<void> {
  const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/users' && new URL(r.url()).searchParams.get('q') === text)
  await page.getByRole('textbox', { name: 'Search users' }).fill(text)
  await request
}

/** The cell of a column, by the column header's position. */
async function cell(page: Page, row: Locator, header: string): Promise<Locator> {
  const headers = await page.getByLabel('Users', { exact: true }).locator('thead th').allInnerTexts()
  const index = headers.findIndex((text) => text.trim() === header)
  if (index < 0) throw new Error(`no column ${header} in ${JSON.stringify(headers)}`)
  return row.locator('td').nth(index)
}

async function openActions(page: Page, email: string): Promise<Locator> {
  await page.getByRole('button', { name: `User actions for ${email}` }).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  return menu
}

async function getUser(adminApi: ApiClient, userId: string): Promise<User> {
  return ok(await adminApi.getUser(userId), 'getUser')
}

test.describe('users table', () => {
  test(
    'searches by name or email and shows role, status, privileged flag, worker limit, usage and creation',
    { tag: ['@UI-ADMIN-007'] },
    async ({ page, adminApi }) => {
      const prefix = unique('tbl')
      const created: TestUser[] = []
      try {
        created.push(await createUser(adminApi, { prefix: `${prefix}-a`, canRunPrivileged: true, maxWorkers: 0 }))
        created.push(await createUser(adminApi, { prefix: `${prefix}-b`, maxWorkers: 5 }))
        const [a, b] = created as [TestUser, TestUser]
        const reason = `banned by ${unique('ui')}`
        ok(await adminApi.call('banUser', { path: { userId: b.id }, body: { reason, cancelScans: false } }), 'banUser')

        await openPage(page, '/admin/users')
        for (const header of ['Name', 'Email', 'Role', 'Status', 'Privileged', 'Worker limit', 'Usage', 'Created']) {
          await expect(page.getByLabel('Users', { exact: true }).getByRole('columnheader', { name: header, exact: true })).toBeVisible()
        }
        await search(page, prefix)
        await expect(userRows(page)).toHaveCount(2)

        const rowA = userRow(page, a.id)
        await expect(await cell(page, rowA, 'Name')).toHaveText(a.name)
        await expect(await cell(page, rowA, 'Email')).toHaveText(a.email)
        await expect(await cell(page, rowA, 'Role')).toHaveText('user')
        await expect(await cell(page, rowA, 'Status')).toHaveText('active')
        await expect(await cell(page, rowA, 'Privileged')).toHaveText('privileged')
        await expect(await cell(page, rowA, 'Worker limit')).toHaveText('unlimited')
        const usage = (await getUser(adminApi, a.id)).usage
        await expect(await cell(page, rowA, 'Usage')).toHaveText(`${usage.activeWorkers} workers · ${usage.tasks} tasks · ${usage.scans} scans`)
        await expect((await cell(page, rowA, 'Created')).locator('time')).toHaveText(/just now|\d+ min ago/)

        const rowB = userRow(page, b.id)
        await expect((await cell(page, rowB, 'Status')).getByText('banned', { exact: true })).toBeVisible()
        await expect(await cell(page, rowB, 'Status')).toContainText(reason)
        await expect(await cell(page, rowB, 'Privileged')).toHaveText('no')
        await expect(await cell(page, rowB, 'Worker limit')).toHaveText('5')

        // Search by the exact email of one user, and by name.
        await search(page, b.email)
        await expect(userRows(page)).toHaveCount(1)
        await expect(rowB).toBeVisible()
        await search(page, a.name)
        await expect(userRows(page)).toHaveCount(1)
        await expect(rowA).toBeVisible()

        // The admin's own row says "(you)", other rows do not.
        await expect((await cell(page, rowA, 'Name')).getByText('(you)')).toHaveCount(0)
        await search(page, env.admin.email)
        const me = ok(await adminApi.getAccount(), 'getAccount')
        const own = userRow(page, me.id)
        await expect((await cell(page, own, 'Name')).getByText('(you)')).toBeVisible()
        await expect(await cell(page, own, 'Role')).toHaveText('admin')
      } finally {
        for (const user of created) await deleteUser(adminApi, user.id)
      }
    },
  )
})

test.describe('creating and editing users', () => {
  test('"New user" creates a user with every field and reports a duplicate email', { tag: ['@UI-ADMIN-008'] }, async ({ page, adminApi }) => {
    const name = unique('new')
    const email = `${name}@scantor.test`
    try {
      await openPage(page, '/admin/users')
      await page.getByRole('button', { name: 'New user' }).click()
      const dialog = page.getByRole('dialog', { name: 'New user' })
      await dialog.getByRole('textbox', { name: 'Email' }).fill(email)
      await dialog.getByRole('textbox', { name: 'Name' }).fill(name)
      await dialog.getByLabel('Initial password').fill('short')
      await dialog.getByRole('button', { name: 'Create user' }).click()
      await expect(dialog.getByText(/>=8 characters/)).toBeVisible()

      await dialog.getByLabel('Initial password').fill('a-long-enough-password')
      await dialog.getByRole('combobox', { name: 'Role' }).click()
      await page.getByRole('option', { name: 'admin', exact: true }).click()
      await dialog.getByRole('switch', { name: 'Can run privileged tasks' }).click()
      await dialog.getByLabel('Worker limit').fill('7')
      const post = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/users')
      await dialog.getByRole('button', { name: 'Create user' }).click()
      expect((await post).postDataJSON()).toEqual({ email, name, password: 'a-long-enough-password', role: 'admin', canRunPrivileged: true, maxWorkers: 7 })
      await expectToast(page, `User ${email} created`)
      await expect(dialog).toBeHidden()
      const user = (await findUserByEmail(adminApi, email))!
      expect(user).toEqual(expect.objectContaining({ name, role: 'admin', canRunPrivileged: true, maxWorkers: 7, banned: false }))
      await search(page, email)
      await expect(userRow(page, user.id)).toBeVisible()

      // The same email again: the error stays in the form.
      await page.getByRole('button', { name: 'New user' }).click()
      await dialog.getByRole('textbox', { name: 'Email' }).fill(email)
      await dialog.getByRole('textbox', { name: 'Name' }).fill(`${name} again`)
      await dialog.getByLabel('Initial password').fill('a-long-enough-password')
      await dialog.getByRole('button', { name: 'Create user' }).click()
      await expect(dialog.getByRole('alert')).toHaveText('A user with this email already exists.')
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(userRows(page)).toHaveCount(1)
    } finally {
      await deleteUsersByEmail(adminApi, [email])
    }
  })

  test(
    'editing sends only changed fields; the own row cannot change its role, password, ban or delete',
    { tag: ['@UI-ADMIN-009'] },
    async ({ page, adminApi }) => {
      let target: TestUser | undefined
      try {
        target = await createUser(adminApi, { prefix: 'edit', maxWorkers: 3 })
        await openPage(page, '/admin/users')
        await search(page, target.email)
        await openActions(page, target.email)
        await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: `Edit ${target.email}` })
        await expect(dialog.getByRole('textbox', { name: 'Email' })).toHaveValue(target.email)
        await expect(dialog.getByRole('combobox', { name: 'Role' })).toBeEnabled()
        const renamed = `${target.name} renamed`
        await dialog.getByRole('textbox', { name: 'Name' }).fill(renamed)
        await dialog.getByLabel('Worker limit').fill('9')
        const patch = page.waitForRequest((r) => r.method() === 'PATCH' && new URL(r.url()).pathname === `/api/users/${target!.id}`)
        await dialog.getByRole('button', { name: 'Save user' }).click()
        expect((await patch).postDataJSON()).toEqual({ name: renamed, maxWorkers: 9 })
        await expect(dialog).toBeHidden()
        await expect(await cell(page, userRow(page, target.id), 'Name')).toHaveText(renamed)
        await expect(await cell(page, userRow(page, target.id), 'Worker limit')).toHaveText('9')
        expect(await getUser(adminApi, target.id)).toEqual(expect.objectContaining({ name: renamed, maxWorkers: 9, role: 'user', email: target.email }))

        // The admin's own row.
        const me = ok(await adminApi.getAccount(), 'getAccount')
        await search(page, env.admin.email)
        const menu = await openActions(page, env.admin.email)
        for (const item of ['Set password', 'Ban', 'Delete'])
          await expect(menu.getByRole('menuitem', { name: item, exact: true })).toHaveAttribute('aria-disabled', 'true')
        await menu.getByRole('menuitem', { name: 'Edit', exact: true }).click()
        const own = page.getByRole('dialog', { name: `Edit ${env.admin.email}` })
        await expect(own.getByRole('combobox', { name: 'Role' })).toBeDisabled()
        await expect(own.getByText('You cannot change your own role.')).toBeVisible()
        await own.getByRole('button', { name: 'Cancel' }).click()
        await expect(own).toBeHidden()
        expect((await getUser(adminApi, me.id)).role).toBe('admin')
      } finally {
        if (target) await deleteUser(adminApi, target.id)
      }
    },
  )

  test('"Set password" confirms the password, notes the sign-out everywhere and signs the user out', { tag: ['@UI-ADMIN-010'] }, async ({ page, adminApi }) => {
    let target: TestUser | undefined
    try {
      target = await createUser(adminApi, { prefix: 'pw' })
      const session = await signedInContextWithRetry(target.email, target.password)
      try {
        expect((await session.get('/api/account')).status()).toBe(200)
        await openPage(page, '/admin/users')
        await search(page, target.email)
        await openActions(page, target.email)
        await page.getByRole('menuitem', { name: 'Set password', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: `Set password of ${target.email}` })
        await expect(dialog.getByText('Setting a password signs the user out everywhere.')).toBeVisible()
        await dialog.getByLabel('New password').fill('the-new-password-1')
        await dialog.getByLabel('Confirm password').fill('the-new-password-2')
        await dialog.getByRole('button', { name: 'Set password' }).click()
        await expect(dialog.getByText('The passwords do not match')).toBeVisible()

        await dialog.getByLabel('Confirm password').fill('the-new-password-1')
        const put = page.waitForRequest((r) => r.method() === 'PUT' && new URL(r.url()).pathname === `/api/users/${target!.id}/password`)
        await dialog.getByRole('button', { name: 'Set password' }).click()
        expect((await put).postDataJSON()).toEqual({ password: 'the-new-password-1' })
        await expectToast(page, `Password of ${target.email} set`)
        await expect(dialog).toBeHidden()
        // The user's existing session ended.
        await expect.poll(async () => (await session.get('/api/account')).status()).toBe(401)
      } finally {
        await session.dispose()
      }
    } finally {
      if (target) await deleteUser(adminApi, target.id)
    }
  })
})

test.describe('banning and deleting users', () => {
  test('Ban takes a reason and cancels scans by default; Unban returns the user to active', { tag: ['@UI-ADMIN-011'] }, async ({ page, adminApi }) => {
    let target: TestUser | undefined
    try {
      target = await createUser(adminApi, { prefix: 'ban' })
      await openPage(page, '/admin/users')
      await search(page, target.email)
      const row = userRow(page, target.id)
      await expect(await cell(page, row, 'Status')).toHaveText('active')

      await openActions(page, target.email)
      await page.getByRole('menuitem', { name: 'Ban', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: `Ban ${target.email}` })
      const cancelScans = dialog.getByRole('checkbox', { name: 'Also cancel all their scans' })
      await expect(cancelScans).toBeChecked()
      await expect(dialog.getByText('Unchecked, their running scans continue until they end.')).toBeVisible()
      const reason = `ui ban ${unique('reason')}`
      await dialog.getByRole('textbox', { name: 'Reason' }).fill(reason)
      const ban = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === `/api/users/${target!.id}/ban`)
      await dialog.getByRole('button', { name: 'Ban user' }).click()
      expect((await ban).postDataJSON()).toEqual({ reason, cancelScans: true })
      await expect(dialog).toBeHidden()
      await expect((await cell(page, row, 'Status')).getByText('banned', { exact: true })).toBeVisible()
      await expect(await cell(page, row, 'Status')).toContainText(reason)
      expect(await getUser(adminApi, target.id)).toEqual(expect.objectContaining({ banned: true, banReason: reason }))

      // Unchecking the box keeps the scans; a ban without a reason is fine too.
      ok(await adminApi.call('unbanUser', { path: { userId: target.id } }), 'unbanUser')
      await reloadPage(page)
      await search(page, target.email)
      await expect(await cell(page, row, 'Status')).toHaveText('active')
      await openActions(page, target.email)
      await page.getByRole('menuitem', { name: 'Ban', exact: true }).click()
      await dialog.getByRole('checkbox', { name: 'Also cancel all their scans' }).click()
      const second = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === `/api/users/${target!.id}/ban`)
      await dialog.getByRole('button', { name: 'Ban user' }).click()
      expect((await second).postDataJSON()).toEqual({ cancelScans: false })
      await expect((await cell(page, row, 'Status')).getByText('banned', { exact: true })).toBeVisible()

      // Unban.
      const menu = await openActions(page, target.email)
      await expect(menu.getByRole('menuitem', { name: 'Ban', exact: true })).toHaveCount(0)
      const unban = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/users/${target!.id}/unban`)
      await menu.getByRole('menuitem', { name: 'Unban', exact: true }).click()
      expect((await unban).status()).toBe(200)
      await expect(await cell(page, row, 'Status')).toHaveText('active')
      expect((await getUser(adminApi, target.id)).banned).toBe(false)
    } finally {
      if (target) await deleteUser(adminApi, target.id)
    }
  })

  test('Delete needs the email, shows the purge job on the row and removes it with "User deleted"', { tag: ['@UI-ADMIN-012'] }, async ({ page, adminApi }) => {
    let target: TestUser | undefined
    let deleted = false
    try {
      target = await createUser(adminApi, { prefix: 'del' })
      await openPage(page, '/admin/users')
      await search(page, target.email)
      const row = userRow(page, target.id)
      await expect(row).toBeVisible()

      await openActions(page, target.email)
      await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: `Delete ${target.email}` })
      const remove = dialog.getByRole('button', { name: 'Delete user' })
      await expect(remove).toBeDisabled()
      await dialog.getByLabel(`Type ${target.email} to confirm`).fill(target.name)
      await expect(remove).toBeDisabled()
      await dialog.getByLabel(`Type ${target.email} to confirm`).fill(target.email)

      // The job polls are held, so the row's job state stays on screen long enough to be read.
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => (release = resolve))
      let finished = false
      await page.route(
        (url) => url.pathname.startsWith('/api/jobs/'),
        async (route) => {
          await held
          // The real purge waits behind every other user deletion of the shared stack (userPurge runs one at a time),
          // so the page's poll is told that its job succeeded; the page's reaction to that is what is tested here.
          if (finished) await patchJsonResponse<Job>(route, (job) => ({ ...job, state: 'succeeded', finishedAt: new Date().toISOString() }))
          else await route.fallback()
        },
      )
      const accepted = page.waitForResponse((r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname === `/api/users/${target!.id}`)
      await remove.click()
      const response = await accepted
      expect(response.status()).toBe(202)
      const job = ((await response.json()) as JobAccepted).job
      expect(job.kind).toBe('userPurge')
      deleted = true
      const status = await cell(page, row, 'Status')
      await expect(status).toContainText('deleting')
      await expect(status.locator('[data-state]')).toHaveAttribute('data-state', /^(queued|running)$/)
      const menu = await openActions(page, target.email)
      await expect(menu.getByRole('menuitem', { name: 'Delete', exact: true })).toHaveAttribute('aria-disabled', 'true')
      await page.keyboard.press('Escape')
      // The purge is real: the user is locked out and its job is active or already done.
      expect(['queued', 'running', 'succeeded']).toContain(ok(await adminApi.getJob(job.id), 'getJob').state)

      finished = true
      release()
      await expectToastAnywhere(page, 'User deleted')
      await expect(row).toHaveCount(0)
    } finally {
      if (target && !deleted) await deleteUser(adminApi, target.id)
    }
  })

  for (const ending of ['failed', 'cancelled'] as const) {
    test(`a ${ending} purge job shows a toast and unlocks the row for another try`, { tag: ['@UI-ADMIN-012'] }, async ({ page, adminApi }) => {
      let target: TestUser | undefined
      try {
        target = await createUser(adminApi, { prefix: `purge-${ending}` })
        const userId = target.id
        // The stack cannot fail a purge on purpose: deleteUser answers with a job of its own, which then ends this way.
        // The user is never really deleted.
        const jobId = crypto.randomUUID()
        await page.route(
          (url) => url.pathname === `/api/users/${userId}`,
          (route) => (route.request().method() === 'DELETE'
            ? fulfillJson(route, { job: { id: jobId, kind: 'userPurge', state: 'queued' } }, 202)
            : route.fallback()),
        )
        await page.route(
          (url) => url.pathname === `/api/jobs/${jobId}`,
          (route) => fulfillJson(route, {
            id: jobId,
            kind: 'userPurge',
            subject: { kind: 'user', id: userId },
            state: ending,
            progress: { done: 0, total: null },
            attempts: 1,
            error: ending === 'failed' ? { code: 'internal', message: 'the purge could not finish' } : null,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          } satisfies Job),
        )
        await openPage(page, '/admin/users')
        await search(page, target.email)
        const row = userRow(page, userId)
        await openActions(page, target.email)
        await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: `Delete ${target.email}` })
        await dialog.getByLabel(`Type ${target.email} to confirm`).fill(target.email)
        // The row reads the user again once the job ended.
        const reread = page.waitForRequest((r) => r.method() === 'GET' && new URL(r.url()).pathname === `/api/users/${userId}`)
        await dialog.getByRole('button', { name: 'Delete user' }).click()
        await expectToastAnywhere(page, ending === 'failed' ? 'Deleting the user failed' : 'Deleting the user was cancelled')
        await reread
        await expect(row).toBeVisible()
        await expect(await cell(page, row, 'Status')).not.toContainText('deleting')
        const menu = await openActions(page, target.email)
        for (const item of ['Edit', 'Delete']) await expect(menu.getByRole('menuitem', { name: item, exact: true })).not.toHaveAttribute('aria-disabled', 'true')
        await page.keyboard.press('Escape')
      } finally {
        if (target) await deleteUser(adminApi, target.id)
      }
    })
  }
})
