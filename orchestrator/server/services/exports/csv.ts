// CSV export rows (docs/api.md §4.15, security.md DL-2): one header row with the column names, then one row per
// analysis. Nested values are JSON-encoded; any cell that starts with `=`, `+`, `-`, `@`, tab or CR is prefixed
// with `'` so spreadsheet programs never evaluate it as a formula; cells are quoted per RFC 4180 and rows end
// with CRLF.

const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r'])

/** The text of one cell before escaping: strings as-is, nested values as JSON, null/undefined empty. */
export function csvCellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (value instanceof Date) return value.toISOString()
  return JSON.stringify(value)
}

/** Neutralises spreadsheet formulas, then quotes the cell when it contains a separator, quote or line break. */
export function escapeCsvCell(text: string): string {
  const safe = text.length > 0 && FORMULA_TRIGGERS.has(text[0]!) ? `'${text}` : text
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

/** One CSV line (with CRLF) of `values`. */
export function csvRow(values: readonly unknown[]): string {
  return `${values.map((value) => escapeCsvCell(csvCellText(value))).join(',')}\r\n`
}
