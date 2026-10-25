import type { H3Event } from 'h3'

// Request paths (docs/auth.md §1, security.md AUTH-5). Nitro's router and the middleware match the raw request
// target, while h3's getRequestURL and toWebRequest (and so better-auth) parse it as a URL, which resolves dot
// segments (`..`, `%2e%2e`), turns backslashes into slashes and collapses leading slashes. A path for which the two
// differ could reach one handler while the checks keyed on the other path never run, so middleware/01.path.ts
// rejects every such path before any other check.

const BASE = 'http://canonical.invalid'

/** The path of a request target without its query string. */
export function rawPathOf(target: string | undefined): string {
  return (target ?? '/').split('?')[0] || '/'
}

/** The pathname a WHATWG URL parser (and so h3's getRequestURL) makes of a raw path, or null when it does not parse. */
export function resolvedPathname(rawPath: string): string | null {
  try {
    // getRequestURL collapses leading slashes and backslashes before parsing, so `//host/x` stays a path.
    const url = new URL(rawPath.replace(/^[/\\]+/, '/'), BASE)
    return url.origin === BASE ? url.pathname : null
  } catch {
    return null
  }
}

/** True when routing the raw path and parsing it as a URL give the same path. */
export function isCanonicalPath(rawPath: string): boolean {
  return rawPath.startsWith('/') && resolvedPathname(rawPath) === rawPath
}

/**
 * The pathname of the URL that h3's getRequestURL builds for the request (the path better-auth routes), without
 * depending on the Host header; the raw path when it does not parse.
 */
export function routedPathname(event: H3Event): string {
  const raw = rawPathOf((event.node.req as { originalUrl?: string }).originalUrl || event.path)
  return resolvedPathname(raw) ?? raw
}
