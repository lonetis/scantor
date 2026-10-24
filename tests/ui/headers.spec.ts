import type { APIRequestContext, Page } from '@playwright/test'
import {
  builtinNode,
  createUiTenant,
  createWorld,
  CRAWL_CONCURRENCY,
  mapConcurrently,
  routeThroughPlaywright,
  stopTenantEditor,
  tenantApi,
  uiPages,
  Viewers,
  visit,
  type UiPage,
  type UiTenant,
  type UiWorld,
} from '../helpers/authz-ui'
import { stackEnv } from '../helpers/docker'
import { gotoWithRetry } from '../helpers/ui'
import { deleteUser, newApiContext } from '../helpers/users'
import { expect, test as base } from '../fixtures'

// Security headers, CSP and outbound requests of the dashboard (docs/ui.md §12–§13, docs/security.md HDR-1…HDR-3,
// docs/testing.md §8.2): every page of docs/ui.md §4 is crawled once per worker as a user, an admin or signed out,
// recording every response (documents, scripts, styles, icons, images and /api calls), every request, the console and
// the CSP violation events. Direct requests add the static assets, error answers of /api, the Scalar UI at /api/docs
// and the editor origin.

interface Traffic {
  spec: UiPage
  /** why the page could not be crawled */
  error?: string
  responses: { url: string; status: number; type: string; headers: Record<string, string> }[]
  requests: { url: string; type: string }[]
  console: { type: string; text: string }[]
  violations: { directive: string; blocked: string; source: string }[]
}

interface HeadersWorker {
  uiTenant: UiTenant
  world: UiWorld
  traffic: Traffic[]
}

const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)'
const NO_FRAME_PAGES = ['/login', '/setup', '/oauth/consent']

/** Records `securitypolicyviolation` events of every document (they also reach the console as "Refused to …"). */
const RECORD_VIOLATIONS = () => {
  const w = window as unknown as { __cspViolations: unknown[] }
  w.__cspViolations = []
  document.addEventListener('securitypolicyviolation', (event) => {
    w.__cspViolations.push({ directive: event.violatedDirective, blocked: event.blockedURI, source: `${event.sourceFile}:${event.lineNumber}` })
  })
}

const test = base.extend<object, HeadersWorker>({
  uiTenant: [
    async ({ adminApi, openapi }, use) => {
      const tenant = await createUiTenant(adminApi, openapi, 'headers')
      await use(tenant)
      // The purge removes the world with the tenant (docs/data-model.md §5).
      await deleteUser(adminApi, tenant.id)
    },
    { scope: 'worker', timeout: 60_000 },
  ],
  world: [
    async ({ uiTenant, openapi }, use) => {
      const api = await tenantApi(uiTenant, openapi)
      try {
        await use(await createWorld(api, 'headers'))
      } finally {
        await api.request.dispose()
      }
    },
    { scope: 'worker', timeout: 180_000 },
  ],
  traffic: [
    async ({ browser, adminApi, openapi, uiTenant, world }, use) => {
      const node = await builtinNode(adminApi)
      const viewers = new Viewers(browser, uiTenant)
      try {
        const pages = uiPages(world, uiTenant, node)
        const traffic = await mapConcurrently(pages, CRAWL_CONCURRENCY, async (spec) => record(await (await viewers.context(spec.viewer)).newPage(), spec))
        await stopTenantEditor(uiTenant, openapi)
        await use(traffic)
      } finally {
        await viewers.dispose()
      }
    },
    { scope: 'worker', timeout: 150_000 },
  ],
  storageState: async ({ uiTenant }, use) => use(uiTenant.storageState),
  page: async ({ page }, use) => {
    await routeThroughPlaywright(page.context())
    await use(page)
    await page.context().unrouteAll({ behavior: 'ignoreErrors' })
  },
})

// One worker runs the file's tests in order, so the world is built and the crawl happens once.
test.describe.configure({ mode: 'default' })

const s3Origin = () => new URL(stackEnv().SCANTOR_S3_PUBLIC_URL!).origin

/**
 * Visits one page and records its traffic; the page is closed afterwards. A page that cannot be crawled keeps its
 * error instead of failing the fixture (which would rebuild the world for every following test).
 */
async function record(page: Page, spec: UiPage): Promise<Traffic> {
  const traffic: Traffic = { spec, responses: [], requests: [], console: [], violations: [] }
  const pending: Promise<void>[] = []
  await page.addInitScript(RECORD_VIOLATIONS)
  page.on('request', (request) => traffic.requests.push({ url: request.url(), type: request.resourceType() }))
  page.on('response', (response) => {
    pending.push(
      response
        .allHeaders()
        .then((headers) => {
          traffic.responses.push({ url: response.url(), status: response.status(), type: response.request().resourceType(), headers })
        })
        // A response of a page that navigated on or closed has no headers any more.
        .catch(() => undefined),
    )
  })
  page.on('console', (message) => traffic.console.push({ type: message.type(), text: message.text() }))
  try {
    await visit(page, spec)
    // The analysis drawer previews the image files of the result from the S3 public origin.
    if (spec.name === 'analysis') await expect(page.locator(`img[src^="${s3Origin()}/"]`).first()).toBeVisible({ timeout: 20_000 })
    traffic.violations.push(...(await page.evaluate(() => (window as unknown as { __cspViolations: Traffic['violations'] }).__cspViolations)))
    await Promise.all(pending)
  } catch (error) {
    traffic.error = String(error)
  } finally {
    await page.close()
  }
  return traffic
}

const where = (traffic: Traffic) => `${traffic.spec.name} (${traffic.spec.viewer})`

/** Every crawl-based test first checks that the crawl is complete (a replacement worker crawls again). */
function expectComplete(traffic: Traffic[]): void {
  expect(
    traffic.filter((t) => t.error).map((t) => `${where(t)}: ${t.error}`),
    'every page of the route map was crawled',
  ).toEqual([])
}
const isNoFramePage = (url: URL) => NO_FRAME_PAGES.some((page) => url.pathname === page || url.pathname.startsWith(`${page}/`))

/** The directives of a CSP header. */
function directives(csp: string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const part of (csp ?? '').split(';')) {
    const [name, ...values] = part.trim().split(/\s+/)
    if (name) out.set(name.toLowerCase(), values)
  }
  return out
}

/** The problems of one dashboard response with the required headers of docs/ui.md §13 (HSTS is checked apart). */
function headerProblems(url: URL, headers: Record<string, string>, document: boolean): string[] {
  const problems: string[] = []
  const csp = directives(headers['content-security-policy'])
  const frameAncestors = document && isNoFramePage(url) ? "'none'" : "'self'"
  if (csp.get('frame-ancestors')?.join(' ') !== frameAncestors)
    problems.push(`frame-ancestors ${String(csp.get('frame-ancestors'))} instead of ${frameAncestors}`)
  if (csp.get('object-src')?.join(' ') !== "'none'") problems.push(`object-src ${String(csp.get('object-src'))}`)
  if (csp.get('base-uri')?.join(' ') !== "'self'") problems.push(`base-uri ${String(csp.get('base-uri'))}`)
  if (headers['x-content-type-options'] !== 'nosniff') problems.push(`X-Content-Type-Options ${headers['x-content-type-options']}`)
  if (headers['referrer-policy'] !== 'same-origin') problems.push(`Referrer-Policy ${headers['referrer-policy']}`)
  if (headers['cross-origin-opener-policy'] !== 'same-origin') problems.push(`Cross-Origin-Opener-Policy ${headers['cross-origin-opener-policy']}`)
  if (headers['permissions-policy'] !== PERMISSIONS_POLICY) problems.push(`Permissions-Policy ${headers['permissions-policy']}`)
  if (
    url.pathname.startsWith('/api/') &&
    !(headers['cache-control'] ?? '')
      .split(',')
      .map((v) => v.trim())
      .includes('no-store')
  )
    problems.push(`Cache-Control ${headers['cache-control']}`)
  return problems
}

/** Direct responses beyond the crawl: static assets, the SPA fallback and /api answers of every kind. */
async function directResponses(context: APIRequestContext, assets: string[]): Promise<{ url: string; status: number; headers: Record<string, string> }[]> {
  const out: { url: string; status: number; headers: Record<string, string> }[] = []
  const requests: [string, string, unknown?][] = [
    ...assets.map((url): [string, string] => ['GET', url]),
    ['GET', '/no-such-page'],
    ['GET', '/api/health'],
    ['GET', '/api/docs/openapi.json'],
    ['GET', '/api/account'],
    ['GET', '/api/no-such-route'],
    ['DELETE', '/api/health'],
    ['POST', '/api/tasks', 'not json'],
    ['GET', '/api/tasks?bogus=1'],
  ]
  for (const [method, url, data] of requests) {
    const response = await context.fetch(url, { method, data, headers: data ? { 'Content-Type': 'application/json' } : {}, maxRedirects: 0 })
    out.push({ url: response.url(), status: response.status(), headers: response.headers() })
  }
  return out
}

test.describe('dashboard security headers', () => {
  test('every dashboard and /api response carries the required headers', { tag: ['@UI-SEC-001'] }, async ({ traffic, env, uiTenant }) => {
    expectComplete(traffic)
    const origin = new URL(env.publicUrl).origin
    const seen = traffic.flatMap((t) => t.responses.filter((r) => new URL(r.url).origin === origin && r.status !== 0).map((r) => ({ ...r, where: where(t) })))
    for (const type of ['document', 'script', 'stylesheet', 'fetch'])
      expect(
        seen.some((r) => r.type === type),
        `the crawl saw ${type} responses`,
      ).toBe(true)
    expect(seen.filter((r) => new URL(r.url).pathname.startsWith('/api/')).length).toBeGreaterThan(50)
    const problems = seen.flatMap((r) => headerProblems(new URL(r.url), r.headers, r.type === 'document').map((p) => `${r.where} ${r.status} ${r.url}: ${p}`))
    expect(problems).toEqual([])

    const context = await newApiContext({ storageState: uiTenant.storageState })
    try {
      const assets = [...new Set(seen.filter((r) => ['script', 'stylesheet', 'image', 'font'].includes(r.type)).map((r) => r.url))].slice(0, 20)
      const direct = await directResponses(context, assets)
      expect(new Set(direct.map((r) => r.status))).toEqual(new Set([200, 400, 404, 405]))
      expect(direct.flatMap((r) => headerProblems(new URL(r.url), r.headers, false).map((p) => `${r.status} ${r.url}: ${p}`))).toEqual([])
    } finally {
      await context.dispose()
    }
    const anonymous = await newApiContext()
    try {
      const unauthorized = await anonymous.get('/api/account')
      expect(unauthorized.status()).toBe(401)
      expect(headerProblems(new URL(unauthorized.url()), unauthorized.headers(), false)).toEqual([])
    } finally {
      await anonymous.dispose()
    }
  })

  test('documents and /api answers send HSTS on https', { tag: ['@UI-SEC-001'] }, async ({ traffic, env }) => {
    expectComplete(traffic)
    expect(env.publicUrl.startsWith('https://')).toBe(true)
    const origin = new URL(env.publicUrl).origin
    const missing = traffic.flatMap((t) =>
      t.responses
        .filter((r) => new URL(r.url).origin === origin && (r.type === 'document' || new URL(r.url).pathname.startsWith('/api/')))
        .filter((r) => r.headers['strict-transport-security'] !== 'max-age=31536000')
        .map((r) => `${where(t)} ${r.url}: ${r.headers['strict-transport-security']}`),
    )
    expect(missing).toEqual([])
  })

  test('static assets send HSTS on https as well', { tag: ['@UI-SEC-001'] }, ({ traffic, env }) => {
    const origin = new URL(env.publicUrl).origin
    const assets = traffic.flatMap((t) => t.responses.filter((r) => new URL(r.url).origin === origin && ['script', 'stylesheet'].includes(r.type)))
    expect(assets.length).toBeGreaterThan(0)
    expect(assets.filter((r) => r.headers['strict-transport-security'] !== 'max-age=31536000').map((r) => r.url)).toEqual([])
  })

  test('/login, /setup and /oauth/consent are never framed or cached', { tag: ['@UI-SEC-002'] }, async ({ traffic, env }) => {
    expectComplete(traffic)
    const origin = new URL(env.publicUrl).origin
    const documents = traffic.flatMap((t) =>
      t.responses.filter((r) => r.type === 'document' && new URL(r.url).origin === origin).map((r) => ({ ...r, where: where(t) })),
    )
    const noFrame = documents.filter((r) => isNoFramePage(new URL(r.url)))
    expect(new Set(noFrame.map((r) => new URL(r.url).pathname))).toEqual(new Set(NO_FRAME_PAGES))
    for (const r of noFrame) {
      expect.soft(directives(r.headers['content-security-policy']).get('frame-ancestors'), `${r.where} ${r.url}`).toEqual(["'none'"])
      expect.soft(r.headers['cache-control'], `${r.where} ${r.url}`).toBe('no-store')
    }
    for (const r of documents.filter((d) => !isNoFramePage(new URL(d.url)))) {
      expect.soft(directives(r.headers['content-security-policy']).get('frame-ancestors'), `${r.where} ${r.url}`).toEqual(["'self'"])
    }

    const anonymous = await newApiContext()
    try {
      for (const path of [
        '/login',
        '/login?redirect=%2Fscans',
        '/setup',
        '/setup?token=sst_authz',
        '/oauth/consent',
        '/oauth/consent?client_id=authz&scope=openid',
      ]) {
        const response = await anonymous.get(path, { maxRedirects: 0 })
        expect.soft(response.status(), path).toBe(200)
        expect.soft(directives(response.headers()['content-security-policy']).get('frame-ancestors'), path).toEqual(["'none'"])
        expect.soft(response.headers()['cache-control'], path).toBe('no-store')
      }
    } finally {
      await anonymous.dispose()
    }
  })

  test('script-src never allows eval on any page', { tag: ['@UI-SEC-003'] }, ({ traffic, env }) => {
    expectComplete(traffic)
    // Every document's policy (the SPA shell of each page) admits its inline scripts without ever allowing eval.
    const origin = new URL(env.publicUrl).origin
    const documents = traffic.flatMap((t) => t.responses.filter((r) => r.type === 'document' && new URL(r.url).origin === origin))
    expect(documents.length).toBeGreaterThanOrEqual(traffic.length)
    for (const r of documents) {
      const script = directives(r.headers['content-security-policy']).get('script-src')
      expect.soft(script, `${r.url} has a script-src`).toBeDefined()
      expect.soft(script ?? [], r.url).not.toContain("'unsafe-eval'")
    }
    // The inline scripts of the shell are admitted: no page reports a blocked inline script.
    const inline = traffic.flatMap((t) => t.violations.filter((v) => v.blocked === 'inline').map((v) => `${where(t)}: ${v.directive} at ${v.source}`))
    expect(inline).toEqual([])
  })

  test('no page logs a CSP violation', { tag: ['@UI-SEC-003'] }, ({ traffic }) => {
    const violations = traffic.flatMap((t) => t.violations.map((v) => `${where(t)}: ${v.directive} blocked ${v.blocked} at ${v.source}`))
    const refused = traffic.flatMap((t) => t.console.filter((m) => /Content Security Policy|Refused to/i.test(m.text)).map((m) => `${where(t)}: ${m.text}`))
    expect(violations).toEqual([])
    expect(refused).toEqual([])
  })

  test('the dashboard talks only to its own, the S3 public and the editor origin', { tag: ['@UI-SEC-005'] }, ({ traffic, env }) => {
    expectComplete(traffic)
    const allowed = new Set([new URL(env.publicUrl).origin, s3Origin(), new URL(env.editorUrl).origin])
    const foreign = traffic.flatMap((t) =>
      t.requests.filter((r) => /^https?:/.test(r.url) && !allowed.has(new URL(r.url).origin)).map((r) => `${where(t)}: ${r.type} ${r.url}`),
    )
    expect(foreign).toEqual([])
    // The allowance is exercised: image previews come from the S3 public origin.
    expect(traffic.some((t) => t.requests.some((r) => new URL(r.url).origin === s3Origin() && r.type === 'image'))).toBe(true)
  })

  test('/api/docs serves the Scalar UI with its own CSP and without console errors', { tag: ['@OAS-005'] }, async ({ page, openapi }) => {
    const errors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.addInitScript(RECORD_VIOLATIONS)
    const response = await gotoWithRetry(page, '/api/docs')
    expect(response?.status()).toBe(200)
    const csp = directives(response?.headers()['content-security-policy'])
    expect(csp.get('font-src')).toContain('https://fonts.scalar.com')
    expect(csp.get('script-src')).not.toContain("'unsafe-eval'")
    expect(csp.get('frame-ancestors')).toEqual(["'self'"])
    expect(csp.get('object-src')).toEqual(["'none'"])
    // Scalar renders the document: its title, a sidebar group per tag, and the operations of a group once opened.
    const info = openapi.document.info as { title: string }
    await expect(page.getByRole('heading', { name: info.title }).first()).toBeVisible({ timeout: 30_000 })
    const sidebar = page.getByRole('complementary', { name: `Sidebar for ${info.title}` })
    const tags = new Set([...openapi.operations.values()].map((op) => op.tags[0]).filter((t): t is string => !!t))
    for (const tag of tags) await expect.soft(sidebar.getByRole('link', { name: tag, exact: true }), `the sidebar group ${tag}`).toBeVisible()
    const health = openapi.get('getHealth')
    const summary = (openapi.document.paths[health.path]![health.method] as { summary: string }).summary
    await sidebar.getByRole('button', { name: `Open Group - ${health.tags[0]}` }).click()
    await expect(sidebar.getByRole('link', { name: new RegExp(`^${summary} `) })).toBeVisible()
    // The docs-specific policy admits every script, style and font the pinned bundle loads. Its feature probe for eval
    // is blocked on purpose (script-src never allows eval), which is the only violation the page may report.
    const violations = await page.evaluate(() => (window as unknown as { __cspViolations: { directive: string; blocked: string }[] }).__cspViolations)
    expect(violations.filter((v) => v.blocked !== 'eval').map((v) => `${v.directive} blocked ${v.blocked}`)).toEqual([])
    expect(errors).toEqual([])
  })

  test('the editor origin sends its own frame-ancestors, nosniff, referrer policy and HSTS', { tag: ['@EDIT-015'] }, async ({ env }) => {
    const context = await newApiContext()
    try {
      for (const path of ['/', '/_auth?code=authz-invalid']) {
        const response = await context.get(`${env.editorUrl}${path}`, { maxRedirects: 0 })
        const headers = response.headers()
        expect.soft(headers['content-security-policy'], path).toContain(`frame-ancestors 'self' ${new URL(env.publicUrl).origin}`)
        expect.soft(headers['x-content-type-options'], path).toBe('nosniff')
        expect.soft(headers['referrer-policy'], path).toBe(path.startsWith('/_auth') ? 'no-referrer' : 'same-origin')
        expect.soft(headers['strict-transport-security'], path).toBe('max-age=31536000')
        if (path.startsWith('/_auth')) expect.soft(headers['cache-control'], path).toBe('no-store')
      }
    } finally {
      await context.dispose()
    }
  })
})
