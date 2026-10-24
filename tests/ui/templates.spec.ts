import type { Locator, Page } from '@playwright/test'
import type { Template, TemplateEstimate } from '#shared/types/catalog'
import type { ItemList } from '#shared/types/common'
import { expect, test } from '../fixtures'
import { ok } from '../helpers/api-client'
import { gotoWithRetry } from '../helpers/ui'
import { shieldFromNetworkChanges, uTable } from '../helpers/ui-scans-kit'

// The templates catalog (docs/ui.md §5.14): one card per template with its description, the "pins inputs at scan
// start" badge, the example configs, the schema tables and an estimate form whose answers (and configInvalid issues)
// come from estimateTemplate. The catalog is read-only, so every test reads the same seven templates.

// Chromium aborts in-flight requests whenever the inner dockerd changes networks (helpers/ui-scans-kit.ts).
test.beforeEach(async ({ page }) => shieldFromNetworkChanges(page))

/** The card of a template: the nearest card root around its title. */
function card(page: Page, title: string): Locator {
  return page.getByRole('heading', { level: 2, name: title, exact: true }).locator('xpath=ancestor::*[@data-slot="root"][1]')
}

function estimateLine(templateCard: Locator): Locator {
  return templateCard.locator('span.tabular-nums')
}

/** Replaces the estimate form's value through "Edit as JSON" and switches back to the form. */
async function setAsJson(templateCard: Locator, value: Record<string, unknown>): Promise<void> {
  const toggle = templateCard.getByRole('button', { name: 'Edit as JSON', exact: true })
  await toggle.click()
  await templateCard.getByRole('textbox', { name: 'scanConfig as JSON' }).fill(JSON.stringify(value))
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
}

async function estimate(page: Page, templateCard: Locator, template: Template): Promise<{ status: number; body: unknown }> {
  const answer = page.waitForResponse(
    (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/templates/${template.name}/estimate`,
  )
  await templateCard.getByRole('button', { name: `Estimate ${template.title}`, exact: true }).click()
  const response = await answer
  return { status: response.status(), body: await response.json() }
}

test.describe('templates catalog', () => {
  test('a card per template with title, name, description, the resolve badge, examples and schema tables', { tag: ['@UI-TPL-001'] }, async ({ page, api }) => {
    const templates = ok(await api.call<ItemList<Template>>('listTemplates'), 'listTemplates').items
    expect(templates.map((template) => template.name).sort()).toEqual(['cidr', 'crux', 'list', 'range', 'repeat', 'single', 'tranco'])

    await gotoWithRetry(page, '/templates')
    await expect(page.getByRole('heading', { level: 2 })).toHaveCount(templates.length)
    for (const template of templates) {
      const templateCard = card(page, template.title)
      await expect(templateCard).toBeVisible()
      await expect(templateCard.locator('p.font-mono')).toHaveText(template.name)
      // Descriptions are plain text with `code` spans rendered as <code>.
      const description = templateCard.locator('p.text-sm').first()
      await expect(description).toHaveText(template.description.replaceAll('`', ''))
      const spans = [...template.description.matchAll(/`([^`]+)`/g)].map((match) => match[1]!)
      await expect(description.locator('code')).toHaveText(spans)
      await expect(templateCard.getByText('pins inputs at scan start', { exact: true })).toHaveCount(template.resolves ? 1 : 0)

      // The example configs.
      const examples = templateCard.locator('[data-slot="json-view"]')
      await expect(examples).toHaveCount(2)
      for (const [index, example] of [template.example.scanConfig, template.example.analysisConfig].entries()) {
        for (const [key, value] of Object.entries(example)) {
          await expect(examples.nth(index)).toContainText(`"${key}"`)
          for (const leaf of Array.isArray(value) ? value : [value])
            await expect(examples.nth(index)).toContainText(typeof leaf === 'string' ? `"${leaf}"` : String(leaf))
        }
      }
    }
    const resolving = templates
      .filter((template) => template.resolves)
      .map((template) => template.name)
      .sort()
    expect(resolving).toEqual(['crux', 'tranco'])

    // The schema tables appear on demand.
    const cidr = templates.find((template) => template.name === 'cidr')!
    const cidrCard = card(page, cidr.title)
    const scanSchema = uTable(cidrCard, `${cidr.title} scan config schema`)
    const analysisSchema = uTable(cidrCard, `${cidr.title} analysis config schema`)
    await expect(scanSchema).toHaveCount(0)
    await cidrCard.getByRole('button', { name: `Show schemas of ${cidr.title}` }).click()
    await expect(scanSchema).toBeVisible()
    await expect(scanSchema.getByRole('columnheader')).toHaveText(['Property', 'Type', 'Required', 'Default', 'Constraints', 'Description'])
    await expect(scanSchema.locator('tbody tr code.font-mono.whitespace-nowrap')).toHaveText(Object.keys(cidr.scanConfigSchema.properties as object))
    const cidrs = scanSchema.locator('tbody tr').filter({ has: page.locator('code', { hasText: /^cidrs$/ }) })
    await expect(cidrs).toContainText('array<string>')
    await expect(cidrs).toContainText('["192.0.2.0/29"]')
    await expect(cidrs).toContainText('minItems: 1')
    await expect(analysisSchema.locator('tbody tr code.font-mono.whitespace-nowrap')).toHaveText(Object.keys(cidr.analysisConfigSchema.properties as object))
    await expect(analysisSchema.locator('tbody tr').filter({ hasText: 'version' })).toContainText('one of: 4, 6')
    await expect(analysisSchema.locator('tbody tr').filter({ hasText: 'version' })).toContainText('required')
    await cidrCard.getByRole('button', { name: `Hide schemas of ${cidr.title}` }).click()
    await expect(scanSchema).toHaveCount(0)
  })

  test(
    'the estimate form starts from the example and shows exact, estimated and unknown totals with their badges',
    { tag: ['@UI-TPL-002'] },
    async ({ page, api }) => {
      const templates = ok(await api.call<ItemList<Template>>('listTemplates'), 'listTemplates').items
      const byName = (name: string) => templates.find((template) => template.name === name)!
      const info = ok(await api.getInstanceInfo(), 'getInstanceInfo')
      expect(info.limits.scanConfirmThreshold).toBeLessThan(5000)

      await gotoWithRetry(page, '/templates')

      // cidr: the example /29 gives eight addresses.
      const cidr = byName('cidr')
      const cidrCard = card(page, cidr.title)
      await expect(cidrCard.locator('[data-field-path="cidrs.0"] input')).toHaveValue('192.0.2.0/29')
      await expect(cidrCard.locator('[data-field-path="maxAnalyses"]').getByRole('spinbutton')).toHaveValue('65536')
      expect((await estimate(page, cidrCard, cidr)).status).toBe(200)
      await expect(estimateLine(cidrCard)).toHaveText(/^8 analyses\s*\(exact\)$/)
      await expect(cidrCard.getByText('needs confirmation', { exact: true })).toHaveCount(0)
      await expect(cidrCard.getByText('too large', { exact: true })).toHaveCount(0)

      // crux: an upper bound.
      const crux = byName('crux')
      const cruxCard = card(page, crux.title)
      expect((await estimate(page, cruxCard, crux)).status).toBe(200)
      await expect(estimateLine(cruxCard)).toHaveText(/^1,000 analyses\s*\(estimate\)$/)

      // tranco: above the confirmation threshold.
      const tranco = byName('tranco')
      const trancoCard = card(page, tranco.title)
      const limit = trancoCard.locator('[data-field-path="limit"]').getByRole('spinbutton')
      await limit.fill('5000')
      await limit.blur()
      expect((await estimate(page, trancoCard, tranco)).body).toEqual({ expectedTotal: 5000, exact: true, confirmationRequired: true, tooLarge: false })
      await expect(estimateLine(trancoCard)).toHaveText(/^5,000 analyses\s*\(exact\)$/)
      await expect(trancoCard.getByText('needs confirmation', { exact: true })).toBeVisible()
      await expect(trancoCard.getByText('too large', { exact: true })).toHaveCount(0)

      // repeat: above the instance maximum.
      const repeat = byName('repeat')
      const repeatCard = card(page, repeat.title)
      const times = repeatCard.locator('[data-field-path="times"]').getByRole('spinbutton')
      await expect(times).toHaveValue('3')
      const tooMany = 50_000_000 // above SCANTOR_MAX_ANALYSES_PER_SCAN of the stack
      await times.fill(String(tooMany))
      await times.blur()
      const answer = (await estimate(page, repeatCard, repeat)).body as TemplateEstimate
      expect(answer).toEqual({ expectedTotal: tooMany, exact: true, confirmationRequired: true, tooLarge: true })
      await expect(estimateLine(repeatCard)).toHaveText(new RegExp(`^${new Intl.NumberFormat('en-US').format(tooMany)} analyses\\s*\\(exact\\)$`))
      await expect(repeatCard.getByText('needs confirmation', { exact: true })).toBeVisible()
      await expect(repeatCard.getByText('too large', { exact: true })).toBeVisible()

      // No template of the catalog leaves the total open; the card says "unknown" when the answer has none.
      const single = byName('single')
      const singleCard = card(page, single.title)
      await expect(singleCard.getByText('No options.', { exact: true })).toBeVisible()
      await page.route('**/api/templates/single/estimate', async (route) => {
        const response = await route.fetch()
        await route.fulfill({ response, json: { ...((await response.json()) as TemplateEstimate), expectedTotal: null, exact: false } })
      })
      await singleCard.getByRole('button', { name: `Estimate ${single.title}`, exact: true }).click()
      await expect(estimateLine(singleCard)).toHaveText(/^unknown analyses\s*\(estimate\)$/)
    },
  )

  test("configs the template rejects are mapped onto the estimate form's fields", { tag: ['@UI-TPL-002'] }, async ({ page, api }) => {
    const templates = ok(await api.call<ItemList<Template>>('listTemplates'), 'listTemplates').items
    const range = templates.find((template) => template.name === 'range')!
    const cidr = templates.find((template) => template.name === 'cidr')!
    await gotoWithRetry(page, '/templates')

    // step 0 passes the JSON Schema; the template's own rules reject it. The values are entered as JSON: a keystroke in
    // a field schedules that field's own validation 300 ms later, which would replace an earlier server issue.
    const rangeCard = card(page, range.title)
    await setAsJson(rangeCard, { start: 1, end: 11, step: 0 })
    const step = rangeCard.locator('[data-field-path="step"]')
    await expect(step.getByRole('spinbutton')).toHaveValue('0')
    const rejected = await estimate(page, rangeCard, range)
    expect(rejected.status).toBe(422)
    const error = (rejected.body as { error: { code: string; details: { issues: { path: string; message: string }[] } } }).error
    expect(error.code).toBe('configInvalid')
    const issue = error.details.issues.find((entry) => entry.path === '/scanConfig/step')!
    expect(issue).toBeDefined()
    await expect(step).toContainText(issue.message)
    await expect(step.getByRole('spinbutton')).toHaveAttribute('aria-invalid', 'true')
    await expect(estimateLine(rangeCard)).toHaveCount(0)

    // A malformed range lands on its array item.
    const cidrCard = card(page, cidr.title)
    await setAsJson(cidrCard, { cidrs: ['not-a-cidr'], maxAnalyses: 65536 })
    const first = cidrCard.locator('[data-field-path="cidrs.0"]')
    await expect(first.locator('input')).toHaveValue('not-a-cidr')
    const bad = await estimate(page, cidrCard, cidr)
    expect(bad.status).toBe(422)
    const cidrIssue = (bad.body as { error: { details: { issues: { path: string; message: string }[] } } }).error.details.issues[0]!
    expect(cidrIssue.path).toBe('/scanConfig/cidrs/0')
    await expect(first).toContainText(cidrIssue.message)
    await expect(first.locator('input')).toHaveAttribute('aria-invalid', 'true')
    // A valid config clears the issue and estimates again.
    await first.locator('input').fill('192.0.2.0/30')
    await first.locator('input').blur()
    expect((await estimate(page, cidrCard, cidr)).status).toBe(200)
    await expect(estimateLine(cidrCard)).toHaveText(/^4 analyses\s*\(exact\)$/)
    await expect(first).not.toContainText(cidrIssue.message)
  })
})
