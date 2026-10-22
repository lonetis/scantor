// Catalog representations: languages, templates, scaffolds (docs/api.md §4.12).

export interface Language {
  language: string
  title: string
  base: string
  baseImage: string
  entry: string
  extensions: string[]
}

export interface Template {
  name: string
  title: string
  description: string
  scanConfigSchema: Record<string, unknown>
  analysisConfigSchema: Record<string, unknown>
  example: { scanConfig: Record<string, unknown>; analysisConfig: Record<string, unknown> }
  resolves: boolean
}

export interface TemplateEstimate {
  expectedTotal: number | null
  exact: boolean
  confirmationRequired: boolean
  tooLarge: boolean
}

export interface Scaffold {
  language: string
  templates: string[]
}
