import type { Template } from '#shared/types/catalog'
import { TEMPLATE_NAME_PATTERN } from '#shared/schemas/tasks'

// The template catalog (docs/templates.md §1, docs/api.md §4.12): one entry per schemas/templates/<name>.json
// (fixtures files skipped), read from the Nitro server assets (base name `schemas`). `GET /api/templates` maps a file
// to {name, title, description, scanConfigSchema, analysisConfigSchema, example, resolves}.

export interface TemplateFile {
  title?: string
  description?: string
  'x-scantor-template'?: {
    name?: string
    resolves?: boolean
    example?: { scanConfig?: Record<string, unknown>; analysisConfig?: Record<string, unknown> }
  }
  $defs?: { scanConfig?: Record<string, unknown>; analysisConfig?: Record<string, unknown> }
}

/** Loads the raw template files; replaced in tests. */
export type TemplateSource = () => Promise<TemplateFile[]>

// nitropack/runtime is imported lazily so unit tests (which replace the source) never load the Nitro runtime.
const storageSource: TemplateSource = async () => {
  const { useStorage } = await import('nitropack/runtime')
  const storage = useStorage('assets:schemas')
  const keys = (await storage.getKeys('templates')).filter((key) => key.endsWith('.json') && !key.endsWith('.fixtures.json'))
  const files: TemplateFile[] = []
  for (const key of keys.sort()) {
    const value = await storage.getItem(key)
    if (value === null || value === undefined) continue
    files.push((typeof value === 'string' ? JSON.parse(value) : value instanceof Uint8Array ? JSON.parse(Buffer.from(value).toString('utf8')) : value) as TemplateFile)
  }
  return files
}

let source: TemplateSource = storageSource
let cache: Promise<Template[]> | null = null

/** Test seam: replaces where template files come from (and clears the cache). */
export function setTemplateSourceForTesting(value: TemplateSource | null): void {
  source = value ?? storageSource
  cache = null
}

/** Maps one template file onto the API representation; files without a valid name are skipped. */
export function toTemplate(file: TemplateFile): Template | null {
  const meta = file['x-scantor-template']
  const name = meta?.name
  if (!name || !TEMPLATE_NAME_PATTERN.test(name)) return null
  return {
    name,
    title: file.title ?? name,
    description: file.description ?? '',
    scanConfigSchema: file.$defs?.scanConfig ?? { type: 'object', properties: {}, additionalProperties: false },
    analysisConfigSchema: file.$defs?.analysisConfig ?? { type: 'object', properties: {}, additionalProperties: false },
    example: { scanConfig: meta?.example?.scanConfig ?? {}, analysisConfig: meta?.example?.analysisConfig ?? {} },
    resolves: meta?.resolves === true,
  }
}

/** Every template, sorted by name (the files are immutable for the lifetime of the process). */
export function listTemplates(): Promise<Template[]> {
  cache ??= source()
    .then((files) =>
      files
        .map(toTemplate)
        .filter((template): template is Template => template !== null)
        .sort((a, b) => a.name.localeCompare(b.name)),
    )
    .catch((error: unknown) => {
      cache = null
      throw error
    })
  return cache
}

export async function findTemplate(name: string): Promise<Template | null> {
  return (await listTemplates()).find((template) => template.name === name) ?? null
}

export async function templateNames(): Promise<string[]> {
  return (await listTemplates()).map((template) => template.name)
}
