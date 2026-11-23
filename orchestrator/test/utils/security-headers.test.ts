import { createApp, createError, defineEventHandler, serveStatic, toWebHandler } from 'h3'
import { describe, expect, it } from 'vitest'
import { SCALAR_BUNDLE_URL } from '../../server/utils/api-docs'
import {
  applySecurityHeaders,
  buildCsp,
  buildDocsCsp,
  cspOptionsFrom,
  HSTS,
  isNoFramePage,
  securityHeadersFor,
  securityPoliciesFrom,
  type SecurityPolicies,
} from '../../server/utils/security-headers'

// Dashboard security headers and CSP (security.md HDR-1..HDR-3; docs/ui.md §13).

const HTTPS = { publicUrl: 'https://scantor.example.com', editorUrl: 'https://editor.example.com', s3PublicUrl: 'https://s3.example.com' }
const HTTP = { publicUrl: 'http://localhost:3000', editorUrl: 'http://localhost:3001', s3PublicUrl: 'http://localhost:9000' }
const REQUIRED = ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'cross-origin-opener-policy', 'permissions-policy']

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

describe('buildDocsCsp', () => {
  it('admits the exact URL of the pinned Scalar bundle and its font origin, and nothing else from outside', () => {
    const csp = buildDocsCsp()
    expect(SCALAR_BUNDLE_URL).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@scalar\/api-reference@\d+\.\d+\.\d+\/dist\/browser\/standalone\.js$/)
    expect(csp).toContain(`script-src 'self' ${SCALAR_BUNDLE_URL};`)
    // Never a whole CDN origin, inline scripts or eval.
    expect(csp).not.toMatch(/https:\/\/cdn\.jsdelivr\.net(\/npm\/)?(;|\s|$)/)
    expect(csp.split('; ').find((directive) => directive.startsWith('script-src'))).not.toMatch(/'unsafe-(inline|eval)'/)
    expect(csp).toContain("style-src 'self' 'unsafe-inline';")
    expect(csp).toContain("font-src 'self' data: https://fonts.scalar.com;")
    expect(csp).toContain("connect-src 'self';")
    expect(csp).toContain("object-src 'none'")
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

describe('securityHeadersFor', () => {
  const https = securityPoliciesFrom(HTTPS, false)

  it.each(['/_nuxt/entry.js', '/_nuxt/entry.css', '/favicon.ico', '/', '/scans', '/api/health', '/login'])(
    '%s carries every required header and HSTS on https',
    (path) => {
      const { headers } = securityHeadersFor(path, https)
      expect(Object.keys(headers).map((name) => name.toLowerCase())).toEqual(expect.arrayContaining(REQUIRED))
      expect(headers['Strict-Transport-Security']).toBe('max-age=31536000')
      expect(headers['X-Content-Type-Options']).toBe('nosniff')
    },
  )

  it('sends no HSTS when SCANTOR_PUBLIC_URL is http', () => {
    for (const path of ['/_nuxt/entry.js', '/', '/api/health']) {
      expect(securityHeadersFor(path, securityPoliciesFrom(HTTP, false)).headers['Strict-Transport-Security']).toBeUndefined()
    }
  })

  it('never frames or caches the no-frame pages and never caches /api', () => {
    const login = securityHeadersFor('/login', https)
    expect(login.headers['Content-Security-Policy']).toContain("frame-ancestors 'none'")
    expect(login.headers['Cache-Control']).toBe('no-store')
    expect(login.frameAncestors).toBe("'none'")
    expect(securityHeadersFor('/api/scans', https).headers['Cache-Control']).toBe('no-store')
    const asset = securityHeadersFor('/_nuxt/entry.js', https)
    expect(asset.headers['Cache-Control']).toBeUndefined()
    expect(asset.headers['Content-Security-Policy']).toContain("frame-ancestors 'self'")
    expect(asset.frameAncestors).toBe("'self'")
  })

  it('gives /api/docs the Scalar policy', () => {
    expect(securityHeadersFor('/api/docs', https).headers['Content-Security-Policy']).toBe(buildDocsCsp())
  })
})

describe('the policies of the tunnel origin (docs/ui.md §13)', () => {
  it('frames no editor, admits no S3 images and always sends HSTS', () => {
    for (const config of [HTTP, HTTPS]) {
      const tunnel = securityPoliciesFrom(config, false, 'tunnel')
      expect(tunnel.hsts).toBe(true)
      expect(tunnel.csp).toEqual({ editorOrigin: null, s3PublicOrigin: null, dev: false })
      for (const csp of [tunnel.normal, tunnel.noFrame]) {
        expect(csp).toContain("frame-src 'none'")
        expect(csp).toContain("img-src 'self' data: blob:;")
        expect(csp).toContain("connect-src 'self';")
        expect(csp).not.toContain(new URL(config.editorUrl).origin)
        expect(csp).not.toContain(new URL(config.s3PublicUrl).origin)
      }
      expect(tunnel.normal).toBe(buildCsp(tunnel.csp))
      expect(tunnel.noFrame).toContain("frame-ancestors 'none'")
      expect(tunnel.docs).toBe(buildDocsCsp())
      for (const path of ['/_nuxt/entry.js', '/', '/api/health', '/login']) {
        expect(securityHeadersFor(path, tunnel).headers['Strict-Transport-Security'], path).toBe(HSTS)
      }
    }
  })

  it('builds the CSP sources without the public origins', () => {
    expect(cspOptionsFrom(HTTPS, true, 'tunnel')).toEqual({ editorOrigin: null, s3PublicOrigin: null, dev: true })
    expect(cspOptionsFrom(HTTPS, false, 'public')).toEqual({ editorOrigin: 'https://editor.example.com', s3PublicOrigin: 'https://s3.example.com', dev: false })
    expect(buildCsp(cspOptionsFrom(HTTPS, true, 'tunnel'))).toContain("connect-src 'self' ws: wss:")
  })

  it('keeps the policies of the public origin as they were', () => {
    const publicPolicies = securityPoliciesFrom(HTTPS, false)
    expect(securityPoliciesFrom(HTTPS, false, 'public')).toEqual(publicPolicies)
    expect(publicPolicies.csp).toEqual(cspOptionsFrom(HTTPS, false))
    expect(publicPolicies.normal).toBe(buildCsp(publicPolicies.csp))
    expect(publicPolicies.normal).toContain('frame-src https://editor.example.com')
    expect(securityPoliciesFrom(HTTP, false, 'public').hsts).toBe(false)
  })
})

describe('applySecurityHeaders', () => {
  // As in Nitro: the request hook runs before every handler, the public-asset handler first among them.
  function handler(policies: SecurityPolicies) {
    const app = createApp({ onRequest: (event) => applySecurityHeaders(event, policies) })
    app.use(
      defineEventHandler(async (event) => {
        const served = await serveStatic(event, {
          getMeta: (id) => (id === '/_nuxt/entry.js' ? { type: 'text/javascript', etag: '"1"', size: 2 } : undefined),
          getContents: () => '{}',
          fallthrough: !event.path.startsWith('/_nuxt/'),
        })
        // false: not an asset, the next handler answers
        return served === false ? undefined : served
      }),
    )
    app.use(
      '/api',
      defineEventHandler(() => {
        throw createError({ statusCode: 404 })
      }),
    )
    app.use(defineEventHandler((event) => `shell ${String(event.context.cspFrameAncestors)}`))
    return toWebHandler(app)
  }

  it('puts the required headers and HSTS on static assets, the shell, /api answers and errors', async () => {
    const fetch = handler(securityPoliciesFrom(HTTPS, false))
    for (const [path, status] of [
      ['/_nuxt/entry.js', 200],
      ['/_nuxt/missing.js', 404],
      ['/scans', 200],
      ['/api/no-such-route', 404],
    ] as const) {
      const response = await fetch(new Request(`https://scantor.example.com${path}`))
      expect(response.status, path).toBe(status)
      for (const name of REQUIRED) expect(response.headers.get(name), `${path}: ${name}`).toBeTruthy()
      expect(response.headers.get('strict-transport-security'), path).toBe('max-age=31536000')
    }
    const asset = await fetch(new Request('https://scantor.example.com/_nuxt/entry.js'))
    expect(asset.headers.get('content-type')).toBe('text/javascript')
    expect(await asset.text()).toBe('{}')
  })

  it('sends HSTS through the tunnel even when the public URL is http', async () => {
    const fetch = handler(securityPoliciesFrom(HTTP, false, 'tunnel'))
    for (const path of ['/_nuxt/entry.js', '/scans', '/api/no-such-route']) {
      const response = await fetch(new Request(`https://tunnel.example.com${path}`))
      expect(response.headers.get('strict-transport-security'), path).toBe('max-age=31536000')
      expect(response.headers.get('content-security-policy'), path).toContain("frame-src 'none'")
    }
  })

  it('hands the frame-ancestors source to the shell renderer', async () => {
    const fetch = handler(securityPoliciesFrom(HTTPS, false))
    expect(await (await fetch(new Request('https://scantor.example.com/login'))).text()).toBe("shell 'none'")
    expect(await (await fetch(new Request('https://scantor.example.com/scans?x=1'))).text()).toBe("shell 'self'")
  })
})
