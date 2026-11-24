import type { NodeResolverReport, NodeResolverStats } from '#shared/types/nodes'
import { stripEscapes } from './ansi'
import { formatCount, formatPercent } from './format'

// The node resolver of a node (docs/ui.md §5.15, docs/nodes.md §6.11): its error codes as readable text, the warning of
// the nodes table and the statistics of the "Node resolver" card.

/** The fixed error vocabulary of `info.resolver.error`. */
const ERROR_TEXT: Record<string, string> = {
  noImage: 'the daemon could not find its own image to run the resolver',
  noNetwork: 'the worker network is missing',
  bindInUse: "another process holds port 53 on the worker network's gateway",
  bindUnavailable: "the worker network's gateway address is not available to the resolver (rootless Docker with a detached network namespace)",
  bindDenied: 'binding port 53 was denied',
  foreignResolver: "another node's resolver answers on the worker network",
  upstreamUnreachable: 'no upstream or root server answers',
  unhealthy: 'the resolver container is unhealthy',
  crashLoop: 'the resolver container keeps exiting',
  probeFailed: 'workers cannot reach the resolver (a host firewall may drop DNS from the worker network)',
  createFailed: 'the resolver container could not be created',
}

/** What a troubled state means when the daemon reported no error code. */
const STATE_TEXT: Record<string, string> = {
  degraded: 'no upstream or root server answers',
  unreachable: 'workers cannot reach the resolver',
  failed: 'the resolver cannot serve',
}

/** States in which new workers do not use the node resolver because of a problem (the nodes table warns). */
const TROUBLED_STATES = new Set(['failed', 'degraded', 'unreachable'])

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** The readable text of a resolver error code with the daemon's short detail, or null without an error. */
export function resolverErrorText(error: string | null | undefined, detail?: string | null): string | null {
  if (!error) return null
  const text = capitalize(ERROR_TEXT[error] ?? stripEscapes(error))
  const extra = detail ? stripEscapes(detail).trim() : ''
  return extra ? `${text} (${extra})` : text
}

/** The nodes table warning for a resolver in a troubled state, or null. */
export function resolverWarning(resolver: NodeResolverReport | null | undefined): string | null {
  if (!resolver || !TROUBLED_STATES.has(resolver.state)) return null
  const reason = resolver.error ? (ERROR_TEXT[resolver.error] ?? stripEscapes(resolver.error)) : STATE_TEXT[resolver.state]!
  return `Node resolver ${resolver.state}: ${reason}`
}

/** The upstream check and IPv6 rows of the "Node resolver" card. */
export interface ResolverHealthText {
  upstream: string
  ipv6: string
}

/**
 * The upstream check and IPv6 use of a resolver as text, "unknown" while the report cannot know them: the resolver is
 * starting, disabled without a kept resolver, or reported no health check output yet (`stats` null; the daemon then
 * sends both flags as false).
 */
export function resolverHealthText(resolver: NodeResolverReport): ResolverHealthText {
  const unknown = resolver.stats === null || resolver.state === 'starting' || (resolver.state === 'disabled' && !resolver.kept)
  if (unknown) return { upstream: 'unknown', ipv6: 'unknown' }
  return { upstream: resolver.upstreamOk ? 'servers answer' : 'no server answers', ipv6: resolver.ipv6 ? 'used' : 'not used' }
}

export interface ResolverStatRow {
  label: string
  value: string
  /** The counts behind a ratio (tooltip). */
  title?: string
  /** The value needs attention (conntrack table nearly full). */
  warn?: boolean
}

/** Conntrack usage from which the card highlights the value: new flows are dropped once the table is full. */
const CONNTRACK_WARN = 0.8

/** The statistics rows of the "Node resolver" card; empty without statistics. */
export function resolverStatRows(stats: NodeResolverStats | null | undefined): ResolverStatRow[] {
  if (!stats) return []
  const hitRatio = stats.queries > 0 ? (stats.cacheHits / stats.queries) * 100 : null
  return [
    { label: 'Queries', value: formatCount(stats.queries) },
    {
      label: 'Cache hits',
      value: formatPercent(hitRatio),
      title: `${formatCount(stats.cacheHits)} of ${formatCount(stats.queries)} queries`,
    },
    { label: 'Lookups', value: formatCount(stats.lookups) },
    { label: 'Failures', value: formatCount(stats.failures) },
    { label: 'In flight', value: formatCount(stats.inflight) },
    { label: 'Queries per second', value: formatCount(Math.round(stats.qps * 10) / 10) },
    {
      label: 'Conntrack usage',
      value: stats.conntrackUsed > 0 ? formatPercent(stats.conntrackUsed * 100) : 'unknown',
      warn: stats.conntrackUsed >= CONNTRACK_WARN,
    },
  ]
}
