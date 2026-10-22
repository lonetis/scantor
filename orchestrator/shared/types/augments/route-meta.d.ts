import type { ScantorRouteMeta } from '../../../server/types/openapi'

// Lets `defineRouteMeta` accept scantor's route metadata (server/types/openapi.ts): Nitro's own OpenAPI types lack
// the JSON Schema bounds keywords and the x-scantor extensions. The file sits under shared/ because both the server
// and the app TypeScript projects check the route files (the app's typed $fetch imports them), and in a
// subdirectory because Nuxt scans shared/types for auto-imports and would mistake the augmentation for an export.
declare module 'nitropack/runtime/internal/meta' {
  export function defineRouteMeta(meta: ScantorRouteMeta): ScantorRouteMeta
}
