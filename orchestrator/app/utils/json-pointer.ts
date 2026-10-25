// JSON Pointer (RFC 6901) and dot-path helpers. The API reports config issues as JSON pointers into
// the request body (`/taskConfig/headers/0`); forms name their fields with dot paths (`taskConfig.headers.0`).

export type PathSegment = string | number

export interface PointerIssue {
  path: string
  message: string
}

export interface FieldError {
  name: string
  message: string
}

function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1')
}

/** `""` → `[]`, `"/a/0/b~1c"` → `["a", "0", "b/c"]`. Throws on a pointer that does not start with `/`. */
export function parsePointer(pointer: string): string[] {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) throw new Error(`invalid JSON pointer: ${pointer}`)
  return pointer.slice(1).split('/').map(unescapeToken)
}

export function formatPointer(segments: readonly PathSegment[]): string {
  return segments.map((segment) => `/${escapeToken(String(segment))}`).join('')
}

export function segmentsToDotPath(segments: readonly PathSegment[]): string {
  return segments.map(String).join('.')
}

export function dotPathToSegments(path: string): string[] {
  return path === '' ? [] : path.split('.')
}

/** `/headers/0` → `headers.0`; with a prefix `taskConfig` → `taskConfig.headers.0`. */
export function pointerToDotPath(pointer: string, prefix?: string): string {
  const path = segmentsToDotPath(parsePointer(pointer))
  if (!prefix) return path
  return path ? `${prefix}.${path}` : prefix
}

/** Ancestors of a dot path from the closest to the root: `a.b.c` → `a.b.c`, `a.b`, `a`. */
export function dotPathAncestors(path: string): string[] {
  const segments = dotPathToSegments(path)
  const result: string[] = []
  for (let length = segments.length; length > 0; length--) result.push(segments.slice(0, length).join('.'))
  return result
}

/**
 * Maps server issues (pointers into the whole request body) onto the fields of one form named `formName`
 * (`/taskConfig/...` for `taskConfig`). Field names are relative to that form. An issue lands on the exact
 * field, else on the nearest rendered ancestor, else becomes a form-level message (docs/ui.md §6.4).
 */
export function mapIssuesToFields(
  issues: readonly PointerIssue[],
  formName: string | undefined,
  renderedPaths: ReadonlySet<string>,
): { fieldErrors: FieldError[], formErrors: string[] } {
  const fieldErrors: FieldError[] = []
  const formErrors: string[] = []
  const prefix = formName ? dotPathToSegments(formName) : []
  for (const issue of issues) {
    let segments: string[]
    try {
      segments = parsePointer(issue.path)
    } catch {
      continue
    }
    if (prefix.some((segment, index) => segments[index] !== segment)) continue
    const relative = segmentsToDotPath(segments.slice(prefix.length))
    const target = dotPathAncestors(relative).find((candidate) => renderedPaths.has(candidate))
    if (target === undefined) formErrors.push(relative ? `${relative}: ${issue.message}` : issue.message)
    else fieldErrors.push({ name: target, message: issue.message })
  }
  return { fieldErrors, formErrors }
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null
}

/** Immutable set; missing containers are created (arrays for numeric segments). */
export function setIn<T>(value: T, segments: readonly PathSegment[], next: unknown): T {
  if (segments.length === 0) return next as T
  const [head, ...rest] = segments as [PathSegment, ...PathSegment[]]
  const container: Record<string, unknown> | unknown[] = Array.isArray(value)
    ? [...value]
    : isContainer(value)
      ? { ...(value as Record<string, unknown>) }
      : typeof head === 'number'
        ? []
        : {}
  const key = String(head)
  const child = (container as Record<string, unknown>)[key]
  ;(container as Record<string, unknown>)[key] = setIn(child, rest, next)
  return container as T
}

/** Immutable removal of an object key or an array element; a missing path is a no-op. */
export function removeIn<T>(value: T, segments: readonly PathSegment[]): T {
  if (segments.length === 0 || !isContainer(value)) return value
  const [head, ...rest] = segments as [PathSegment, ...PathSegment[]]
  const key = String(head)
  if (Array.isArray(value)) {
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || index >= value.length) return value
    const copy: unknown[] = [...value]
    if (rest.length === 0) copy.splice(index, 1)
    else copy[index] = removeIn(copy[index], rest)
    return copy as T
  }
  const record = value as Record<string, unknown>
  if (!Object.hasOwn(record, key)) return value
  const { [key]: child, ...others } = record
  return (rest.length === 0 ? others : { ...others, [key]: removeIn(child, rest) }) as T
}
