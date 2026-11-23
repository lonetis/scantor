import { getRequestHeader, type H3Event } from 'h3'
import type { RequestOrigin } from '#shared/utils/enums'
import { normalizeHost } from './client-ip'
import { type Config, useConfig } from './config'
import { isLoopbackListenerSocket } from './loopback'
import { useTrustedProxies } from './trusted-proxy'

/*
 * The Cloudflare Tunnel (docs/architecture.md §11.9, security.md TUN-1..TUN-8): the optional compose service
 * `cloudflared` (profile cloudflare-tunnel) forwards the requests of SCANTOR_TUNNEL_URL to orchestrator:3000, a second
 * origin of the dashboard, the REST API and /mcp next to SCANTOR_PUBLIC_URL. A request is a tunnel request only when
 * its Host is the tunnel URL's host and its socket peer is cloudflared (resolved like a trusted proxy,
 * utils/trusted-proxy.ts); exactly one of the two is a mismatch, which middleware/00.request.ts answers with 421. Every
 * other request is public. The classification is synchronous and memoized on the event, so the security headers of the
 * `request` hook and every middleware see the same answer.
 *
 * `nuxt dev` proxies every request over a unix socket without a peer address: there the Host alone decides, so in the
 * dev stack the classification is advisory (like the script runtime peer check of middleware/10.auth.ts); verify it
 * against the test stack. Requests of the MCP loopback listener (utils/loopback.ts) are always public.
 */

/** The compose service of the tunnel: the only peer whose requests can be tunnel requests. */
export const TUNNEL_PROXY_HOST = 'cloudflared'
/** The compose profile that starts cloudflared. */
export const TUNNEL_PROFILE = 'cloudflare-tunnel'
/**
 * Cloudflare answers 524 when the origin sends no response within its Proxy Read Timeout (125 s; only Enterprise zones
 * change it), and a wait sends nothing until it ends, so waits through the tunnel end with a margin below it.
 */
export const TUNNEL_WAIT_MAX_SECONDS = 90
/**
 * The /api prefixes that do not exist through the tunnel (404 notFound, middleware/01.tunnel.ts): the node, worker and
 * script runtime APIs, the admin tools, the registry token realm and the editor stay on the public origins.
 */
export const TUNNEL_REFUSED_PREFIXES = ['/api/node', '/api/runtime', '/api/script-runtime', '/api/tools', '/api/registry', '/api/editor'] as const

/** The origin of a request, or `mismatch`: the tunnel host from another peer, or cloudflared with another host. */
export type RequestClassification = RequestOrigin | 'mismatch'

/** Whether a raw request path (without query) lies at or below one of TUNNEL_REFUSED_PREFIXES; `/api/nodes` does not. */
export function isTunnelRefusedPath(path: string): boolean {
  return TUNNEL_REFUSED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

/** Whether a `Host` header names the tunnel URL's host (compared as for an https origin, default port removed). */
export function isTunnelHost(host: string | undefined, tunnelUrl: string): boolean {
  return !!host && normalizeHost(host, 'https:') === new URL(tunnelUrl).host
}

/** Classifies a request once and memoizes the answer in `event.context.requestOrigin`; always public without a tunnel. */
export function classifyRequest(event: H3Event): RequestClassification {
  const { tunnelUrl } = useConfig()
  if (tunnelUrl === null) return 'public'
  const cached = event.context.requestOrigin as RequestClassification | undefined
  if (cached) return cached
  let classification: RequestClassification = 'public'
  const socket = event.node.req.socket
  if (!isLoopbackListenerSocket(socket)) {
    const hostIsTunnel = isTunnelHost(getRequestHeader(event, 'host'), tunnelUrl)
    const peer = socket?.remoteAddress
    const proxies = useTrustedProxies()
    // Only a request for the tunnel host refreshes cloudflared's address after a miss: ordinary traffic causes no lookups.
    const fromTunnel = peer ? !!proxies?.isHostPeer(TUNNEL_PROXY_HOST, peer, hostIsTunnel) : !!import.meta.dev && hostIsTunnel
    classification = hostIsTunnel && fromTunnel ? 'tunnel' : hostIsTunnel || fromTunnel ? 'mismatch' : 'public'
  }
  event.context.requestOrigin = classification
  return classification
}

/** The origin a request reached the master through; a mismatched request counts as public (it is refused anyway). */
export function requestOriginOf(event: H3Event): RequestOrigin {
  return classifyRequest(event) === 'tunnel' ? 'tunnel' : 'public'
}

export function isTunnelRequest(event: H3Event): boolean {
  return classifyRequest(event) === 'tunnel'
}

/** The URL of an origin (without trailing slash). Throws for the tunnel while SCANTOR_TUNNEL_URL is empty. */
export function originUrlOf(config: Pick<Config, 'publicUrl' | 'tunnelUrl'>, origin: RequestOrigin): string {
  if (origin === 'public') return config.publicUrl
  if (config.tunnelUrl === null) throw new Error('the tunnel origin needs SCANTOR_TUNNEL_URL')
  return config.tunnelUrl
}
