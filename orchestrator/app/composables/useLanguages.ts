// The language and scaffold catalog (docs/api.md §4.12, docs/ui.md §5.6): loaded once per page load and shared.

const languages = shallowRef<Language[] | null>(null)
const scaffolds = shallowRef<Scaffold[] | null>(null)
let languagesRequest: Promise<Language[]> | null = null
let scaffoldsRequest: Promise<Scaffold[]> | null = null

export function useLanguages() {
  const api = useApi()
  const error = shallowRef<ApiError | null>(null)

  async function load(): Promise<Language[]> {
    if (languages.value) return languages.value
    languagesRequest ??= api<ItemList<Language>>('/api/languages').then(
      (result) => {
        languages.value = result.items
        return result.items
      },
      (cause: unknown) => {
        languagesRequest = null
        throw cause
      },
    )
    return languagesRequest
  }

  async function loadScaffolds(): Promise<Scaffold[]> {
    if (scaffolds.value) return scaffolds.value
    scaffoldsRequest ??= api<ItemList<Scaffold>>('/api/scaffolds').then(
      (result) => {
        scaffolds.value = result.items
        return result.items
      },
      (cause: unknown) => {
        scaffoldsRequest = null
        throw cause
      },
    )
    return scaffoldsRequest
  }

  load().catch((cause: unknown) => {
    error.value = toApiError(cause)
  })

  /** Templates the scaffold of a language supports (including "custom"). */
  function scaffoldTemplates(language: string): string[] {
    return scaffolds.value?.find((scaffold) => scaffold.language === language)?.templates ?? []
  }

  return { languages, scaffolds, error, load, loadScaffolds, scaffoldTemplates }
}
