// The template catalog (docs/api.md §4.12, docs/ui.md §5.14): listed once per page load and shared; estimates are
// side-effect free and return inline errors (configInvalid issues) instead of toasts.

const templates = shallowRef<Template[] | null>(null)
let request: Promise<Template[]> | null = null

export function useTemplates() {
  const api = useApi()
  const error = shallowRef<ApiError | null>(null)
  const loading = ref(templates.value === null)

  async function load(options: { force?: boolean } = {}): Promise<Template[]> {
    if (templates.value && !options.force) return templates.value
    if (options.force) request = null
    loading.value = true
    request ??= api<ItemList<Template>>('/api/templates', { toast: false }).then(
      (result) => {
        templates.value = result.items
        return result.items
      },
      (cause: unknown) => {
        request = null
        throw cause
      },
    )
    try {
      const items = await request
      error.value = null
      return items
    } catch (cause) {
      error.value = toApiError(cause)
      throw error.value
    } finally {
      loading.value = false
    }
  }

  load().catch(() => undefined)

  async function estimate(template: string, scanConfig: Record<string, unknown>): Promise<TemplateEstimate> {
    return api<TemplateEstimate>(`/api/templates/${encodeURIComponent(template)}/estimate`, { method: 'POST', body: { scanConfig }, toast: false })
  }

  return { templates, loading, error, load, estimate }
}
