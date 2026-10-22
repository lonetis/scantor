import { defineConfig, devices } from '@playwright/test'
import { env } from './helpers/env'

// The Playwright projects of the dockerized suite (docs/testing.md §7.5). Run only inside the runner:
// `just test-e2e [args]` or, against a kept-alive stack, `just test-exec [args]`.

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: env.ci,
  // One retry on CI gives a second trace, but a test that needs it still fails the run.
  retries: env.ci ? 1 : 0,
  failOnFlakyTests: env.ci,
  workers: env.testWorkers,
  globalSetup: './global-setup.ts',
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL: env.publicUrl,
    extraHTTPHeaders: { Origin: env.publicUrl },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: { mode: 'retain-on-failure', size: { width: 1920, height: 1080 } },
  },
  projects: [
    { name: 'api', testMatch: 'api/**/*.spec.ts' },
    { name: 'authz-setup', testMatch: 'authz/seed.setup.ts', teardown: 'authz-teardown' },
    { name: 'authz-teardown', testMatch: 'authz/seed.teardown.ts' },
    { name: 'authz', testMatch: 'authz/**/*.spec.ts', dependencies: ['authz-setup'] },
    { name: 'security', testMatch: 'security/**/*.spec.ts' },
    { name: 'mcp', testMatch: 'mcp/**/*.spec.ts', timeout: 300_000 },
    { name: 'e2e', testMatch: 'e2e/**/*.spec.ts', timeout: 600_000 },
    {
      name: 'ui',
      testMatch: 'ui/**/*.spec.ts',
      // The browser sends its own Origin; a forced one would break the editor's WebSocket origin check.
      use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 }, extraHTTPHeaders: {} },
    },
    {
      name: 'chaos',
      testMatch: 'chaos/**/*.spec.ts',
      timeout: 900_000,
      fullyParallel: false,
      dependencies: ['api', 'authz', 'security', 'mcp', 'e2e', 'ui'],
    },
  ],
})
