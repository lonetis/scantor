import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  expect,
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
  type Response,
  type Route,
  type WorkerInfo,
} from '@playwright/test'
import type { ItemList, JobAccepted, Page as ListPage } from '#shared/types/common'
import type { Credential } from '#shared/types/credentials'
import type { Node } from '#shared/types/nodes'
import type { Scan } from '#shared/types/scans'
import type { Task, WriteTaskFilesResult } from '#shared/types/tasks'
import type { User } from '#shared/types/users'
import type { Tenant } from '../fixtures'
import { ApiClient, ApiError, ok } from './api-client'
import { env } from './env'
import { reserve } from './limiter'
import type { OpenApiIndex } from './openapi'
import { waitForScanState } from './scans'
import { createUser, deleteUser, newApiContext, signIn } from './users'

// Shared code of the UI specs for the shell, sign-in, account, credentials, editor, admin and task pages
// (ui/{auth,passkeys,navigation,tasks,revisions,editor,account,credentials,admin-*}.spec.ts). Error states that the
// shared stack cannot produce (5xx, 429, an unreachable orchestrator, feature flags) are answered by route mocks; every
// other state comes from the real API.

/** A Nuxt UI alert (UAlert has no ARIA role) found by its title. */
export function alertBox(scope: Page | Locator, title: string | RegExp): Locator {
  return scope.locator('[data-slot="title"]').filter({ hasText: title }).locator('xpath=ancestor::*[@data-slot="root"][1]')
}

// ── navigation ───────────────────────────────────────────────────────────────────────────────────────────

const NAVIGATION_ATTEMPTS = 3
/** How long a navigated page may take to render its shell. */
const RENDER_TIMEOUT_MS = 20_000
const RENDER_POLL_MS = 200

/**
 * Polls until the SPA rendered its shell or Nuxt shows a failed chunk. Polled rather than awaited once: a page that
 * navigates on its own right after loading (the login page's hard navigation to the redirect target) is blank for a
 * moment between the two documents.
 */
async function renderOutcome(page: Page): Promise<'rendered' | 'failedChunk' | 'blank'> {
  const shell = page.locator('#__nuxt').locator('main, nav, h1')
  const failedChunk = page.getByText('Failed to fetch dynamically imported module')
  const deadline = Date.now() + RENDER_TIMEOUT_MS
  for (;;) {
    if ((await failedChunk.count()) > 0) return 'failedChunk'
    if ((await shell.count()) > 0) return 'rendered'
    if (Date.now() > deadline) return 'blank'
    await new Promise((resolve) => setTimeout(resolve, RENDER_POLL_MS))
  }
}

/** A document load broken by a network change (Chromium shows its error page instead). */
const NETWORK_CHANGED_NAVIGATION = /ERR_NETWORK_CHANGED|chrome-error:\/\/chromewebdata/

/**
 * A navigation that a newer one replaced: Chromium repeats a document load that failed with net::ERR_NETWORK_CHANGED
 * by itself, and Nuxt reloads the page after a chunk failed that way. The newer navigation is waited for.
 */
const INTERRUPTED_NAVIGATION = /is interrupted by another navigation/

/**
 * Loads a page and waits until the SPA rendered. The inner dockerd changes the runner's network interfaces whenever a
 * test elsewhere creates a container network, and Chromium then fails in-flight requests with net::ERR_NETWORK_CHANGED
 * (docs/testing.md §9). helpers/ui.ts gotoWithRetry covers the document itself; a lazily loaded chunk that fails the
 * same way leaves a blank page or Nuxt's 500 page, and a failed API call leaves the page without its data and with a
 * "Cannot reach the orchestrator" toast, so such a load is repeated too.
 */
async function loadRendered(page: Page, navigate: () => Promise<unknown>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    let networkChanged = false
    const onFailed = (request: Request) => {
      if (request.failure()?.errorText.includes('ERR_NETWORK_CHANGED')) networkChanged = true
    }
    page.on('requestfailed', onFailed)
    try {
      try {
        await navigate()
      } catch (error) {
        if (INTERRUPTED_NAVIGATION.test(String(error))) {
          await page.waitForLoadState('load')
        } else {
          if (!NETWORK_CHANGED_NAVIGATION.test(String(error)) || attempt >= NAVIGATION_ATTEMPTS) throw error
          continue
        }
      }
      const outcome = await renderOutcome(page)
      if (outcome === 'rendered' && (!networkChanged || attempt >= NAVIGATION_ATTEMPTS)) return
      if (outcome === 'blank' && !networkChanged) throw new Error(`${page.url()} rendered nothing within ${RENDER_TIMEOUT_MS / 1000} s`)
      if (outcome !== 'rendered' && attempt >= NAVIGATION_ATTEMPTS)
        throw new Error(`${page.url()} did not load: a request failed with net::ERR_NETWORK_CHANGED ${attempt} times`)
    } finally {
      page.off('requestfailed', onFailed)
    }
  }
}

/** How long a request sent on behalf of the browser may take. */
const NODE_FETCH_TIMEOUT_MS = 60_000

type ContextFixture = ({ context }: { context: BrowserContext }, use: (context: BrowserContext) => Promise<void>) => Promise<void>

/**
 * Body of a `context` override (`base.extend({ context: nodeRoutedContext })`): the dashboard origin's requests (API
 * calls, chunks and documents) are sent by Playwright's Node-side client (route.fetch) and handed to the page, because
 * Chromium fails its in-flight requests with net::ERR_NETWORK_CHANGED whenever the inner dockerd adds or removes an
 * interface, which every container start of the shared stack does (docs/testing.md §9). The page still sees the same
 * requests and responses (headers, cookies, status, CSP); event streams stay in the browser because route.fetch buffers
 * whole responses. Routes a test registers on the page take precedence and fall back to this one.
 *
 * With `documents: false` page and frame loads go through Chromium (openPage and reloadPage repeat a failed one): a
 * fulfilled document has no loopback address, so Chromium's local network access checks would block its iframes and its
 * requests to the other *.scantor.localhost origins (the editor iframe). `origins` adds origins to route (the editor's
 * scripts and styles); WebSockets always stay in Chromium.
 */
export function nodeRouted(options: { documents?: boolean; origins?: string[] } = {}): ContextFixture {
  const documents = options.documents ?? true
  const origins = new Set([env.publicUrl, ...(options.origins ?? [])])
  return async ({ context }, use) => {
    await context.route(
      (url) => origins.has(url.origin),
      async (route) => {
        const request = route.request()
        const eventStream = request.resourceType() === 'eventsource' || (request.headers()['accept'] ?? '').includes('text/event-stream')
        if (eventStream || (!documents && request.isNavigationRequest())) {
          await route.fallback()
          return
        }
        let response: APIResponse
        try {
          response = await route.fetch({ maxRedirects: 0, timeout: NODE_FETCH_TIMEOUT_MS })
        } catch {
          // The page closed meanwhile, or the request really failed: the page sees a failed request either way.
          await route.abort('failed').catch(() => undefined)
          return
        }
        // Fails only when the page closed meanwhile.
        await route.fulfill({ response }).catch(() => undefined)
      },
    )
    await use(context)
  }
}

/** nodeRouted() with every request of the dashboard origin, documents included. */
export const nodeRoutedContext: ContextFixture = nodeRouted()

/** page.goto that repeats a load broken by net::ERR_NETWORK_CHANGED (see loadRendered). */
export async function openPage(page: Page, url: string): Promise<void> {
  await loadRendered(page, () => page.goto(url))
}

/** page.reload that repeats a load broken by net::ERR_NETWORK_CHANGED (see loadRendered). */
export async function reloadPage(page: Page): Promise<void> {
  await loadRendered(page, () => page.reload())
}

/** Marks the document hidden or visible and fires visibilitychange (what a tab switch does). */
export async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value === 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

/**
 * Switches away from the tab and back. Every poll refetches at once when its page becomes visible again (docs/ui.md
 * §9), so a test sees the next poll's result without waiting out a long interval.
 */
export async function revisitTab(page: Page): Promise<void> {
  await setVisibility(page, 'hidden')
  await setVisibility(page, 'visible')
}

/**
 * The open toasts. A modal dialog hides everything outside it from the accessibility tree, the toast region included,
 * so the region is found by its attributes instead of its role.
 */
export function openToastItems(page: Page): Locator {
  return page.locator('[role="region"][aria-label^="Notifications"] li[data-state="open"]')
}

/** Expects an open toast with the text, also while a modal dialog is open. */
export async function expectToastAnywhere(page: Page, text: string | RegExp, timeout?: number): Promise<void> {
  await expect(openToastItems(page).filter({ hasText: text }).first()).toBeVisible({ timeout })
}

/** Every localStorage and sessionStorage entry of the page's origin, as one string to search for secrets. */
export async function browserStorage(page: Page): Promise<string> {
  return page.evaluate(() => {
    const dump = (storage: Storage) => {
      const entries: Record<string, string | null> = {}
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index)
        if (key !== null) entries[key] = storage.getItem(key)
      }
      return entries
    }
    return JSON.stringify({ localStorage: dump(window.localStorage), sessionStorage: dump(window.sessionStorage) })
  })
}

/** Asserts that none of the secrets appears in the page's browser storage. */
export async function expectStorageWithout(page: Page, secrets: string[]): Promise<void> {
  const storage = await browserStorage(page)
  for (const secret of secrets) expect(storage, 'browser storage must never hold a secret').not.toContain(secret)
}

export interface MockedError {
  status: number
  code: string
  message: string
  details?: Record<string, unknown>
  requestId?: string
}

/** Fulfils a route with the API error envelope (docs/api.md §1.7). */
export async function fulfillError(route: Route, error: MockedError): Promise<void> {
  await route.fulfill({
    status: error.status,
    contentType: 'application/json',
    headers: { 'cache-control': 'no-store', ...(error.requestId ? { 'x-request-id': error.requestId } : {}) },
    body: JSON.stringify({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }),
  })
}

/** Fulfils a route with a JSON body. */
export async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) })
}

/** Rewrites the JSON body of the real response (for example a feature flag of getInstanceInfo). */
export async function patchJsonResponse<T>(route: Route, patch: (body: T) => T): Promise<void> {
  const response = await route.fetch()
  const body = (await response.json()) as T
  await route.fulfill({ response, json: patch(body) })
}

/** True for a request of the given method to exactly this API path (query ignored). */
export function isApiRequest(request: Request, method: string, path: string | RegExp): boolean {
  if (request.method() !== method) return false
  const pathname = new URL(request.url()).pathname
  return typeof path === 'string' ? pathname === path : path.test(pathname)
}

/** Records the API requests a page sends (method and URL), for assertions on requests that must or must not happen. */
export function recordApiRequests(page: Page): { method: string; url: URL }[] {
  const requests: { method: string; url: URL }[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) requests.push({ method: request.method(), url })
  })
  return requests
}

// ── sign-ins ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * better-auth resets its per-IP sign-in counter only after a whole window without an allowed sign-in, so under the
 * suite's sustained load a sign-in can get 429 although the shared limiter granted its slot. Such a 429 says nothing
 * about the behaviour under test: wait for `X-Retry-After` and try again (each attempt reserves a new slot).
 */
const SIGN_IN_ATTEMPTS = 6

function retryAfterMs(headers: Record<string, string>): number {
  const seconds = Number(headers['x-retry-after'] ?? '')
  return (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) : 30) * 1000 + 500
}

// ── tenants ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Creates a user as admin, signs in (waiting out a 429), saves the session under a file name of its own and creates a
 * `default` API key: the Tenant of fixtures.ts. Remove it with disposeTenant.
 */
async function createTenant(adminApi: ApiClient, openapi: OpenApiIndex, prefix: string): Promise<Tenant> {
  const user = await createUser(adminApi, { prefix })
  try {
    const session = await signedInContextWithRetry(user.email, user.password)
    try {
      await mkdir(env.paths.auth, { recursive: true })
      const storageState = join(env.paths.auth, `ui-shell-tasks-${user.id}.json`)
      await session.storageState({ path: storageState })
      const key = ok(await new ApiClient(session, openapi).createApiKey('tests'), 'createApiKey')
      return { ...user, storageState, apiKey: key.key }
    } finally {
      await session.dispose()
    }
  } catch (error) {
    await deleteUser(adminApi, user.id)
    throw error
  }
}

/** Deletes the tenant (its userPurge job removes everything it owns) and its session file. */
async function disposeTenant(adminApi: ApiClient, tenant: Tenant): Promise<void> {
  await deleteUser(adminApi, tenant.id)
  await rm(tenant.storageState, { force: true })
}

/**
 * Body of a worker-scoped `user` override (`base.extend({ user: [workerTenant, { scope: 'worker' }] })`): the same kind
 * of tenant as the shared fixture's, whose sign-in waits out a 429 of better-auth's per-IP budget (see
 * signedInContextWithRetry), saved under a file name of its own and removed with it.
 */
export async function workerTenant(
  { adminApi, openapi }: { adminApi: ApiClient; openapi: OpenApiIndex },
  use: (tenant: Tenant) => Promise<void>,
  workerInfo: WorkerInfo,
): Promise<void> {
  const tenant = await createTenant(adminApi, openapi, `w${workerInfo.workerIndex}`)
  try {
    await use(tenant)
  } finally {
    await disposeTenant(adminApi, tenant)
  }
}

/**
 * Body of a `freshUserHandle` override (`base.extend({ freshUserHandle: freshTenantHandle })`): the shared fixture's
 * lazily created fresh user, whose sign-in waits out a 429 of better-auth's per-IP budget (see signedInContextWithRetry).
 */
export async function freshTenantHandle(
  { adminApi, openapi }: { adminApi: ApiClient; openapi: OpenApiIndex },
  use: (handle: { get(): Promise<Tenant> }) => Promise<void>,
): Promise<void> {
  let created: Promise<Tenant> | undefined
  await use({ get: () => (created ??= createTenant(adminApi, openapi, 'fresh')) })
  // A creation that failed already failed the test that asked for the user, and removed the user again.
  const tenant = created ? await created.catch(() => null) : null
  if (tenant) await disposeTenant(adminApi, tenant)
}

/** signedInContext of helpers/users.ts that waits out a 429 of the shared sign-in budget. */
export async function signedInContextWithRetry(email: string, password: string): Promise<APIRequestContext> {
  for (let attempt = 1; ; attempt++) {
    const context = await newApiContext()
    const response = await signIn(context, email, password)
    if (response.status === 200) return context
    await context.dispose()
    if (response.status !== 429 || attempt >= SIGN_IN_ATTEMPTS) throw new ApiError(`sign-in of ${email}`, response)
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs(response.headers)))
  }
}

/**
 * Submits the login form (filled by the caller) through the limiter and waits for its answer; a 429 of the shared
 * budget is waited out and the form submitted again. Returns the final sign-in response.
 */
export async function submitLoginForm(page: Page): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    await reserve('/sign-in/email')
    const answer = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/sign-in/email')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    const response = await answer
    if (response.status() !== 429 || attempt >= SIGN_IN_ATTEMPTS) return response
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs(response.headers())))
  }
}

// ── API setup for page tests ─────────────────────────────────────────────────────────────────────────────

/** Creates a scaffolded task (no build); register it with `tasks.track(name)` for cleanup. */
export async function createScaffoldTask(
  api: ApiClient,
  name: string,
  options: { language?: string; template?: string; description?: string } = {},
): Promise<Task> {
  return ok(
    await api.call<Task>('createTask', {
      body: { name, language: options.language ?? 'python', template: options.template ?? 'single', description: options.description },
    }),
    'createTask',
  )
}

/** Writes workspace files of a task (UTF-8 text, or `{base64}` for binary content). */
export async function writeTaskFiles(api: ApiClient, task: string, files: Record<string, string | { base64: string }>): Promise<WriteTaskFilesResult> {
  return ok(await api.call<WriteTaskFilesResult>('writeTaskFiles', { path: { task }, body: { files } }), 'writeTaskFiles')
}

/** A pool that no node belongs to: the workers of a scan that selects it stay pending, so it starts no container. */
const UNPLACED_POOL = 'ui-shell-tasks-nowhere'

/**
 * Starts a real scan of the user whose workers no node can place (`nodeSelector.pool` is UNPLACED_POOL): it counts as
 * an active scan (sidebar badge, 409 taskInUse) without costing a worker container. Stop it with cancelScanAndWait.
 * It is not deleted afterwards: scanDelete jobs (concurrency 2, each with a settle phase) queue for minutes on a busy
 * shared stack, a cancelled scan no longer blocks deleting its task, and the tenant's purge removes it.
 */
export async function startUnplacedScan(api: ApiClient, revision: string, name: string): Promise<Scan> {
  return ok(
    await api.startScan({
      revision,
      name,
      settings: { workers: 1, processes: 1, resources: { cpus: 0.25, memoryMiB: 256 }, nodeSelector: { pool: UNPLACED_POOL } },
    }),
    'startScan',
  )
}

/** Cancels a scan (a terminal one is left alone) and waits until it is cancelled. */
export async function cancelScanAndWait(api: ApiClient, scanId: string, timeoutMs = 60_000): Promise<void> {
  const scan = ok(await api.getScan(scanId), 'getScan')
  if (scan.state === 'completed' || scan.state === 'failed' || scan.state === 'cancelled') return
  ok(await api.cancelScan(scanId), 'cancelScan')
  await waitForScanState(api, scanId, 'cancelled', timeoutMs)
}

/** Waits until a job reached a terminal state; returns it. */
export async function waitForJob(api: ApiClient, jobId: string, timeoutMs = 120_000): Promise<{ state: string }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = ok(await api.getJob(jobId, 10), 'getJob')
    if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') return job
    if (Date.now() > deadline) throw new Error(`job ${jobId} is still ${job.state} after ${timeoutMs / 1000} s`)
  }
}

/** Deletes a task and waits for its taskDelete job, so its name is free again (TASK-012). */
export async function deleteTaskAndWait(api: ApiClient, task: string): Promise<void> {
  const response = await api.deleteTask(task)
  if (response.status === 404) return
  const accepted = ok(response, `deleteTask ${task}`) as JobAccepted
  const job = await waitForJob(api, accepted.job.id)
  if (job.state !== 'succeeded') throw new Error(`taskDelete of ${task} ended ${job.state}`)
}

/** The caller's git credentials. */
export async function listCredentials(api: ApiClient): Promise<Credential[]> {
  return ok(await api.call<ItemList<Credential>>('listCredentials'), 'listCredentials').items
}

export async function createCredential(api: ApiClient, body: { name: string; host: string; username?: string; token: string }): Promise<Credential> {
  return ok(await api.call<Credential>('createCredential', { body: { kind: 'gitToken', username: 'x-access-token', ...body } }), 'createCredential')
}

/** Deletes the caller's credentials with these names (missing ones are fine). */
export async function deleteCredentialsNamed(api: ApiClient, names: string[]): Promise<void> {
  for (const credential of await listCredentials(api)) {
    if (!names.includes(credential.name)) continue
    const response = await api.call('deleteCredential', { path: { credentialId: credential.id } })
    if (response.status !== 204 && response.status !== 404) throw new ApiError('deleteCredential', response)
  }
}

/** A user found by exact email through the admin search, or null. */
export async function findUserByEmail(adminApi: ApiClient, email: string): Promise<User | null> {
  const page = ok(await adminApi.call<ListPage<User>>('listUsers', { query: { q: email } }), 'listUsers')
  return page.items.find((user) => user.email === email) ?? null
}

/** Deletes the users with these emails (created through the UI by a test); missing ones are fine. */
export async function deleteUsersByEmail(adminApi: ApiClient, emails: string[]): Promise<void> {
  for (const email of emails) {
    const user = await findUserByEmail(adminApi, email)
    if (!user) continue
    const response = await adminApi.deleteUser(user.id)
    if (response.status !== 202 && response.status !== 404) throw new ApiError('deleteUser', response)
  }
}

/** Deletes the nodes with these names (created through the UI by a test); missing ones are fine. */
export async function deleteNodesNamed(adminApi: ApiClient, names: string[]): Promise<void> {
  const nodes = ok(await adminApi.listNodes(), 'listNodes').items as Node[]
  for (const node of nodes) {
    if (!names.includes(node.name) || node.builtIn) continue
    const response = await adminApi.deleteNode(node.id)
    if (response.status !== 204 && response.status !== 404) throw new ApiError('deleteNode', response)
  }
}

/** The tenant's API keys of config `default`, for cleanup of keys a UI test created. */
export async function deleteApiKeysNamed(api: ApiClient, names: string[]): Promise<void> {
  const keys = ok(await api.call<ItemList<{ id: string; name: string | null }>>('listApiKeys', { query: { configId: 'default' } }), 'listApiKeys').items
  for (const key of keys) {
    if (!key.name || !names.includes(key.name)) continue
    const response = await api.call('deleteApiKey', { path: { keyId: key.id } })
    if (response.status !== 204 && response.status !== 404) throw new ApiError('deleteApiKey', response)
  }
}

// ── the browser editor ───────────────────────────────────────────────────────────────────────────────────

export interface EditorStatus {
  state: 'starting' | 'running' | 'stopping' | 'stopped'
  startedAt: string | null
  lastActivityAt: string | null
  idleTimeoutMs: number
  error: string | null
}

/** getEditor of the caller. */
export async function editorStatus(api: ApiClient): Promise<EditorStatus> {
  return ok(await api.call<EditorStatus>('getEditor'), 'getEditor')
}

/** Polls getEditor until the editor is in one of the states; returns its status. */
export async function waitForEditorState(api: ApiClient, states: EditorStatus['state'][], timeoutMs = 120_000): Promise<EditorStatus> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = await editorStatus(api)
    if (states.includes(status.state)) return status
    if (Date.now() > deadline)
      throw new Error(`the editor is ${status.state} (error ${status.error}) after ${timeoutMs / 1000} s, expected ${states.join(' or ')}`)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/** stopEditor, then waits until the editor is stopped. */
export async function stopEditorAndWait(api: ApiClient): Promise<void> {
  const response = await api.call('stopEditor')
  if (response.status !== 204) throw new ApiError('stopEditor', response)
  await waitForEditorState(api, ['stopped'])
}

/** createEditorSession (retrying 409 while the editor is still stopping), then waits until the editor runs. */
export async function startEditorAndWait(api: ApiClient, timeoutMs = 120_000): Promise<EditorStatus> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await api.call('createEditorSession', { body: {} })
    if (response.status === 201) break
    if (response.status !== 409 || Date.now() > deadline) throw new ApiError('createEditorSession', response)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return waitForEditorState(api, ['running'], Math.max(1000, deadline - Date.now()))
}

/**
 * importGitTask through the API. Git imports create fixed task names (`git-*`); a task of the same name that another
 * test of this worker deleted a moment ago blocks the name until its taskDelete job ends (TASK-012), so a 409 is retried.
 */
export async function importGitTask(
  api: ApiClient,
  body: { url: string; ref?: string; path?: string; credentialId?: string },
  timeoutMs = 60_000,
): Promise<Task[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await api.call<{ imported: Task[] }>('importGitTask', { body })
    if (response.status !== 409 || Date.now() > deadline) return ok(response, 'importGitTask').imported
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}
