import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Orchestrator unit tests (docs/testing.md §4.2): pure server and shared logic, run without Nitro. Test paths
// mirror server/ (test/utils/labels.test.ts covers server/utils/labels.ts); shared code is tested under
// test/shared/, UI utilities under test/ui/. The aliases are the ones Nuxt defines for server and shared code.

export default defineConfig({
  resolve: {
    alias: {
      '#shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '~~': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 10_000,
  },
})
