import languagesTable from '../../../schemas/languages.json'

// The user guides of docs/guide/ (docs/mcp.md §6): which guides exist and how they are named. They back the MCP
// instructions and resources and the REST routes `getAuthoringGuide` and `getGuide` (docs/api.md §4.12). The text
// is read from the Nitro server assets (base name `guide`) by server/utils/guide-assets.ts.

const languageRows = (languagesTable as { languages: Record<string, { script?: { guide: string } }> }).languages

/** Languages with an authoring guide `authoring-<language>.md`: every row of schemas/languages.json. */
export const GUIDE_LANGUAGES: readonly string[] = Object.keys(languageRows)

/** What an authoring guide teaches: the task API (`authoring-<language>.md`) or the script API (the row's `script.guide`). */
export const AUTHORING_GUIDE_KINDS = ['task', 'script'] as const
export type AuthoringGuideKind = (typeof AUTHORING_GUIDE_KINDS)[number]

const GUIDE_DIR = 'docs/guide/'

/** Guides served by name (`docs/guide/<name>.md`). */
export const GUIDE_NAMES = ['templates', 'manifest', 'errors-and-retries', 'cli', 'mcp', 'remote-nodes', 'scripts'] as const
export type GuideName = (typeof GUIDE_NAMES)[number]

export type GuideReader = (file: string) => Promise<string | null>

export function isGuideLanguage(language: string): boolean {
  return GUIDE_LANGUAGES.includes(language)
}

export function isGuideName(name: string): name is GuideName {
  return (GUIDE_NAMES as readonly string[]).includes(name)
}

/** The file under docs/guide/ of a language's script guide (its row's `script.guide`); null without script support. */
export function scriptGuideFile(language: string): string | null {
  const guide = isGuideLanguage(language) ? languageRows[language]!.script?.guide : undefined
  return guide?.startsWith(GUIDE_DIR) ? guide.slice(GUIDE_DIR.length) : null
}

/** The authoring guide of a language and kind; null for unknown languages, a language without scripts or a missing file. */
export async function authoringGuide(language: string, read: GuideReader, kind: AuthoringGuideKind = 'task'): Promise<string | null> {
  if (kind === 'script') {
    const file = scriptGuideFile(language)
    return file === null ? null : read(file)
  }
  return isGuideLanguage(language) ? read(`authoring-${language}.md`) : null
}

/** A named guide; null for unknown names or a missing file. */
export async function namedGuide(name: string, read: GuideReader): Promise<string | null> {
  return isGuideName(name) ? read(`${name}.md`) : null
}
