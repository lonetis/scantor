import { apiError } from '../../utils/errors'

/*
 * Secret references in user queries (security.md Q-6, SEC-2). Aggregation output cannot be masked, so a pipeline
 * that references a `writeOnly` path of the scan is rejected (400 queryRejected). The same check guards query
 * filters, sorts and projection expressions, so that neither a renamed field nor a filter oracle can reveal a
 * secret; plain projections keep their paths and are masked afterwards.
 *
 * A reference overlaps a secret when one is a prefix of the other: `$config` (the whole config) reveals
 * `config.apiKey`, and so does `config.apiKey.0`. A `*` in a secret path matches one segment or none (MongoDB
 * traverses arrays implicitly, so `config.items.token` reaches `config.items.*.token`).
 *
 * As defence in depth, aggregations also drop every secret path right after the scope `$match`
 * (secretUnsetPaths), so stages that pass documents through unchanged (`$facet`, `$sample`, …) cannot leak them.
 */

/**
 * Operators that address fields by literal name instead of a `$path` string; refused when a scan has secrets.
 * `$jsonSchema` belongs here as a whole: `patternProperties`, `additionalProperties`, `items` and similar keywords
 * constrain a field without naming it, so its schema cannot be reduced to the paths it tests.
 */
const FIELD_NAME_OPERATORS = new Set(['$getField', '$setField', '$unsetField', '$jsonSchema'])
const ROOT_VARIABLES = ['$$ROOT', '$$CURRENT']

function overlaps(reference: readonly string[], i: number, secret: readonly string[], j: number): boolean {
  if (i >= reference.length || j >= secret.length) return true
  if (secret[j] === '*') return overlaps(reference, i + 1, secret, j + 1) || overlaps(reference, i, secret, j + 1)
  return reference[i] === secret[j] && overlaps(reference, i + 1, secret, j + 1)
}

/** True when the dot path `reference` (as segments) addresses, contains or lies inside a secret path. */
export function referencesSecret(reference: readonly string[], secrets: readonly (readonly string[])[]): boolean {
  return secrets.some((secret) => overlaps(reference, 0, secret, 0))
}

/** The document path a `$`-string addresses, or null when the string is not a field reference. */
export function fieldReference(value: string): string[] | null {
  if (value.startsWith('$$')) {
    for (const root of ROOT_VARIABLES) {
      if (value === root) return []
      if (value.startsWith(`${root}.`)) return value.slice(root.length + 1).split('.')
    }
    return null
  }
  if (value.startsWith('$') && value.length > 1) return value.slice(1).split('.')
  return null
}

export interface SecretScanOptions {
  /** Treat object keys that are not operators as field paths (filters, sorts, pipelines; not find projections). */
  keysAreReferences: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The input path of the first element that references a secret, or null. `keyPath` accumulates the non-operator
 * keys on the way down, so `{config: {apiKey: 1}}` and `{"config.apiKey": 1}` both address `config.apiKey`.
 */
export function findSecretReference(
  value: unknown,
  secrets: readonly (readonly string[])[],
  options: SecretScanOptions,
  path: string,
  keyPath: readonly string[] = [],
): string | null {
  if (secrets.length === 0) return null
  if (typeof value === 'string') {
    const reference = fieldReference(value)
    return reference && referencesSecret(reference, secrets) ? path : null
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findSecretReference(item, secrets, options, `${path}.${index}`, keyPath)
      if (found) return found
    }
    return null
  }
  if (!isPlainObject(value)) return null
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`
    if (FIELD_NAME_OPERATORS.has(key)) return childPath
    let childKeyPath = keyPath
    if (!key.startsWith('$')) {
      childKeyPath = [...keyPath, ...key.split('.')]
      if (options.keysAreReferences && referencesSecret(childKeyPath, secrets)) return childPath
    }
    const found = findSecretReference(child, secrets, options, childPath, childKeyPath)
    if (found) return found
  }
  return null
}

/** Throws 400 queryRejected when `value` references a secret path of the scan. */
export function assertNoSecretReference(
  value: unknown,
  secrets: readonly (readonly string[])[],
  options: SecretScanOptions,
  path: string,
): void {
  const found = findSecretReference(value, secrets, options, path)
  if (found) {
    throw apiError('queryRejected', 'the query references a secret (writeOnly) field of this scan, whose values cannot be returned', {
      path: found,
    })
  }
}

/**
 * Dot paths to `$unset` before user stages: each secret path up to its first `*` (a wildcard cannot be expressed in
 * `$unset`, so its whole parent goes), without paths that lie inside another listed path.
 */
export function secretUnsetPaths(secrets: readonly (readonly string[])[]): string[] {
  const candidates = secrets.map((segments) => {
    const star = segments.indexOf('*')
    return (star === -1 ? segments : segments.slice(0, star)).join('.')
  })
  const unique = [...new Set(candidates)].filter((candidate) => candidate.length > 0)
  return unique.filter((candidate) => !unique.some((other) => other !== candidate && candidate.startsWith(`${other}.`)))
}
