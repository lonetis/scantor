import { BlockList, isIP } from 'node:net'
import { SCRIPTS_NETWORK, useDocker } from './docker'
import { stripIpv4Mapped } from './internal-auth'
import { type Logger, useLogger } from './logger'

/*
 * The peer restriction of the script runtime API (docs/scripts.md, docs/security.md): `/api/script-runtime/*` answers
 * only connections whose socket peer lies in a subnet of the Docker network `scantor-scripts`, so a leaked script-run
 * token is useless outside the master. The subnets are inspected by a boot step (server/plugins/35.scripts.ts). While
 * they are unknown (the network was missing or Docker failed) every peer is refused, and a refused check schedules a
 * new inspection at most every SCRIPT_NETWORK_REFRESH_MS. The check itself is synchronous.
 */

export const SCRIPT_NETWORK_REFRESH_MS = 30_000

/** Where the subnets come from: the IPAM configuration of `scantor-scripts`, or null when the network does not exist. */
export type ScriptNetworkSource = () => Promise<string[] | null>

type Family = 'ipv4' | 'ipv6'

function familyOf(address: string): Family | null {
  const version = isIP(address)
  return version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : null
}

function isStatus(error: unknown, status: number): boolean {
  return (error as { statusCode?: number } | null)?.statusCode === status
}

/** The subnets of `scantor-scripts` from the Docker daemon; null when the network does not exist. */
export const dockerScriptNetworkSource: ScriptNetworkSource = async () => {
  try {
    const network = await useDocker().getNetwork(SCRIPTS_NETWORK).inspect()
    return ((network.IPAM?.Config ?? []) as { Subnet?: string }[]).flatMap((config) => (config.Subnet ? [config.Subnet] : []))
  } catch (error) {
    if (isStatus(error, 404)) return null
    throw error
  }
}

export class ScriptNetwork {
  private list: BlockList | null = null
  private known: string[] = []
  private refreshing: Promise<boolean> | null = null
  private lastRefresh = Number.NEGATIVE_INFINITY
  /** the last problem logged, so a lasting one is logged once */
  private problem: string | null = null

  constructor(
    private readonly source: ScriptNetworkSource,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** The subnets in use, or null while they are unknown (every peer is refused then). */
  get subnets(): readonly string[] | null {
    return this.list ? this.known : null
  }

  /**
   * Replaces the subnets. Entries that are not CIDR ranges are skipped with a warning; an empty result leaves the
   * subnets unknown, so the check keeps failing closed.
   */
  setSubnets(subnets: readonly string[]): void {
    const list = new BlockList()
    const accepted: string[] = []
    for (const subnet of subnets) {
      const slash = subnet.indexOf('/')
      const address = slash === -1 ? '' : subnet.slice(0, slash)
      const bits = Number(subnet.slice(slash + 1))
      const family = familyOf(address)
      if (!family || !Number.isInteger(bits) || bits < 0 || bits > (family === 'ipv4' ? 32 : 128)) {
        this.log.warn('ignoring a subnet of the scripts network that is not a CIDR range', { network: SCRIPTS_NETWORK, subnet })
        continue
      }
      list.addSubnet(address, bits, family)
      accepted.push(subnet)
    }
    this.list = accepted.length > 0 ? list : null
    this.known = accepted
  }

  /** True when `address` (the socket peer; IPv4-mapped IPv6 is normalised) lies in a subnet of the scripts network. */
  readonly isPeer = (address: string | null | undefined): boolean => {
    if (!this.list) {
      if (this.now() - this.lastRefresh >= SCRIPT_NETWORK_REFRESH_MS) void this.refresh()
      return false
    }
    if (!address) return false
    const normalised = stripIpv4Mapped(address)
    const family = familyOf(normalised)
    return family !== null && this.list.check(normalised, family)
  }

  /**
   * Inspects the network again; concurrent calls share one inspection. Resolves true when the subnets are known
   * afterwards. Never throws: a missing network or a Docker error keeps the previous subnets and logs a warning.
   */
  refresh(): Promise<boolean> {
    this.refreshing ??= this.load().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async load(): Promise<boolean> {
    this.lastRefresh = this.now()
    try {
      const subnets = await this.source()
      if (subnets === null) {
        if (!this.list) this.warnOnce('the scripts network does not exist; the script runtime API refuses every request until it does')
        return this.list !== null
      }
      const previous = this.known.join(',')
      this.setSubnets(subnets)
      if (!this.list) {
        this.warnOnce('the scripts network has no subnet; the script runtime API refuses every request')
        return false
      }
      this.problem = null
      if (this.known.join(',') !== previous) {
        this.log.info('the script runtime API accepts the scripts network only', { network: SCRIPTS_NETWORK, subnets: this.known })
      }
      return true
    } catch (error) {
      this.warnOnce('inspecting the scripts network failed; keeping the previous subnets', error)
      return this.list !== null
    }
  }

  private warnOnce(message: string, error?: unknown): void {
    if (this.problem === message) return
    this.problem = message
    this.log.warn(message, { network: SCRIPTS_NETWORK, ...(error === undefined ? {} : { err: error }) })
  }
}

let instance: ScriptNetwork | null = null

/** The process-wide scripts network, inspected through the Docker daemon. */
export function useScriptNetwork(): ScriptNetwork {
  instance ??= new ScriptNetwork(dockerScriptNetworkSource, useLogger('script-network'))
  return instance
}

/** True when a socket peer address lies in a subnet of `scantor-scripts`; false (fail closed) while they are unknown. */
export function isScriptNetworkPeer(address: string | null | undefined): boolean {
  return useScriptNetwork().isPeer(address)
}

/** Test seam: replaces the process-wide instance. */
export function setScriptNetworkForTesting(network: ScriptNetwork | null): void {
  instance = network
}
