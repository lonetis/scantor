import { describe, expect, it } from 'vitest'
import { grantAccess, nodeAllowed, orchestratorAllowed, parseScope, parseScopes } from '../../../server/services/registry/scopes'

// Registry token scopes (docs/api.md §6, docs/auth.md §10.4, security.md MC-5): the grant is the intersection of the
// requested and the allowed actions; disallowed or malformed scopes are omitted, never an error.

const TASK_A = 'tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c'
const TASK_B = 'tasks/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

describe('parseScope', () => {
  it('parses repository and registry scopes', () => {
    expect(parseScope(`repository:${TASK_A}:pull`)).toEqual({ type: 'repository', name: TASK_A, actions: ['pull'] })
    expect(parseScope(`repository:${TASK_A}:pull,push`)).toEqual({ type: 'repository', name: TASK_A, actions: ['pull', 'push'] })
    expect(parseScope('registry:catalog:*')).toEqual({ type: 'registry', name: 'catalog', actions: ['*'] })
    expect(parseScope('repository(plugin):tasks/x:pull')).toEqual({ type: 'repository(plugin)', name: 'tasks/x', actions: ['pull'] })
  })

  it('deduplicates actions', () => {
    expect(parseScope(`repository:${TASK_A}:pull,pull`)?.actions).toEqual(['pull'])
  })

  it('rejects malformed scopes', () => {
    for (const scope of ['', 'repository', 'repository:tasks/x', `repository:${TASK_A}:`, 'repository:Tasks/X:pull', 'repository:tasks/../x:pull', ':x:pull', 'repository:tasks/x:pull;rm']) {
      expect(parseScope(scope), scope).toBeNull()
    }
  })

  it('splits space-separated and repeated scopes and ignores malformed ones', () => {
    expect(parseScopes([`repository:${TASK_A}:pull repository:${TASK_B}:pull`, 'bogus', 'registry:catalog:*'])).toEqual([
      { type: 'repository', name: TASK_A, actions: ['pull'] },
      { type: 'repository', name: TASK_B, actions: ['pull'] },
      { type: 'registry', name: 'catalog', actions: ['*'] },
    ])
  })

  it('caps the number of scopes', () => {
    const many = Array.from({ length: 100 }, (_, index) => `repository:tasks/t${index}:pull`)
    expect(parseScopes(many)).toHaveLength(32)
  })
})

describe('grants', () => {
  it('gives the orchestrator credential pull, push and delete on tasks/* and the catalog only', () => {
    const requested = parseScopes([`repository:${TASK_A}:pull,push,delete`, 'repository:library/alpine:pull', 'registry:catalog:*', 'repository:tasks/x:*'])
    expect(grantAccess(requested, orchestratorAllowed)).toEqual([
      { type: 'repository', name: TASK_A, actions: ['pull', 'push', 'delete'] },
      { type: 'registry', name: 'catalog', actions: ['*'] },
    ])
  })

  it('gives a node pull on the repositories of its assignments only', () => {
    const allowed = nodeAllowed(new Set([TASK_A]))
    const requested = parseScopes([`repository:${TASK_A}:pull,push`, `repository:${TASK_B}:pull`, 'registry:catalog:*'])
    expect(grantAccess(requested, allowed)).toEqual([{ type: 'repository', name: TASK_A, actions: ['pull'] }])
  })

  it('merges repeated scopes of one resource', () => {
    const requested = parseScopes([`repository:${TASK_A}:pull`, `repository:${TASK_A}:push`])
    expect(grantAccess(requested, orchestratorAllowed)).toEqual([{ type: 'repository', name: TASK_A, actions: ['pull', 'push'] }])
  })

  it('grants nothing without scopes (docker login)', () => {
    expect(grantAccess([], orchestratorAllowed)).toEqual([])
  })
})
