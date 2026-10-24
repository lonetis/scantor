import { stripEscapes } from './ansi'

// Display formatting (docs/ui.md §10). Pure functions; the locale is fixed so output is stable.

const LOCALE = 'en-US'
const countFormat = new Intl.NumberFormat(LOCALE)

type DateInput = string | number | Date

function toMs(value: DateInput): number {
  return value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)
}

/** "just now", "3 min ago", "2 h ago", "4 days ago", "in 3 min"; older than 30 days: the date. */
export function formatRelativeTime(value: DateInput | null | undefined, now: number = Date.now()): string {
  if (value === null || value === undefined) return '–'
  const at = toMs(value)
  if (Number.isNaN(at)) return '–'
  const diffSeconds = Math.round((now - at) / 1000)
  const future = diffSeconds < 0
  const seconds = Math.abs(diffSeconds)
  let text: string
  if (seconds < 45) return 'just now'
  if (seconds < 3600) text = `${Math.max(1, Math.round(seconds / 60))} min`
  else if (seconds < 86_400) text = `${Math.round(seconds / 3600)} h`
  else if (seconds < 30 * 86_400) {
    const days = Math.round(seconds / 86_400)
    text = `${days} ${days === 1 ? 'day' : 'days'}`
  } else return new Date(at).toISOString().slice(0, 10)
  return future ? `in ${text}` : `${text} ago`
}

/** Absolute ISO 8601 UTC time with milliseconds (tooltips). */
export function formatAbsoluteTime(value: DateInput | null | undefined): string {
  if (value === null || value === undefined) return ''
  const at = toMs(value)
  return Number.isNaN(at) ? '' : new Date(at).toISOString()
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** "850 ms", "4.2s", "23s", "1m 03s", "1h 02m", "2d 03h". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–'
  const value = Math.max(0, ms)
  if (value < 1000) return `${Math.round(value)} ms`
  const totalSeconds = value / 1000
  if (totalSeconds < 10) return `${(Math.floor(totalSeconds * 10) / 10).toFixed(1)}s`
  if (totalSeconds < 60) return `${Math.floor(totalSeconds)}s`
  const seconds = Math.floor(totalSeconds)
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad2(seconds % 60)}s`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${pad2(Math.floor((seconds % 3600) / 60))}m`
  return `${Math.floor(seconds / 86_400)}d ${pad2(Math.floor((seconds % 86_400) / 3600))}h`
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const

/** Binary units: "0 B", "512 B", "14 KiB", "1.5 GiB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '–'
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  if (unit === 0) return `${Math.round(value)} B`
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value)
  return `${rounded} ${BYTE_UNITS[unit]}`
}

/** "100,000". */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–'
  return countFormat.format(value)
}

/** "39.9 %". */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–'
  return `${(Math.round(value * 10) / 10).toFixed(1)} %`
}

/** "8,100 / min". */
export function formatRate(perMinute: number | null | undefined): string {
  if (perMinute === null || perMinute === undefined || !Number.isFinite(perMinute)) return '–'
  return `${formatCount(Math.round(perMinute))} / min`
}

/** "≈ 7 min", "≈ 2h 05m"; empty when unknown. */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 60) return '≈ 1 min'
  if (seconds < 3600) return `≈ ${Math.round(seconds / 60)} min`
  return `≈ ${formatDuration(seconds * 1000)}`
}

/** Ids and hashes are shown shortened to 8 characters (the full value is copyable). */
export function shortId(id: string | null | undefined, length = 8): string {
  if (!id) return ''
  const value = id.startsWith('sha256:') ? id.slice('sha256:'.length) : id
  return value.slice(0, length)
}

/** "1 analysis" / "3 analyses". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`
}

export interface TextPart {
  text: string
  code: boolean
}

/** Splits text at Markdown code spans (`code`); an unpaired backtick stays plain text. */
export function splitCodeSpans(text: string): TextPart[] {
  const parts: TextPart[] = []
  let rest = text
  for (;;) {
    const open = rest.indexOf('`')
    const close = open === -1 ? -1 : rest.indexOf('`', open + 1)
    if (close === -1) break
    if (open > 0) parts.push({ text: rest.slice(0, open), code: false })
    if (close > open + 1) parts.push({ text: rest.slice(open + 1, close), code: true })
    rest = rest.slice(close + 1)
  }
  if (rest) parts.push({ text: rest, code: false })
  return parts
}

/**
 * A short text of a value for a table cell (FEATURES UI-RES-004): strings without escape sequences, other values as
 * compact JSON, both cut at `maxLength` characters.
 */
export function valuePreview(value: unknown, maxLength = 200): string {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'string' ? stripEscapes(value) : JSON.stringify(value)
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}
