// Sidebar navigation (docs/ui.md §3.2), defined once as data. Icon names stay literal strings so the
// icon bundler finds them in this .ts file.

export type NavigationBadge = 'activeScans' | 'offlineNodes'

export type NavigationVisibility = 'all' | 'admin' | 'editorFeature'

export interface NavigationLink {
  label: string
  to: string
  icon: string
  visible: NavigationVisibility
  badge?: NavigationBadge
  /** Opens in a new tab and is served by the API, not the SPA. */
  external?: boolean
}

export interface NavigationGroup {
  label: string
  links: NavigationLink[]
}

export const SIDEBAR_ACTIONS = [
  { label: 'New scan', to: '/scans/new', icon: 'i-lucide-play', color: 'primary', variant: 'solid' },
  { label: 'New task', to: '/tasks/new', icon: 'i-lucide-plus', color: 'neutral', variant: 'outline' },
] as const

export const SIDEBAR_GROUPS: readonly NavigationGroup[] = [
  {
    label: 'Workspace',
    links: [
      { label: 'Overview', to: '/', icon: 'i-lucide-layout-dashboard', visible: 'all' },
      { label: 'Tasks', to: '/tasks', icon: 'i-lucide-package', visible: 'all' },
      { label: 'Scans', to: '/scans', icon: 'i-lucide-radar', visible: 'all', badge: 'activeScans' },
      { label: 'Templates', to: '/templates', icon: 'i-lucide-layout-template', visible: 'all' },
      { label: 'Editor', to: '/editor', icon: 'i-lucide-code', visible: 'editorFeature' },
    ],
  },
  {
    label: 'Access',
    links: [
      { label: 'CLI & MCP access', to: '/account/access', icon: 'i-lucide-terminal', visible: 'all' },
      { label: 'Git credentials', to: '/account/credentials', icon: 'i-lucide-key-round', visible: 'all' },
    ],
  },
  {
    label: 'Admin',
    links: [
      { label: 'Nodes', to: '/admin/nodes', icon: 'i-lucide-server', visible: 'admin', badge: 'offlineNodes' },
      { label: 'Users', to: '/admin/users', icon: 'i-lucide-users', visible: 'admin' },
      { label: 'Admin tools', to: '/admin/tools', icon: 'i-lucide-wrench', visible: 'admin' },
    ],
  },
]

export const SIDEBAR_FOOTER_LINKS: readonly NavigationLink[] = [
  { label: 'API docs', to: '/api/docs', icon: 'i-lucide-book-open', visible: 'all', external: true },
]

export interface NavigationContext {
  isAdmin: boolean
  editorEnabled: boolean
}

export function isLinkVisible(link: NavigationLink, context: NavigationContext): boolean {
  if (link.visible === 'admin') return context.isAdmin
  if (link.visible === 'editorFeature') return context.editorEnabled
  return true
}

/** The groups and links visible to a caller; groups without visible links are dropped. */
export function visibleGroups(context: NavigationContext): NavigationGroup[] {
  return SIDEBAR_GROUPS
    .map((group) => ({ label: group.label, links: group.links.filter((link) => isLinkVisible(link, context)) }))
    .filter((group) => group.links.length > 0)
}

/** Data-derived links are rendered only for http(s) URLs (docs/security.md HDR-5); anything else is null. */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/** The origin of a URL, or null when it does not parse. */
export function urlOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null
  try {
    const url = new URL(value)
    return url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin
  } catch {
    return null
  }
}

/**
 * A `redirect` query value is followed only when it is a same-origin path: it starts with one `/`, is not
 * protocol-relative (`//`, `/\`) and carries no scheme or control characters (docs/ui.md §4.1).
 */
export function safeRedirectPath(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return fallback
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\\]/.test(value)) return fallback
  try {
    const url = new URL(value, 'http://scantor.invalid')
    if (url.origin !== 'http://scantor.invalid') return fallback
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return fallback
  }
}
