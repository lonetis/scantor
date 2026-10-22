import { fileURLToPath } from 'node:url'

// Build-time parameter (docker-bake VERSION, passed as BUILD_VERSION by orchestrator/Dockerfile; development.md §10);
// never runtime configuration.
const buildVersion = process.env.BUILD_VERSION || 'dev'

// Renders every error of /api, /mcp and /.well-known as the envelope of docs/api.md §1.7; other paths fall through
// to Nuxt's own error handler.
const apiErrorHandler = fileURLToPath(new URL('./server/utils/error-handler.ts', import.meta.url))

// Static security headers (security.md HDR-1..3, ui.md §13). Nitro serves public assets before server
// middleware runs, so the configuration-independent values are repeated here; the full CSP, HSTS and the
// per-page overrides are added by server/middleware/01.security-headers.ts.
const staticSecurityHeaders = {
  'Content-Security-Policy': "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)',
}

export default defineNuxtConfig({
  modules: ['@nuxt/ui', '@nuxt/eslint'],

  ssr: false,

  css: ['~/assets/css/main.css'],

  ui: { fonts: false },

  colorMode: { preference: 'dark', fallback: 'dark', storageKey: 'scantor-color-mode' },

  icon: {
    clientBundle: { scan: { globInclude: ['app/**/*.{vue,ts}'] } },
    serverBundle: 'local',
    fallbackToApi: false,
    localApiEndpoint: '/_icons',
  },

  experimental: { emitRouteChunkError: 'automatic-immediate' },

  routeRules: {
    '/**': { headers: staticSecurityHeaders },
  },

  nitro: {
    preset: 'node-server',
    experimental: { openAPI: true },
    openAPI: {
      meta: {
        title: 'scantor API',
        description:
          'REST API of scantor, a distributed scanning platform: author tasks, publish revisions, run scans and query results.',
        version: buildVersion,
      },
      production: 'runtime',
      route: '/api/docs/openapi.json',
      ui: {
        scalar: { route: '/api/docs' },
        swagger: false,
      },
    },
    replace: {
      __SCANTOR_VERSION__: JSON.stringify(buildVersion),
    },
    serverAssets: [
      { baseName: 'schemas', dir: '../../schemas' },
      { baseName: 'guide', dir: '../../docs/guide' },
    ],
  },

  hooks: {
    'nitro:config'(nitroConfig) {
      const existing = nitroConfig.errorHandler === undefined ? [] : [nitroConfig.errorHandler].flat()
      nitroConfig.errorHandler = [apiErrorHandler, ...existing]
    },
  },

  compatibilityDate: '2026-10-01',
})
