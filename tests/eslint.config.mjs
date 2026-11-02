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
  {
    // The ui workers never use Node's fetch (docs/testing.md §9 rule 18): MCP checks there go through rawMcp.
    files: ['ui/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', { name: 'fetch', message: 'ui specs use Playwright requests, never Node fetch (docs/testing.md §9).' }],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@modelcontextprotocol/client', message: 'ui specs check MCP with rawMcp, never an SDK client (docs/testing.md §9).' },
            { name: '../helpers/mcp', importNames: ['connectMcp', 'connectMcpWithKey'], message: 'ui specs check MCP with rawMcp (docs/testing.md §9).' },
            { name: '../helpers/mcp-oauth', importNames: ['connectMcpPatiently'], message: 'ui specs check MCP with rawMcp (docs/testing.md §9).' },
            { name: '../helpers/mcp-accounts', importNames: ['connectMcpWithApiKeyHeader'], message: 'ui specs check MCP with rawMcp (docs/testing.md §9).' },
          ],
        },
      ],
    },
  },
)
