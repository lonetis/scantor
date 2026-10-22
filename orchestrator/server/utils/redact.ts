// Log redaction (security.md MC-10), the orchestrator counterpart of Go internal/redact. Applied by the logger to
// every message and string field, and by anything that echoes third-party text (git errors).

export const REDACTED = '***'

/** Headers whose values are never logged. */
export const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-scantor-internal-auth',
  'x-scantor-setup-token',
  'cookie',
  'set-cookie',
])

const TEXT_RULES: [RegExp, string][] = [
  // scantor token shapes
  [/\bsk_scantor_editor_[A-Za-z0-9]+/g, `sk_scantor_editor_${REDACTED}`],
  [/\bsk_scantor_(?!editor_)[A-Za-z0-9]+/g, `sk_scantor_${REDACTED}`],
  [/\bsnt_[A-Za-z0-9_-]+/g, `snt_${REDACTED}`],
  [/\bswt_[0-9a-fA-F-]+\.[A-Za-z0-9_-]+/g, `swt_${REDACTED}`],
  [/\bsst_[A-Za-z0-9_-]+/g, `sst_${REDACTED}`],
  [/\bspk_[A-Za-z0-9_-]+/g, `spk_${REDACTED}`],
  [/\bsic_[A-Za-z0-9_-]+/g, `sic_${REDACTED}`],
  [/\bsec_[A-Za-z0-9_-]+/g, `sec_${REDACTED}`],
  // credentials in URLs (amqp, amqps, mongodb, http basic)
  [/\b((?:amqps?|mongodb(?:\+srv)?|https?):\/\/[^:/\s@]+:)[^@\s/]+@/gi, `$1${REDACTED}@`],
  // presigned URL signatures
  [/(X-Amz-Signature=)[^&\s"']+/gi, `$1${REDACTED}`],
  // the setup link
  [/(\/setup\?(?:[^\s#"']*&)?token=)[^&\s#"']+/g, `$1${REDACTED}`],
  // Authorization header values, including git http.extraheader
  [/(authorization:\s*(?:basic|bearer)\s+)[A-Za-z0-9+/=._~-]+/gi, `$1${REDACTED}`],
  [/(extraheader\s*[=:]\s*)(?!authorization:)[^\s"']+/gi, `$1${REDACTED}`],
]

export function redactText(text: string): string {
  let result = text
  for (const [pattern, replacement] of TEXT_RULES) result = result.replace(pattern, replacement)
  return result
}

/** Copy of a header map with the values of sensitive headers replaced. */
export function redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
  const result: Record<string, string | string[] | undefined> = {}
  for (const [name, value] of Object.entries(headers)) {
    result[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? REDACTED : value
  }
  return result
}

/** Deep copy of a log value with every string redacted (cycles and depth are bounded). */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value)
  if (value === null || typeof value !== 'object') return value
  if (depth > 6) return '[depth limit]'
  if (value instanceof Date) return value
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, depth + 1))
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTED : redactValue(item, depth + 1)
  }
  return result
}
