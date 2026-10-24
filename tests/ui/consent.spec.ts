import type { Page } from '@playwright/test'
import { connectMcpWithKey, DEFAULT_MCP_SCOPES, REDIRECT_URI } from '../helpers/mcp'
import { ADMIN_MCP_SCOPES, authorizationUrl, CONSENT_PATH, exchangeCode, jwtClaims, pkce, registerTestClient } from '../helpers/mcp-oauth'
import { withMcpTenants } from '../helpers/mcp-tenant'
import { expectRendered, gotoRendered, networkChanges, openAuthorization, retryOnNetworkChange, settleAuthorization } from '../helpers/mcp-ui'
import { newApiContext } from '../helpers/users'
import { reserve } from '../helpers/limiter'
import { expect, test as base, unique } from '../fixtures'

// The OAuth consent page and the sign-in on its way (docs/ui.md §5.1, §5.3; docs/mcp.md §3.3), driven through the
// real authorization URL in the browser. The page's own logic (signed query kept across the sign-in, the access
// levels offered for the requested scopes, the redirect origin, errors without a request or for an unknown client)
// is checked with hand-made OAuth queries, which spend none of the per-IP authorize budget; the page shown for a real
// authorization and the decisions run against a client registered for each test.

const test = withMcpTenants(base)

const LOGIN_NOTICE = 'Sign in to authorize an application to access your scantor account.'
const ONLY_FROM_REQUEST = 'This page is only reachable from an application authorization request.'
const CALLBACK = new URL(REDIRECT_URI)

/** An OAuth query as better-auth signs it onto /login and /oauth/consent (the signature is not checked by the page). */
function oauthQuery(fields: { clientId?: string; scope?: string; redirectUri?: string } = {}): URLSearchParams {
  return new URLSearchParams({
    response_type: 'code',
    client_id: fields.clientId ?? unique('unknown-client'),
    redirect_uri: fields.redirectUri ?? REDIRECT_URI,
    scope: fields.scope ?? DEFAULT_MCP_SCOPES,
    state: 'state-1',
    code_challenge: pkce().challenge,
    code_challenge_method: 'S256',
    exp: String(Math.floor(Date.now() / 1000) + 600),
    sig: 'c2lnbmF0dXJl',
  })
}

/** Opens the consent page with a hand-made OAuth query and waits until it loaded the session (the account shows). */
async function openConsent(page: Page, query: URLSearchParams | null): Promise<void> {
  await gotoRendered(page, query ? `${CONSENT_PATH}?${query}` : CONSENT_PATH, page.getByTestId('oauth-account'))
}

function radio(page: Page, label: string) {
  return page.getByRole('radio', { name: label, exact: true })
}

/** The consent page loaded its client: the decisions are enabled. */
function decisionsEnabled(page: Page) {
  return page.getByRole('button', { name: 'Deny', disabled: false })
}

/** Catches the redirect back to the client (nothing listens on the loopback callback) and returns its URL. */
async function catchCallback(page: Page): Promise<() => Promise<URL>> {
  let resolve!: (url: URL) => void
  const caught = new Promise<URL>((done) => (resolve = done))
  await page.route(`${CALLBACK.origin}/**`, async (route) => {
    resolve(new URL(route.request().url()))
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'callback received' })
  })
  return () => caught
}

/** Resolves with `promise`, or fails after `ms`. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} within ${ms / 1000} s`)), ms))])
}

test.describe('OAuth sign-in on the way to consent', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('a signed-out visit to the consent page goes to /login with the OAuth query, which explains why', { tag: ['@UI-AUTH-006'] }, async ({ page }) => {
    const query = oauthQuery()
    await gotoRendered(page, `${CONSENT_PATH}?${query}`, page.getByTestId('oauth-login-notice'))
    expect(new URL(page.url()).pathname).toBe('/login')
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(Object.fromEntries(query))
    await expect(page.getByTestId('oauth-login-notice')).toHaveText(LOGIN_NOTICE)
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()

    // A plain sign-in shows no notice.
    await gotoRendered(page, '/login', page.getByText('Distributed scanning platform'))
    await expect(page.getByTestId('oauth-login-notice')).toHaveCount(0)
  })

  test('signing in from an authorization returns to the consent page of the client', { tag: ['@UI-AUTH-006'] }, async ({ page, user }) => {
    // Two authorize requests (before and after the sign-in) may each wait out the per-IP limit.
    test.setTimeout(180_000)
    const name = unique('consent-sign-in')
    const client = await registerTestClient(name)
    await openAuthorization(
      page,
      authorizationUrl({ clientId: client.client_id, scope: DEFAULT_MCP_SCOPES, challenge: pkce().challenge }),
      page.getByTestId('oauth-login-notice'),
    )
    expect(new URL(page.url()).pathname).toBe('/login')
    await expect(page.getByTestId('oauth-login-notice')).toHaveText(LOGIN_NOTICE)
    await page.getByLabel('Email').fill(user.email)
    await page.getByLabel('Password').fill(user.password)
    const since = networkChanges(page)
    await retryOnNetworkChange(page, async () => {
      await reserve('/sign-in/email')
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await page.waitForURL((url) => url.pathname !== '/login', { timeout: 20_000 })
    })
    // After the sign-in the browser continues the authorization (a second authorize request).
    await settleAuthorization(page, CONSENT_PATH, 120_000)
    await expectRendered(page, decisionsEnabled(page), since, page.url())
    await expect(page.getByTestId('oauth-client-name')).toHaveText(name)
    await expect(page.getByTestId('oauth-account')).toHaveText(user.email)
  })
})

test.describe('OAuth consent page without a registered client', () => {
  test(
    'without an authorization request the page says where it is reachable from and offers no decision',
    { tag: ['@UI-AUTH-015'] },
    async ({ page, user }) => {
      await openConsent(page, null)
      await expect(page.getByTestId('oauth-consent-error')).toContainText(ONLY_FROM_REQUEST)
      await expect(page.getByTestId('oauth-account')).toHaveText(user.email)
      await expect(page.getByRole('button', { name: 'Approve' })).toBeDisabled()
      await expect(page.getByRole('button', { name: 'Deny' })).toBeDisabled()
    },
  )

  test(
    'an unknown client shows the error inline, its redirect origin and the signed-in account',
    { tag: ['@UI-AUTH-015', '@UI-AUTH-012'] },
    async ({ page, user }) => {
      const lookup = page.waitForResponse((response) => response.url().includes('/api/auth/oauth2/public-client'))
      await openConsent(page, oauthQuery({ redirectUri: 'http://localhost:43123/oauth/callback' }))
      expect((await lookup).status()).toBe(404)
      const error = page.getByTestId('oauth-consent-error')
      await expect(error).toBeVisible()
      await expect(error).not.toContainText(ONLY_FROM_REQUEST)
      // Without client metadata the page names no one and shows no badge or link.
      await expect(page.getByTestId('oauth-client-name')).toHaveText('An application')
      await expect(page.getByText('unverified', { exact: true })).toHaveCount(0)
      await expect(page.getByTestId('oauth-consent').getByRole('link')).toHaveCount(0)
      // The redirect origin and the account are shown regardless.
      await expect(page.getByText('After approval you will return to')).toContainText('http://localhost:43123')
      await expect(page.getByTestId('oauth-redirect-origin')).toHaveText('http://localhost:43123')
      await expect(page.getByTestId('oauth-account')).toHaveText(user.email)
      await expect(page.getByRole('button', { name: 'Approve' })).toBeDisabled()
      await expect(page.getByRole('button', { name: 'Deny' })).toBeDisabled()
    },
  )

  test('a client identified by a metadata document is named by its host and is not labelled unverified', { tag: ['@UI-AUTH-012'] }, async ({ page }) => {
    // A reserved TLD: the metadata fetch fails, the host is still shown.
    await openConsent(page, oauthQuery({ clientId: 'https://agent.example/oauth/client.json' }))
    await expect(page.getByTestId('oauth-client-name')).toHaveText('agent.example')
    await expect(page.getByText('Identified by its metadata document on')).toContainText('agent.example')
    await expect(page.getByText('unverified', { exact: true })).toHaveCount(0)
  })

  test('a user is offered Read only and Read and write, with Read and write preselected', { tag: ['@UI-AUTH-013'] }, async ({ page }) => {
    await openConsent(page, oauthQuery({ scope: ADMIN_MCP_SCOPES }))
    await expect(page.getByRole('radiogroup', { name: 'Access level' })).toBeVisible()
    await expect(radio(page, 'Read only')).toBeVisible()
    await expect(radio(page, 'Read and write')).toBeChecked()
    await expect(radio(page, 'Read only')).not.toBeChecked()
    await expect(radio(page, 'Admin')).toHaveCount(0)
  })

  test.describe('as an admin', () => {
    test.use({ role: 'admin' })

    test('an admin is also offered Admin, which is never preselected', { tag: ['@UI-AUTH-013'] }, async ({ page }) => {
      await openConsent(page, oauthQuery({ scope: ADMIN_MCP_SCOPES }))
      await expect(radio(page, 'Admin')).toBeVisible()
      await expect(radio(page, 'Admin')).not.toBeChecked()
      await expect(radio(page, 'Read and write')).toBeChecked()
    })
  })
})

test.describe('OAuth consent page with a registered client', () => {
  test(
    'the page shows the client name, the unverified badge, its homepage link, the redirect origin and the account',
    { tag: ['@UI-AUTH-012'] },
    async ({ page, user }) => {
      test.setTimeout(180_000)
      const clientName = unique('consent-client')
      const client = await registerTestClient(clientName, { client_uri: 'https://tools.example.com/about' })
      await openAuthorization(
        page,
        authorizationUrl({ clientId: client.client_id, scope: DEFAULT_MCP_SCOPES, challenge: pkce().challenge }),
        decisionsEnabled(page),
      )
      expect(new URL(page.url()).pathname).toBe(CONSENT_PATH)
      await expect(page.getByTestId('oauth-client-name')).toHaveText(clientName)
      await expect(page.getByText('unverified', { exact: true })).toBeVisible()
      const link = page.getByRole('link', { name: 'https://tools.example.com/about' })
      await expect(link).toHaveAttribute('href', 'https://tools.example.com/about')
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
      await expect(page.getByTestId('oauth-redirect-origin')).toHaveText(CALLBACK.origin)
      await expect(page.getByTestId('oauth-account')).toHaveText(user.email)
    },
  )

  test('a level is enabled only when the client requested all of its scopes', { tag: ['@UI-AUTH-013'] }, async ({ page }) => {
    // The query a real authorization of this client for `offline_access scantor:read` carries (the page reads only
    // the client id and the scopes for the levels).
    const client = await registerTestClient()
    await openConsent(page, oauthQuery({ clientId: client.client_id, scope: 'offline_access scantor:read' }))
    await expect(page.getByRole('button', { name: 'Approve' })).toBeEnabled()
    await expect(radio(page, 'Read only')).toBeEnabled()
    await expect(radio(page, 'Read only')).toBeChecked()
    await expect(radio(page, 'Read and write')).toBeDisabled()
    await expect(radio(page, 'Admin')).toHaveCount(0)
  })

  test(
    'Approve with Read only yields a token without write tools; both buttons are disabled while submitting',
    { tag: ['@UI-AUTH-014', '@UI-AUTH-013'] },
    async ({ page }) => {
      test.setTimeout(180_000)
      const client = await registerTestClient()
      const { verifier, challenge } = pkce()
      const callback = await catchCallback(page)
      // Hold the consent request until the disabled buttons are checked.
      let release!: () => void
      const held = new Promise<void>((done) => (release = done))
      await page.route('**/api/auth/oauth2/consent', async (route) => {
        await held
        await route.continue()
      })

      await openAuthorization(page, authorizationUrl({ clientId: client.client_id, scope: DEFAULT_MCP_SCOPES, challenge }), decisionsEnabled(page))
      expect(new URL(page.url()).pathname).toBe(CONSENT_PATH)
      await expect(radio(page, 'Read and write')).toBeChecked()
      await radio(page, 'Read only').check()
      await page.getByRole('button', { name: 'Approve' }).click()
      await expect(page.getByRole('button', { name: 'Approve' })).toBeDisabled()
      await expect(page.getByRole('button', { name: 'Deny' })).toBeDisabled()
      release()

      const redirect = await within(callback(), 30_000, 'the browser returned to the client')
      const code = redirect.searchParams.get('code')
      expect(code, redirect.toString()).toBeTruthy()
      const context = await newApiContext()
      const tokens = await exchangeCode(context, client.client_id, code!, verifier).finally(() => context.dispose())
      expect(String(jwtClaims(tokens.access_token).scope).split(' ').sort()).toEqual(['offline_access', 'scantor:read'])
      const mcp = await connectMcpWithKey(tokens.access_token)
      try {
        const names = (await mcp.listTools()).tools.map((tool) => tool.name)
        expect(names).toContain('get_scan')
        expect(names).not.toContain('start_scan')
      } finally {
        await mcp.close()
      }
    },
  )

  test('Deny returns access_denied to the client', { tag: ['@UI-AUTH-014'] }, async ({ page }) => {
    test.setTimeout(180_000)
    const client = await registerTestClient()
    const callback = await catchCallback(page)
    await openAuthorization(
      page,
      authorizationUrl({ clientId: client.client_id, scope: DEFAULT_MCP_SCOPES, challenge: pkce().challenge, state: 'deny-state' }),
      decisionsEnabled(page),
    )
    expect(new URL(page.url()).pathname).toBe(CONSENT_PATH)
    // A Deny whose request the network change aborted leaves the page with its buttons enabled: deny again.
    let redirect!: URL
    await retryOnNetworkChange(page, async () => {
      await page.getByRole('button', { name: 'Deny' }).click()
      redirect = await within(callback(), 20_000, 'the browser returned to the client')
    })
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI)
    expect(redirect.searchParams.get('error')).toBe('access_denied')
    expect(redirect.searchParams.get('state')).toBe('deny-state')
    expect(redirect.searchParams.get('code')).toBeNull()
  })
})
