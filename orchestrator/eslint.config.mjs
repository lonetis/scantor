// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

// ESLint for the orchestrator (docs/development.md §4 `lint`): the standalone @nuxt/eslint configuration (JS,
// TypeScript, Vue) plus scantor's rules. `vue/no-v-html` is an error because results, logs and file names are
// untrusted content that must render as text (security.md HDR-5).
export default withNuxt(
  {
    name: 'scantor/rules',
    rules: {
      'vue/no-v-html': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // docs/api.md §1.1: a route's first statement is defineRouteMeta, so imports follow it.
    name: 'scantor/route-meta-first',
    files: ['server/api/**/*.ts'],
    rules: { 'import/first': 'off' },
  },
)
