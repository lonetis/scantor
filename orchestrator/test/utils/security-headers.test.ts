import { describe, expect, it } from 'vitest'
import { buildCsp, cspOptionsFrom, isNoFramePage } from '../../server/utils/security-headers'

// Dashboard CSP (security.md HDR-1, HDR-2; docs/ui.md §13).

describe('buildCsp', () => {
  const options = cspOptionsFrom({ editorUrl: 'https://editor.example.com', s3PublicUrl: 'https://s3.example.com' }, false)

  it('contains the required directives and the runtime origins', () => {
    const csp = buildCsp(options)
    for (const directive of ["frame-ancestors 'self'", "object-src 'none'", "base-uri 'self'", 'frame-src https://editor.example.com']) {
      expect(csp).toContain(directive)
    }
    expect(csp).toContain("img-src 'self' data: blob: https://s3.example.com")
    expect(csp).not.toContain('unsafe-eval')
  })

  it('adds nonces and per-page frame ancestors', () => {
    const csp = buildCsp({ ...options, scriptSources: ["'nonce-abc'"], frameAncestors: "'none'" })
    expect(csp).toContain("script-src 'self' 'nonce-abc'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('relaxes script and connect sources only for development', () => {
    const csp = buildCsp(cspOptionsFrom({ editorUrl: 'http://localhost:3001', s3PublicUrl: 'http://localhost:9000' }, true))
    expect(csp).toContain("'unsafe-eval'")
    expect(csp).toContain('connect-src')
  })
})

describe('isNoFramePage', () => {
  it.each(['/login', '/setup', '/oauth/consent', '/setup/next'])('%s is never framed', (path) => {
    expect(isNoFramePage(path)).toBe(true)
  })

  it.each(['/', '/scans', '/loginx'])('%s may be framed by itself', (path) => {
    expect(isNoFramePage(path)).toBe(false)
  })
})
