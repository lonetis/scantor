import { readdirSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { referencedUploadIds, uploadPointers } from '../../../server/services/catalog/estimate'
import { baseImageRef, isKnownLanguage, listLanguages, listScaffolds } from '../../../server/services/catalog/languages'
import { listTemplates, setTemplateSourceForTesting, type TemplateFile, toTemplate } from '../../../server/services/catalog/templates'
import { readRepoFile, repoPath } from '../../helpers/repo'

// The catalog (docs/api.md §4.12): languages from schemas/languages.json, templates from schemas/templates/*.json,
// scaffolds, and the upload references a template estimate passes to `scantor templates estimate`.

function templateFiles(): TemplateFile[] {
  return readdirSync(repoPath('schemas/templates'))
    .filter((file) => file.endsWith('.json') && !file.endsWith('.fixtures.json'))
    .map((file) => JSON.parse(readRepoFile(`schemas/templates/${file}`)) as TemplateFile)
}

afterEach(() => setTemplateSourceForTesting(null))

describe('languages', () => {
  it('lists every language with the deployment base image', () => {
    const languages = listLanguages({ imagePrefix: 'ghcr.io/lonetis/', imageTag: '1.4.0' })
    expect(languages.map((language) => language.language).sort()).toEqual(['go', 'javascript', 'python', 'typescript'])
    expect(languages.find((language) => language.language === 'typescript')).toMatchObject({ base: 'js', baseImage: 'ghcr.io/lonetis/scantor-base-js:1.4.0', entry: 'main.ts' })
    expect(baseImageRef({ imagePrefix: '', imageTag: 'dev' }, 'scantor-base-go')).toBe('scantor-base-go:dev')
    expect(isKnownLanguage('python')).toBe(true)
    expect(isKnownLanguage('rust')).toBe(false)
    expect(isKnownLanguage('toString')).toBe(false)
  })
})

describe('templates', () => {
  it('maps every template file of schemas/templates', async () => {
    setTemplateSourceForTesting(async () => templateFiles())
    const templates = await listTemplates()
    expect(templates.map((template) => template.name)).toEqual(['cidr', 'crux', 'list', 'range', 'repeat', 'single', 'tranco'])
    for (const template of templates) {
      expect(template.title.length).toBeGreaterThan(0)
      expect(template.scanConfigSchema).toMatchObject({ type: 'object' })
      expect(template.analysisConfigSchema).toMatchObject({ type: 'object' })
    }
    expect(templates.find((template) => template.name === 'tranco')?.resolves).toBe(true)
    expect(templates.find((template) => template.name === 'single')?.resolves).toBe(false)
  })

  it('skips files without a valid name', () => {
    expect(toTemplate({ title: 'x' })).toBeNull()
    expect(toTemplate({ 'x-scantor-template': { name: 'Bad Name' } })).toBeNull()
  })

  it('lists a scaffold per language with every template and custom', async () => {
    setTemplateSourceForTesting(async () => templateFiles())
    const scaffolds = await listScaffolds()
    expect(scaffolds).toHaveLength(4)
    expect(scaffolds[0]!.templates).toEqual(['cidr', 'crux', 'list', 'range', 'repeat', 'single', 'tranco', 'custom'])
  })
})

describe('upload references', () => {
  it('finds the upload fields of the list template', async () => {
    const list = toTemplate(templateFiles().find((file) => file['x-scantor-template']?.name === 'list')!)!
    const pointers = uploadPointers(list.scanConfigSchema)
    expect(pointers.length).toBeGreaterThan(0)
    const field = pointers[0]!.slice(1)
    expect(referencedUploadIds({ [field]: '4e3d2c1b-0a9f-4e8d-8c7b-6a5f4e3d2c1b' }, pointers)).toEqual(['4e3d2c1b-0a9f-4e8d-8c7b-6a5f4e3d2c1b'])
    expect(referencedUploadIds({}, pointers)).toEqual([])
  })

  it('collects ids at wildcard paths', () => {
    expect(referencedUploadIds({ lists: ['a', 'b', 'a'] }, ['/lists/*'])).toEqual(['a', 'b'])
  })
})
