import type { Locator, Page } from '@playwright/test'
import type { ApiKey, OAuthApp } from '#shared/types/account'
import type { InstanceInfo } from '#shared/types/instance'
import { ok } from '../helpers/api-client'
import { scantor } from '../helpers/cli'
import { connectMcpWithKey } from '../helpers/mcp'
import { startEditorAndReadKey, stopEditor } from '../helpers/mcp-accounts'
import { authorize, rawMcp, registerTestClient } from '../helpers/mcp-oauth'
import { withMcpTenants } from '../helpers/mcp-tenant'
import { gotoRendered, retryOnNetworkChange } from '../helpers/mcp-ui'
import { expectToast } from '../helpers/ui'
import { newApiContext } from '../helpers/users'
import { expect, test as base, unique } from '../fixtures'

// The "CLI & MCP access" page (docs/ui.md §5.18): API keys with the one-time reveal and its snippets, editor keys,
// CLI download links, the MCP section and the authorized OAuth apps. Tests that create, delete or revoke run on
// `freshUser`. Instance facts the test stack cannot show (a release version, MCP disabled, OAuth off) are produced
// by rewriting the page's own getInstanceInfo response; so are authorized apps whose URIs or client ids a real
// registration cannot produce (a javascript: URI, a CIMD client), next to a real authorized app.

const test = withMcpTenants(base)

const ACCESS_PATH = '/account/access'
const RELEASE = 'https://github.com/lonetis/scantor/releases'

/** Rewrites the page's getInstanceInfo response. */
async function patchInstanceInfo(page: Page, patch: (info: InstanceInfo) => InstanceInfo): Promise<void> {
  await page.route('**/api/info', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: patch((await response.json()) as InstanceInfo) })
  })
}

/** Opens the page and waits until `ready` (default: the API keys heading) is visible. */
async function openAccess(page: Page, ready?: Locator): Promise<void> {
  await gotoRendered(page, ACCESS_PATH, ready ?? page.getByRole('heading', { name: 'API keys' }))
}

/** The API key table. UTable puts its aria-label on the element around the <table>, not on the table itself. */
function keyTable(page: Page) {
  return page.locator('[aria-label="API keys"]:has(table)')
}

/** The text of a labelled code block (CodeBlock renders `role=region` with the label). */
function codeBlock(page: Page, label: string) {
  return page.getByRole('region', { name: label, exact: true }).locator('code')
}

test.describe('CLI & MCP access: API keys', () => {
  test.use({ pageUser: 'fresh' })

  test('the key table lists default keys with their facts, and editor keys separately', { tag: ['@UI-ACCT-008'] }, async ({ page, freshUser, freshApi }) => {
    test.setTimeout(180_000)
    const [key] = ok(await freshApi.call<{ items: ApiKey[] }>('listApiKeys', { query: { configId: 'default' } }), 'listApiKeys').items
    expect(key, 'the fresh user has its default key').toBeTruthy()

    const editorKey = await startEditorAndReadKey(freshApi, freshUser.id)
    try {
      const table = keyTable(page)
      const row = table.locator(`[data-row-id="${key!.id}"]`)
      await openAccess(page, row)
      await expect(row).toContainText('tests')
      await expect(row).toContainText(`${key!.start}…`)
      await expect(row).toContainText('enabled')
      await expect(row.getByRole('cell')).toHaveCount(7)
      await expect(row.getByRole('cell').nth(4)).toHaveText('never')
      // Created is a relative time; the expiry 90 days ahead is beyond the relative range and shows its date.
      await expect(row.getByRole('cell').nth(2)).toHaveText(/^(just now|\d+ min ago)$/)
      expect(key!.expiresAt, 'the default key expires').toBeTruthy()
      await expect(row.getByRole('cell').nth(3)).toHaveText(new Date(key!.expiresAt!).toISOString().slice(0, 10))

      // The editor's key is listed read-only under "Managed by the editor", never in the table.
      const editorStart = editorKey.slice(0, 22)
      await expect(page.getByText('Managed by the editor')).toBeVisible()
      await expect(page.getByText(`${editorStart}…`)).toBeVisible()
      await expect(table).not.toContainText(editorStart)
      await expect(page.getByText('rotated automatically by the editor; stop the editor to revoke it')).toBeVisible()
    } finally {
      await stopEditor(freshApi)
    }
  })

  test('"Create key" validates the name and expiry and creates the key with the chosen expiry', { tag: ['@UI-ACCT-008'] }, async ({ page, freshApi }) => {
    await openAccess(page)
    await page.getByRole('button', { name: 'Create key' }).click()
    const dialog = page.getByRole('dialog', { name: 'Create API key' })
    const nameInput = dialog.getByLabel('Name')
    const expiry = dialog.getByLabel('Expires in (days)')
    await expect(nameInput).toHaveAttribute('maxlength', '32')
    await expect(expiry).toHaveValue('90')
    await expect(expiry).toHaveAttribute('aria-valuemin', '1')
    await expect(expiry).toHaveAttribute('aria-valuemax', '365')

    // An empty (or blank) name is refused in the form; no key is created.
    const before = ok(await freshApi.call<{ items: ApiKey[] }>('listApiKeys'), 'listApiKeys').items.length
    await nameInput.fill('   ')
    await dialog.getByRole('button', { name: 'Create API key' }).click()
    await expect(dialog.getByText(/at least 1|too small|required/i)).toBeVisible()
    expect(ok(await freshApi.call<{ items: ApiKey[] }>('listApiKeys'), 'listApiKeys').items).toHaveLength(before)

    const name = unique('ui-key').slice(0, 32)
    await nameInput.fill(name)
    await expiry.fill('30')
    await retryOnNetworkChange(page, async () => {
      await dialog.getByRole('button', { name: 'Create API key' }).click()
      await expect(page.getByRole('dialog', { name: `API key ${name}` })).toBeVisible()
    })
    const created = ok(await freshApi.call<{ items: ApiKey[] }>('listApiKeys'), 'listApiKeys').items.find((candidate) => candidate.name === name)
    expect(created, 'the new key is listed').toBeTruthy()
    const days = (Date.parse(created!.expiresAt!) - Date.parse(created!.createdAt)) / 86_400_000
    expect(days).toBeCloseTo(30, 2)
  })

  test(
    'a new key is revealed once with its snippets, works for the API, the CLI and MCP, and a two-step delete revokes it',
    { tag: ['@UI-ACCT-009'] },
    async ({ env, page, freshUser, adminApi }) => {
      const info = ok(await adminApi.call<InstanceInfo>('getInstanceInfo'), 'getInstanceInfo')
      await openAccess(page)
      const name = unique('ui-reveal').slice(0, 32)
      await page.getByRole('button', { name: 'Create key' }).click()
      const form = page.getByRole('dialog', { name: 'Create API key' })
      await form.getByLabel('Name').fill(name)
      const reveal = page.getByRole('dialog', { name: `API key ${name}` })
      await retryOnNetworkChange(page, async () => {
        await form.getByRole('button', { name: 'Create API key' }).click()
        await expect(reveal).toBeVisible()
      })
      const key = (await reveal.getByTestId('secret-value').textContent())?.trim() ?? ''
      expect(key).toMatch(/^sk_scantor_[A-Za-z]{64}$/)
      await expect(codeBlock(page, 'Environment')).toHaveText(`export SCANTOR_URL=${env.publicUrl}\nexport SCANTOR_TOKEN=${key}`)
      expect(info.cliImage).toBeTruthy()
      await expect(codeBlock(page, 'Docker alias')).toHaveText(
        `alias scantor='docker run --rm -i -v "$PWD:$PWD" -w "$PWD" -v /var/run/docker.sock:/var/run/docker.sock -e SCANTOR_URL -e SCANTOR_TOKEN --add-host host.docker.internal:host-gateway ${info.cliImage}'`,
      )
      await expect(codeBlock(page, 'MCP with this key')).toHaveText(
        `claude mcp add --transport http scantor ${env.mcpUrl} --header "Authorization: Bearer ${key}"`,
      )
      await reveal.getByRole('button', { name: 'Done' }).click()
      await expect(reveal).toBeHidden()
      // Shown once: the page no longer has the key anywhere.
      await expect(page.locator('body')).not.toContainText(key)

      // The key works for the API, the CLI and MCP as the fresh user.
      const keyApi = await newApiContext({ headers: { Authorization: `Bearer ${key}` } })
      try {
        const account = await keyApi.get('/api/account')
        expect(account.status()).toBe(200)
        expect(((await account.json()) as { email: string }).email).toBe(freshUser.email)
        const whoami = await scantor(['whoami', '-o', 'json'], { token: key })
        expect(whoami.exitCode, whoami.stderr).toBe(0)
        expect(JSON.stringify(whoami.json)).toContain(freshUser.email)
        const client = await connectMcpWithKey(key)
        await client.close()

        // Two-step delete: the first click arms, the second deletes.
        await retryOnNetworkChange(page, async () => {
          await page.getByRole('button', { name: `Delete key ${name}` }).click()
          await page.getByRole('button', { name: `Confirm delete key ${name}` }).click()
          await expect(keyTable(page)).not.toContainText(name)
        })
        await expect.poll(async () => (await keyApi.get('/api/account')).status()).toBe(401)
        expect((await rawMcp(keyApi, { Authorization: `Bearer ${key}` })).status).toBe(401)
      } finally {
        await keyApi.dispose()
      }
    },
  )
})

test.describe('CLI & MCP access: downloads and MCP', () => {
  test('a dev build shows no CLI download links', { tag: ['@UI-ACCT-010'] }, async ({ page, adminApi }) => {
    const info = ok(await adminApi.call<InstanceInfo>('getInstanceInfo'), 'getInstanceInfo')
    expect(info.version, 'the test stack runs a dev build').not.toMatch(/^\d+\.\d+\.\d+$/)
    await openAccess(page)
    // The shim is mentioned, but without a release there is nothing to download.
    await expect(page.getByText('Run the CLI with the Docker shim')).toHaveText('Run the CLI with the Docker shim scantor.sh or a native binary.')
    await expect(page.getByRole('list', { name: 'CLI downloads' })).toHaveCount(0)
    await expect(page.locator(`a[href^="${RELEASE}"]`)).toHaveCount(0)
  })

  test('a release version links the release and every CLI asset', { tag: ['@UI-ACCT-010'] }, async ({ page }) => {
    await patchInstanceInfo(page, (info) => ({ ...info, version: '1.4.2' }))
    await openAccess(page)
    await expect(page.getByRole('link', { name: 'v1.4.2' })).toHaveAttribute('href', `${RELEASE}/tag/v1.4.2`)
    const downloads = page.getByRole('list', { name: 'CLI downloads' })
    for (const asset of ['scantor.sh', 'scantor-darwin-arm64', 'scantor-darwin-amd64', 'scantor-linux-amd64', 'scantor-linux-arm64', 'SHA256SUMS']) {
      await expect(downloads.getByRole('link', { name: asset, exact: true })).toHaveAttribute('href', `${RELEASE}/download/v1.4.2/${asset}`)
    }
  })

  test(
    'the MCP section shows the endpoint with copy, the OAuth command, the client snippet and the API-key command',
    { tag: ['@UI-ACCT-011'] },
    async ({ env, page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: env.publicUrl })
      await openAccess(page)
      const section = page.getByRole('region', { name: 'MCP', exact: true })
      await expect(section.getByTestId('mcp-url')).toHaveText(env.mcpUrl)
      await section.getByRole('button', { name: 'Copy MCP URL' }).click()
      await expectToast(page, 'Copied')
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(env.mcpUrl)

      await expect(codeBlock(page, 'Claude Code OAuth command')).toHaveText(`claude mcp add --transport http scantor ${env.mcpUrl}`)
      expect(JSON.parse((await codeBlock(page, 'MCP client configuration').textContent()) ?? '')).toEqual({
        mcpServers: { scantor: { type: 'http', url: env.mcpUrl } },
      })
      await expect(codeBlock(page, 'MCP command with an API key')).toHaveText(
        `claude mcp add --transport http scantor ${env.mcpUrl} --header "Authorization: Bearer $SCANTOR_TOKEN"`,
      )
      await expect(section.getByText('MCP is disabled on this instance.')).toHaveCount(0)
    },
  )

  test('without OAuth only the API-key command is shown, and with MCP disabled the section says so', { tag: ['@UI-ACCT-011'] }, async ({ env, page }) => {
    await patchInstanceInfo(page, (info) => ({ ...info, features: { ...info.features, mcpOAuth: false } }))
    await openAccess(page)
    const section = page.getByRole('region', { name: 'MCP', exact: true })
    await expect(section.getByTestId('mcp-url')).toHaveText(env.mcpUrl)
    await expect(codeBlock(page, 'MCP command with an API key')).toBeVisible()
    await expect(section.getByText('OAuth for MCP clients needs an https public URL; use an API key instead.')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Claude Code OAuth command' })).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'MCP client configuration' })).toHaveCount(0)

    await page.unrouteAll({ behavior: 'wait' })
    await patchInstanceInfo(page, (info) => ({ ...info, mcpUrl: null, features: { ...info.features, mcp: false, mcpOAuth: false } }))
    await openAccess(page)
    await expect(section.getByText('MCP is disabled on this instance.')).toBeVisible()
    await expect(section.getByTestId('mcp-url')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'MCP command with an API key' })).toHaveCount(0)
  })
})

test.describe('CLI & MCP access: authorized apps', () => {
  test('authorized apps show name, client id, http(s) links only, scopes and time, and revoke in two steps', { tag: ['@UI-ACCT-012'] }, async ({ page }) => {
    // The list as listOAuthApps returns it (docs/api.md §4.3): a DCR client with an http(s) URI, one with a
    // javascript: URI and a CIMD client identified by its metadata URL.
    const apps: OAuthApp[] = [
      {
        clientId: 'dcr-client-1',
        name: 'Inspector',
        uri: 'https://inspector.example.com/about',
        scopes: ['offline_access', 'scantor:read', 'scantor:write'],
        createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      },
      { clientId: 'dcr-client-2', name: 'Sneaky', uri: 'javascript:alert(1)', scopes: ['scantor:read'], createdAt: new Date().toISOString() },
      { clientId: 'https://agent.example.org/oauth/client.json', name: null, uri: null, scopes: ['scantor:read'], createdAt: new Date().toISOString() },
    ]
    let revoked: string | null = null
    await page.route('**/api/account/oauth-apps', (route) => route.fulfill({ json: { items: apps } }))
    await page.route('**/api/account/oauth-apps/*', async (route) => {
      expect(route.request().method()).toBe('DELETE')
      revoked = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()!)
      await route.fulfill({ status: 204 })
    })
    await openAccess(page)
    const list = page.getByRole('list', { name: 'Authorized apps' })
    const inspector = list.locator('[data-row-id="dcr-client-1"]')
    await expect(inspector).toContainText('Inspector')
    await expect(inspector).toContainText('dcr-client-1')
    await expect(inspector).toContainText(/authorized (1 h|60 min) ago/)
    for (const scope of ['offline_access', 'scantor:read', 'scantor:write']) await expect(inspector.getByText(scope, { exact: true })).toBeVisible()
    const link = inspector.getByRole('link', { name: 'https://inspector.example.com/about' })
    await expect(link).toHaveAttribute('href', 'https://inspector.example.com/about')
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    // A non-http(s) URI is never a link.
    await expect(list.locator('[data-row-id="dcr-client-2"]').getByRole('link')).toHaveCount(0)
    // A CIMD client without a name shows its metadata host.
    await expect(list.locator('[data-row-id="https://agent.example.org/oauth/client.json"]')).toContainText('agent.example.org')

    await inspector.getByRole('button', { name: 'Revoke Inspector' }).click()
    expect(revoked).toBeNull()
    await inspector.getByRole('button', { name: 'Confirm revoke Inspector' }).click()
    await expect(inspector).toHaveCount(0)
    expect(revoked).toBe('dcr-client-1')
  })
})

test.describe('CLI & MCP access: revoking a real authorized app', () => {
  // A client registered for this test: the tenant's consent to it concerns no other test.
  test('revoking a real authorized app removes it and its next MCP call gets 401', { tag: ['@UI-ACCT-012'] }, async ({ page, user }) => {
    const session = await newApiContext({ storageState: user.storageState })
    try {
      const name = unique('ui-app')
      const client = await registerTestClient(name)
      const { tokens } = await authorize(session, { client })
      expect((await rawMcp(session, { Authorization: `Bearer ${tokens.access_token}` })).status).toBe(200)

      const row = page.getByRole('list', { name: 'Authorized apps' }).locator(`[data-row-id="${client.client_id}"]`)
      await openAccess(page, row)
      await expect(row).toContainText(name)
      await retryOnNetworkChange(page, async () => {
        await row.getByRole('button', { name: `Revoke ${name}` }).click()
        await row.getByRole('button', { name: `Confirm revoke ${name}` }).click()
        await expect(row).toHaveCount(0)
      })
      expect((await rawMcp(session, { Authorization: `Bearer ${tokens.access_token}` })).status).toBe(401)
    } finally {
      await session.dispose()
    }
  })
})
