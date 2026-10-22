import type { SecretPathsDoc } from '../../types/documents'
import { maskSecrets, parsePointer } from '../../utils/secrets'

// Secret paths of analysis documents (security.md SEC-2): `secretPaths.analysisConfig` points into an analysis'
// `config`, `secretPaths.result` into its `result`. Both are JSON pointers relative to their value and may contain
// `*` (any array index or property name). This module turns them into document-level patterns.

export type AnalysisSecretPaths = Pick<SecretPathsDoc, 'analysisConfig' | 'result'>

/** JSON-pointer patterns relative to an analysis document (or representation): `/config/apiKey`, `/result/token`. */
export function analysisMaskPatterns(secretPaths: AnalysisSecretPaths | null | undefined): string[] {
  if (!secretPaths) return []
  return [
    ...secretPaths.analysisConfig.map((pointer) => `/config${pointer}`),
    ...secretPaths.result.map((pointer) => `/result${pointer}`),
  ]
}

/**
 * Document-level secret paths as segment lists (`['config', 'apiKey']`, `['result', 'items', '*', 'token']`).
 * A pointer segment containing a dot is split, because MongoDB dot paths cannot address such keys separately.
 */
export function analysisSecretSegments(secretPaths: AnalysisSecretPaths | null | undefined): string[][] {
  return analysisMaskPatterns(secretPaths).map((pattern) => parsePointer(pattern).flatMap((segment) => segment.split('.')))
}

/** Masks the secret values of an analysis document or representation (a deep copy when anything is masked). */
export function maskAnalysis<T>(value: T, patterns: readonly string[]): T {
  return patterns.length === 0 ? value : maskSecrets(value, patterns)
}
