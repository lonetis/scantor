// Parsers for the environment value syntax of docs/architecture.md §10, identical to Go internal/envconf:
// booleans `true`/`false`; comma-separated lists (trimmed, empty entries dropped); Go durations; byte sizes with an
// optional binary suffix. Every parser throws on invalid input; the config loader decides whether that aborts.

const DURATION_UNITS_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  'µs': 1e-3, // U+00B5 micro sign
  'μs': 1e-3, // U+03BC Greek mu
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
}

const DURATION_PART = /^(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/

/** Parses a non-negative Go duration (`500ms`, `1h30m`, `1.5h`, `0`) into milliseconds. */
export function parseDuration(value: string): number {
  const input = value.trim()
  if (input === '0') return 0
  if (input === '') throw new Error('empty duration')
  let rest = input
  let total = 0
  while (rest.length > 0) {
    const match = DURATION_PART.exec(rest)
    if (!match) throw new Error(`invalid duration "${value}" (examples: 500ms, 30s, 15m, 24h)`)
    total += Number(match[1]) * DURATION_UNITS_MS[match[2]!]!
    rest = rest.slice(match[0].length)
  }
  if (!Number.isFinite(total)) throw new Error(`duration "${value}" is out of range`)
  return total
}

const BYTE_UNITS: Record<string, number> = {
  '': 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
}

/** Parses a byte size: a non-negative integer with an optional `KiB`, `MiB`, `GiB` or `TiB` suffix. */
export function parseByteSize(value: string): number {
  const match = /^(\d{1,15})(KiB|MiB|GiB|TiB)?$/.exec(value.trim())
  if (!match) throw new Error(`invalid byte size "${value}" (examples: 512MiB, 10GiB, 1048576)`)
  const bytes = Number(match[1]) * BYTE_UNITS[match[2] ?? '']!
  if (!Number.isSafeInteger(bytes)) throw new Error(`byte size "${value}" is out of range`)
  return bytes
}

/** Parses a boolean: exactly `true` or `false`. */
export function parseBoolean(value: string): boolean {
  const input = value.trim()
  if (input === 'true') return true
  if (input === 'false') return false
  throw new Error(`invalid boolean "${value}" (use true or false)`)
}

/** Parses a comma-separated list; whitespace is trimmed and empty entries are dropped. */
export function parseList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/** Parses a decimal integer. */
export function parseInteger(value: string): number {
  const input = value.trim()
  if (!/^-?\d{1,15}$/.test(input)) throw new Error(`invalid integer "${value}"`)
  return Number(input)
}
