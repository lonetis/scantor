import { fileURLToPath } from 'node:url'

// Build-time parameter (docker-bake VERSION, passed as BUILD_VERSION by orchestrator/Dockerfile; development.md §10);
// never runtime configuration.
const buildVersion = process.env.BUILD_VERSION || 'dev'

// Renders every error of /api, /mcp and /.well-known as the envelope of docs/api.md §1.7; other paths fall through
// to Nuxt's own error handler.
const apiErrorHandler = fileURLToPath(new URL('./server/utils/error-handler.ts', import.meta.url))

// `nuxt dev` only (docker-compose.dev.yml): Vite answers 403 to every request whose Host it does not know, its guard
// against DNS rebinding. localhost, *.localhost and IP addresses always pass; the dev stack also reaches the server
// by the host of SCANTOR_INTERNAL_URL (the built-in node dials http://orchestrator:3000), of SCANTOR_PUBLIC_URL (a
// dev stack behind Traefik) and as host.docker.internal, which the containerized CLI (`just cli`, scantor.sh) dials
// for a loopback SCANTOR_URL (internal/cli/config.go ContainerHost). The orchestrator's config loader validates both
// URLs and aborts the boot on a bad value, so an unparsable one is left out here instead of failing the dev server
// before that message is logged.
const CONTAINERIZED_CLI_HOST = 'host.docker.internal'

function devServerAllowedHosts(urls: Array<string | undefined>): string[] {
  const hosts = new Set<string>([CONTAINERIZED_CLI_HOST])
  for (const url of urls) {
    if (!url || !URL.canParse(url)) continue
    hosts.add(new URL(url).hostname)
  }
  return [...hosts]
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

  vite: {
    server: {
      allowedHosts: devServerAllowedHosts([process.env.SCANTOR_INTERNAL_URL, process.env.SCANTOR_PUBLIC_URL]),
    },
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
      // /api/docs is server/routes/api/docs.get.ts: Nitro's Scalar page loads an unpinned bundle (docs/ui.md §13).
      ui: {
        scalar: false,
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
