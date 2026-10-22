// Registry token scopes (CNCF distribution token auth, docs/api.md §6): `<type>:<name>:<actions>`, for example
// `repository:tasks/<taskId>:pull,push` or `registry:catalog:*`. The GET flow repeats `scope`; the POST (OAuth2
// password grant) flow separates scopes with spaces. A granted token holds the intersection of requested and
// allowed actions; a scope that is not allowed is simply omitted (the registry then answers insufficient_scope).

export interface RegistryAccess {
  type: string
  name: string
  actions: string[]
}

/** The allowed actions of a principal for one resource (empty = nothing). */
export type AllowedActions = (type: string, name: string) => readonly string[]

const MAX_SCOPES = 32
const SCOPE_TYPE = /^[a-z0-9]+(\([a-z0-9]+\))?$/
// Repository names of distribution (lowercase path components) and the `catalog` resource of type `registry`.
const RESOURCE_NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/
const ACTION = /^([a-z]+|\*)$/

/** Parses one scope string; null when malformed (malformed scopes are ignored like disallowed ones). */
export function parseScope(scope: string): RegistryAccess | null {
  const first = scope.indexOf(':')
  const last = scope.lastIndexOf(':')
  if (first <= 0 || last <= first) return null
  const type = scope.slice(0, first)
  const name = scope.slice(first + 1, last)
  const actions = scope
    .slice(last + 1)
    .split(',')
    .map((action) => action.trim())
    .filter((action) => action.length > 0)
  if (!SCOPE_TYPE.test(type) || !RESOURCE_NAME.test(name) || actions.length === 0 || !actions.every((action) => ACTION.test(action))) return null
  return { type, name, actions: [...new Set(actions)] }
}

/** Parses the requested scopes of a token request (repeated values, each possibly space-separated). */
export function parseScopes(values: readonly string[]): RegistryAccess[] {
  const scopes: RegistryAccess[] = []
  for (const value of values) {
    for (const part of value.split(' ')) {
      const trimmed = part.trim()
      if (!trimmed) continue
      const parsed = parseScope(trimmed)
      if (parsed) scopes.push(parsed)
      if (scopes.length >= MAX_SCOPES) return scopes
    }
  }
  return scopes
}

/** The granted access: requested ∩ allowed, merged per resource, empty grants dropped. */
export function grantAccess(requested: readonly RegistryAccess[], allowed: AllowedActions): RegistryAccess[] {
  const granted = new Map<string, RegistryAccess>()
  for (const scope of requested) {
    const permitted = allowed(scope.type, scope.name)
    const actions = scope.actions.filter((action) => permitted.includes(action) || (permitted.includes('*') && action === '*'))
    if (actions.length === 0) continue
    const key = `${scope.type}\u0000${scope.name}`
    const existing = granted.get(key)
    if (existing) existing.actions = [...new Set([...existing.actions, ...actions])]
    else granted.set(key, { type: scope.type, name: scope.name, actions })
  }
  return [...granted.values()]
}

const TASK_REPOSITORY = /^tasks\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/

/**
 * The orchestrator credential: `pull`, `push` and `delete` on `tasks/*` and the catalog (docs/auth.md §10.4).
 */
export function orchestratorAllowed(type: string, name: string): readonly string[] {
  if (type === 'repository' && TASK_REPOSITORY.test(name)) return ['pull', 'push', 'delete']
  if (type === 'registry' && name === 'catalog') return ['*']
  return []
}

/** A node: `pull` on the task repositories of its current assignments, nothing else. */
export function nodeAllowed(repositories: ReadonlySet<string>): AllowedActions {
  return (type, name) => (type === 'repository' && repositories.has(name) ? ['pull'] : [])
}
