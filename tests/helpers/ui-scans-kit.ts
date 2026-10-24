import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Locator, type Page, type Request, type Route } from '@playwright/test'
import { parseDocument } from 'yaml'
import type { Revision } from '#shared/types/revisions'
import type { Scan } from '#shared/types/scans'
import type { ScanState } from '#shared/utils/enums'
import { ApiClient } from './api-client'
import type { OpenApiIndex } from './openapi'
import { cancelAndDeleteScan, SMALL_SETTINGS, startScan, waitForScanState, type StartScanBody } from './scans'
import { exampleTaskDir, fixtureTaskDir, uploadAndPublish, type UploadedTask } from './tasks'
import { gotoWithRetry } from './ui'
import { unique } from './unique'
import { env } from './env'
import { newApiContext } from './users'

// Shared code of the ui-scans specs (ui/overview, scans, scan-results, scan-health, test-run, schema-form,
// templates): generated task folders, scan settings that keep scans cheap, and page helpers for the scan pages.

// ── scan settings ───────────────────────────────────────────────────────────────────────────────────

/** A node label no test node carries: the scan's workers stay `workersPending` (reason `selectorMismatch`). */
export const NOWHERE_LABELS = { zone: 'scantor-test-nowhere' } as const

/** Small settings whose workers can never be placed: the scan stays active without running a container. */
export const PENDING_SETTINGS = { ...SMALL_SETTINGS, nodeSelector: { pool: 'shared', labels: NOWHERE_LABELS } } as const

// ── generated task folders ──────────────────────────────────────────────────────────────────────────

/** A temporary task folder; remove it with `dispose()` (the tasks fixture packs it at upload time). */
export interface TempTask {
  dir: string
  dispose(): Promise<void>
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `ui-scans-${prefix}-`))
}

const MINIMAL_DOCKERFILE = 'ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nCOPY . .\n'

async function writePythonTask(prefix: string, manifest: Record<string, unknown>, mainPy: string, extra: Record<string, string> = {}): Promise<TempTask> {
  const dir = await tempDir(prefix)
  const lines = ['scantor: 1', `name: ${prefix}`, 'language: python', `description: "${String(manifest.description ?? prefix)}"`]
  if (manifest.defaults) lines.push(`defaults: ${JSON.stringify(manifest.defaults)}`)
  await writeFile(join(dir, 'scantor.yaml'), `${lines.join('\n')}\n`)
  await writeFile(join(dir, 'Dockerfile'), MINIMAL_DOCKERFILE)
  await writeFile(join(dir, '.dockerignore'), '.scantor\n__pycache__\n')
  await writeFile(join(dir, 'main.py'), mainPy)
  for (const [name, content] of Object.entries(extra)) await writeFile(join(dir, name), content)
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) }
}

/**
 * A task whose connector dies before its handshake inside worker containers only: at import it checks the memory
 * limit of its cgroup, which is at least 1 GiB in the describe container (docs/tasks.md §9.5) but `processes ×
 * memoryMiB + 256 MiB` in a worker (CRASH_LOOP_SETTINGS: 320 MiB). There it writes an ANSI-coloured line to stderr
 * and allocates past the limit, so the kernel kills it; after three spawn failures the runtime exits 1 and the
 * node daemon restarts the container with backoff and raises `crashLoop` (docs/runtime.md §7.5, docs/nodes.md §6.5).
 * Process crashes after a handshake (the `crashy` fixture) are analysis errors and never raise `crashLoop`.
 */
export function crashLoopTask(): Promise<TempTask> {
  return writePythonTask(
    'crash-loop',
    { description: 'Test fixture: a connector that is killed before its handshake inside workers.' },
    `"""crash-loop: the connector dies at import inside worker containers (small cgroup memory limit)."""

import sys

from pydantic import BaseModel

import scantor


def _memory_limit() -> int | None:
    for path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            with open(path) as handle:
                text = handle.read().strip()
        except OSError:
            continue
        return None if text == "max" else int(text)
    return None


_limit = _memory_limit()
if _limit is not None and _limit < 900 * 1024 * 1024:
    sys.stderr.write("\\x1b[31mcrash-loop marker: allocating past the memory limit\\x1b[0m\\n")
    sys.stderr.flush()
    _hog = b"\\xff" * (2 * 1024 * 1024 * 1024)


class Result(BaseModel):
    ok: bool


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: scantor.Empty) -> Result:
    return Result(ok=True)


task = scantor.Task(result=Result, run=run)
`,
  )
}

/**
 * A task that passes a template unwrapped (docs/templates.md), so the platform estimates, resolves and streams it:
 * for example `tranco` (exact estimate, a list id as provenance), `crux` (an upper-bound estimate) or `range`
 * (semantic checks such as `step: 0` that only the server makes). Each analysis returns its config at once.
 */
export function templateEchoTask(template: 'tranco' | 'crux' | 'range' | 'cidr'): Promise<TempTask> {
  return writePythonTask(
    `${template}-echo`,
    { description: `Test fixture: the ${template} template unwrapped; every analysis echoes its config.` },
    `"""${template}-echo: the template schedules, every analysis echoes its config."""

from typing import Any

from pydantic import BaseModel

import scantor
from scantor import templates


class Result(BaseModel):
    config: dict[str, Any]


def run(ctx: scantor.Context, analysis_config: templates.${template}.AnalysisConfig, task_config: scantor.Empty) -> Result:
    return Result(config=analysis_config.model_dump(mode="json"))


task = scantor.Task(result=Result, schedule=templates.${template}.schedule, run=run)
`,
  )
}

/**
 * The results task: a custom schedule of `count` analyses whose analysis config carries a secret. By value:
 * 0 fails twice and succeeds in attempt 3; 5 kills its process (a `crash` with details, retried until it fails);
 * 1, 4, 7, … raise `Fatal` with an ANSI-coloured message; every other value succeeds with a result of six
 * properties (a FileRef `report`, a 250-character string, a URL-like string) and a log line; value 3 also stores a
 * PNG that the result does not reference.
 */
export function resultsTask(): Promise<TempTask> {
  return writePythonTask(
    'results-zoo',
    {
      description: 'Test fixture: analyses with results, files, secrets, retries, crashes and failures.',
      defaults: { maxAttempts: 3, timeout: '30s', backoff: { initial: '1s', max: '2s' } },
    },
    `"""results-zoo: a custom schedule whose analyses succeed, fail, crash and retry by value."""

import base64
import os
from collections.abc import Iterator
from typing import Any

from pydantic import BaseModel, Field, SecretStr

import scantor

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


class ScanConfig(scantor.Config):
    count: int = Field(default=60, ge=1, le=500, description="Number of analyses.")


class AnalysisConfig(scantor.Config):
    value: int = 0
    token: SecretStr | None = None


class Result(BaseModel):
    value: int
    label: str
    long: str
    url: str
    report: scantor.FileRef
    extra: dict[str, Any]


def schedule(ctx: scantor.Context, scan_config: ScanConfig, task_config: scantor.Empty) -> Iterator[AnalysisConfig]:
    for value in range(scan_config.count):
        yield AnalysisConfig(value=value, token=SecretStr(f"token-{value}"))


def run(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: scantor.Empty) -> Result:
    value = analysis_config.value
    ctx.log("info", f"analysis {value} starts", value=value)
    print(f"\\x1b[32mstdout line {value}\\x1b[0m", flush=True)
    if value == 0 and ctx.attempt < 3:
        raise RuntimeError(f"flaky failure in attempt {ctx.attempt}")
    if value == 5:
        os._exit(3)
    if value % 3 == 1:
        raise scantor.Fatal(f"\\x1b[31mfatal\\x1b[0m failure of value {value}")
    report = ctx.files.put(f"report-{value}.txt", f"report {value}\\n", "text/plain")
    if value == 3:
        ctx.files.put("chart.png", PNG, "image/png")
    return Result(
        value=value,
        label=f"label-{value}",
        long="x" * 250 + f"-{value}",
        url=f"https://example.org/{value}",
        report=report,
        extra={"nested": {"value": value}},
    )


task = scantor.Task(scan_config=ScanConfig, analysis_config=AnalysisConfig, result=Result, schedule=schedule, run=run)
`,
  )
}

/** Settings for CRASH_LOOP scans: one runner with 64 MiB per process (a 320 MiB container). */
export const CRASH_LOOP_SETTINGS = { workers: 1, processes: 1, resources: { cpus: 0.25, memoryMiB: 64 } } as const

/** A copy of a fixture or example task with `defaults.privileged: true` (docs/tasks.md §8.3). */
export async function privilegedCopy(source: { fixture?: string; example?: string }): Promise<TempTask> {
  const from = source.fixture ? fixtureTaskDir(source.fixture) : exampleTaskDir(source.example ?? 'echo')
  const dir = await tempDir('privileged')
  await cp(from, dir, { recursive: true, filter: (path) => !/(^|\/)(\.scantor|__pycache__|node_modules)(\/|$)/.test(path) })
  const manifestPath = join(dir, 'scantor.yaml')
  const doc = parseDocument(await readFile(manifestPath, 'utf8'))
  doc.setIn(['defaults', 'privileged'], true)
  await writeFile(manifestPath, doc.toString())
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) }
}

/**
 * The task config schema of the form-extras task: one property per form widget of docs/ui.md §6.2 that schema-zoo
 * lacks (formats, long strings, readOnly, deprecated, const, titled options, integer enum, arrays of enums,
 * primitives and objects, a keyed map, an open map, collapsible and too deep objects, recursion, unsupported
 * keywords, a nullable integer). The connector exports it verbatim, so describe stores exactly this schema.
 */
export const FORM_EXTRAS_SCHEMA = {
  type: 'object',
  title: 'TaskConfig',
  additionalProperties: false,
  required: ['priority'],
  properties: {
    priority: { title: 'Priority', description: 'Required with at most four options: rendered as `radio` buttons.', enum: [1, 2, 3] },
    color: {
      title: 'Color',
      oneOf: [
        { const: 'red', title: 'Red' },
        { const: 'green', title: 'Green' },
        { const: 'blue', title: 'Blue' },
      ],
      default: 'red',
    },
    size: { title: 'Size', enum: ['s', 'm', 'l', 'xl', 'xxl'], default: 'm' },
    when: { title: 'When', type: 'string', format: 'date', default: '2024-01-01' },
    at: { title: 'At', type: 'string', format: 'date-time', examples: ['2024-01-01T12:00:00Z'] },
    site: { title: 'Site', type: 'string', format: 'uri', examples: ['https://example.org/start'] },
    contact: { title: 'Contact', type: 'string', format: 'email' },
    code: { title: 'Code', type: 'string', minLength: 3, maxLength: 8, pattern: '^[A-Z]+$', default: 'ABC' },
    bio: { title: 'Bio', type: 'string', maxLength: 1000, default: '' },
    version: { title: 'Version', type: 'string', readOnly: true, default: 'v1' },
    legacy: { title: 'Legacy', type: 'integer', deprecated: true, default: 0 },
    kind: { title: 'Kind', const: 'fixed', default: 'fixed' },
    verbose: { title: 'Verbose', type: 'boolean', default: false },
    amount: { title: 'Amount', type: 'number', minimum: 0, maximum: 10, multipleOf: 0.5, default: 1 },
    maybe: { title: 'Maybe', type: ['integer', 'null'], default: null },
    channels: { title: 'Channels', type: 'array', items: { enum: ['alpha', 'beta', 'gamma'] }, default: [] },
    ports: { title: 'Ports', type: 'array', items: { type: 'integer', minimum: 1, maximum: 65535 }, maxItems: 2, default: [80] },
    servers: { title: 'Servers', type: 'array', items: { $ref: '#/$defs/Server' }, default: [] },
    labels: { title: 'Labels', type: 'object', additionalProperties: { type: 'string' }, propertyNames: { pattern: '^[a-z]+$' }, default: {} },
    extra: { title: 'Extra', type: 'object', additionalProperties: true, default: {} },
    place: { $ref: '#/$defs/Place' },
    deep: { $ref: '#/$defs/L1' },
    tree: { $ref: '#/$defs/Node' },
    combo: { title: 'Combo', allOf: [{ type: 'integer' }, { minimum: 0 }], default: 1 },
    either: { title: 'Either', anyOf: [{ type: 'integer' }, { type: 'string' }], default: 1 },
    pair: { title: 'Pair', type: 'array', prefixItems: [{ type: 'integer' }, { type: 'string' }], default: [1, 'a'] },
    cond: { title: 'Cond', type: 'integer', if: { minimum: 10 }, then: { multipleOf: 10 }, default: 0 },
    notnull: { title: 'Notnull', not: { type: 'null' }, default: 1 },
    patterned: { title: 'Patterned', type: 'object', patternProperties: { '^x': { type: 'integer' } }, default: {} },
  },
  $defs: {
    Server: {
      type: 'object',
      title: 'Server',
      additionalProperties: false,
      properties: { host: { title: 'Host', type: 'string', default: 'localhost' }, port: { title: 'Port', type: 'integer', default: 22 } },
    },
    Geo: {
      type: 'object',
      title: 'Geo',
      additionalProperties: false,
      properties: { lat: { title: 'Lat', type: 'number', default: 0 }, lon: { title: 'Lon', type: 'number', default: 0 } },
    },
    Place: {
      type: 'object',
      title: 'Place',
      additionalProperties: false,
      properties: { city: { title: 'City', type: 'string', default: 'Bochum' }, geo: { $ref: '#/$defs/Geo' } },
    },
    L1: { type: 'object', title: 'Deep', additionalProperties: false, properties: { l2: { $ref: '#/$defs/L2' } } },
    L2: { type: 'object', title: 'L2', additionalProperties: false, properties: { l3: { $ref: '#/$defs/L3' } } },
    L3: { type: 'object', title: 'L3', additionalProperties: false, properties: { l4: { $ref: '#/$defs/L4' } } },
    L4: { type: 'object', title: 'L4', additionalProperties: false, properties: { l5: { $ref: '#/$defs/L5' } } },
    L5: { type: 'object', title: 'L5', additionalProperties: false, properties: { value: { title: 'Value', type: 'integer', default: 1 } } },
    Node: {
      type: 'object',
      title: 'Tree',
      additionalProperties: false,
      properties: {
        name: { title: 'Name', type: 'string', default: 'root' },
        children: { title: 'Children', type: 'array', items: { $ref: '#/$defs/Node' }, default: [] },
      },
    },
  },
} as const

/** A task whose task config schema is FORM_EXTRAS_SCHEMA (the model accepts anything; the schema is what counts). */
export function formExtrasTask(): Promise<TempTask> {
  return writePythonTask(
    'form-extras',
    { description: 'Test fixture: one task config property per form widget that schema-zoo lacks.' },
    `"""form-extras: exports a handwritten task config schema with every form widget of docs/ui.md §6.2."""

import json
import pathlib
from typing import Any

from pydantic import BaseModel, ConfigDict

import scantor

_SCHEMA = json.loads((pathlib.Path(__file__).parent / "task_config.schema.json").read_text())


class TaskConfig(scantor.Config):
    model_config = ConfigDict(extra="allow")

    @classmethod
    def model_json_schema(cls, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return json.loads(json.dumps(_SCHEMA))


class Result(BaseModel):
    ok: bool


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> Result:
    return Result(ok=True)


task = scantor.Task(task_config=TaskConfig, result=Result, run=run)
`,
    { 'task_config.schema.json': JSON.stringify(FORM_EXTRAS_SCHEMA, null, 2) },
  )
}

// ── network: patching API responses ────────────────────────────────────────────────────────────────

/**
 * Routes `url` through the real API and replaces the JSON body with `patch(body)` (for states the shared stack must
 * not be driven into, such as a broker alarm). Only GET requests are patched; others pass through.
 */
export async function patchJsonResponses(page: Page, url: string | RegExp, patch: (body: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  await page.route(url, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    if (response.status() !== 200) return route.fulfill({ response })
    const body = (await response.json()) as Record<string, unknown>
    await route.fulfill({ response, json: patch(body) })
  })
}

/** Answers matching requests with an API error envelope (docs/api.md §1.7) instead of reaching the server. */
export async function failWithApiError(
  page: Page,
  url: string | RegExp,
  error: { status: number; code: string; message: string; details?: Record<string, unknown> },
  method = 'POST',
): Promise<void> {
  await page.route(url, async (route) => {
    if (route.request().method() !== method) return route.fallback()
    await route.fulfill({
      status: error.status,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: error.code, message: error.message, details: error.details ?? {} } }),
    })
  })
}

// ── scan pages ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Serves the dashboard origin's requests through Playwright (`route.fetch`, Node's HTTP stack) instead of Chromium's
 * network stack. The inner dockerd shares the runner's network namespace, so every container or network any run
 * creates changes the interfaces Chromium watches, and Chromium then aborts its in-flight requests with
 * net::ERR_NETWORK_CHANGED: script chunks (a blank page or a "Failed to fetch dynamically imported module" error page)
 * and API calls alike (a POST the server processed without the page seeing the answer). Responses are passed on
 * unchanged, redirects included; the test-run event stream stays on the browser (it never ends while a run lasts).
 * Navigations stay on the browser too (gotoApp retries them): a document fulfilled by Playwright has no known address
 * space, so Chromium's local network access checks would then block the page's loopback S3 previews.
 * Handlers a test registers later run first; `route.fallback()` hands a request back to this one.
 */
export async function shieldFromNetworkChanges(page: Page): Promise<void> {
  const origin = new URL(env.publicUrl).origin
  await page.route(
    (url) => url.origin === origin && !url.pathname.endsWith('/stream'),
    async (route) => {
      if (route.request().isNavigationRequest()) return route.fallback()
      let response
      for (let attempt = 1; ; attempt++) {
        try {
          response = await route.fetch({ maxRedirects: 0 })
          break
        } catch (error) {
          // The page or its context closed while the request was in flight.
          if (page.isClosed()) return
          if (attempt < 3 && isTransientFetchError(error, route.request().method())) {
            await new Promise((resolve) => setTimeout(resolve, 200 * attempt))
            continue
          }
          // A real failure: the page sees a failed request (instead of one that never ends), the test this error.
          await route.abort('failed')
          throw error
        }
      }
      await route.fulfill({ response })
    },
  )
}

/**
 * Fetch errors worth another attempt: a failed name lookup (the runner's dnsmasq answers EAI_AGAIN under load) means
 * the request never left, so any method may repeat it; a reset connection may have reached the server, so only reads.
 */
function isTransientFetchError(error: unknown, method: string): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (/EAI_AGAIN|ENOTFOUND/.test(message)) return true
  return (method === 'GET' || method === 'HEAD') && /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up/.test(message)
}

/**
 * Requests Chromium aborted with net::ERR_NETWORK_CHANGED: the inner dockerd changes the runner's network interfaces
 * whenever any run creates or removes a container network, and a page whose script chunks were aborted stays blank.
 */
function watchNetworkChanges(page: Page): { aborted: () => boolean; stop: () => void } {
  let count = 0
  const listener = (request: Request) => {
    // A failed name lookup of the runner's dnsmasq under load is just as transient.
    if (/ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED/.test(request.failure()?.errorText ?? '')) count++
  }
  page.on('requestfailed', listener)
  return { aborted: () => count > 0, stop: () => page.off('requestfailed', listener) }
}

/**
 * The dashboard shell, absent from a blank page and from Nuxt's error page. A CSS locator: an open modal or slideover
 * hides the rest of the page from the accessibility tree.
 */
const appShell = (page: Page) => page.locator('button[aria-label="Collapse sidebar"]')

/**
 * After a network change Chromium repeats a navigation to the same URL itself, and Playwright reports the first one as
 * "interrupted by another navigation".
 */
function isInterruptedNavigation(error: unknown): boolean {
  return /is interrupted by another navigation/.test(error instanceof Error ? error.message : String(error))
}

/**
 * Loads a dashboard page (navigation or reload) until its shell renders, retrying only when Chromium aborted requests
 * with net::ERR_NETWORK_CHANGED or repeated the navigation (helpers/ui.ts gotoWithRetry covers the document request
 * alone).
 */
async function loadApp(page: Page, load: () => Promise<unknown>, attempts = 4): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const network = watchNetworkChanges(page)
    try {
      await load()
      await expect(appShell(page)).toBeVisible({ timeout: 15_000 })
      return
    } catch (error) {
      if (attempt >= attempts || !(network.aborted() || isInterruptedNavigation(error))) throw error
    } finally {
      network.stop()
    }
  }
}

/** gotoWithRetry that also survives aborted script chunks (see loadApp). */
export async function gotoApp(page: Page, url: string): Promise<void> {
  await loadApp(page, () => gotoWithRetry(page, url))
}

/** page.reload that also survives aborted script chunks (see loadApp). */
export async function reloadApp(page: Page): Promise<void> {
  await loadApp(page, () => page.reload())
}

/**
 * Opens a scan page (optionally with a query string) and waits until its controls are rendered. A CSS locator: with
 * `?analysis=` the drawer (a modal) hides the rest of the page from the accessibility tree.
 */
export async function openScanPage(page: Page, scanId: string, query = ''): Promise<void> {
  await gotoApp(page, `/scans/${scanId}${query}`)
  await expect(page.locator('[role="toolbar"][aria-label="Scan controls"]')).toBeVisible()
}

/**
 * Status badges (StatusBadge: a UBadge whose `data-state` is the state) inside a scope. Tooltip triggers carry
 * `data-state="closed"` too, so a bare `[data-state]` would also match id chips and relative times.
 */
export function badges(scope: Page | Locator): Locator {
  return scope.locator('span[data-slot="base"][data-state]')
}

/** The state badge of the scan header. */
export function headerState(page: Page): Locator {
  return badges(page.locator('header').filter({ has: page.getByRole('button', { name: 'Copy scan id' }) })).first()
}

/**
 * The open toasts. A modal (a dialog, a slideover, an open dropdown menu) hides everything outside it from the
 * accessibility tree, the toast region included, so the region is found by its attributes instead of its role.
 */
export function openToasts(page: Page): Locator {
  return page.locator('[role="region"][aria-label^="Notifications"] li[data-state="open"]')
}

/** Expects an open toast with the text, also while a modal is open (helpers/ui.ts expectToast needs none). */
export async function expectToast(page: Page, text: string | RegExp): Promise<void> {
  await expect(openToasts(page).filter({ hasText: text }).first()).toBeVisible()
}

/** Clicks the navbar "Refresh" button of a polled page. */
export async function refresh(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
}

/** Clicks "Refresh" until the assertion passes (pages poll slower than the expect timeout). */
export async function expectAfterRefresh(page: Page, assertion: () => Promise<void>, timeoutMs = 120_000): Promise<void> {
  await expect(async () => {
    await refresh(page)
    await assertion()
  }).toPass({ timeout: timeoutMs, intervals: [1000, 2000, 3000, 5000] })
}

/** A table row by its `data-row-id` (docs/ui.md §11 rule 3). */
export function row(scope: Page | Locator, id: string | number): Locator {
  return scope.locator(`[data-row-id="${id}"]`)
}

/** Records native dialogs (the UI never opens one, docs/ui.md §11 rule 7; hostile content must not either). */
export function recordDialogs(page: Page): string[] {
  const messages: string[] = []
  page.on('dialog', (dialog) => {
    messages.push(dialog.message())
    void dialog.dismiss()
  })
  return messages
}

// ── shared per worker ───────────────────────────────────────────────────────────────────────────────

/**
 * Tasks and scans the ui-scans specs share within one Playwright worker. Publishing builds an image, and the stack
 * builds at most SCANTOR_BUILD_CONCURRENCY images at a time for every concurrent run, so each task is uploaded once per
 * worker and tenant on first use (through the tenant's API key) and reused by every later test of any ui-scans spec
 * in that worker. Tests only read shared tasks and shared scans or start their own scans on shared tasks (the `scans`
 * fixture deletes those); no test changes a shared task. They are removed with the tenant at worker teardown:
 * `deleteUser` purges its tasks, revisions and scans (docs/testing.md §7.7).
 */
export type SharedTaskName =
  'throws' | 'sleep' | 'schema-zoo' | 'hostile-output' | 'hostile-label' | 'results-zoo' | 'form-extras' | 'tranco-echo' | 'range-echo'

const folderOf = (dir: string) => async (): Promise<TempTask> => ({ dir, dispose: async () => undefined })

const SHARED_TASK_SOURCES: Record<SharedTaskName, { folder: () => Promise<TempTask>; expectState?: Revision['state'] }> = {
  throws: { folder: folderOf(exampleTaskDir('throws')) },
  sleep: { folder: folderOf(exampleTaskDir('sleep')) },
  'schema-zoo': { folder: folderOf(fixtureTaskDir('schema-zoo')) },
  'hostile-output': { folder: folderOf(fixtureTaskDir('hostile-output')) },
  // Its only revision fails at the static Dockerfile check.
  'hostile-label': { folder: folderOf(fixtureTaskDir('hostile-label')), expectState: 'failed' },
  'results-zoo': { folder: () => resultsTask() },
  'form-extras': { folder: () => formExtrasTask() },
  'tranco-echo': { folder: () => templateEchoTask('tranco') },
  'range-echo': { folder: () => templateEchoTask('range') },
}

interface Owner {
  id: string
  apiKey: string
}

const tenantClients = new Map<string, Promise<ApiClient>>()
const sharedTasks = new Map<string, Promise<UploadedTask>>()
const sharedScans = new Map<string, Promise<Scan>>()

/** An ApiClient with the tenant's API key that lives as long as the worker (independent of storage-state files). */
export function tenantApi(owner: Owner, openapi: OpenApiIndex): Promise<ApiClient> {
  let client = tenantClients.get(owner.id)
  if (!client) {
    client = newApiContext({ headers: { Authorization: `Bearer ${owner.apiKey}` } }).then((context) => new ApiClient(context, openapi))
    tenantClients.set(owner.id, client)
  }
  return client
}

/** Caches a promise per key; a rejected promise is dropped, so the next test tries again. */
function cached<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
  let value = cache.get(key)
  if (!value) {
    value = create()
    cache.set(key, value)
    value.catch(() => cache.delete(key))
  }
  return value
}

/** A built revision (ready unless the source says otherwise) of a shared task of the tenant, uploaded under a unique name on first use in this worker. */
export function sharedTask(owner: Owner, openapi: OpenApiIndex, name: SharedTaskName): Promise<UploadedTask> {
  return cached(sharedTasks, `${owner.id}/${name}`, async () => {
    const api = await tenantApi(owner, openapi)
    const source = SHARED_TASK_SOURCES[name]
    const folder = await source.folder()
    try {
      return await uploadAndPublish(api, folder.dir, unique(name), { expectState: source.expectState })
    } finally {
      await folder.dispose()
    }
  })
}

/**
 * The timeout of the `test.beforeAll` hook in which a spec builds its shared tasks (sharedTasksOf) before its first
 * test in a worker: image builds queue behind the builds of every concurrent run (SCANTOR_BUILD_CONCURRENCY), so they
 * are kept out of the tests' own timeouts.
 */
export const SHARED_SETUP_TIMEOUT_MS = 180_000

/** Starts the uploads of several shared tasks at once (the builds queue in parallel) and returns them in order. */
export function sharedTasksOf<const N extends readonly SharedTaskName[]>(
  owner: Owner,
  openapi: OpenApiIndex,
  names: N,
): Promise<{ [K in keyof N]: UploadedTask }> {
  return Promise.all(names.map((name) => sharedTask(owner, openapi, name))) as Promise<{ [K in keyof N]: UploadedTask }>
}

/**
 * A scan of the tenant shared by the tests of this worker that only read it, started on first use under `key` and
 * awaited until it reaches `state`.
 */
export function sharedScan(
  owner: Owner,
  openapi: OpenApiIndex,
  key: string,
  start: () => Promise<StartScanBody>,
  state: ScanState | ScanState[] = 'completed',
  timeoutMs = 150_000,
): Promise<Scan> {
  return cached(sharedScans, `${owner.id}/${key}`, async () => {
    const api = await tenantApi(owner, openapi)
    const scan = await startScan(api, await start())
    return waitForScanState(api, scan.id, state, timeoutMs)
  })
}

/**
 * Scans a test starts on shared tasks, cancelled and deleted after the test (`test.afterEach(deleteOwnScans)` in every
 * spec) in parallel and without waiting for the scanDelete jobs: the `scans` fixture waits for each job because the
 * `tasks` fixture deletes the tasks next, but shared tasks stay until the tenant is purged.
 */
const ownScans: { owner: Owner; openapi: OpenApiIndex; scanId: string }[] = []

/** Starts a scan as the tenant (small settings unless the body sets them) and deletes it after the test. */
export async function startOwnScan(owner: Owner, openapi: OpenApiIndex, body: StartScanBody): Promise<Scan> {
  const scan = await startScan(await tenantApi(owner, openapi), body)
  ownScans.push({ owner, openapi, scanId: scan.id })
  return scan
}

/** Deletes a scan started another way (the UI) after the test. */
export function trackOwnScan(owner: Owner, openapi: OpenApiIndex, scanId: string): void {
  ownScans.push({ owner, openapi, scanId })
}

/** Waits until a scan of the tenant reaches `state` (helpers/scans.ts waitForScanState). */
export async function waitForOwnScan(owner: Owner, openapi: OpenApiIndex, scanId: string, state: ScanState | ScanState[], timeoutMs = 120_000): Promise<Scan> {
  return waitForScanState(await tenantApi(owner, openapi), scanId, state, timeoutMs)
}

/** Cancels and deletes the scans of the finished test (afterEach). */
export async function deleteOwnScans(): Promise<void> {
  const scans = ownScans.splice(0)
  // A few at a time: each cancel waits with a long-poll, and SCANTOR_MAX_CONCURRENT_WAITS caps them per user.
  for (let index = 0; index < scans.length; index += 6) {
    await Promise.all(scans.slice(index, index + 6).map(async ({ owner, openapi, scanId }) => cancelAndDeleteScan(await tenantApi(owner, openapi), scanId)))
  }
}

/** A shared scan of the throws task whose schedule raises before the first analysis until scheduling fails. */
export function schedulingFailedScan(owner: Owner, openapi: OpenApiIndex): Promise<Scan> {
  return sharedScan(
    owner,
    openapi,
    'scheduling-failed',
    async () => ({
      revision: (await sharedTask(owner, openapi, 'throws')).revision.id,
      name: unique('scheduling-failed'),
      taskConfig: { fail_in_schedule: true },
    }),
    'failed',
  )
}

/** A shared completed scan of the throws task: four analyses that succeed (range 0–4, mode ok). */
export function completedScan(owner: Owner, openapi: OpenApiIndex): Promise<Scan> {
  return sharedScan(owner, openapi, 'throws-ok-4', async () => ({
    revision: (await sharedTask(owner, openapi, 'throws')).revision.id,
    name: unique('throws-ok'),
    taskConfig: { mode: 'ok' },
    scanConfig: { start: 0, end: 4 },
  }))
}

/** A tab of the scan page (the query console has tabs of its own). */
export async function openScanTab(page: Page, name: string): Promise<void> {
  const tab = page.getByLabel('Scan tabs').getByRole('tab', { name, exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

export const scanTab = (page: Page, name: string): Locator => page.getByLabel('Scan tabs').getByRole('tab', { name, exact: true })

/**
 * A UTable by its aria-label. UTable puts the label on its root element (a div around the <table>), so
 * `getByRole('table', { name })` cannot find it; rows are found inside by `data-row-id`.
 */
export function uTable(scope: Page | Locator, label: string): Locator {
  return scope.locator(`[aria-label="${label}"]:has(table)`)
}

// ── schema forms (docs/ui.md §6) ────────────────────────────────────────────────────────────────────

/** A section of the new-scan form by its heading, for example "3 · Task config". */
export function formSection(page: Page, heading: string): Locator {
  return page.locator('section', { has: page.getByRole('heading', { name: heading, exact: true }) })
}

/** The UFormField of a schema-form field by its dot path relative to the form (`address.zip`, `tags.0`). */
export function schemaField(scope: Page | Locator, path: string): Locator {
  return scope.locator(`[data-field-path="${path}"]`)
}

/** The field's own label, hint, description and error (not those of nested fields). */
export const fieldLabel = (field: Locator) => field.locator(':scope > [data-slot="wrapper"] label[data-slot="label"]')
export const fieldHint = (field: Locator) => field.locator(':scope > [data-slot="wrapper"] [data-slot="hint"]')
export const fieldDescription = (field: Locator) => field.locator(':scope > [data-slot="wrapper"] [data-slot="description"]')
export const fieldError = (field: Locator) => field.locator(':scope > div:not([data-slot="wrapper"]) > [data-slot="error"]')

/**
 * Waits until nothing was added to or removed from `scope` for `quietMs`. A number field validates its previous value
 * when it loses the focus and shows that error for a moment (schema-form.spec.ts records the product bug), which moves
 * everything below it: a click during that moment misses its target.
 */
export async function settle(scope: Locator, quietMs = 400): Promise<void> {
  await scope.evaluate((element) => {
    const target = element as HTMLElement & { scantorLastMutation?: number; scantorObserver?: MutationObserver }
    target.scantorLastMutation = performance.now()
    if (target.scantorObserver) return
    target.scantorObserver = new MutationObserver(() => {
      target.scantorLastMutation = performance.now()
    })
    target.scantorObserver.observe(target, { subtree: true, childList: true, characterData: true })
  })
  await expect
    .poll(() => scope.evaluate((element) => performance.now() - ((element as HTMLElement & { scantorLastMutation?: number }).scantorLastMutation ?? 0)), {
      intervals: [100],
      timeout: 5000,
    })
    .toBeGreaterThan(quietMs)
}

/** Types a number into a spinbutton and leaves it, then waits until the form below it stands still (settle). */
export async function fillNumber(spinbutton: Locator, value: string, form: Locator): Promise<void> {
  await spinbutton.fill(value)
  await spinbutton.blur()
  await settle(form)
}

/** Field paths of a form in document order (top level only unless `nested`). */
export async function renderedFieldPaths(scope: Locator, nested = false): Promise<string[]> {
  const paths = await scope.locator('[data-field-path]').evaluateAll((fields) => fields.map((field) => field.getAttribute('data-field-path') ?? ''))
  return nested ? paths : paths.filter((path) => !path.includes('.'))
}

/** Switches a schema form to JSON and returns the parsed value; switches back to the form when `back`. */
export async function formValue(scope: Locator, name: string, back = true): Promise<unknown> {
  const toggle = scope.getByRole('button', { name: 'Edit as JSON', exact: true })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  const text = await scope.getByRole('textbox', { name: `${name} as JSON` }).inputValue()
  if (back) {
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  }
  return JSON.parse(text) as unknown
}
