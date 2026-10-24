import { expect, type Locator, type Page, type Response } from '@playwright/test'
import { reserveOAuth, retryAfterMs } from './mcp-limiter'
import { gotoWithRetry } from './ui'

// Browser helpers of the mcp writer's UI specs (ui/consent.spec.ts, ui/access.spec.ts):
//   - Chromium aborts requests with net::ERR_NETWORK_CHANGED when the inner dockerd changes the runner's network
//     interfaces (other specs' scans create networks all the time). helpers/ui.ts `gotoWithRetry` retries a failed
//     navigation, but when only a page's scripts or a later API request fail that way, the page stays blank or the
//     action shows "The orchestrator did not answer the request.". `gotoRendered`, `expectRendered` and
//     `retryOnNetworkChange` repeat such a load or action, and only when a request of the page failed that way since
//     it started; any other failure fails the test.
//   - `openAuthorization` opens an OAuth authorization URL like an MCP client does. better-auth limits authorize
//     requests per client IP (docs/auth.md §2.7) and the whole suite shares that IP, so a 429 page is waited out
//     (X-Retry-After) and loaded again; each attempt takes a slot of the OAuth budget of helpers/mcp-limiter.ts.

const NETWORK_CHANGED = 'net::ERR_NETWORK_CHANGED'
const AUTHORIZE_PATH = '/api/auth/oauth2/authorize'
const RENDER_TIMEOUT_MS = 15_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const changes = new WeakMap<Page, { count: number }>()

/** How many requests of the page failed with ERR_NETWORK_CHANGED so far (counting starts on the first call). */
export function networkChanges(page: Page): number {
  let counter = changes.get(page)
  if (!counter) {
    const created = { count: 0 }
    page.on('requestfailed', (request) => {
      if (request.failure()?.errorText.includes(NETWORK_CHANGED)) created.count++
    })
    changes.set(page, created)
    counter = created
  }
  return counter.count
}

/**
 * Runs a UI action that sends requests (and asserts its outcome) again when it failed while a request of the page
 * failed with ERR_NETWORK_CHANGED. The action must be repeatable from the state a failed attempt leaves behind.
 */
export async function retryOnNetworkChange(page: Page, action: (attempt: number) => Promise<void>, attempts = 3): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const before = networkChanges(page)
    try {
      await action(attempt)
      return
    } catch (error) {
      if (networkChanges(page) === before || attempt >= attempts) throw error
    }
  }
}

/**
 * Waits until `ready` is visible. A page that did not render because one of its requests failed with
 * ERR_NETWORK_CHANGED since `since` (a `networkChanges` value taken before the load) is opened again at `url` (a page
 * whose session check failed that way may already have moved on to /login on its own).
 */
export async function expectRendered(page: Page, ready: Locator, since: number, url: string, attempts = 3): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await expect(ready).toBeVisible({ timeout: RENDER_TIMEOUT_MS })
      return
    } catch (error) {
      if (networkChanges(page) === since || attempt >= attempts) throw error
      since = networkChanges(page)
      await gotoWithRetry(page, url)
    }
  }
}

/** Opens `url` and waits until `ready` is visible (see `expectRendered`). */
export async function gotoRendered(page: Page, url: string, ready: Locator): Promise<void> {
  const since = networkChanges(page)
  await gotoWithRetry(page, url)
  await expectRendered(page, ready, since, url)
}

/**
 * Opens an OAuth authorization URL in the browser and waits until the page it leads to shows `ready` (the consent or
 * the sign-in page). A 429 page of the per-IP authorize limit is waited out and loaded again until `timeoutMs`.
 */
export async function openAuthorization(page: Page, url: URL, ready: Locator, timeoutMs = 150_000): Promise<void> {
  const since = networkChanges(page)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await reserveOAuth('/oauth2/authorize')
    const response = await gotoWithRetry(page, url.toString())
    if (!response) throw new Error('the authorization did not navigate')
    if (response.status() !== 429) {
      // Opened again, the page the authorization led to (with its signed query) needs no new authorize request.
      await expectRendered(page, ready, since, response.url())
      return
    }
    if (Date.now() >= deadline) throw new Error(`the authorization is still rate-limited after ${timeoutMs / 1000} s`)
    await sleep(Math.min(retryAfterMs(await response.headerValue('x-retry-after')), Math.max(deadline - Date.now(), 0)))
  }
}

/**
 * Waits until the browser reaches `pathname` after an action that continues an authorization in the browser (the
 * sign-in on the way to the consent page). When the continued authorize request meets the per-IP limit, the 429
 * page is waited out and reloaded until `timeoutMs`.
 */
export async function settleAuthorization(page: Page, pathname: string, timeoutMs = 150_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let limited: Response | null = null
  const onResponse = (response: Response) => {
    if (new URL(response.url()).pathname !== AUTHORIZE_PATH || !response.request().isNavigationRequest()) return
    limited = response.status() === 429 ? response : null
  }
  page.on('response', onResponse)
  try {
    for (;;) {
      const reached = await page
        .waitForURL((url) => url.pathname === pathname, { timeout: 5_000 })
        .then(() => true)
        .catch(() => false)
      if (reached) return
      if (Date.now() >= deadline) throw new Error(`the browser did not reach ${pathname} within ${timeoutMs / 1000} s; it is at ${page.url()}`)
      const blocked = limited as Response | null
      if (blocked === null || new URL(page.url()).pathname !== AUTHORIZE_PATH) continue
      limited = null
      await sleep(Math.min(retryAfterMs(await blocked.headerValue('x-retry-after')), Math.max(deadline - Date.now(), 0)))
      await reserveOAuth('/oauth2/authorize')
      await page.reload()
    }
  } finally {
    page.off('response', onResponse)
  }
}
