import { describe, expect, it } from 'vitest'
import { listScansQuery, SCAN_NAME_QUERY_MAX_LENGTH } from '#shared/schemas/scans'
import { listScansFilter } from '../../../server/services/scans/queries'

// `listScans?q` (docs/api.md §4.13): a case-insensitive substring of the scan name for the scan picker of the script run
// form. The value is regex-escaped, so it never acts as a pattern, and is at most 64 characters.

type UserPrincipal = import('../../../server/utils/principal').UserPrincipal

const USER_ID = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const alice = { kind: 'user', via: 'session', user: { id: USER_ID }, isAdmin: false } as unknown as UserPrincipal

function nameClause(q: string): { $regex: string; $options: string } {
  const filter = listScansFilter(alice, listScansQuery.parse({ q })) as { $and: Record<string, unknown>[] }
  const clause = filter.$and.find((entry) => 'name' in entry) as { name: { $regex: string; $options: string } }
  return clause.name
}

describe('listScans q', () => {
  it('matches a case-insensitive substring of the name with every regex character escaped', () => {
    const clause = nameClause('top-1k (v2.*)')
    expect(clause).toEqual({ $regex: 'top-1k \\(v2\\.\\*\\)', $options: 'i' })
    const pattern = new RegExp(clause.$regex, clause.$options)
    expect(pattern.test('Tranco TOP-1K (V2.*) rerun')).toBe(true)
    expect(pattern.test('top-1k (v22222)')).toBe(false)
  })

  it('escapes anchors, alternations and backslashes', () => {
    expect(nameClause('^a|b$\\')).toEqual({ $regex: '\\^a\\|b\\$\\\\', $options: 'i' })
  })

  it('keeps the other filters and adds no name clause without q', () => {
    const filter = listScansFilter(alice, listScansQuery.parse({ state: 'running' })) as { $and: Record<string, unknown>[] }
    expect(filter.$and).toEqual([{ userId: USER_ID }, { state: { $in: ['running'] } }])
  })

  it('trims q and refuses empty or longer than 64 characters', () => {
    expect(listScansQuery.parse({ q: '  csp  ' }).q).toBe('csp')
    expect(listScansQuery.safeParse({ q: '   ' }).success).toBe(false)
    expect(listScansQuery.safeParse({ q: 'x'.repeat(SCAN_NAME_QUERY_MAX_LENGTH) }).success).toBe(true)
    expect(listScansQuery.safeParse({ q: 'x'.repeat(SCAN_NAME_QUERY_MAX_LENGTH + 1) }).success).toBe(false)
  })
})
