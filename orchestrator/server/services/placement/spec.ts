import { createHash } from 'node:crypto'

// Worker spec hash (docs/nodes.md §12.1): `sha256:` + hex(SHA-256 of the canonical JSON {image, privileged,
// dindMode, capAdd}). It is computed once at placement and sent in assignments; the node daemon recreates a
// container whose hash changed, and applies process/resource changes live. `image` is the profile-independent
// reference `<repository>@<digest>` (the registry host differs per endpoint profile).

/** JSON with object keys sorted recursively (enough for the plain data hashed here). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export interface SpecHashInput {
  repository: string
  digest: string
  privileged: boolean
  dindMode: 'sysbox' | 'privileged' | null
  capAdd: readonly string[]
}

export function specHash(input: SpecHashInput): string {
  const json = canonicalJson({
    image: `${input.repository}@${input.digest}`,
    privileged: input.privileged,
    dindMode: input.dindMode,
    capAdd: [...input.capAdd].sort(),
  })
  return `sha256:${createHash('sha256').update(json, 'utf8').digest('hex')}`
}
