// Mapping helpers for API representations (docs/api.md §1.6): ISO 8601 UTC timestamps with milliseconds.

export function isoDate(date: Date): string {
  return date.toISOString()
}

export function isoDateOrNull(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null
}
