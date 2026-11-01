import { join } from 'node:path'
import { expect, type APIResponse, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test'
import type { CreatedApiKey } from '#shared/types/account'
import type { Analysis } from '#shared/types/analyses'
import type { ItemList, Page as ListPage } from '#shared/types/common'
import type { Node } from '#shared/types/nodes'
import type { Scan } from '#shared/types/scans'
import type { Task } from '#shared/types/tasks'
import type { TestRun } from '#shared/types/test-runs'
import { ApiClient, ok } from './api-client'
import { env } from './env'
import { GIT_REPOS } from './fixtures-server'
import type { OpenApiIndex } from './openapi'
import { SMALL_SETTINGS, startScan, waitForScanState } from './scans'
import { exampleTaskDir, fixtureTaskDir, uploadAndPublish, type UploadedTask } from './tasks'
import { unique } from './unique'
import { createUser, deleteUser, newApiContext, signedInContext, type TestUser } from './users'

// The browser crawl behind ui/a11y.spec.ts and ui/headers.spec.ts (authz writer): a tenant of the spec's own, a small
// world of resources that makes every page of docs/ui.md §4 render its tables, forms, logs and badges, the list of
// those pages, a bounded-concurrency crawler, and the facts collected per page (accessibility tree, tables, badges,
// test ids and the tooltips of icon-only buttons).

// ── tenant ──────────────────────────────────────────────────────────────────────────────────────────────

/** A user with a saved session and a `default` API key (the shape of fixtures.ts' Tenant). */
export interface UiTenant extends TestUser {
  storageState: string
  apiKey: string
}

/**
 * A tenant whose storage state file is named after its unique user name. The fixtures' tenants use
 * `.auth/user-<workerIndex>.json`, which concurrent `just test-exec` runs overwrite with their own sessions; a
 * crawl that suddenly ran as another run's tenant would assert on the wrong data. Deleting the tenant (userPurge)
 * removes everything the world created (docs/data-model.md §5).
 */
export async function createUiTenant(adminApi: ApiClient, openapi: OpenApiIndex, prefix: string): Promise<UiTenant> {
  const user = await createUser(adminApi, { prefix })
  try {
    const session = await signedInContext(user.email, user.password)
    try {
      const storageState = join(env.paths.auth, `${user.name}.json`)
      await session.storageState({ path: storageState })
      const key = ok(await new ApiClient(session, openapi).call<CreatedApiKey>('createApiKey', { body: { name: 'tests', expiresInDays: 1 } }), 'createApiKey')
      return { ...user, storageState, apiKey: key.key }
    } finally {
      await session.dispose()
    }
  } catch (error) {
    await deleteUser(adminApi, user.id)
    throw error
  }
}

/**
 * Stops the tenant's editor, which the crawl's visit of /editor started (the page opens the editor on mount): the
 * stack's editor slots are shared by every spec, and nothing after the crawl needs it.
 */
export async function stopTenantEditor(tenant: UiTenant, openapi: OpenApiIndex): Promise<void> {
  const api = await tenantApi(tenant, openapi)
  try {
    const stopped = await api.call('stopEditor')
    if (![200, 202, 204].includes(stopped.status)) throw new Error(`stopEditor answered ${stopped.status}: ${JSON.stringify(stopped.body)}`)
  } finally {
    await api.request.dispose()
  }
}

/** An ApiClient on the tenant's session; dispose its `request`. */
export async function tenantApi(tenant: UiTenant, openapi: OpenApiIndex): Promise<ApiClient> {
  return new ApiClient(await newApiContext({ storageState: tenant.storageState }), openapi)
}

// ── the world the pages render ──────────────────────────────────────────────────────────────────────────

/** Settings whose workers can never be placed: the scan stays active with a `workersPending` condition. */
export const UNPLACEABLE_SETTINGS = { ...SMALL_SETTINGS, nodeSelector: { pool: 'authz-ui-nowhere' } } as const

export interface UiWorld {
  /** schema-zoo: forms with every widget (secret, array, "Edit as JSON") and a completed test run */
  zoo: UploadedTask
  zooTestRun: TestRun
  /** the `files` example with a completed two-analysis scan (results with file chips and image previews) and an export */
  files: UploadedTask
  scan: Scan
  analysis: Analysis
  exportId: string
  /** a scan whose workers can never be placed (condition workersPending) */
  pendingScan: Scan
  /** hostile-label: a revision that failed at static (build errors) */
  failed: UploadedTask
  /** a scaffold task without any revision (unpublished changes) */
  draft: Task
  /** a task imported from the fixtures server's git repository (Pull from git) */
  git: Task
  /** the `sleep` example (long test runs that can be cancelled), only when asked for */
  sleep?: UploadedTask
}

async function waitForTestRun(api: ApiClient, testRunId: string, timeoutMs = 120_000): Promise<TestRun> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const wait = Math.max(1, Math.min(60, Math.ceil((deadline - Date.now()) / 1000)))
    const run = ok(await api.call<TestRun>('getTestRun', { path: { testRunId }, query: { wait } }), 'getTestRun')
    if (['completed', 'failed', 'cancelled'].includes(run.state)) return run
    if (Date.now() > deadline) throw new Error(`test run ${testRunId} is still ${run.state} after ${timeoutMs / 1000} s`)
  }
}

/**
 * Builds the world as the tenant, every chain in parallel: each task's follow-up (test run, scans, export) starts as
 * soon as its own revision is ready. Nothing is removed here: deleting the tenant purges all of it.
 */
export async function createWorld(api: ApiClient, label: string, options: { sleep?: boolean } = {}): Promise<UiWorld> {
  const zooChain = (async () => {
    const zoo = await uploadAndPublish(api, fixtureTaskDir('schema-zoo'), unique(`${label}-zoo`), { timeoutMs: 150_000 })
    const started = ok(await api.call<TestRun>('testTask', { path: { task: zoo.task.id }, body: { limit: 1 } }), 'testTask')
    const run = await waitForTestRun(api, started.id)
    expect(run.state, `the schema-zoo test run: ${JSON.stringify(run.errors ?? null)}`).toBe('completed')
    return { zoo, zooTestRun: run }
  })()
  const filesChain = (async () => {
    const files = await uploadAndPublish(api, exampleTaskDir('files'), unique(`${label}-files`), { timeoutMs: 150_000 })
    const [scan, pendingScan] = await Promise.all([
      startScan(api, { revision: files.revision.id, name: unique(`${label}-scan`), scanConfig: { items: ['alpha.example', 'beta.example'] } }),
      startScan(api, { revision: files.revision.id, name: unique(`${label}-pending`), scanConfig: { items: ['x'] }, settings: UNPLACEABLE_SETTINGS }),
    ])
    const [completed] = await Promise.all([
      waitForScanState(api, scan.id, 'completed', 150_000),
      expect
        .poll(async () => ok(await api.getScan(pendingScan.id), 'getScan').conditions.map((c) => c.type), {
          timeout: 120_000,
          intervals: [500, 1_000],
          message: 'the pending scan reports workersPending',
        })
        .toContain('workersPending'),
    ])
    const [analyses, exported] = await Promise.all([
      api.call<ListPage<Analysis>>('listAnalyses', { path: { scanId: scan.id } }).then((r) => ok(r, 'listAnalyses')),
      api
        .call<{ id: string; state: string }>('exportScan', { path: { scanId: scan.id }, body: { format: 'jsonl' }, query: { wait: 60 } })
        .then((r) => ok(r, 'exportScan')),
    ])
    const analysis = analyses.items.find((a) => a.seq === 0) ?? analyses.items[0]
    if (!analysis) throw new Error(`the scan ${scan.id} of the world has no analyses`)
    return { files, scan: completed, analysis, exportId: exported.id, pendingScan }
  })()
  const [zoo, files, failed, draft, git, sleep] = await Promise.all([
    zooChain,
    filesChain,
    uploadAndPublish(api, fixtureTaskDir('hostile-label'), unique(`${label}-failed`), { expectState: 'failed', timeoutMs: 150_000 }),
    api.call<Task>('createTask', { body: { name: unique(`${label}-draft`), language: 'python' } }).then((r) => ok(r, 'createTask')),
    api.call<{ imported: Task[] }>('importGitTask', { body: { url: GIT_REPOS.single } }).then((r) => ok(r, 'importGitTask').imported[0]!),
    options.sleep ? uploadAndPublish(api, exampleTaskDir('sleep'), unique(`${label}-sleep`), { timeoutMs: 150_000 }) : Promise.resolve(undefined),
  ])
  return { ...zoo, ...files, failed, draft, git, sleep }
}

/** The built-in node (read-only: its detail page is only viewed). */
export async function builtinNode(adminApi: ApiClient): Promise<Node> {
  const nodes = ok(await adminApi.call<ItemList<Node>>('listNodes'), 'listNodes').items
  const node = nodes.find((n) => n.builtIn)
  if (!node) throw new Error('no built-in node')
  return node
}

// ── the pages of docs/ui.md §4 ──────────────────────────────────────────────────────────────────────────

export type Viewer = 'user' | 'admin' | 'anonymous'

export interface UiPage {
  /** a short name for messages */
  name: string
  path: string
  viewer: Viewer
  /** resolves once the page shows its data */
  ready(page: Page): Promise<void>
}

/**
 * Every ready check gets 20 s, not the 10 s of a UI assertion: the crawl loads six pages at a time through Playwright's
 * HTTP client (`routeThroughPlaywright`, which also turns off the browser cache), next to the other workers' browsers
 * and the stack, so on a CI runner the chunks, the session and the data of a plain page can take longer than 10 s.
 */
const SLOW = 20_000
const heading = (page: Page, name: string | RegExp) => expect(page.getByRole('heading', { level: 1, name })).toBeVisible({ timeout: SLOW })
const row = (page: Page, id: string | number) => expect(page.locator(`tr[data-row-id="${id}"]`).first()).toBeVisible({ timeout: SLOW })
const testId = (page: Page, id: string) => expect(page.getByTestId(id).first()).toBeVisible({ timeout: SLOW })
const button = (page: Page, name: string | RegExp) =>
  expect(page.getByRole('button', { name, exact: typeof name === 'string' }).first()).toBeVisible({ timeout: SLOW })

/** Every route of docs/ui.md §4 (tabs of the detail pages included) with the world's ids. */
export function uiPages(world: UiWorld, tenant: UiTenant, node: Node): UiPage[] {
  const zoo = world.zoo.task
  const scan = world.scan
  return [
    { name: 'login', path: '/login', viewer: 'anonymous', ready: (p) => button(p, 'Sign in') },
    { name: 'setup', path: '/setup', viewer: 'anonymous', ready: (p) => button(p, 'Sign in') },
    { name: 'consent (signed out)', path: '/oauth/consent?client_id=authz-ui&scope=openid', viewer: 'anonymous', ready: (p) => button(p, 'Sign in') },
    {
      name: 'consent',
      path: `/oauth/consent?${new URLSearchParams({ client_id: 'authz-ui-unknown', scope: 'offline_access scantor:read scantor:write', redirect_uri: 'http://127.0.0.1:53682/callback' })}`,
      viewer: 'user',
      ready: (p) => expect(p.getByTestId('oauth-account')).toHaveText(tenant.email, { timeout: SLOW }),
    },
    { name: 'overview', path: '/', viewer: 'user', ready: (p) => expect(p.getByRole('link', { name: zoo.name }).first()).toBeVisible({ timeout: SLOW }) },
    { name: 'tasks', path: '/tasks', viewer: 'user', ready: (p) => row(p, zoo.id) },
    { name: 'new task', path: '/tasks/new', viewer: 'user', ready: (p) => button(p, /^From a scaffold/) },
    { name: 'task overview', path: `/tasks/${zoo.id}?tab=overview`, viewer: 'user', ready: (p) => button(p, 'Publish revision') },
    {
      name: 'task files',
      path: `/tasks/${zoo.id}?tab=files`,
      viewer: 'user',
      ready: (p) => expect(p.getByText('scantor.yaml', { exact: true }).filter({ visible: true }).first()).toBeVisible({ timeout: SLOW }),
    },
    { name: 'task revisions', path: `/tasks/${zoo.id}?tab=revisions`, viewer: 'user', ready: (p) => row(p, world.zoo.revision.id) },
    { name: 'task test', path: `/tasks/${zoo.id}?tab=test`, viewer: 'user', ready: (p) => row(p, world.zooTestRun.id) },
    { name: 'draft task', path: `/tasks/${world.draft.id}`, viewer: 'user', ready: (p) => testId(p, 'unpublished-badge') },
    { name: 'git task', path: `/tasks/${world.git.id}`, viewer: 'user', ready: (p) => button(p, 'Pull from git') },
    { name: 'revision', path: `/tasks/${zoo.id}/revisions/${world.zoo.revision.number}`, viewer: 'user', ready: (p) => testId(p, 'build-log') },
    {
      name: 'failed revision',
      path: `/tasks/${world.failed.task.id}/revisions/${world.failed.revision.number}`,
      viewer: 'user',
      ready: (p) => testId(p, 'build-errors'),
    },
    { name: 'editor', path: '/editor', viewer: 'user', ready: (p) => button(p, 'Stop editor') },
    { name: 'scans', path: '/scans', viewer: 'user', ready: (p) => row(p, scan.id) },
    { name: 'new scan', path: `/scans/new?revision=${encodeURIComponent(`${zoo.id}@latest`)}`, viewer: 'user', ready: (p) => button(p, 'Edit as JSON') },
    { name: 'scan overview', path: `/scans/${scan.id}?tab=overview`, viewer: 'user', ready: (p) => testId(p, 'scan-stats') },
    { name: 'scan results', path: `/scans/${scan.id}?tab=results`, viewer: 'user', ready: (p) => row(p, world.analysis.seq) },
    { name: 'scan query', path: `/scans/${scan.id}?tab=query`, viewer: 'user', ready: (p) => button(p, 'Run query') },
    // The workers tab lists non-terminal workers by default: the pending scan's workers wait for placement.
    { name: 'scan workers', path: `/scans/${world.pendingScan.id}?tab=workers`, viewer: 'user', ready: (p) => button(p, /^Show worker logs/) },
    {
      name: 'scan events',
      path: `/scans/${scan.id}?tab=events`,
      viewer: 'user',
      ready: (p) => expect(p.getByText('scan.created').first()).toBeVisible({ timeout: SLOW }),
    },
    { name: 'scan exports', path: `/scans/${scan.id}?tab=exports`, viewer: 'user', ready: (p) => row(p, world.exportId) },
    { name: 'analysis', path: `/scans/${scan.id}?tab=results&analysis=${world.analysis.seq}`, viewer: 'user', ready: (p) => testId(p, 'analysis-slideover') },
    { name: 'pending scan', path: `/scans/${world.pendingScan.id}`, viewer: 'user', ready: (p) => testId(p, 'condition-workersPending') },
    { name: 'templates', path: '/templates', viewer: 'user', ready: (p) => button(p, /^Estimate /) },
    { name: 'account', path: '/account', viewer: 'user', ready: (p) => button(p, 'Stop editor') },
    { name: 'access', path: '/account/access', viewer: 'user', ready: (p) => button(p, 'Create key') },
    { name: 'credentials', path: '/account/credentials', viewer: 'user', ready: (p) => heading(p, 'Git credentials') },
    { name: 'nodes', path: '/admin/nodes', viewer: 'admin', ready: (p) => row(p, node.id) },
    { name: 'node', path: `/admin/nodes/${node.id}`, viewer: 'admin', ready: (p) => heading(p, node.name) },
    // Any user row: the list is shared by every concurrent spec, so the tenant's own row may be on a later page.
    { name: 'users', path: '/admin/users', viewer: 'admin', ready: (p) => expect(p.locator('tr[data-row-id]').first()).toBeVisible({ timeout: SLOW }) },
    { name: 'admin tools', path: '/admin/tools', viewer: 'admin', ready: (p) => heading(p, 'Admin tools') },
  ]
}

// ── crawling ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Sends the context's HTTP requests through Playwright's own HTTP client (`route.fetch`) instead of Chromium's network
 * stack. Inside the DinD runner every container that concurrent specs create or remove changes the runner's addresses,
 * and Chromium aborts its in-flight requests on each change (net::ERR_NETWORK_CHANGED, docs/testing.md §9); with a
 * dozen specs on the stack that happens several times a minute, often enough to defeat page-level retries. The
 * server's responses reach the page unchanged (status, headers, body), so the browser still applies the CSP and the
 * other headers, and the crawl still sees every request. A fetch that fails is retried. Redirects are followed here
 * (Chromium would fetch a redirect target itself, outside the route); the pages under test have none, only the API
 * docs' CDN script does. Event streams (EventSource) never end, so they go through Chromium as before, and so does the
 * editor origin (the code-server iframe with its WebSocket and its redirecting cookie handshake).
 */
export async function routeThroughPlaywright(context: BrowserContext): Promise<void> {
  const editor = new URL(env.editorUrl).origin
  await context.route(
    (url) => (url.protocol === 'https:' || url.protocol === 'http:') && url.origin !== editor,
    async (route) => {
      if ((route.request().headers()['accept'] ?? '').includes('text/event-stream')) return route.continue().catch(() => undefined)
      let response: APIResponse | undefined
      for (let attempt = 1; !response; attempt++) {
        try {
          response = await route.fetch({ timeout: 60_000 })
        } catch (error) {
          // The page closed or navigated away, or the request kept failing: let the browser see a failed request.
          if (attempt >= 3 || /closed|disposed/i.test(String(error))) return route.abort().catch(() => undefined)
        }
      }
      // Playwright's client decodes gzip, deflate and br bodies: the browser gets the decoded body without the encoding.
      // Repeated headers are joined, Set-Cookie with newlines (as Playwright splits them again).
      const headers: Record<string, string> = {}
      for (const { name, value } of response.headersArray()) {
        const key = name.toLowerCase()
        if (key === 'content-encoding' || key === 'content-length') continue
        headers[key] = key in headers ? `${headers[key]}${key === 'set-cookie' ? '\n' : ', '}${value}` : value
      }
      // A request the page cancelled meanwhile can no longer be fulfilled.
      await route.fulfill({ response, headers }).catch(() => undefined)
    },
  )
}

/** The browser contexts of the viewers (the ui project's device settings apply through `browser.newContext`). */
export class Viewers {
  private readonly contexts = new Map<Viewer, Promise<BrowserContext>>()

  constructor(
    private readonly browser: Browser,
    private readonly tenant: UiTenant,
  ) {}

  context(viewer: Viewer): Promise<BrowserContext> {
    let context = this.contexts.get(viewer)
    if (!context) {
      const storageState = viewer === 'user' ? this.tenant.storageState : viewer === 'admin' ? env.paths.adminState : { cookies: [], origins: [] }
      context = this.browser.newContext({ baseURL: env.publicUrl, viewport: { width: 1920, height: 1080 }, storageState }).then(async (created) => {
        await routeThroughPlaywright(created)
        return created
      })
      this.contexts.set(viewer, context)
    }
    return context
  }

  async dispose(): Promise<void> {
    for (const pending of this.contexts.values()) {
      const context = await pending
      await context.unrouteAll({ behavior: 'ignoreErrors' })
      await context.close()
    }
    this.contexts.clear()
  }
}

/** Pages crawled at the same time: the crawl runs in a worker fixture and must stay well under its timeout. */
export const CRAWL_CONCURRENCY = 6

/** Maps the items with at most `concurrency` calls in flight; the results keep the items' order. */
export async function mapConcurrently<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(lanes)
  return results
}

/** The DinD netlink race (docs/testing.md §9): Chromium aborts in-flight requests when the runner's interfaces change. */
const NETWORK_CHANGED = 'net::ERR_NETWORK_CHANGED'
/** A document load aborted that way ends on Chromium's error page, which interrupts the navigation of `page.goto`. */
const ERROR_PAGE = 'chrome-error://chromewebdata/'

/**
 * Navigates to the page and waits until it is ready. A visit is repeated (at most `attempts` times) only when the
 * navigation or a request of the page failed with net::ERR_NETWORK_CHANGED: a failed document load ends on Chromium's
 * error page, a failed script chunk leaves the SPA blank and a failed API call shows "The orchestrator did not answer
 * the request.". Every other failure fails at once. The race is frequent while concurrent specs create and remove
 * containers, so a page gets several attempts. A page that never gets ready fails with its URL, the failed requests
 * and the start of its accessibility tree, for the diagnosis.
 */
export async function visit(page: Page, spec: UiPage, attempts = 6): Promise<void> {
  const failed: string[] = []
  // Rejects the current attempt as soon as a request of the page fails with the race, instead of waiting for `ready`
  // to time out on a page that can no longer get ready.
  let abort: ((error: Error) => void) | undefined
  const dashboard = new URL(env.publicUrl).origin
  const onFailed = (request: Request) => {
    const failure = `${request.failure()?.errorText ?? 'failed'} ${request.method()} ${request.url()}`
    failed.push(failure)
    // Only the dashboard's own requests decide whether the page can get ready (not the editor's iframe).
    if (failure.startsWith(NETWORK_CHANGED) && new URL(request.url()).origin === dashboard) abort?.(new Error(failure))
  }
  page.on('requestfailed', onFailed)
  try {
    for (let attempt = 1; ; attempt++) {
      failed.length = 0
      const aborted = new Promise<never>((_, reject) => (abort = reject))
      const load = (async () => {
        await page.goto(spec.path, { timeout: 30_000 })
        await spec.ready(page)
      })()
      // The loser of the race settles later (the next goto interrupts it): its rejection is expected.
      aborted.catch(() => undefined)
      load.catch(() => undefined)
      try {
        await Promise.race([load, aborted])
        return
      } catch (error) {
        const message = String(error)
        const networkChanged = message.includes(NETWORK_CHANGED) || message.includes(ERROR_PAGE) || failed.some((f) => f.startsWith(NETWORK_CHANGED))
        if (networkChanged && attempt < attempts) continue
        const snapshot = await page
          .locator('body')
          .ariaSnapshot({ timeout: 5_000 })
          .catch(() => '(no snapshot)')
        throw new Error(
          `${spec.name} (${spec.path} as ${spec.viewer}) did not get ready at ${page.url()} (attempt ${attempt}): ${message.split('\n')[0]}\n` +
            `failed requests: ${JSON.stringify(failed.slice(0, 10))}\n${snapshot.slice(0, 3_000)}`,
          { cause: error },
        )
      }
    }
  } finally {
    page.off('requestfailed', onFailed)
  }
}

/** Opens a path on a page with the retries of `visit`, ready once `ready` resolves. */
export function open(page: Page, path: string, ready: (page: Page) => Promise<void>, viewer: Viewer = 'user'): Promise<void> {
  return visit(page, { name: path, path, viewer, ready })
}

/** A nameless button in the accessibility tree: `- button`, `- button [disabled]` or `- button:` (with children). */
const NAMELESS_BUTTON = /^\s*- button(?: \[[^\]]*\])*:?\s*$/

/** Lines of an ARIA snapshot that are buttons without an accessible name. */
export function namelessButtons(snapshot: string): string[] {
  return snapshot.split('\n').filter((line) => NAMELESS_BUTTON.test(line))
}

/** Every state label of app/utils/status.ts (docs/ui.md §10): a StatusBadge carries its state as `data-state`. */
export const STATUS_LABELS = [
  'creating',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'deleting',
  'deleted',
  'pending',
  'done',
  'retrying',
  'succeeded',
  'lost',
  'queued',
  'building',
  'ready',
  'assigned',
  'pulling',
  'starting',
  'backoff',
  'draining',
  'stopped',
  'online',
  'offline',
  'revoked',
  'stopping',
  'info',
  'warning',
  'error',
]

export interface TableFacts {
  /** the accessible name the `<table>` element exposes */
  name: string
  /** the aria-label written on the table component (its wrapper when the component does not forward it) */
  componentLabel: string | null
  dataRows: number
  rowsWithoutId: number
  /** button names that occur more than once in the table */
  repeatedButtons: string[]
}

export interface DomFacts {
  tables: TableFacts[]
  /** status badges: their state and their text */
  badges: { state: string; text: string }[]
  testIds: string[]
  /** visible, enabled icon-only buttons (no visible text) with their aria-label, tagged with data-authz-probe */
  iconButtons: { probe: string; label: string }[]
}

/** Reads the facts of the current page in the browser. */
export async function domFacts(page: Page): Promise<DomFacts> {
  return page.evaluate((statusLabels) => {
    const labels = new Set(statusLabels)
    const visible = (el: Element) => (el as HTMLElement).checkVisibility?.() !== false && el.getBoundingClientRect().width > 0
    const accessibleName = (el: Element) => {
      const labelledBy = el.getAttribute('aria-labelledby')
      if (labelledBy)
        return labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
          .join(' ')
          .trim()
      return (el.getAttribute('aria-label') ?? '').trim()
    }
    const tables = [...document.querySelectorAll('table')].filter(visible).map((table) => {
      const rows = [...table.querySelectorAll(':scope > tbody > tr')]
      // An empty or loading table renders one row with a single spanning cell.
      const dataRows = rows.filter((tr) => !(tr.children.length === 1 && (tr.children[0] as HTMLTableCellElement).colSpan > 1))
      const names = [...table.querySelectorAll('button')].map((b) => accessibleName(b) || (b.textContent ?? '').trim()).filter(Boolean)
      const counts = new Map<string, number>()
      for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
      const wrapper = table.closest('[aria-label]')
      return {
        name: accessibleName(table),
        componentLabel: wrapper ? wrapper.getAttribute('aria-label') : null,
        dataRows: dataRows.length,
        rowsWithoutId: dataRows.filter((tr) => !tr.hasAttribute('data-row-id')).length,
        repeatedButtons: [...counts].filter(([, n]) => n > 1).map(([name]) => name),
      }
    })
    const badges = [...document.querySelectorAll('span[data-state]')]
      .filter((el) => labels.has(el.getAttribute('data-state') ?? '') && visible(el))
      .map((el) => ({ state: el.getAttribute('data-state')!, text: (el.textContent ?? '').trim() }))
    const testIds = [...new Set([...document.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid')!))]
    let probe = 0
    // Buttons proper: a <button> with another role (switch, radio, checkbox, tab, menu item) is not an icon-only button.
    const iconButtons = [...document.querySelectorAll('button, [role="button"]')]
      .filter((el) => (el.getAttribute('role') ?? 'button') === 'button')
      .filter((el) => visible(el) && !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true')
      .filter((el) => ((el as HTMLElement).innerText ?? '').trim() === '' && (el.getAttribute('aria-label') ?? '').trim() !== '')
      .map((el) => {
        const id = `p${probe++}`
        el.setAttribute('data-authz-probe', id)
        return { probe: id, label: el.getAttribute('aria-label')!.trim() }
      })
    return { tables, badges, testIds, iconButtons }
  }, STATUS_LABELS)
}

export interface TooltipProbe {
  /** the button's aria-label when its tooltip was probed */
  label: string
  /** the tooltip's text, or null when none opened */
  tooltip: string | null
}

/**
 * Opens the tooltip of each probed button by focusing it (a reka-ui tooltip trigger opens at once on focus, while a
 * hover waits for the provider's delay) and reads the text of the `role="tooltip"` element the trigger's
 * `aria-describedby` names; a button whose tooltip does not open within `waitMs` has none. Everything runs in one
 * evaluate per page. Buttons that a polled list re-rendered since `domFacts` tagged them are skipped.
 */
export async function probeTooltips(page: Page, probes: string[], waitMs = 600): Promise<TooltipProbe[]> {
  if (probes.length === 0) return []
  const results = await page.evaluate(
    async ({ ids, waitMs }) => {
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      /** The tooltip that the element or one of its two closest ancestors (the trigger wrapper) describes itself with. */
      const tooltipOf = (el: Element): string | null => {
        let node: Element | null = el
        for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
          for (const ref of (node.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)) {
            const target = document.getElementById(ref)
            const text = target?.getAttribute('role') === 'tooltip' ? (target.textContent ?? '').trim() : ''
            if (text) return text
          }
        }
        return null
      }
      const out: { label: string; tooltip: string | null }[] = []
      for (const id of ids) {
        const button = document.querySelector<HTMLElement>(`[data-authz-probe="${id}"]`)
        if (!button?.isConnected) continue
        button.focus({ preventScroll: true })
        let tooltip: string | null = null
        const deadline = performance.now() + waitMs
        while (tooltip === null && performance.now() < deadline) {
          await frame()
          tooltip = tooltipOf(button)
        }
        const label = (button.getAttribute('aria-label') ?? '').trim()
        button.blur()
        if (label) out.push({ label, tooltip })
      }
      return out
    },
    { ids: probes, waitMs },
  )
  return results
}

/**
 * The shape of a label with its context ("… for <row>", "… of <field>") and numbers masked, so repeated row controls
 * are probed once per kind.
 */
export function labelShape(label: string): string {
  return label.replace(/ (for|of|to|from) .+$/, ' $1 <context>').replace(/\d+/g, '<n>')
}

/** A tooltip "names" an icon-only button when it shows exactly the label or the label's canonical prefix. */
export function tooltipMatches(label: string, tooltip: string): boolean {
  return tooltip === label || label.startsWith(`${tooltip} `)
}
