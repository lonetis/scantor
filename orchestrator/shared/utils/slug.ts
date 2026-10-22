// Name rules shared by server, UI and tests (docs/data-model.md §4.1, §4.8, docs/api.md §1.4).

/** Task names, node names and pools: lowercase slug of 1–64 characters. */
export const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/
export const SLUG_MAX_LENGTH = 64

/** Static route segments under /api/tasks; they can never be task names. */
export const RESERVED_TASK_NAMES = ['upload', 'import-git', 'new', 'latest'] as const

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Node label keys (≤ 32 labels per node, values ≤ 63 characters). */
export const NODE_LABEL_KEY_PATTERN = /^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$/
export const NODE_LABEL_VALUE_MAX_LENGTH = 63
export const NODE_LABELS_MAX = 32

export function isSlug(value: string): boolean {
  return SLUG_PATTERN.test(value)
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

/** A valid task name is a slug that is neither a reserved route segment nor shaped like a uuid. */
export function isValidTaskName(value: string): boolean {
  return isSlug(value) && !isUuid(value) && !(RESERVED_TASK_NAMES as readonly string[]).includes(value)
}

/** The reason a task name is invalid, or null when it is valid. */
export function taskNameProblem(value: string): string | null {
  if (!isSlug(value)) {
    return 'must be 1–64 lowercase letters, digits or hyphens, starting and ending with a letter or digit'
  }
  if (isUuid(value)) return 'must not look like a uuid'
  if ((RESERVED_TASK_NAMES as readonly string[]).includes(value)) return `"${value}" is reserved`
  return null
}
