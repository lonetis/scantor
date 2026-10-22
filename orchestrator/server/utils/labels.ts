import spec from '../../../schemas/managed-labels.json'

// Managed labels (docs/architecture.md §7, security.md LBL-1, LBL-5): every container and network scantor creates
// gets them from this one function, which reads the key set from schemas/managed-labels.json (shared with Go
// internal/container). They override image labels with the same key. Containers are recognised only by these
// labels AND their name prefix.

export type ManagedKind = keyof typeof spec.kinds
export type IdentityKey = keyof typeof spec.identityKeys

export const MANAGED_KINDS = Object.keys(spec.kinds) as ManagedKind[]
export const MANAGED_LABEL_KIND_KEY = spec.kindKey
export const FORBIDDEN_IMAGE_LABEL_PATTERN = new RegExp(spec.forbiddenImageLabelKeys.pattern, spec.forbiddenImageLabelKeys.caseInsensitive ? 'i' : '')

/** The labels of a scantor-created object of `kind`; identity values must belong to that kind. */
export function managedLabels(kind: ManagedKind, identity: Partial<Record<IdentityKey, string>> = {}): Record<string, string> {
  const allowed = new Set<string>(spec.kinds[kind].identity)
  const labels: Record<string, string> = { ...spec.fixed, [spec.kindKey]: kind }
  for (const [key, value] of Object.entries(identity)) {
    if (value === undefined) continue
    if (!allowed.has(key)) throw new Error(`label ${key} is not an identity label of kind ${kind}`)
    labels[key] = value
  }
  return labels
}

/** The container name prefix of a container kind (`scantor-h-`, `scantor-editor-`, …), or null for networks. */
export function managedNamePrefix(kind: ManagedKind): string | null {
  const definition = spec.kinds[kind] as { namePrefix?: string }
  return definition.namePrefix ?? null
}

/** True when a container carries the managed labels of `kind` and its name has that kind's prefix. */
export function isManagedContainer(kind: ManagedKind, name: string, labels: Record<string, string> | undefined): boolean {
  const prefix = managedNamePrefix(kind)
  if (!prefix || !labels) return false
  const bare = name.startsWith('/') ? name.slice(1) : name
  return bare.startsWith(prefix) && labels['scantor.managed'] === 'true' && labels[spec.kindKey] === kind
}

/** True when an image label key is forbidden (Dockerfile rule D9, post-build label check). */
export function isForbiddenImageLabelKey(key: string): boolean {
  return FORBIDDEN_IMAGE_LABEL_PATTERN.test(key) || (spec.forbiddenImageLabelKeys.forbidDollar && key.includes('$'))
}
