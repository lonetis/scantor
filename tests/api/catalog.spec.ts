import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Language, Scaffold, Template, TemplateEstimate } from '#shared/types/catalog'
import type { ItemList } from '#shared/types/common'
import { ok } from '../helpers/api-client'
import { env } from '../helpers/env'
import { expect, test as fixturesTest } from '../fixtures'
import { apiResultsTest } from '../helpers/api-results-fixtures'

const test = apiResultsTest(fixturesTest)

// The catalog (docs/api.md §4.12): languages, templates and their estimates, scaffolds and the user guides. Every
// expectation is derived from the repository's own tables (schemas/languages.json, schemas/templates/*.json), so a
// new language or template needs no change here.

interface LanguageRow {
  title: string
  base: string
  image: string
  entry: string
  extensions: string[]
}

const languagesTable = JSON.parse(readFileSync(join(env.paths.repo, 'schemas', 'languages.json'), 'utf8')) as { languages: Record<string, LanguageRow> }
const LANGUAGES = Object.keys(languagesTable.languages)
const TEMPLATES = ['single', 'repeat', 'list', 'range', 'cidr', 'tranco', 'crux']
const GUIDES = ['templates', 'manifest', 'errors-and-retries', 'cli', 'mcp', 'remote-nodes']

function templateResolves(name: string): boolean {
  const file = JSON.parse(readFileSync(join(env.paths.repo, 'schemas', 'templates', `${name}.json`), 'utf8')) as {
    'x-scantor-template': { resolves: boolean }
  }
  return file['x-scantor-template'].resolves
}

/** The first line of a guide in the repository (the served copy is embedded at image build time). */
function guideHeading(file: string): string {
  return readFileSync(join(env.paths.repo, 'docs', 'guide', file), 'utf8').split('\n')[0]!
}

test.describe('languages and scaffolds', () => {
  test('listLanguages returns every row of languages.json', { tag: ['@CAT-001'] }, async ({ api }) => {
    const { items } = ok(await api.call<ItemList<Language>>('listLanguages'), 'listLanguages')
    expect(items.map((item) => item.language).sort()).toEqual([...LANGUAGES].sort())
    expect(LANGUAGES).toEqual(expect.arrayContaining(['python', 'typescript', 'javascript', 'go']))
    for (const item of items) {
      const row = languagesTable.languages[item.language]!
      expect(Object.keys(item).sort()).toEqual(['base', 'baseImage', 'entry', 'extensions', 'language', 'title'])
      expect(item).toMatchObject({ title: row.title, base: row.base, entry: row.entry, extensions: row.extensions })
      // The stack runs local images: no registry prefix and the tag dev (tests/docker/stack.env).
      expect(item.baseImage).toBe(`${row.image}:dev`)
    }
  })

  test('listScaffolds lists every template plus custom for every language', { tag: ['@CAT-006'] }, async ({ api }) => {
    const { items } = ok(await api.call<ItemList<Scaffold>>('listScaffolds'), 'listScaffolds')
    expect(items.map((item) => item.language).sort()).toEqual([...LANGUAGES].sort())
    for (const item of items) expect([...item.templates].sort(), item.language).toEqual([...TEMPLATES, 'custom'].sort())
  })
})

test.describe('templates', () => {
  test('listTemplates returns the seven templates with their schemas and examples', { tag: ['@CAT-002'] }, async ({ api }) => {
    const { items } = ok(await api.call<ItemList<Template>>('listTemplates'), 'listTemplates')
    expect(items.map((item) => item.name).sort()).toEqual([...TEMPLATES].sort())
    for (const item of items) {
      expect(item.title, item.name).toEqual(expect.any(String))
      expect(item.description.length, item.name).toBeGreaterThan(0)
      expect(item.scanConfigSchema, item.name).toMatchObject({ type: 'object' })
      expect(item.analysisConfigSchema, item.name).toMatchObject({ type: 'object' })
      expect(item.example, item.name).toEqual({ scanConfig: expect.any(Object), analysisConfig: expect.any(Object) })
      expect(item.resolves, item.name).toBe(templateResolves(item.name))
    }
    expect(items.find((item) => item.name === 'tranco')?.resolves).toBe(true)
    expect(items.find((item) => item.name === 'range')?.resolves).toBe(false)
  })

  test('getTemplate returns one template; unknown and malformed names are 404', { tag: ['@CAT-003'] }, async ({ api }) => {
    const { items } = ok(await api.call<ItemList<Template>>('listTemplates'), 'listTemplates')
    for (const name of ['cidr', 'list']) {
      const one = ok(await api.call<Template>('getTemplate', { path: { template: name } }), 'getTemplate')
      expect(one).toEqual(items.find((item) => item.name === name))
    }
    for (const name of ['nosuch', 'Range', 'range-x', '9range', 'a'.repeat(40), '..']) {
      const response = await api.call('getTemplate', { path: { template: name } })
      expect(response.status, name).toBe(404)
      expect(response.body).toMatchObject({ error: { code: 'notFound' } })
    }
  })

  test('estimateTemplate counts analyses and flags confirmation', { tag: ['@CAT-004'] }, async ({ api }) => {
    const cidr = await api.call<TemplateEstimate>('estimateTemplate', { path: { template: 'cidr' }, body: { scanConfig: { cidrs: ['192.0.2.0/29'] } } })
    expect(cidr.status).toBe(200)
    expect(cidr.body).toEqual({ expectedTotal: 8, exact: true, confirmationRequired: false, tooLarge: false })

    // Defaults apply: the range template counts 0…9.
    const range = ok(await api.call<TemplateEstimate>('estimateTemplate', { path: { template: 'range' }, body: {} }), 'estimateTemplate')
    expect(range).toMatchObject({ expectedTotal: 10, exact: true, confirmationRequired: false })

    // Above SCANTOR_SCAN_CONFIRM_THRESHOLD (1000 in the test stack) a scan needs confirm: true.
    const items = Array.from({ length: 1001 }, (_, i) => `item-${i}`)
    const list = ok(await api.call<TemplateEstimate>('estimateTemplate', { path: { template: 'list' }, body: { scanConfig: { items } } }), 'estimateTemplate')
    expect(list).toEqual({ expectedTotal: 1001, exact: true, confirmationRequired: true, tooLarge: false })

    // Above SCANTOR_MAX_ANALYSES_PER_SCAN the estimate is tooLarge.
    const huge = ok(
      await api.call<TemplateEstimate>('estimateTemplate', { path: { template: 'range' }, body: { scanConfig: { start: 0, end: 9_000_000_000_000 } } }),
      'estimateTemplate',
    )
    expect(huge).toMatchObject({ expectedTotal: 9_000_000_000_000, confirmationRequired: true, tooLarge: true })

    const unknown = await api.call('estimateTemplate', { path: { template: 'nosuch' }, body: { scanConfig: {} } })
    expect(unknown.status).toBe(404)
    expect(unknown.body).toMatchObject({ error: { code: 'notFound' } })
  })

  test('estimateTemplate rejects schema violations and semantic rules with JSON pointers', { tag: ['@CAT-005'] }, async ({ api }) => {
    const cases: { template: string; scanConfig: Record<string, unknown>; path: string; message: RegExp }[] = [
      { template: 'range', scanConfig: { start: 'x' }, path: '/scanConfig/start', message: /integer/ },
      { template: 'list', scanConfig: { unknown: 1 }, path: '/scanConfig', message: /additional|unknown|must NOT have/i },
      { template: 'cidr', scanConfig: { cidrs: ['10.0.0.0/24'], maxAnalyses: 8 }, path: '/scanConfig/maxAnalyses', message: /256/ },
      { template: 'range', scanConfig: { step: 0 }, path: '/scanConfig/step', message: /0/ },
      { template: 'tranco', scanConfig: { offset: 999_999, limit: 2 }, path: '/scanConfig/limit', message: /1000000/ },
    ]
    for (const { template, scanConfig, path, message } of cases) {
      const response = await api.call<{ error: { code: string; details: { issues: { path: string; message: string }[] } } }>('estimateTemplate', {
        path: { template },
        body: { scanConfig },
      })
      expect(response.status, `${template} ${JSON.stringify(scanConfig)}`).toBe(422)
      expect(response.body.error.code).toBe('configInvalid')
      const issue = response.body.error.details.issues[0]!
      expect(issue.path.startsWith(path), `${issue.path} under ${path}`).toBe(true)
      expect(issue.message).toMatch(message)
    }
  })
})

test.describe('guides', () => {
  test('getAuthoringGuide serves markdown for every language and 404 otherwise', { tag: ['@CAT-007'] }, async ({ api }) => {
    for (const language of LANGUAGES) {
      const response = await api.call('getAuthoringGuide', { path: { language } })
      expect(response.status, language).toBe(200)
      expect(response.headers['content-type']).toMatch(/^text\/markdown/)
      const text = response.raw.toString('utf8')
      expect(text.split('\n')[0]).toBe(guideHeading(`authoring-${language}.md`))
      expect(text.length).toBeGreaterThan(1000)
    }
    for (const language of ['cobol', 'Python', 'templates']) {
      const response = await api.call('getAuthoringGuide', { path: { language } })
      expect(response.status, language).toBe(404)
      expect(response.body).toMatchObject({ error: { code: 'notFound' } })
    }
  })

  test('getGuide serves the six named guides and 404 for any other name', { tag: ['@CAT-008'] }, async ({ api }) => {
    for (const guide of GUIDES) {
      const response = await api.call('getGuide', { path: { guide } })
      expect(response.status, guide).toBe(200)
      expect(response.headers['content-type']).toMatch(/^text\/markdown/)
      expect(response.raw.toString('utf8').split('\n')[0]).toBe(guideHeading(`${guide}.md`))
    }
    for (const guide of ['readme', 'README', 'authoring-python', 'nosuch', 'architecture']) {
      const response = await api.call('getGuide', { path: { guide } })
      expect(response.status, guide).toBe(404)
      expect(response.body).toMatchObject({ error: { code: 'notFound' } })
    }
  })
})
