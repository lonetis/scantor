// ESLint for the dockerized Playwright suite (`just lint`): the recommended JavaScript and
// TypeScript rules over the specs, helpers and scripts.
import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

const nodeGlobals = Object.fromEntries(
  ['process', 'console', 'Buffer', 'URL', 'URLSearchParams', 'fetch', 'setTimeout', 'clearTimeout', 'AbortController', 'structuredClone'].map((name) => [
    name,
    'readonly',
  ]),
)

export default defineConfig(
  { ignores: ['node_modules/', 'playwright-report/', 'test-results/', '.auth/', 'fixtures/tasks/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: nodeGlobals },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Playwright fixtures destructure an empty object when they need no other fixture.
      'no-empty-pattern': 'off',
    },
  },
)
