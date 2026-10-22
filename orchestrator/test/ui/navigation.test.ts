import { describe, expect, it } from 'vitest'
import { SIDEBAR_GROUPS, safeHttpUrl, safeRedirectPath, urlOrigin, visibleGroups } from '../../app/utils/navigation'

describe('sidebar navigation (docs/ui.md §3.2)', () => {
  it('defines every item with its route and icon', () => {
    const links = SIDEBAR_GROUPS.flatMap((group) => group.links.map((link) => [group.label, link.label, link.to, link.icon]))
    expect(links).toEqual([
      ['Workspace', 'Overview', '/', 'i-lucide-layout-dashboard'],
      ['Workspace', 'Tasks', '/tasks', 'i-lucide-package'],
      ['Workspace', 'Scans', '/scans', 'i-lucide-radar'],
      ['Workspace', 'Templates', '/templates', 'i-lucide-layout-template'],
      ['Workspace', 'Editor', '/editor', 'i-lucide-code'],
      ['Access', 'CLI & MCP access', '/account/access', 'i-lucide-terminal'],
      ['Access', 'Git credentials', '/account/credentials', 'i-lucide-key-round'],
      ['Admin', 'Nodes', '/admin/nodes', 'i-lucide-server'],
      ['Admin', 'Users', '/admin/users', 'i-lucide-users'],
      ['Admin', 'Admin tools', '/admin/tools', 'i-lucide-wrench'],
    ])
  })

  it('hides the admin group from users and the editor without the feature', () => {
    const user = visibleGroups({ isAdmin: false, editorEnabled: false })
    expect(user.map((group) => group.label)).toEqual(['Workspace', 'Access'])
    expect(user[0]!.links.map((link) => link.label)).not.toContain('Editor')
    const admin = visibleGroups({ isAdmin: true, editorEnabled: true })
    expect(admin.map((group) => group.label)).toEqual(['Workspace', 'Access', 'Admin'])
    expect(admin[0]!.links.map((link) => link.label)).toContain('Editor')
  })
})

describe('safeRedirectPath (docs/ui.md §4.1)', () => {
  it.each([
    ['/scans/123?tab=results', '/scans/123?tab=results'],
    ['/tasks#files', '/tasks#files'],
  ])('accepts same-origin path %s', (value, expected) => {
    expect(safeRedirectPath(value)).toBe(expected)
  })

  it.each([
    'https://evil.example/',
    '//evil.example/path',
    '/\\evil.example',
    'javascript:alert(1)',
    'scans',
    '',
    '/\u0000x',
    '/a\\b',
  ])('rejects %j', (value) => {
    expect(safeRedirectPath(value)).toBe('/')
  })

  it('rejects non-strings and uses the fallback', () => {
    expect(safeRedirectPath(['/a', '/b'], '/home')).toBe('/home')
    expect(safeRedirectPath(undefined)).toBe('/')
  })
})

describe('safeHttpUrl and urlOrigin', () => {
  it('links only http(s) URLs', () => {
    expect(safeHttpUrl('https://example.com/app')).toBe('https://example.com/app')
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull()
    expect(safeHttpUrl('data:text/html,x')).toBeNull()
    expect(safeHttpUrl('not a url')).toBeNull()
    expect(safeHttpUrl(null)).toBeNull()
  })

  it('extracts redirect origins, also for private-use schemes', () => {
    expect(urlOrigin('http://127.0.0.1:53682/callback?x=1')).toBe('http://127.0.0.1:53682')
    expect(urlOrigin('cursor://anysphere.cursor-retrieval/oauth')).toBe('cursor://anysphere.cursor-retrieval')
    expect(urlOrigin('nope')).toBeNull()
  })
})
