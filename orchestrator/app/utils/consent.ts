// Access levels of the OAuth consent page (docs/mcp.md §3.3, docs/ui.md §5.3).

export type AccessLevel = 'read' | 'write' | 'admin'

export interface AccessLevelOption {
  value: AccessLevel
  label: string
  description: string
  scopes: readonly string[]
}

export const ACCESS_LEVELS: readonly AccessLevelOption[] = [
  {
    value: 'read',
    label: 'Read only',
    description: 'Read tasks, scans and results.',
    scopes: ['scantor:read'],
  },
  {
    value: 'write',
    label: 'Read and write',
    description: 'Also create and change tasks, and start and control scans.',
    scopes: ['scantor:read', 'scantor:write'],
  },
  {
    value: 'admin',
    label: 'Admin',
    description: 'Also manage nodes.',
    scopes: ['scantor:read', 'scantor:write', 'scantor:admin'],
  },
]

export function parseScopes(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return [...new Set(value.split(/\s+/).filter(Boolean))]
}

/** Levels shown to the user: Admin only for admins. A level is enabled when the client requested all of its scopes. */
export function consentLevels(requested: readonly string[], isAdmin: boolean): (AccessLevelOption & { disabled: boolean })[] {
  const requestedSet = new Set(requested)
  return ACCESS_LEVELS
    .filter((level) => level.value !== 'admin' || isAdmin)
    .map((level) => ({ ...level, disabled: !level.scopes.every((scope) => requestedSet.has(scope)) }))
}

/** "Read and write" when possible, else the highest enabled non-admin level; never Admin. */
export function defaultConsentLevel(levels: readonly (AccessLevelOption & { disabled: boolean })[]): AccessLevel | null {
  const preferred = levels.find((level) => level.value === 'write' && !level.disabled)
  if (preferred) return preferred.value
  return levels.find((level) => level.value === 'read' && !level.disabled)?.value ?? null
}

/** The `scope` sent on approval: every requested non-scantor scope plus the chosen level's scopes. */
export function approvedScope(requested: readonly string[], level: AccessLevel): string {
  const option = ACCESS_LEVELS.find((candidate) => candidate.value === level)
  const others = requested.filter((scope) => !scope.startsWith('scantor:'))
  return [...others, ...(option?.scopes ?? [])].join(' ')
}
