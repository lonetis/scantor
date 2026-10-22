import { describe, expect, it } from 'vitest'
import { approvedScope, consentLevels, defaultConsentLevel, parseScopes } from '../../app/utils/consent'

const ALL = ['openid', 'offline_access', 'scantor:read', 'scantor:write', 'scantor:admin']

describe('consent access levels (docs/mcp.md §3.3)', () => {
  it('parses requested scopes', () => {
    expect(parseScopes('openid  scantor:read scantor:read')).toEqual(['openid', 'scantor:read'])
    expect(parseScopes(undefined)).toEqual([])
  })

  it('offers Admin only to admins', () => {
    expect(consentLevels(ALL, false).map((level) => level.label)).toEqual(['Read only', 'Read and write'])
    expect(consentLevels(ALL, true).map((level) => level.label)).toEqual(['Read only', 'Read and write', 'Admin'])
  })

  it('disables levels whose scopes were not requested', () => {
    const levels = consentLevels(['scantor:read'], true)
    expect(levels.map((level) => [level.value, level.disabled])).toEqual([['read', false], ['write', true], ['admin', true]])
  })

  it('preselects Read and write, never Admin', () => {
    expect(defaultConsentLevel(consentLevels(ALL, true))).toBe('write')
    expect(defaultConsentLevel(consentLevels(['scantor:read'], true))).toBe('read')
    expect(defaultConsentLevel(consentLevels(['scantor:admin'], true))).toBeNull()
  })

  it('approves the requested non-scantor scopes plus the chosen level', () => {
    expect(approvedScope(ALL, 'read')).toBe('openid offline_access scantor:read')
    expect(approvedScope(ALL, 'write')).toBe('openid offline_access scantor:read scantor:write')
    expect(approvedScope(ALL, 'admin')).toBe('openid offline_access scantor:read scantor:write scantor:admin')
  })
})
