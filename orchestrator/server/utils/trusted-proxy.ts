import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { useConfig } from './config'
import { SANDBOX_NETWORK, useDocker } from './docker'
import { stripIpv4Mapped } from './internal-auth'
import { type Logger, useLogger } from './logger'

/*
 * Trusted reverse proxies (docs/auth.md §4.3, security.md AUTH-6). With SCANTOR_TRUST_PROXY=true, X-Forwarded-For
 * counts only on a connection whose socket peer is one of SCANTOR_TRUSTED_PROXIES: IP addresses, CIDR ranges and
 * host names. Every other peer is the client itself, so code on `scantor-sandbox` (master workers, editor terminals)
 * that talks to orchestrator:3000 directly cannot pick its own client IP.
 *
 * Host names (the compose service `traefik`) are resolved again every REFRESH_MS and, at most every MISS_REFRESH_MS,
 * after a forwarded request from an unknown peer, because a restarted Traefik can get another address. Addresses in
 * the subnets of scantor-sandbox are never trusted, whatever the list says. The check itself is synchronous.
 */

export const REFRESH_MS = 30_000
export const MISS_REFRESH_MS = 5_000

/** Answers whether a socket peer address is a trusted reverse proxy. */
export type ProxyTrust = (peer: string) => boolean

export const TRUST_NO_PROXY: ProxyTrust = () => false

export interface TrustedProxySource {
  /** Every address of a host name (an empty list when it does not resolve). */
  resolve(host: string): Promise<string[]>
  /** The CIDR ranges that are never trusted (the scantor-sandbox subnets); [] when there is no such network. */
  untrustedSubnets(): Promise<string[]>
}

type Family = 'ipv4' | 'ipv6'

function familyOf(address: string): Family | null {
  const version = isIP(address)
  return version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : null
}

function addRange(list: BlockList, entry: string): boolean {
  const slash = entry.indexOf('/')
  const address = slash === -1 ? entry : entry.slice(0, slash)
  const family = familyOf(address)
  if (!family) return false
  if (slash === -1) list.addAddress(address, family)
  else list.addSubnet(address, Number(entry.slice(slash + 1)), family)
  return true
}

export class TrustedProxies {
  private readonly ranges = new BlockList()
  private readonly hosts: string[] = []
  private readonly byHost = new Map<string, string[]>()
  private resolved = new Set<string>()
  private excluded = new BlockList()
  private refreshing: Promise<void> | null = null
  private lastRefresh = Number.NEGATIVE_INFINITY
  private readonly failures = new Map<string, string>()

  constructor(
    entries: readonly string[],
    private readonly source: TrustedProxySource,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    for (const entry of entries) {
      if (!addRange(this.ranges, entry)) this.hosts.push(entry)
    }
  }

  /** The synchronous check of the request path; an unknown peer schedules a refresh of the host names. */
  readonly isTrusted: ProxyTrust = (peer) => {
    const address = stripIpv4Mapped(peer)
    const family = familyOf(address)
    if (!family || this.excluded.check(address, family)) return false
    if (this.resolved.has(address) || this.ranges.check(address, family)) return true
    if (this.now() - this.lastRefresh >= MISS_REFRESH_MS) void this.refresh()
    return false
  }

  /** Resolves the host names and the sandbox subnets again; concurrent calls share one refresh. Never throws. */
  refresh(): Promise<void> {
    this.refreshing ??= this.load().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async load(): Promise<void> {
    this.lastRefresh = this.now()
    const excluded = await this.attempt('untrusted subnets', () => this.source.untrustedSubnets())
    if (excluded) {
      const list = new BlockList()
      for (const subnet of excluded) addRange(list, subnet)
      this.excluded = list
    }
    // A failed lookup keeps the host's previous addresses; a host that does not resolve has none.
    for (const host of this.hosts) {
      const addresses = await this.attempt(host, () => this.source.resolve(host))
      if (addresses) this.byHost.set(host, addresses.map(stripIpv4Mapped))
    }
    this.resolved = new Set([...this.byHost.values()].flat())
  }

  /** Runs one lookup; logs a failure once until the lookup works again, and returns null on failure. */
  private async attempt<T>(what: string, run: () => Promise<T>): Promise<T | null> {
    try {
      const result = await run()
      if (this.failures.delete(what)) this.log.info('trusted proxy lookup works again', { lookup: what })
      return result
    } catch (error) {
      const message = (error as Error).message
      if (this.failures.get(what) !== message) {
        this.failures.set(what, message)
        this.log.warn('trusted proxy lookup failed; keeping the previous result', { lookup: what, err: error })
      }
      return null
    }
  }
}

function isStatus(error: unknown, status: number): boolean {
  return (error as { statusCode?: number } | null)?.statusCode === status
}

/** DNS through the system resolver (Docker's embedded DNS in compose) and the scantor-sandbox IPAM subnets. */
export const systemProxySource: TrustedProxySource = {
  async resolve(host) {
    try {
      return (await lookup(host, { all: true })).map((entry) => entry.address)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOTFOUND' || code === 'ENODATA') return []
      throw error
    }
  },
  async untrustedSubnets() {
    try {
      const network = await useDocker().getNetwork(SANDBOX_NETWORK).inspect()
      return ((network.IPAM?.Config ?? []) as { Subnet?: string }[]).flatMap((config) => (config.Subnet ? [config.Subnet] : []))
    } catch (error) {
      if (isStatus(error, 404)) return []
      throw error
    }
  },
}

let instance: TrustedProxies | null = null

/** The process-wide trusted proxies, or null when SCANTOR_TRUST_PROXY=false. */
export function useTrustedProxies(): TrustedProxies | null {
  const config = useConfig()
  if (!config.trustProxy) return null
  instance ??= new TrustedProxies(config.trustedProxies, systemProxySource, useLogger('trusted-proxy'))
  return instance
}

/** The check that computeClientIp needs: no proxy at all unless SCANTOR_TRUST_PROXY=true. */
export function proxyTrust(): ProxyTrust {
  return useTrustedProxies()?.isTrusted ?? TRUST_NO_PROXY
}
