import { randomBytes } from 'node:crypto'
import { setResponseHeader } from 'h3'
import { defineNitroPlugin } from 'nitropack/runtime'
import { useConfig } from '../utils/config'
import { applySecurityHeaders, buildCsp, cspOptionsFrom, securityPoliciesFrom, type SecurityPolicies } from '../utils/security-headers'

// Dashboard security headers (security.md HDR-1..HDR-3, docs/ui.md §13):
//   request      the required headers on every response. Nitro calls this hook before every handler, including the
//                public assets (/_nuxt/*) that it serves before any server middleware runs.
//   render:html  a per-response CSP nonce for the SPA shell (ui.md §13 option 1): every inline <script> of the
//                rendered shell gets the nonce, and the response's Content-Security-Policy admits exactly that nonce.
//                Development keeps the relaxed policy of the request hook (Vite's client).

const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)(?![^>]*\snonce=)([^>]*)>/g

function addNonce(chunks: string[], nonce: string): string[] {
  return chunks.map((chunk) => chunk.replace(INLINE_SCRIPT, `<script nonce="${nonce}"$1>`))
}

let policies: SecurityPolicies | null = null

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    policies ??= securityPoliciesFrom(useConfig(), import.meta.dev)
    applySecurityHeaders(event, policies)
  })

  if (import.meta.dev) return
  nitroApp.hooks.hook('render:html', (html, { event }) => {
    const nonce = randomBytes(16).toString('base64')
    html.head = addNonce(html.head, nonce)
    html.bodyPrepend = addNonce(html.bodyPrepend, nonce)
    html.body = addNonce(html.body, nonce)
    html.bodyAppend = addNonce(html.bodyAppend, nonce)
    const frameAncestors = typeof event.context.cspFrameAncestors === 'string' ? event.context.cspFrameAncestors : "'self'"
    const options = cspOptionsFrom(useConfig(), false)
    setResponseHeader(event, 'Content-Security-Policy', buildCsp({ ...options, scriptSources: [`'nonce-${nonce}'`], frameAncestors }))
  })
})
