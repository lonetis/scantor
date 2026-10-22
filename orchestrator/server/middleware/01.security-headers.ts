import { defineEventHandler, setResponseHeader } from 'h3'
import { useConfig } from '../utils/config'
import {
  buildCsp,
  buildDocsCsp,
  cspOptionsFrom,
  isNoFramePage,
  PERMISSIONS_POLICY,
} from '../utils/security-headers'

// Required headers on every dashboard response (security.md HDR-1..HDR-3, docs/ui.md §13). `/login`, `/setup` and
// `/oauth/consent` are never framed or cached. HTML documents of the SPA get a per-response nonce from
// server/plugins/csp.ts, which replaces the policy set here.

let policies: { normal: string; noFrame: string; docs: string; hsts: boolean } | null = null

function resolvePolicies() {
  if (!policies) {
    const config = useConfig()
    const options = cspOptionsFrom(config, import.meta.dev)
    policies = {
      normal: buildCsp(options),
      noFrame: buildCsp({ ...options, frameAncestors: "'none'" }),
      docs: buildDocsCsp(),
      hsts: config.publicUrl.startsWith('https://'),
    }
  }
  return policies
}

export default defineEventHandler((event) => {
  const path = event.path.split('?')[0] ?? '/'
  const resolved = resolvePolicies()
  const noFrame = isNoFramePage(path)
  const csp = path === '/api/docs' ? resolved.docs : noFrame ? resolved.noFrame : resolved.normal
  setResponseHeader(event, 'Content-Security-Policy', csp)
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff')
  setResponseHeader(event, 'Referrer-Policy', 'same-origin')
  setResponseHeader(event, 'Cross-Origin-Opener-Policy', 'same-origin')
  setResponseHeader(event, 'Permissions-Policy', PERMISSIONS_POLICY)
  if (resolved.hsts) setResponseHeader(event, 'Strict-Transport-Security', 'max-age=31536000')
  if (noFrame || path.startsWith('/api/')) setResponseHeader(event, 'Cache-Control', 'no-store')
  event.context.cspFrameAncestors = noFrame ? "'none'" : "'self'"
})
