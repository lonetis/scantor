import { z } from 'zod'

// zod 4 probes for eval support with `new Function('')` when it builds its first object schema, to compile a faster
// parser. The CSP forbids eval (docs/ui.md §13), so the probe is reported as a securitypolicyviolation on every page
// that renders a form. jitless skips the probe and the compiled fast path; validation results are the same. This runs
// while the entry module evaluates, before the router loads the first page chunk and any schema is built. The server
// keeps zod's compiled parsers: it has no CSP.
z.config({ jitless: true })

export default defineNuxtPlugin({ name: 'scantor:zod-jitless', setup: () => {} })
