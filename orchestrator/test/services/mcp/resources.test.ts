import { describe, expect, it } from 'vitest'
import { extractInstructions, INSTRUCTIONS_END, INSTRUCTIONS_START } from '../../../server/services/mcp/resources'
import { authoringGuide, GUIDE_LANGUAGES, GUIDE_NAMES, namedGuide, scriptGuideFile } from '../../../server/utils/guides'
import { readRepoFile, repoFileExists } from '../../helpers/repo'

// Instructions and guide resources (docs/mcp.md §6).

describe('extractInstructions', () => {
  it('uses the marked section of docs/guide/mcp.md', () => {
    const markdown = `# MCP\n\nintro\n${INSTRUCTIONS_START}\nUse the tools.\n${INSTRUCTIONS_END}\nmore`
    expect(extractInstructions(markdown)).toBe('Use the tools.')
  })

  it('falls back to a built-in text without the section', () => {
    expect(extractInstructions(null)).toContain('untrusted_data')
    expect(extractInstructions('# no markers')).toContain('untrusted_data')
  })

  it.skipIf(!repoFileExists('docs/guide/mcp.md'))('keeps the shipped instructions within 8 KiB', () => {
    const instructions = extractInstructions(readRepoFile('docs/guide/mcp.md'))
    expect(Buffer.byteLength(instructions, 'utf8')).toBeLessThanOrEqual(8 * 1024)
  })
})



describe('guide catalogue', () => {
  it('serves an authoring guide for every row of schemas/languages.json and the named guides', async () => {
    const table = JSON.parse(readRepoFile('schemas/languages.json')) as { languages: Record<string, unknown> }
    expect(GUIDE_LANGUAGES).toEqual(Object.keys(table.languages))
    const read = async (file: string) => `contents of ${file}`
    expect(await authoringGuide('go', read)).toBe('contents of authoring-go.md')
    expect(await authoringGuide('cobol', read)).toBeNull()
    expect(await namedGuide('errors-and-retries', read)).toBe('contents of errors-and-retries.md')
    expect(await namedGuide('../secrets', read)).toBeNull()
    expect(GUIDE_NAMES).toEqual(['templates', 'manifest', 'errors-and-retries', 'cli', 'mcp', 'remote-nodes', 'scripts'])
  })

  it("serves a language row's script.guide for kind script and nothing for a language without scripts", async () => {
    const table = JSON.parse(readRepoFile('schemas/languages.json')) as { languages: Record<string, { script?: { guide: string } }> }
    const read = async (file: string) => `contents of ${file}`
    expect(await authoringGuide('python', read, 'task')).toBe('contents of authoring-python.md')
    for (const [language, row] of Object.entries(table.languages)) {
      const expected = row.script ? `contents of ${row.script.guide.replace(/^docs\/guide\//, '')}` : null
      expect(scriptGuideFile(language), language).toBe(row.script ? row.script.guide.replace(/^docs\/guide\//, '') : null)
      expect(await authoringGuide(language, read, 'script'), language).toBe(expected)
    }
    expect(await authoringGuide('cobol', read, 'script')).toBeNull()
  })
})
