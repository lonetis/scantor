import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import type { Config } from '../../utils/config'

// The boot check of docs/nodes.md §11: remote nodes and their workers get only the public endpoint profile, and
// they refuse plaintext (`http://`, `amqp://`) unless every address of the host is loopback, RFC 1918, CGNAT or IPv6
// ULA (security.md TLS-1). A plaintext public endpoint on another host would therefore fail on every remote node;
// the orchestrator warns at boot instead of letting the operator find out from refused nodes.

const PRIVATE = new BlockList()
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4')
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4')
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4')
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4')
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4')
PRIVATE.addAddress('::1', 'ipv6')
PRIVATE.addSubnet('fc00::', 7, 'ipv6')

/** True for the addresses remote clients may reach in plaintext. */
export function isPlaintextAllowedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  return PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

export type ResolveAll = (host: string) => Promise<string[]>

/** DNS must not hold up the boot: a host that does not resolve within this time is reported as unresolved. */
const RESOLVE_TIMEOUT_MS = 3000

const resolveAll: ResolveAll = async (host) => {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`resolving ${host} timed out`)), RESOLVE_TIMEOUT_MS)
  })
  try {
    return (await Promise.race([lookup(host, { all: true }), timeout])).map((entry) => entry.address)
  } finally {
    clearTimeout(timer)
  }
}

export interface PlaintextEndpoint {
  variable: string
  url: string
  /** a public address of the host, or null when the host could not be resolved */
  address: string | null
}

/**
 * The plaintext public endpoints whose host has an address outside the private ranges. Hosts that do not resolve
 * from the orchestrator are reported with `address: null`; remote nodes may still resolve them.
 */
export async function plaintextPublicEndpoints(
  config: Pick<Config, 'publicUrl' | 'amqpPublicUrl' | 's3PublicUrl'>,
  resolve: ResolveAll = resolveAll,
): Promise<PlaintextEndpoint[]> {
  const endpoints = [
    ['SCANTOR_PUBLIC_URL', config.publicUrl],
    ['SCANTOR_AMQP_PUBLIC_URL', config.amqpPublicUrl],
    ['SCANTOR_S3_PUBLIC_URL', config.s3PublicUrl],
  ] as const
  const found: PlaintextEndpoint[] = []
  for (const [variable, value] of endpoints) {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'amqp:') continue
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
    let addresses: string[]
    try {
      addresses = isIP(host) ? [host] : await resolve(host)
    } catch {
      found.push({ variable, url: value, address: null })
      continue
    }
    const exposed = addresses.find((address) => !isPlaintextAllowedAddress(address))
    if (exposed) found.push({ variable, url: value, address: exposed })
  }
  return found
}
