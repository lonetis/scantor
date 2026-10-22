import languagesTable from '../../../schemas/languages.json'

// The user guides of docs/guide/ (docs/mcp.md §6): which guides exist and how they are named. They back the MCP
// instructions and resources and the REST routes `getAuthoringGuide` and `getGuide` (docs/api.md §4.12). The text
// is read from the Nitro server assets (base name `guide`) by server/utils/guide-assets.ts.

/** Languages with an authoring guide `authoring-<language>.md`: every row of schemas/languages.json. */
export const GUIDE_LANGUAGES: readonly string[] = Object.keys((languagesTable as { languages: Record<string, unknown> }).languages)

/** Guides served by name (`docs/guide/<name>.md`). */
export const GUIDE_NAMES = ['templates', 'manifest', 'errors-and-retries', 'cli', 'mcp', 'remote-nodes'] as const
export type GuideName = (typeof GUIDE_NAMES)[number]

export type GuideReader = (file: string) => Promise<string | null>

export function isGuideLanguage(language: string): boolean {
  return GUIDE_LANGUAGES.includes(language)
}

export function isGuideName(name: string): name is GuideName {
  return (GUIDE_NAMES as readonly string[]).includes(name)
}

/** The authoring guide of a language; null for unknown languages or a missing file. */
export async function authoringGuide(language: string, read: GuideReader): Promise<string | null> {
  return isGuideLanguage(language) ? read(`authoring-${language}.md`) : null
}

/** A named guide; null for unknown names or a missing file. */
export async function namedGuide(name: string, read: GuideReader): Promise<string | null> {
  return isGuideName(name) ? read(`${name}.md`) : null
}
