import type { Locator, Page } from '@playwright/test'
import type { ItemList } from '#shared/types/common'
import type { Node, NodeWithToken } from '#shared/types/nodes'
import { ok, type ApiClient } from '../helpers/api-client'
import { env } from '../helpers/env'
import { expectToast } from '../helpers/ui'
import {
  alertBox,
  deleteNodesNamed,
  expectStorageWithout,
  expectToastAnywhere,
  openPage,
  patchJsonResponse,
  recordApiRequests,
  reloadPage,
  nodeRoutedContext,
  workerTenant,
} from '../helpers/ui-shell-tasks'
import { expect, test as base, unique } from '../fixtures'

// The worker's tenant under a session file of its own, and the dashboard's requests sent from Node (helpers/ui-shell-tasks.ts).
const test = base.extend({ user: [workerTenant, { scope: 'worker' }], context: nodeRoutedContext })

// The nodes pages (docs/ui.md §5.15). Every test creates its own unjoined nodes in a pool of its own and deletes them
// afterwards; the built-in node and remote-1 are only read (docs/testing.md §9). Warnings that only a misconfigured
// host reports are answered by a patched listNodes response.

// The seeded admin's saved session; overriding the storage state also spares the worker's tenant (and its sign-in).
test.use({ role: 'admin', storageState: env.paths.adminState })

const BUILTIN_HINT = "The built-in node's token is derived from SCANTOR_SECRET"

function nodeRow(page: Page, id: string): Locator {
  return page.getByLabel('Nodes', { exact: true }).locator(`tr[data-row-id="${id}"]`)
}

function nodeRows(page: Page): Locator {
  return page.getByLabel('Nodes', { exact: true }).locator('tbody tr[data-row-id]')
}

/** The cell of a column, by the column header's position. */
async function cell(page: Page, row: Locator, header: string): Promise<Locator> {
  const headers = await page.getByLabel('Nodes', { exact: true }).locator('thead th').allInnerTexts()
  const index = headers.findIndex((text) => text.trim() === header)
  if (index < 0) throw new Error(`no column ${header} in ${JSON.stringify(headers)}`)
  return row.locator('td').nth(index)
}

/**
 * Filters the table by a pool of the test's own and waits for the filtered list: a filter change empties and rebuilds
 * the table, which would close a row menu opened in between.
 */
async function filterByPool(page: Page, pool: string, rows: number): Promise<void> {
  const listed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/nodes' && new URL(r.url()).searchParams.get('pool') === pool)
  await page.getByRole('textbox', { name: 'Filter by pool' }).fill(pool)
  await listed
  await expect(nodeRows(page)).toHaveCount(rows)
}

async function openActions(page: Page, name: string): Promise<Locator> {
  await page.getByRole('button', { name: `Node actions for ${name}` }).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  return menu
}

/** Creates an unjoined node through the API. */
async function createNode(
  adminApi: ApiClient,
  body: { name: string; pool?: string; labels?: Record<string, string>; maxWorkers?: number },
): Promise<NodeWithToken> {
  return ok(await adminApi.createNode(body), 'createNode')
}

async function getNode(adminApi: ApiClient, nodeId: string): Promise<Node> {
  return ok(await adminApi.call<Node>('getNode', { path: { nodeId } }), 'getNode')
}

/** A healthy stack reports no warnings, so the built-in node's report is altered in the unfiltered listNodes response. */
async function patchBuiltinWarnings(page: Page, builtinId: string): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/nodes' && !url.searchParams.has('state') && !url.searchParams.has('pool'),
    (route) =>
      patchJsonResponse<ItemList<Node>>(route, (body) => ({
        items: body.items.map((node) => (node.id === builtinId ? { ...node, info: { ...node.info!, egressDenyApplied: false, clockOffsetMs: 7_500 } } : node)),
      })),
  )
}

async function builtinNode(adminApi: ApiClient): Promise<Node> {
  const node = ok(await adminApi.listNodes(), 'listNodes').items.find((candidate) => candidate.builtIn)
  if (!node) throw new Error('the built-in node is missing')
  return node
}

/** formatBytes of the UI (binary units, one decimal below 10). */
function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  if (unit === 0) return `${Math.round(value)} B`
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value)
  return `${rounded} ${units[unit]}`
}

test.describe('nodes table', () => {
  test(
    'shows name, state, cordon, pool, labels, platform, capacity, DinD, version and last seen, filtered by state and pool',
    { tag: ['@UI-ADMIN-001'] },
    async ({ page, adminApi }) => {
      const pool = unique('pool')
      const names = [unique('node-a'), unique('node-b')]
      try {
        const a = await createNode(adminApi, { name: names[0]!, pool, labels: { zone: 'eu-1', tier: 'gold' }, maxWorkers: 4 })
        const b = await createNode(adminApi, { name: names[1]!, pool })
        ok(await adminApi.call('updateNode', { path: { nodeId: a.node.id }, body: { cordoned: true } }), 'updateNode')
        ok(await adminApi.call('revokeNodeToken', { path: { nodeId: b.node.id } }), 'revokeNodeToken')
        const builtin = await builtinNode(adminApi)

        await openPage(page, '/admin/nodes')
        for (const header of ['Name', 'State', 'Pool', 'Labels', 'Arch', 'CPUs', 'Memory', 'Free disk', 'Workers', 'DinD', 'Version', 'Last seen']) {
          await expect(page.getByLabel('Nodes', { exact: true }).getByRole('columnheader', { name: header, exact: true })).toBeVisible()
        }

        // The built-in node: pill, state, platform and capacity as reported by its daemon.
        const info = builtin.info!
        const row = nodeRow(page, builtin.id)
        await expect(row.getByRole('link', { name: builtin.name })).toHaveAttribute('href', `/admin/nodes/${builtin.id}`)
        await expect(row.getByText('built-in', { exact: true })).toBeVisible()
        await expect(row.locator('[data-state="online"]')).toBeVisible()
        await expect(await cell(page, row, 'Arch')).toHaveText(`${info.os}/${info.arch}`)
        await expect(await cell(page, row, 'CPUs')).toHaveText(String(info.cpus))
        await expect(await cell(page, row, 'Memory')).toHaveText(formatBytes(info.memoryBytes))
        await expect(await cell(page, row, 'Free disk')).toHaveText(/^\d+(\.\d)? (B|KiB|MiB|GiB|TiB)$/)
        await expect(await cell(page, row, 'Workers')).toHaveText(
          new RegExp(`^\\d+ / ${Math.min(info.maxWorkers, builtin.maxWorkers ?? Number.POSITIVE_INFINITY)}$`),
        )
        await expect(await cell(page, row, 'DinD')).toHaveText(info.dindMode)
        await expect(await cell(page, row, 'Version')).toHaveText(info.version)
        await expect((await cell(page, row, 'Last seen')).locator('time')).toHaveText(/just now|\d+ min ago|\d+s ago/)

        // The pool filter shows only this test's nodes, with their pool, labels, cordon and state.
        const poolRequest = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/nodes' && new URL(r.url()).searchParams.get('pool') === pool)
        await page.getByRole('textbox', { name: 'Filter by pool' }).fill(pool)
        await poolRequest
        await expect(nodeRows(page)).toHaveCount(2)
        const rowA = nodeRow(page, a.node.id)
        await expect(rowA.locator('[data-state="pending"]')).toBeVisible()
        await expect(rowA.getByText('cordoned', { exact: true })).toBeVisible()
        await expect(await cell(page, rowA, 'Pool')).toHaveText(pool)
        await expect((await cell(page, rowA, 'Labels')).getByText('zone=eu-1', { exact: true })).toBeVisible()
        await expect((await cell(page, rowA, 'Labels')).getByText('tier=gold', { exact: true })).toBeVisible()
        await expect(await cell(page, rowA, 'Workers')).toHaveText('0 / 4')
        await expect(await cell(page, rowA, 'Arch')).toHaveText('–')
        const rowB = nodeRow(page, b.node.id)
        await expect(rowB.locator('[data-state="revoked"]')).toBeVisible()
        await expect(rowB.getByText('cordoned', { exact: true })).toHaveCount(0)
        await expect(await cell(page, rowB, 'Labels')).toHaveText('–')

        // The state filter narrows the pool further.
        await page.getByRole('combobox', { name: 'Filter by state' }).click()
        await page.getByRole('option', { name: 'revoked', exact: true }).click()
        await expect(nodeRows(page)).toHaveCount(1)
        await expect(rowB).toBeVisible()
        await page.getByRole('combobox', { name: 'Filter by state' }).click()
        await page.getByRole('option', { name: 'pending', exact: true }).click()
        await expect(nodeRows(page)).toHaveCount(1)
        await expect(rowA).toBeVisible()
        await page.getByRole('combobox', { name: 'Filter by state' }).click()
        await page.getByRole('option', { name: 'online', exact: true }).click()
        await expect(page.getByLabel('Nodes', { exact: true }).getByText('No nodes match.')).toBeVisible()
      } finally {
        await deleteNodesNamed(adminApi, names)
      }
    },
  )

  test('warns when a node did not apply the egress deny list or its clock is off', { tag: ['@UI-ADMIN-001'] }, async ({ page, adminApi }) => {
    const builtin = await builtinNode(adminApi)
    await patchBuiltinWarnings(page, builtin.id)
    await openPage(page, '/admin/nodes')
    const row = nodeRow(page, builtin.id)
    const egress = row.locator(`[aria-label="${builtin.name}: Egress deny list not applied"]`)
    const clock = row.locator(`[aria-label="${builtin.name}: Clock off by 7.5s"]`)
    await expect(egress).toBeVisible()
    await expect(clock).toBeVisible()
    await egress.hover()
    await expect(page.getByRole('tooltip')).toHaveText('Egress deny list not applied')
    // The open tooltip may cover the neighbouring icon: move away and let it close first.
    await page.mouse.move(0, 0)
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await clock.hover()
    await expect(page.getByRole('tooltip')).toHaveText('Clock off by 7.5s')
  })
})

test.describe('adding a node', () => {
  test(
    '"Add node" reveals the token once with copy buttons, join commands and the checklist',
    { tag: ['@UI-ADMIN-002', '@UI-SEC-006'] },
    async ({ page, adminApi }) => {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: env.publicUrl })
      const name = unique('added')
      const pool = unique('pool')
      try {
        await openPage(page, '/admin/nodes')
        await page.getByRole('button', { name: 'Add node' }).click()
        const form = page.getByRole('dialog', { name: 'Add node' })
        await expect(form).toContainText('Add only machines you trust like the master.')
        await expect(form.getByRole('textbox', { name: 'Pool' })).toHaveValue('shared')
        await form.getByRole('textbox', { name: 'Name' }).fill(name)
        await form.getByRole('textbox', { name: 'Pool' }).fill(pool)
        await form.getByRole('button', { name: 'Add label' }).click()
        await form.getByRole('textbox', { name: 'Key of label 1' }).fill('zone')
        await form.getByRole('textbox', { name: 'Value of zone' }).fill('lab')
        await form.getByLabel('Worker limit').fill('3')
        const created = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/nodes')
        await form.getByRole('button', { name: 'Create node' }).click()
        const response = await created
        expect(response.status()).toBe(201)
        expect(response.request().postDataJSON()).toEqual({ name, pool, labels: { zone: 'lab' }, maxWorkers: 3 })
        const result = (await response.json()) as NodeWithToken

        // The token is shown once, with the join snippets and the host checklist.
        const reveal = page.getByRole('dialog', { name: `Token of node ${name}` })
        await expect(reveal).toBeVisible()
        await expect(reveal.getByTestId('secret-reveal')).toContainText('This token is shown only now.')
        const token = (await reveal.getByTestId('secret-value').innerText()).trim()
        expect(token).toBe(result.token)
        expect(token.startsWith(result.node.tokenPrefix!)).toBe(true)
        await expect(reveal.getByRole('region', { name: 'docker run' })).toContainText(token)
        await expect(reveal.getByRole('region', { name: 'compose.yml' })).toContainText(token)
        await expect(reveal.getByText('Checklist', { exact: true })).toBeVisible()
        await expect(reveal).toContainText('Docker Engine 25 or newer on the node host.')
        for (const label of ['Copy node token', 'Copy docker run', 'Copy compose.yml']) await expect(reveal.getByRole('button', { name: label })).toBeVisible()
        const clipboard = () => page.evaluate(() => navigator.clipboard.readText())
        await reveal.getByRole('button', { name: 'Copy node token' }).click()
        await expectToastAnywhere(page, 'Copied')
        await expect.poll(clipboard).toBe(token)
        await reveal.getByRole('button', { name: 'Copy docker run' }).click()
        await expect.poll(clipboard).toBe(result.join.dockerRun)
        await reveal.getByRole('button', { name: 'Copy compose.yml' }).click()
        await expect.poll(clipboard).toBe(result.join.compose)
        await expectStorageWithout(page, [token])

        // An outside click or Escape does not close it; only "Done" does.
        await page.mouse.click(5, 5)
        await page.keyboard.press('Escape')
        await expect(reveal).toBeVisible()
        await reveal.getByRole('button', { name: 'Done' }).click()
        await expect(reveal).toBeHidden()
        await expect(page.locator('body')).not.toContainText(token)
        await expectStorageWithout(page, [token])

        const node = await getNode(adminApi, result.node.id)
        expect(node).toEqual(expect.objectContaining({ name, pool, labels: { zone: 'lab' }, maxWorkers: 3, state: 'pending' }))
        await expect(nodeRow(page, node.id)).toBeVisible()

        // The token never appears again: the join command carries a placeholder.
        await openActions(page, name)
        await page.getByRole('menuitem', { name: 'Show join command' }).click()
        const join = page.getByRole('dialog', { name: `Join command of ${name}` })
        await expect(join.getByRole('region', { name: 'docker run' })).toContainText('${SCANTOR_NODE_TOKEN}')
        await expect(join).not.toContainText(token)
        await join.getByRole('button', { name: 'Close' }).first().click()
        await reloadPage(page)
        await expect(nodeRow(page, node.id)).toBeVisible()
        await expect(page.locator('body')).not.toContainText(token)
        await expectStorageWithout(page, [token])
      } finally {
        await deleteNodesNamed(adminApi, [name])
      }
    },
  )

  test('a duplicate name is reported; invalid names and labels are blocked before any request', { tag: ['@UI-ADMIN-003'] }, async ({ page, adminApi }) => {
    const taken = unique('taken')
    try {
      await createNode(adminApi, { name: taken, pool: unique('pool') })
      await openPage(page, '/admin/nodes')
      await page.getByRole('button', { name: 'Add node' }).click()
      const form = page.getByRole('dialog', { name: 'Add node' })
      const nameInput = form.getByRole('textbox', { name: 'Name' })
      const requests = recordApiRequests(page)
      const posts = () => requests.filter((request) => request.method === 'POST' && request.url.pathname === '/api/nodes')

      await nameInput.fill('Bad_Name')
      await form.getByRole('button', { name: 'Create node' }).click()
      await expect(form.getByText('must be 1–64 lowercase letters, digits or hyphens')).toBeVisible()
      await nameInput.fill('builtin')
      await form.getByRole('button', { name: 'Create node' }).click()
      await expect(form.getByText('"builtin" is reserved for the built-in node')).toBeVisible()

      await nameInput.fill(unique('fine'))
      // The cleared error shifts the layout; a click during the shift misses the button.
      await expect(form.getByText('"builtin" is reserved for the built-in node')).toHaveCount(0)
      await form.getByRole('button', { name: 'Add label' }).click()
      await form.getByRole('textbox', { name: 'Key of label 1' }).fill('Bad Key')
      await form.getByRole('textbox', { name: 'Value of Bad Key' }).fill('x')
      await expect(form.getByText('lowercase letters, digits, ".", "_" or "-"', { exact: true })).toBeVisible()
      await form.getByRole('button', { name: 'Create node' }).click()
      await expect(form).toBeVisible()
      expect(posts()).toEqual([])

      await form.getByRole('button', { name: 'Remove Bad Key' }).click()
      await nameInput.fill(taken)
      const duplicate = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/nodes')
      await form.getByRole('button', { name: 'Create node' }).click()
      expect((await duplicate).status()).toBe(409)
      await expect(form.getByRole('alert')).toHaveText('A node with this name already exists.')
      await expect(form).toBeVisible()
      expect(posts()).toHaveLength(1)
    } finally {
      await deleteNodesNamed(adminApi, [taken])
    }
  })
})

test.describe('node actions', () => {
  test('Edit saves only changed fields and cordons; "Show join command" uses the token placeholder', { tag: ['@UI-ADMIN-004'] }, async ({ page, adminApi }) => {
    const name = unique('edited')
    const pool = unique('pool')
    try {
      const { node } = await createNode(adminApi, { name, pool, labels: { zone: 'a' } })
      await openPage(page, '/admin/nodes')
      await filterByPool(page, pool, 1)
      const row = nodeRow(page, node.id)
      await expect(row).toBeVisible()
      await expect(row.getByText('cordoned', { exact: true })).toHaveCount(0)

      await openActions(page, name)
      await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
      let dialog = page.getByRole('dialog', { name: `Edit ${name}` })
      await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue(name)
      await expect(dialog.getByRole('textbox', { name: 'Value of zone' })).toHaveValue('a')
      const cordon = dialog.getByRole('switch', { name: 'Cordoned' })
      await expect(cordon).not.toBeChecked()
      await cordon.click()
      let patch = page.waitForRequest((r) => r.method() === 'PATCH' && new URL(r.url()).pathname === `/api/nodes/${node.id}`)
      await dialog.getByRole('button', { name: 'Save node' }).click()
      expect((await patch).postDataJSON()).toEqual({ cordoned: true })
      await expectToast(page, `Node ${name} saved`)
      await expect(row.getByText('cordoned', { exact: true })).toBeVisible()
      expect((await getNode(adminApi, node.id)).cordoned).toBe(true)

      await openActions(page, name)
      await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
      dialog = page.getByRole('dialog', { name: `Edit ${name}` })
      await expect(dialog.getByRole('switch', { name: 'Cordoned' })).toBeChecked()
      await dialog.getByRole('textbox', { name: 'Value of zone' }).fill('b')
      patch = page.waitForRequest((r) => r.method() === 'PATCH' && new URL(r.url()).pathname === `/api/nodes/${node.id}`)
      await dialog.getByRole('button', { name: 'Save node' }).click()
      expect((await patch).postDataJSON()).toEqual({ labels: { zone: 'b' } })
      await expectToast(page, `Node ${name} saved`)
      await expect(row.getByText('zone=b', { exact: true })).toBeVisible()

      // Saving without a change sends nothing.
      const requests = recordApiRequests(page)
      await openActions(page, name)
      await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
      await page
        .getByRole('dialog', { name: `Edit ${name}` })
        .getByRole('button', { name: 'Save node' })
        .click()
      await expect(page.getByRole('dialog', { name: `Edit ${name}` })).toBeHidden()
      expect(requests.filter((request) => request.method === 'PATCH')).toEqual([])

      await openActions(page, name)
      await page.getByRole('menuitem', { name: 'Show join command' }).click()
      const join = page.getByRole('dialog', { name: `Join command of ${name}` })
      await expect(join).toContainText('Replace ${SCANTOR_NODE_TOKEN} with the node')
      await expect(join.getByRole('region', { name: 'docker run' })).toContainText('${SCANTOR_NODE_TOKEN}')
      await expect(join.getByRole('region', { name: 'compose.yml' })).toContainText('${SCANTOR_NODE_TOKEN}')
      await expect(join.getByTestId('secret-reveal')).toHaveCount(0)
    } finally {
      await deleteNodesNamed(adminApi, [name])
    }
  })

  test('rotate reveals a new token, revoke marks the node revoked and delete needs the name', { tag: ['@UI-ADMIN-005'] }, async ({ page, adminApi }) => {
    const name = unique('rotated')
    const pool = unique('pool')
    try {
      const created = await createNode(adminApi, { name, pool })
      const nodeId = created.node.id
      await openPage(page, '/admin/nodes')
      await filterByPool(page, pool, 1)
      const row = nodeRow(page, nodeId)
      await expect(row.locator('[data-state="pending"]')).toBeVisible()

      // Rotate: a confirmation, then the new token once.
      await openActions(page, name)
      await page.getByRole('menuitem', { name: 'Rotate token' }).click()
      let confirm = page.getByRole('dialog', { name: `Rotate the token of ${name}` })
      await expect(confirm).toContainText('The current token stops working at once.')
      await confirm.getByRole('button', { name: 'Rotate token' }).click()
      const reveal = page.getByRole('dialog', { name: `Token of node ${name}` })
      const rotated = (await reveal.getByTestId('secret-value').innerText()).trim()
      expect(rotated).not.toBe(created.token)
      expect(rotated.startsWith((await getNode(adminApi, nodeId)).tokenPrefix!)).toBe(true)
      await reveal.getByRole('button', { name: 'Done' }).click()
      await expect(reveal).toBeHidden()

      // Revoke: a confirmation, the toast and the revoked state.
      await openActions(page, name)
      await page.getByRole('menuitem', { name: 'Revoke token' }).click()
      confirm = page.getByRole('dialog', { name: `Revoke the token of ${name}` })
      await expect(confirm).toContainText('Its workers are rescheduled on other nodes.')
      await confirm.getByRole('button', { name: 'Revoke token' }).click()
      await expectToast(page, `Token of ${name} revoked`)
      await expect(row.locator('[data-state="revoked"]')).toBeVisible()
      expect((await getNode(adminApi, nodeId)).state).toBe('revoked')
      const menu = await openActions(page, name)
      await expect(menu.getByRole('menuitem', { name: 'Revoke token' })).toHaveAttribute('aria-disabled', 'true')
      await page.keyboard.press('Escape')

      // Delete: the node's name must be typed.
      await openActions(page, name)
      await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
      confirm = page.getByRole('dialog', { name: `Delete node ${name}` })
      const remove = confirm.getByRole('button', { name: 'Delete node' })
      await expect(remove).toBeDisabled()
      await confirm.getByLabel(`Type ${name} to confirm`).fill(name)
      await remove.click()
      await expectToast(page, `Node ${name} deleted`)
      await expect(row).toHaveCount(0)
      expect((await adminApi.call('getNode', { path: { nodeId } })).status).toBe(404)
    } finally {
      await deleteNodesNamed(adminApi, [name])
    }
  })

  test('rotate, revoke and delete are disabled for the built-in node, and its menu says why', { tag: ['@UI-ADMIN-005'] }, async ({ page, adminApi }) => {
    const builtin = await builtinNode(adminApi)
    await openPage(page, '/admin/nodes')
    const menu = await openActions(page, builtin.name)
    // The explanation is a label above the actions (docs/ui.md §5.15): the button's tooltip is its name.
    await expect(menu.getByText(BUILTIN_HINT, { exact: true })).toBeVisible()
    for (const item of ['Rotate token', 'Revoke token', 'Delete'])
      await expect(menu.getByRole('menuitem', { name: item, exact: true })).toHaveAttribute('aria-disabled', 'true')
    for (const item of ['Edit', 'Show join command'])
      await expect(menu.getByRole('menuitem', { name: item, exact: true })).not.toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    expect((await getNode(adminApi, builtin.id)).state).toBe('online')
  })
})

test.describe('node page', () => {
  test('an unjoined node shows its info, labels, an empty lease, workers and events', { tag: ['@UI-ADMIN-006', '@UI-NAV-010'] }, async ({ page, adminApi }) => {
    const name = unique('detail')
    try {
      const { node } = await createNode(adminApi, { name, pool: unique('pool'), labels: { zone: 'x' }, maxWorkers: 2 })
      await openPage(page, `/admin/nodes/${node.id}`)
      await expect(page).toHaveTitle(`${name} · scantor`)
      const title = page.locator('#scantor-dashboard-panel-admin-node h1[data-slot="title"]')
      await expect(title).toContainText(name)
      await expect(title.locator('[data-state="pending"]')).toBeVisible()

      const fact = (label: string) => page.locator('dt', { hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd[1]')
      await expect(fact('Pool')).toHaveText(node.pool)
      await expect(fact('Worker limit')).toHaveText('2')
      await expect(fact('Token')).toHaveText(`${node.tokenPrefix}…`)
      await expect(fact('Endpoint profile')).toHaveText(node.endpointProfile)
      await expect(fact('Lease')).toHaveText('no daemon instance holds the lease')
      await expect(fact('Hostname')).toHaveCount(0)
      await expect(page.getByText('zone=x', { exact: true })).toBeVisible()
      await expect(page.locator('[aria-label="Workers on this node"]').getByText('No workers on this node.')).toBeVisible()
      await expect(page.locator('[aria-label="Node events"]')).toBeVisible()
      await expect(page.getByRole('switch', { name: 'Active only' })).toBeChecked()

      await page.getByRole('link', { name: 'Back to nodes' }).click()
      await expect(page).toHaveURL(/\/admin\/nodes$/)
    } finally {
      await deleteNodesNamed(adminApi, [name])
    }
  })

  test(
    'the built-in node shows its reported info and lease, and "Active only" switches the worker filter',
    { tag: ['@UI-ADMIN-006'] },
    async ({ page, adminApi }) => {
      const builtin = await builtinNode(adminApi)
      const workersRequest = (active: boolean) =>
        page.waitForRequest((r) => {
          const url = new URL(r.url())
          return url.pathname === `/api/nodes/${builtin.id}/workers` && url.searchParams.has('state') === active
        })
      let request = workersRequest(true)
      await openPage(page, `/admin/nodes/${builtin.id}`)
      expect(new URL((await request).url()).searchParams.get('state')).toMatch(/running/)

      const fact = (label: string) => page.locator('dt', { hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd[1]')
      const info = builtin.info!
      await expect(fact('Hostname')).toHaveText(info.hostname)
      await expect(fact('Platform')).toHaveText(`${info.os}/${info.arch}`)
      await expect(fact('Daemon version')).toHaveText(info.version)
      await expect(fact('CPUs')).toHaveText(String(info.cpus))
      await expect(fact('DinD mode')).toHaveText(info.dindMode)
      await expect(fact('Egress deny list')).toHaveText(info.egressDenyApplied ? 'applied' : 'not applied')
      await expect(fact('Instance version')).toHaveText(builtin.instance!.version)
      await expect(fact('Instance started')).not.toHaveText('')
      await expect(page.locator('[aria-label="Workers on this node"]')).toBeVisible()
      await expect(page.locator('[aria-label="Node events"]')).toBeVisible()

      request = workersRequest(false)
      await page.getByRole('switch', { name: 'Active only' }).click()
      await request
      await expect(page.getByRole('switch', { name: 'Active only' })).not.toBeChecked()
    },
  )

  test('an unknown node shows "Node not found"', { tag: ['@UI-ADMIN-006'] }, async ({ page }) => {
    await openPage(page, '/admin/nodes/5d1f7c2a-3b4e-4f60-9a71-8c2b3d4e5f60')
    await expect(alertBox(page, 'Node not found')).toBeVisible()
  })
})
