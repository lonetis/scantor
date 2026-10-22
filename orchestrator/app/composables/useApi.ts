import type { ApiClient, ApiRequestOptions } from '~/plugins/api'

export type { ApiClient, ApiRequestOptions }

/** The central fetch wrapper (`$api`, docs/ui.md §8). Call it during setup and keep the reference. */
export function useApi(): ApiClient {
  return useNuxtApp().$api as ApiClient
}

/** Builds a query string record, dropping empty values; lists become comma-separated (docs/api.md §1.5). */
export function apiQuery(params: Record<string, string | number | boolean | readonly string[] | null | undefined>): Record<string, string> {
  const query: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue
    if (Array.isArray(value)) {
      if (value.length > 0) query[key] = value.join(',')
      continue
    }
    query[key] = String(value)
  }
  return query
}
