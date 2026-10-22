import type { Language, Scaffold } from '#shared/types/catalog'
import { CUSTOM_TEMPLATE } from '#shared/schemas/tasks'
import languagesTable from '../../../../schemas/languages.json'
import type { Config } from '../../utils/config'
import { templateNames } from './templates'

// Languages and scaffolds (docs/tasks.md §4.1, §12; docs/api.md §4.12), from schemas/languages.json, the only
// language table of the platform. `baseImage` is the reference this deployment builds on: `<prefix><image>:<tag>`
// with the orchestrator's own SCANTOR_IMAGE_PREFIX/SCANTOR_IMAGE_TAG pair, which it passes to every subprocess.

interface LanguageRow {
  title: string
  base: string
  image: string
  entry: string
  entryKind: 'source' | 'binary'
  extensions: string[]
}

const table = languagesTable as { languages: Record<string, LanguageRow> }

export function languageRow(language: string): LanguageRow | null {
  return Object.hasOwn(table.languages, language) ? table.languages[language]! : null
}

export function isKnownLanguage(language: string): boolean {
  return languageRow(language) !== null
}

export function baseImageRef(config: Pick<Config, 'imagePrefix' | 'imageTag'>, image: string): string {
  return `${config.imagePrefix}${image}:${config.imageTag}`
}

export function listLanguages(config: Pick<Config, 'imagePrefix' | 'imageTag'>): Language[] {
  return Object.entries(table.languages).map(([language, row]) => ({
    language,
    title: row.title,
    base: row.base,
    baseImage: baseImageRef(config, row.image),
    entry: row.entry,
    extensions: [...row.extensions],
  }))
}

/**
 * Scaffolds: every language has an entry per template of schemas/templates plus `custom` (a unit test of the
 * binary asserts the embedded scaffolds are complete, docs/tasks.md §12.1).
 */
export async function listScaffolds(): Promise<Scaffold[]> {
  const templates = [...(await templateNames()), CUSTOM_TEMPLATE]
  return Object.keys(table.languages).map((language) => ({ language, templates: [...templates] }))
}
