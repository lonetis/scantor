import type { ConsoleMessage, Locator, Page, Route } from '@playwright/test'
import type { Scan } from '#shared/types/scans'
import { expect, test } from '../fixtures'
import { ok } from '../helpers/api-client'
import {
  SHARED_SETUP_TIMEOUT_MS,
  FORM_EXTRAS_SCHEMA,
  PENDING_SETTINGS,
  badges,
  deleteOwnScans,
  fieldDescription,
  fieldError,
  fieldHint,
  fieldLabel,
  fillNumber,
  formSection,
  formValue,
  gotoApp,
  renderedFieldPaths,
  schemaField,
  sharedTask,
  sharedTasksOf,
  shieldFromNetworkChanges,
  trackOwnScan,
  uTable,
} from '../helpers/ui-scans-kit'

// The JSON-Schema form renderer (docs/ui.md §6) on the new-scan form and the test-run panel: every widget of §6.2
// with the schema-zoo fixture plus the form-extras task (the widgets schema-zoo lacks), the JSON fallback, the
// "Edit as JSON" round trip, the value semantics of §6.3, browser validation under the production CSP and the
// mapping of server issues (§6.4). Both tasks are shared per worker (helpers/ui-scans-kit.ts); scans started from the
// form are kept from running by a node selector no node matches, added to the captured request.

// Chromium aborts in-flight requests whenever the inner dockerd changes networks (helpers/ui-scans-kit.ts).
test.beforeEach(async ({ page }) => shieldFromNetworkChanges(page))
// The shared tasks of this spec are built before its first test in a worker, outside the tests' timeouts.
test.beforeAll(async ({ user, openapi }) => {
  test.setTimeout(SHARED_SETUP_TIMEOUT_MS)
  await sharedTasksOf(user, openapi, ['schema-zoo', 'form-extras', 'throws'])
})
test.afterEach(deleteOwnScans)

interface StartBody {
  revision: string
  taskConfig: Record<string, unknown>
  scanConfig: Record<string, unknown>
  settings?: Record<string, unknown>
  confirm?: boolean
}

const TASK_CONFIG = '3 · Task config'

/**
 * Captures the next startScan request and lets it through with settings whose workers are never placed, so the scan
 * stays `running` without a container. Returns the body the form sent and the created scan.
 */
async function startFromForm(page: Page): Promise<{ body: StartBody; scan: Scan }> {
  let sent: StartBody | undefined
  const handler = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    sent = route.request().postDataJSON() as StartBody
    await route.fallback({ postData: JSON.stringify({ ...sent, settings: { ...(sent.settings ?? {}), ...PENDING_SETTINGS } }) })
  }
  await page.route('**/api/scans', handler)
  try {
    const created = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/scans')
    await page.getByRole('button', { name: 'Start scan' }).click()
    const response = await created
    expect(response.status(), await response.text()).toBe(201)
    return { body: sent!, scan: (await response.json()) as Scan }
  } finally {
    await page.unroute('**/api/scans', handler)
  }
}

/** The CSS content of a field label's ::after (the required marker). */
async function requiredMarker(field: Locator): Promise<string> {
  return fieldLabel(field).evaluate((label) => getComputedStyle(label, '::after').content)
}

test.describe('schema forms', () => {
  test(
    'schema-zoo: fields in source order, nested objects, strings, numbers, booleans, enums and nullable fields; only touched keys are sent',
    { tag: ['@UI-FORM-001', '@UI-FORM-002', '@UI-FORM-004', '@UI-FORM-006', '@UI-FORM-009', '@UI-FORM-012'] },
    async ({ page, api, user, openapi }) => {
      const zoo = await sharedTask(user, openapi, 'schema-zoo')
      const schema = zoo.revision.description!.schemas.taskConfig as { properties: Record<string, unknown> }
      await gotoApp(page, `/scans/new?revision=${zoo.task.name}@latest`)
      const form = formSection(page, TASK_CONFIG)
      await expect(schemaField(form, 'text')).toBeVisible()
      await expect.poll(() => renderedFieldPaths(form)).toEqual(Object.keys(schema.properties))
      // The scan config of the single template has no properties.
      await expect(formSection(page, '4 · Scan config').getByText('No options.', { exact: true })).toBeVisible()

      // A nested object at depth 1: a titled group of its own fields, not collapsible.
      const address = schemaField(form, 'address')
      await expect(fieldLabel(address)).toHaveText('Address')
      await expect.poll(() => renderedFieldPaths(address, true)).toEqual(['address.street', 'address.zip'])
      await expect(address.getByRole('button', { name: /^(Hide|Show) / })).toHaveCount(0)

      // Strings: label, description, default as hint and placeholder, bounds, pattern errors under the field.
      const text = schemaField(form, 'text')
      await expect(fieldLabel(text)).toHaveText('Text')
      await expect(fieldDescription(text)).toHaveText('A bounded string.')
      await expect(fieldHint(text)).toHaveText('default: hello')
      const textInput = text.getByRole('textbox')
      await expect(textInput).toHaveAttribute('type', 'text')
      await expect(textInput).toHaveAttribute('placeholder', 'hello')
      await expect(textInput).toHaveAttribute('maxlength', '50')
      await expect(textInput).toHaveValue('')
      const zip = schemaField(form, 'address.zip')
      await zip.getByRole('textbox').fill('12ab')
      await zip.getByRole('textbox').blur()
      await expect(fieldError(zip)).toHaveText('String does not match pattern.')
      await zip.getByRole('textbox').fill('44801')
      await expect(fieldError(zip)).toHaveCount(0)

      // Numbers: bounds and step from the schema; exclusive bounds through the validator.
      const count = schemaField(form, 'count').getByRole('spinbutton')
      await expect(count).toHaveAttribute('aria-valuemin', '1')
      await expect(count).toHaveAttribute('aria-valuemax', '100')
      await expect(count).toHaveAttribute('placeholder', '3')
      await count.fill('250')
      await count.blur()
      await expect(count).toHaveValue('100')
      const step = schemaField(form, 'step').getByRole('spinbutton')
      await step.fill('0.5')
      await step.press('ArrowUp')
      await expect(step).toHaveValue('0.75')
      const ratio = schemaField(form, 'ratio')
      await ratio.getByRole('spinbutton').fill('1')
      await ratio.getByRole('spinbutton').blur()
      await expect(fieldError(ratio)).toHaveText('1 is greater than or equal to 1.')
      // Clearing removes the key again.
      await fillNumber(ratio.getByRole('spinbutton'), '', form)
      await expect(fieldError(ratio)).toHaveCount(0)

      // Booleans: the default while unset, an explicit value after a click, "Reset" removes it.
      const enabled = schemaField(form, 'enabled')
      const toggle = enabled.getByRole('switch', { name: 'Enabled' })
      await expect(toggle).toBeChecked()
      await expect(enabled).toContainText('on (default)')
      await expect(enabled.getByRole('button', { name: 'Reset Enabled' })).toHaveCount(0)
      await toggle.click()
      await expect(toggle).not.toBeChecked()
      await expect(enabled).toContainText('off')
      await expect(enabled).not.toContainText('(default)')
      await enabled.getByRole('button', { name: 'Reset Enabled' }).click()
      await expect(enabled).toContainText('on (default)')
      await toggle.click()

      // An enum of more than four options or of an optional field: a select with the default as placeholder.
      const level = form.getByRole('combobox', { name: 'Level' })
      await expect(level).toContainText('default: medium')
      await level.click()
      await expect(page.getByRole('option')).toHaveText(['low', 'medium', 'high'])
      await page.getByRole('option', { name: 'high', exact: true }).click()
      await expect(level).toContainText('high')
      await expect(schemaField(form, 'level').getByRole('button', { name: 'Reset Level' })).toBeVisible()

      // A nullable field: "null" sends null explicitly.
      const note = schemaField(form, 'note')
      await expect(note.getByRole('textbox')).toBeVisible()
      await note.getByRole('checkbox', { name: 'Set Note to null' }).check()
      await expect(note.getByRole('textbox')).toHaveCount(0)
      await expect(note.getByText('null', { exact: true }).first()).toBeVisible()

      // Untouched fields stay absent; cleared ones are removed.
      const expected = { address: { zip: '44801' }, count: 100, step: 0.75, enabled: false, level: 'high', note: null }
      expect(await formValue(form, 'taskConfig')).toEqual(expected)

      const { body, scan } = await startFromForm(page)
      trackOwnScan(user, openapi, scan.id)
      expect(body.taskConfig).toEqual(expected)
      expect(body.scanConfig).toEqual({})
      // The server fills the defaults of the untouched fields.
      const stored = ok(await api.getScan(scan.id), 'getScan')
      expect(stored.taskConfig).toMatchObject({ ...expected, address: { street: '', zip: '44801' }, text: 'hello', ratio: 0.5, tags: ['a'], weights: {} })
    },
  )

  test(
    'schema-zoo: arrays, maps, the discriminated union and the secret; browser validation under the production CSP',
    { tag: ['@UI-FORM-003', '@UI-FORM-005', '@UI-FORM-007', '@UI-FORM-008', '@UI-FORM-011', '@UI-FORM-013'] },
    async ({ page, user, openapi }) => {
      const zoo = await sharedTask(user, openapi, 'schema-zoo')
      const violations: string[] = []
      page.on('console', (message: ConsoleMessage) => {
        if (/content security policy/i.test(message.text())) violations.push(message.text())
      })
      const documentResponse = page.waitForResponse((response) => response.request().resourceType() === 'document')
      await gotoApp(page, `/scans/new?revision=${zoo.task.name}@latest`)
      const csp = (await (await documentResponse).allHeaders())['content-security-policy'] ?? ''
      const scriptSrc =
        csp
          .split(';')
          .map((directive) => directive.trim())
          .find((directive) => directive.startsWith('script-src')) ?? ''
      expect(scriptSrc).not.toBe('')
      expect(scriptSrc).not.toContain('unsafe-eval')
      const form = formSection(page, TASK_CONFIG)

      // An array of primitives: rows with add/remove, duplicates and maxItems through the validator.
      const tags = schemaField(form, 'tags')
      await expect(tags.getByText('No items.')).toBeVisible()
      const add = tags.getByRole('button', { name: 'Add item to Tags' })
      await add.click()
      await add.click()
      await schemaField(form, 'tags.0').getByRole('textbox').fill('alpha')
      await schemaField(form, 'tags.1').getByRole('textbox').fill('alpha')
      // Errors of the array itself appear when the whole form is validated: on "Start scan", before any request.
      const requests: string[] = []
      page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/scans') requests.push(request.url())
      })
      await page.getByRole('button', { name: 'Start scan' }).click()
      await expect(page.getByText('Check the highlighted fields', { exact: true })).toBeVisible()
      await expect(fieldError(tags)).toHaveText('Duplicate items at indexes 0 and 1.')
      expect(requests).toEqual([])
      await schemaField(form, 'tags.1').getByRole('textbox').fill('beta')
      for (let index = 2; index < 5; index++) await add.click()
      await expect(add).toBeDisabled()
      await tags.getByRole('button', { name: 'Remove item 5 from Tags' }).click()
      await tags.getByRole('button', { name: 'Remove item 4 from Tags' }).click()
      await tags.getByRole('button', { name: 'Remove item 3 from Tags' }).click()
      await expect(add).toBeEnabled()

      // A map: a key-value editor with key validation.
      const weights = schemaField(form, 'weights')
      await weights.getByRole('button', { name: 'Add Weights entry' }).click()
      await weights.getByRole('spinbutton', { name: 'Value of Weights entry 1' }).fill('3')
      await weights.getByRole('spinbutton', { name: 'Value of Weights entry 1' }).blur()
      await expect(weights.getByText('Key is required', { exact: true })).toBeVisible()
      await weights.getByRole('textbox', { name: 'Key of Weights entry 1' }).fill('a')
      await expect(weights.getByText('Key is required', { exact: true })).toHaveCount(0)
      await weights.getByRole('button', { name: 'Add Weights entry' }).click()
      await weights.getByRole('textbox', { name: 'Key of Weights entry 2' }).fill('a')
      await expect(weights.getByText('Duplicate key', { exact: true })).toHaveCount(2)
      await weights.getByRole('button', { name: 'Remove a' }).last().click()
      await expect(weights.getByText('Duplicate key', { exact: true })).toHaveCount(0)

      // The discriminated union: a select of the branch titles, then the branch's fields (without the discriminator).
      const notify = schemaField(form, 'notify')
      const kind = notify.getByRole('combobox', { name: 'Notify: kind' })
      await expect(schemaField(form, 'notify.to')).toHaveCount(0)
      await kind.click()
      await expect(page.getByRole('option')).toHaveText(['ByEmail', 'ByWebhook'])
      await page.getByRole('option', { name: 'ByWebhook', exact: true }).click()
      await expect.poll(() => renderedFieldPaths(notify, true)).toEqual(['notify.url', 'notify.retries'])
      const url = schemaField(form, 'notify.url').getByRole('textbox')
      await expect(url).toHaveAttribute('type', 'url')
      await expect(url).toHaveAttribute('placeholder', 'https://example.com/hook')
      const retries = schemaField(form, 'notify.retries')
      await fillNumber(retries.getByRole('spinbutton'), '11', form)
      await expect(retries.getByRole('spinbutton')).toHaveValue('10')
      // Only the selected branch is validated: its format error, and none about the other branch's constant. The value
      // passes the browser's own check of a type=url input (a value that fails it blocks the submit natively) but not
      // the schema's format "uri", so the whole form is validated again.
      await url.fill('https://example.com/a b')
      await url.blur()
      await page.getByRole('button', { name: 'Start scan' }).click()
      await expect(fieldError(schemaField(form, 'notify.url'))).toHaveText('String does not match format "uri".')
      await expect(notify.locator('[data-slot="error"]')).toHaveCount(1)
      // The corrected array has no error any more.
      await expect(fieldError(tags)).toHaveCount(0)
      expect(requests).toEqual([])
      await url.fill('https://hooks.example.org/scantor')
      await expect(fieldError(schemaField(form, 'notify.url'))).toHaveCount(0)
      expect(await formValue(form, 'taskConfig')).toMatchObject({ notify: { kind: 'webhook', url: 'https://hooks.example.org/scantor', retries: 10 } })
      // Switching branches keeps only the discriminator.
      await kind.click()
      await page.getByRole('option', { name: 'ByEmail', exact: true }).click()
      await expect.poll(() => renderedFieldPaths(notify, true)).toEqual(['notify.to'])
      await expect(schemaField(form, 'notify.to').getByRole('textbox')).toHaveAttribute('type', 'email')
      expect(await formValue(form, 'taskConfig')).toEqual({ tags: ['alpha', 'beta'], weights: { a: 3 }, notify: { kind: 'email' } })

      // The secret: a password input with a reveal button and a "secret" badge, never prefilled and without default.
      const token = schemaField(form, 'api_token')
      await expect(fieldLabel(token)).toContainText('Api Token')
      await expect(fieldLabel(token)).toContainText('secret')
      await expect(fieldHint(token)).toHaveCount(0)
      // The text input (the field's "null" checkbox has a hidden input of its own).
      const secret = token.locator('input[data-slot="base"]')
      await expect(secret).toHaveAttribute('type', 'password')
      await expect(secret).toHaveValue('')
      expect(await secret.getAttribute('placeholder')).toBeNull()
      await secret.fill('s3cret-value')
      await token.getByRole('button', { name: 'Show value of Api Token' }).click()
      await expect(secret).toHaveAttribute('type', 'text')
      await token.getByRole('button', { name: 'Hide value of Api Token' }).click()
      await expect(secret).toHaveAttribute('type', 'password')

      // "Edit as JSON": the whole value as text, blocked while invalid, back to the form with the edited value.
      const toggle = form.getByRole('button', { name: 'Edit as JSON', exact: true })
      await toggle.click()
      const json = form.getByRole('textbox', { name: 'taskConfig as JSON' })
      expect(JSON.parse(await json.inputValue())).toMatchObject({ tags: ['alpha', 'beta'], api_token: 's3cret-value' })
      await json.fill('{"count": ')
      await expect(form.getByText(/^Invalid JSON: /)).toBeVisible()
      await expect(toggle).toBeDisabled()
      // Validation errors of the JSON: unknown keys and bounds, before any request.
      await json.fill('{"count": 0, "x": 1}')
      await expect(form.locator('li', { hasText: 'unknown property "x"' })).toHaveText('(root) unknown property "x"')
      await expect(form.locator('li', { hasText: 'count' })).toHaveText('count 0 is less than 1.')
      await page.getByRole('button', { name: 'Start scan' }).click()
      await expect(page.getByText('Check the highlighted fields', { exact: true })).toBeVisible()
      expect(requests).toEqual([])
      await json.fill('{"count": 7, "tags": ["x"]}')
      await expect(toggle).toBeEnabled()
      await toggle.click()
      await expect(json).toHaveCount(0)
      await expect(schemaField(form, 'count').getByRole('spinbutton')).toHaveValue('7')
      await expect(schemaField(form, 'tags.0').getByRole('textbox')).toHaveValue('x')
      await expect(token.locator('input[data-slot="base"]')).toHaveValue('')
      expect(violations).toEqual([])
    },
  )

  test(
    'form-extras: formats, long strings, titled options, radios, read-only, deprecated and constant fields, arrays and maps',
    { tag: ['@UI-FORM-002', '@UI-FORM-004', '@UI-FORM-006', '@UI-FORM-007', '@UI-FORM-008', '@UI-FORM-009', '@UI-FORM-012', '@UI-FORM-013'] },
    async ({ page, user, openapi }) => {
      const extras = await sharedTask(user, openapi, 'form-extras')
      await gotoApp(page, `/scans/new?revision=${extras.task.name}@latest`)
      const form = formSection(page, TASK_CONFIG)
      await expect(schemaField(form, 'priority')).toBeVisible()
      await expect.poll(() => renderedFieldPaths(form)).toEqual(Object.keys(FORM_EXTRAS_SCHEMA.properties))

      // Required with at most four options: a radio group; required fields are marked; descriptions render code spans.
      const priority = schemaField(form, 'priority')
      expect(await requiredMarker(priority)).toBe('"*"')
      expect(await requiredMarker(schemaField(form, 'size'))).toBe('none')
      await expect(fieldDescription(priority).locator('code')).toHaveText('radio')
      await expect(fieldDescription(priority)).toHaveText('Required with at most four options: rendered as radio buttons.')
      await expect(priority.getByRole('radiogroup', { name: 'Priority' }).getByRole('radio')).toHaveCount(3)
      // A required field that is missing blocks the start with "is required".
      await page.getByRole('button', { name: 'Start scan' }).click()
      await expect(page.getByText('Check the highlighted fields', { exact: true })).toBeVisible()
      await expect(fieldError(priority)).toHaveText('is required')
      await priority.getByRole('radio', { name: '2', exact: true }).check()
      await expect(fieldError(priority)).toHaveCount(0)

      // Titled constants: a select with the titles; plain enums of five options: a select.
      const color = form.getByRole('combobox', { name: 'Color' })
      await expect(color).toContainText('default: Red')
      await color.click()
      await expect(page.getByRole('option')).toHaveText(['Red', 'Green', 'Blue'])
      await page.getByRole('option', { name: 'Green', exact: true }).click()
      const size = form.getByRole('combobox', { name: 'Size' })
      await size.click()
      await expect(page.getByRole('option')).toHaveText(['s', 'm', 'l', 'xl', 'xxl'])
      await page.getByRole('option', { name: 'xl', exact: true }).click()
      // "Reset" removes the key again; the default is the hint.
      await expect(fieldHint(schemaField(form, 'size'))).toHaveText('default: m')
      await schemaField(form, 'size').getByRole('button', { name: 'Reset Size' }).click()
      await expect(size).toContainText('default: m')

      // Formats choose the input type (date-time stays text: RFC 3339 needs seconds and a zone); examples or defaults
      // are placeholders; long strings get a textarea.
      for (const [path, type] of [
        ['when', 'date'],
        ['at', 'text'],
        ['site', 'url'],
        ['contact', 'email'],
        ['code', 'text'],
      ] as const) {
        await expect(schemaField(form, path).locator('input')).toHaveAttribute('type', type)
      }
      await expect(schemaField(form, 'site').locator('input')).toHaveAttribute('placeholder', 'https://example.org/start')
      await expect(schemaField(form, 'at').locator('input')).toHaveAttribute('placeholder', '2024-01-01T12:00:00Z')
      // A date-time value the validators accept, and one they reject.
      const at = schemaField(form, 'at')
      await at.locator('input').fill('2024-03-05')
      await at.locator('input').blur()
      await expect(fieldError(at)).toHaveText('String does not match format "date-time".')
      await at.locator('input').fill('2024-03-05T07:15:00+01:00')
      await at.locator('input').blur()
      await expect(fieldError(at)).toHaveCount(0)
      await expect(at.locator('input')).toHaveValue('2024-03-05T07:15:00+01:00')
      await expect(schemaField(form, 'code').locator('input')).toHaveAttribute('placeholder', 'ABC')
      await expect(schemaField(form, 'bio').locator('textarea')).toBeVisible()
      await expect(schemaField(form, 'bio').locator('input')).toHaveCount(0)
      const code = schemaField(form, 'code')
      await code.locator('input').fill('AB')
      await code.locator('input').blur()
      await expect(fieldError(code)).toHaveText('String is too short (2 < 3).')
      await code.locator('input').fill('abc')
      await expect(fieldError(code)).toHaveText('String does not match pattern.')
      await code.locator('input').fill('XYZ')
      await expect(fieldError(code)).toHaveCount(0)
      await schemaField(form, 'site').locator('input').fill('https://scan.example.org/')

      // Read-only and constant fields are shown but never sent; deprecated fields carry a badge.
      const version = schemaField(form, 'version')
      await expect(version.locator('input')).toBeDisabled()
      await expect(fieldLabel(version)).toContainText('read-only')
      await expect(schemaField(form, 'kind')).toContainText('"fixed"')
      await expect(schemaField(form, 'kind').locator('input')).toHaveCount(0)
      await expect(fieldLabel(schemaField(form, 'legacy'))).toContainText('deprecated')
      await expect(schemaField(form, 'verbose')).toContainText('off (default)')
      // Numbers: min, max and step from the schema.
      const amount = schemaField(form, 'amount').getByRole('spinbutton')
      await amount.fill('9.5')
      await amount.press('ArrowUp')
      await expect(amount).toHaveValue('10')
      await amount.press('ArrowUp')
      await expect(amount).toHaveValue('10')
      await expect(schemaField(form, 'maybe').getByRole('checkbox', { name: 'Set Maybe to null' })).toBeVisible()

      // Arrays of enums: a multi-select; arrays of primitives: rows up to maxItems; arrays of objects: "Item n" sections.
      const channels = form.getByRole('button', { name: 'Channels', exact: true })
      await channels.click()
      await page.getByRole('option', { name: 'alpha', exact: true }).click()
      await page.getByRole('option', { name: 'gamma', exact: true }).click()
      await page.keyboard.press('Escape')
      const ports = schemaField(form, 'ports')
      const addPort = ports.getByRole('button', { name: 'Add item to Ports' })
      await addPort.click()
      await addPort.click()
      await expect(addPort).toBeDisabled()
      await fillNumber(schemaField(form, 'ports.0').getByRole('spinbutton'), '443', form)
      await ports.getByRole('button', { name: 'Remove item 2 from Ports' }).click()
      await expect(addPort).toBeEnabled()
      const servers = schemaField(form, 'servers')
      await servers.getByRole('button', { name: 'Add item to Servers' }).click()
      await expect(servers.getByText('Item 1', { exact: true })).toBeVisible()
      await schemaField(form, 'servers.0.host').getByRole('textbox').fill('db.internal')
      await expect(schemaField(form, 'servers.0.port').getByRole('spinbutton')).toHaveAttribute('placeholder', '22')

      // A map with constrained keys; an open map is JSON.
      const labels = schemaField(form, 'labels')
      await labels.getByRole('button', { name: 'Add Labels entry' }).click()
      await labels.getByRole('textbox', { name: 'Key of Labels entry 1' }).fill('Bad')
      await expect(labels.getByText('Keys must match ^[a-z]+$', { exact: true })).toBeVisible()
      await labels.getByRole('textbox', { name: 'Key of Labels entry 1' }).fill('env')
      await labels.getByRole('textbox', { name: 'Value of env' }).fill('prod')
      await expect(labels.getByText('Keys must match ^[a-z]+$', { exact: true })).toHaveCount(0)
      await expect(schemaField(form, 'extra').getByRole('textbox', { name: 'Extra (JSON)' })).toBeVisible()
      await expect(schemaField(form, 'extra')).toContainText('Edited as JSON (open object).')

      const expected = {
        priority: 2,
        color: 'green',
        at: '2024-03-05T07:15:00+01:00',
        code: 'XYZ',
        site: 'https://scan.example.org/',
        amount: 10,
        channels: ['alpha', 'gamma'],
        ports: [443],
        servers: [{ host: 'db.internal' }],
        labels: { env: 'prod' },
      }
      expect(await formValue(form, 'taskConfig')).toEqual(expected)
      const { body, scan } = await startFromForm(page)
      trackOwnScan(user, openapi, scan.id)
      // Non-string enum values keep their JSON type; read-only and constant fields are absent.
      expect(body.taskConfig).toEqual(expected)
      expect(typeof body.taskConfig.priority).toBe('number')
    },
  )

  test(
    'form-extras: collapsible nested objects, the depth limit, recursion and unsupported constructs fall back to JSON',
    { tag: ['@UI-FORM-001', '@UI-FORM-010'] },
    async ({ page, user, openapi }) => {
      const extras = await sharedTask(user, openapi, 'form-extras')
      await gotoApp(page, `/scans/new?revision=${extras.task.name}@latest`)
      const form = formSection(page, TASK_CONFIG)

      // Depth 1 renders open; from depth 2 on, nested objects are collapsible.
      const place = schemaField(form, 'place')
      await expect(place.getByRole('button', { name: 'Hide Place' })).toHaveCount(0)
      await expect(schemaField(form, 'place.city')).toBeVisible()
      const geo = schemaField(form, 'place.geo')
      await expect(schemaField(form, 'place.geo.lat')).toBeVisible()
      await geo.getByRole('button', { name: 'Hide Geo' }).click()
      await expect(schemaField(form, 'place.geo.lat')).toHaveCount(0)
      await geo.getByRole('button', { name: 'Show Geo' }).click()
      await expect(schemaField(form, 'place.geo.lat')).toBeVisible()

      // Objects deeper than four levels are edited as JSON.
      for (const path of ['deep.l2', 'deep.l2.l3', 'deep.l2.l3.l4']) await expect(schemaField(form, path)).toBeVisible()
      const l5 = schemaField(form, 'deep.l2.l3.l4.l5')
      await expect(l5.getByRole('textbox', { name: 'L5 (JSON)' })).toBeVisible()
      await expect(l5).toContainText('Edited as JSON (nested too deeply).')
      await expect(schemaField(form, 'deep.l2.l3.l4.l5.value')).toHaveCount(0)

      // A recursive schema: the recursion is edited as JSON.
      await expect(schemaField(form, 'tree.name').getByRole('textbox')).toBeVisible()
      const children = schemaField(form, 'tree.children')
      await expect(children.getByRole('textbox', { name: 'Children (JSON)' })).toBeVisible()
      await expect(children).toContainText('Edited as JSON (array of recursive reference).')

      // Constructs outside the subset.
      for (const [path, title, reason] of [
        ['combo', 'Combo', 'unsupported keyword allOf'],
        ['either', 'Either', 'unsupported anyOf'],
        ['pair', 'Pair', 'unsupported keyword prefixItems'],
        ['cond', 'Cond', 'unsupported keyword if'],
        ['notnull', 'Notnull', 'unsupported keyword not'],
        ['patterned', 'Patterned', 'unsupported keyword patternProperties'],
      ] as const) {
        const field = schemaField(form, path)
        const textarea = field.getByRole('textbox', { name: `${title} (JSON)` })
        await expect(textarea).toBeVisible()
        await expect(field).toContainText(`Edited as JSON (${reason}).`)
      }
      // The default is the placeholder; invalid JSON is reported on blur, a valid value is validated by the schema.
      const combo = schemaField(form, 'combo')
      const comboText = combo.getByRole('textbox', { name: 'Combo (JSON)' })
      await expect(comboText).toHaveAttribute('placeholder', '1')
      await comboText.fill('{"a": ')
      await comboText.blur()
      await expect(combo.getByText(/^Invalid JSON: /)).toBeVisible()
      await comboText.fill('-4')
      await comboText.blur()
      await expect(combo.getByText(/^Invalid JSON: /)).toHaveCount(0)
      await expect(fieldError(combo)).toHaveText('-4 is less than 0.')
      await comboText.fill('5')
      await comboText.blur()
      await expect(fieldError(combo)).toHaveCount(0)
      await page.getByRole('radio', { name: '1', exact: true }).check()
      expect(await formValue(form, 'taskConfig')).toEqual({ priority: 1, combo: 5 })
    },
  )

  test(
    'server issues land on their field, on the nearest rendered ancestor, or above the form',
    { tag: ['@UI-SCAN-012', '@UI-FORM-005'] },
    async ({ page, user, openapi }) => {
      const zoo = await sharedTask(user, openapi, 'schema-zoo')
      await gotoApp(page, `/scans/new?revision=${zoo.task.name}@latest`)
      const form = formSection(page, TASK_CONFIG)
      await schemaField(form, 'count').getByRole('spinbutton').fill('5')
      await form.getByRole('combobox', { name: 'Notify: kind' }).click()
      await page.getByRole('option', { name: 'ByEmail', exact: true }).click()
      // The server is authoritative; its configInvalid answer (docs/api.md §1.7) is produced here for paths the
      // stack cannot be made to reject on demand.
      const issues = [
        { path: '/taskConfig/count', message: 'count rejected by the server' },
        { path: '/taskConfig/address/zip', message: 'zip rejected by the server' },
        { path: '/taskConfig/notify/url', message: 'url of another branch rejected' },
        { path: '/taskConfig/unknownField', message: 'no such field here' },
      ]
      await page.route('**/api/scans', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback()
        await route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'configInvalid', message: 'the task config is invalid', details: { issues } } }),
        })
      })
      await page.getByRole('button', { name: 'Start scan' }).click()
      await expect(fieldError(schemaField(form, 'count'))).toHaveText('count rejected by the server')
      await expect(schemaField(form, 'count').getByRole('spinbutton')).toHaveAttribute('aria-invalid', 'true')
      await expect(fieldError(schemaField(form, 'address.zip'))).toHaveText('zip rejected by the server')
      // notify.url is not rendered while the e-mail branch is selected: the union field shows it.
      await expect(fieldError(schemaField(form, 'notify'))).toHaveText('url of another branch rejected')
      // An issue without a rendered field (or ancestor) is listed above the form.
      await expect(form.getByText('The server rejected this configuration', { exact: true })).toBeVisible()
      await expect(form.getByRole('listitem')).toHaveText(['unknownField: no such field here'])
      await expect(page).toHaveURL(/\/scans\/new/)
    },
  )

  test(
    'leaving a required number field right after typing keeps the form still, so the click on "Start test run" starts the run',
    { tag: ['@UI-FORM-013'] },
    async ({ page, user, openapi }) => {
      const throws = await sharedTask(user, openapi, 'throws')
      await gotoApp(page, `/tasks/${throws.task.id}?tab=test`)
      const inputs = page.getByRole('form', { name: 'Test run inputs' })
      await expect(inputs).toBeVisible()
      await inputs.getByRole('radio', { name: 'One analysis' }).check()
      const value = schemaField(inputs, 'value')
      await expect(fieldLabel(value)).toContainText('Value')
      // Every error the field shows, also one that disappears again.
      await value.evaluate((field) => {
        const seen: string[] = []
        ;(window as unknown as { __valueErrors: string[] }).__valueErrors = seen
        new MutationObserver(() => {
          const text = field.querySelector('[data-slot="error"]')?.textContent?.trim()
          if (text && seen.at(-1) !== text) seen.push(text)
        }).observe(field, { subtree: true, childList: true, characterData: true })
      })
      await value.getByRole('spinbutton').fill('7')
      // The value field still has the focus: the click's mousedown blurs it.
      const started = page.waitForRequest((request) => request.method() === 'POST' && /\/api\/tasks\/[^/]+\/test-runs$/.test(new URL(request.url()).pathname), {
        timeout: 5000,
      })
      await inputs.getByRole('button', { name: 'Start test run' }).click()
      await started
      expect(await page.evaluate(() => (window as unknown as { __valueErrors: string[] }).__valueErrors)).toEqual([])
    },
  )

  test(
    'the test-run panel renders the same form and sends only what was touched',
    { tag: ['@UI-FORM-001', '@UI-FORM-011', '@UI-FORM-012'] },
    async ({ page, user, openapi }) => {
      test.setTimeout(180_000)
      const zoo = await sharedTask(user, openapi, 'schema-zoo')
      await gotoApp(page, `/tasks/${zoo.task.id}?tab=test`)
      const inputs = page.getByRole('form', { name: 'Test run inputs' })
      await expect(inputs).toBeVisible()
      const taskForm = inputs.locator('form').first()
      await expect(schemaField(taskForm, 'text')).toBeVisible()
      const schema = zoo.revision.description!.schemas.taskConfig as { properties: Record<string, unknown> }
      await expect.poll(() => renderedFieldPaths(taskForm)).toEqual(Object.keys(schema.properties))
      await expect(inputs.getByText('No options.', { exact: true })).toBeVisible()

      await schemaField(taskForm, 'text').getByRole('textbox').fill('from the panel')
      await taskForm.getByRole('combobox', { name: 'Notify: kind' }).click()
      await page.getByRole('option', { name: 'ByWebhook', exact: true }).click()
      await schemaField(taskForm, 'notify.retries').getByRole('spinbutton').fill('4')
      await schemaField(taskForm, 'notify.retries').getByRole('spinbutton').blur()
      // The round trip through JSON keeps the value.
      expect(await formValue(taskForm, 'taskConfig')).toEqual({ text: 'from the panel', notify: { kind: 'webhook', retries: 4 } })
      await expect(schemaField(taskForm, 'notify.retries').getByRole('spinbutton')).toHaveValue('4')

      const request = page.waitForRequest(
        (candidate) => candidate.method() === 'POST' && /\/api\/tasks\/[^/]+\/test-runs$/.test(new URL(candidate.url()).pathname),
      )
      await page.getByRole('button', { name: 'Start test run' }).click()
      const body = (await request).postDataJSON() as { taskConfig: Record<string, unknown>; scanConfig: Record<string, unknown>; limit: number }
      expect(body.taskConfig).toEqual({ text: 'from the panel', notify: { kind: 'webhook', retries: 4 } })
      expect(body.scanConfig).toEqual({})
      // The run receives the defaults of everything else.
      const analyses = uTable(page, 'Test run analyses')
      await expect(badges(analyses.locator('tbody tr[data-row-id]').first())).toHaveText('succeeded', { timeout: 150_000 })
      const outcome = analyses.locator('tbody tr[data-row-id]').first()
      await expect(outcome).toContainText('"text":"from the panel"')
      await expect(outcome).toContainText('"count":3')
      await expect(outcome).toContainText('"url":"https://example.com/hook"')
      await expect(outcome).toContainText('"retries":4')
    },
  )
})
