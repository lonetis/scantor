// DNS servers of daemon overrides (docs/nodes.md §6.12, docs/api.md §4.17), shared by the API schema, the UI form and
// the tests. The syntax is the one of the Go daemon (internal/node ParseDNSServer) and the CLI: an IPv4 or IPv6
// literal, `ip:port` or `[v6]:port` (port 1–65535 without leading zeros), never a zone, the unspecified address, a
// multicast address or an IPv6 link-local address. A daemon override never names a server in the ranges the node
// resolver refuses unless the node environment configures the server (internal/resolver AlwaysRefused): those can be
// configured only in SCANTOR_NODE_DNS_*. Bundled into the UI, so it parses addresses itself (no node:net).

/**
 * The ranges of internal/resolver AlwaysRefused: private, loopback, link-local, shared, benchmark, multicast and
 * reserved space and the NAT64 prefixes (test/shared/dns-servers.test.ts compares them with the Go list).
 */
export const ALWAYS_REFUSED_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
] as const

/** Why a value is not a DNS server a daemon override may name. */
export type DnsServerProblem = 'syntax' | 'zone' | 'notUnicast' | 'linkLocal' | 'alwaysRefused'

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const HEX_WORD = /^[0-9A-Fa-f]{1,4}$/
const PORT = /^([1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/
const IPV4_WITH_PORT = /^([\d.]+):(\d+)$/
const BRACKETED = /^\[([^\]]+)\]:(\d+)$/

/** The 4 bytes of a dotted IPv4 address (no leading zeros), or null. */
function parseIpv4(text: string): number[] | null {
  return IPV4.test(text) ? text.split('.').map(Number) : null
}

/** The 16 bytes of an IPv6 address without zone (a dotted IPv4 tail allowed, `::` at most once), or null. */
function parseIpv6(text: string): number[] | null {
  if (!text.includes(':')) return null
  const halves = text.split('::')
  if (halves.length > 2) return null
  const words: number[][] = []
  for (const [h, half] of halves.entries()) {
    const out: number[] = []
    const parts = half === '' ? [] : half.split(':')
    for (const [i, part] of parts.entries()) {
      if (h === halves.length - 1 && i === parts.length - 1 && part.includes('.')) {
        const v4 = parseIpv4(part)
        if (!v4) return null
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!)
      } else if (HEX_WORD.test(part)) {
        out.push(Number.parseInt(part, 16))
      } else {
        return null
      }
    }
    words.push(out)
  }
  const head = words[0]!
  const tail = words[1] ?? []
  const count = head.length + tail.length
  // `::` stands for at least one zero word.
  if (halves.length === 2 ? count > 7 : count !== 8) return null
  return [...head, ...Array<number>(8 - count).fill(0), ...tail].flatMap((word) => [word >> 8, word & 0xff])
}

/** An IPv4-mapped IPv6 address as its IPv4 address (Go's netip Unmap); other addresses unchanged. */
function unmap(bytes: number[]): number[] {
  if (bytes.length === 16 && bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12)
  return bytes
}

interface Range {
  bytes: number[]
  bits: number
}

function parseRange(cidr: string): Range {
  const [address, bits] = cidr.split('/') as [string, string]
  return { bytes: (address.includes(':') ? parseIpv6(address) : parseIpv4(address))!, bits: Number(bits) }
}

/** Whether `range` contains `bytes`; an address of the other family never matches. */
function contains(range: Range, bytes: readonly number[]): boolean {
  if (range.bytes.length !== bytes.length) return false
  for (let i = 0, rest = range.bits; rest > 0; i++, rest -= 8) {
    const mask = rest >= 8 ? 0xff : (0xff << (8 - rest)) & 0xff
    if ((range.bytes[i]! & mask) !== (bytes[i]! & mask)) return false
  }
  return true
}

const REFUSED = ALWAYS_REFUSED_RANGES.map(parseRange)
const MULTICAST = ['224.0.0.0/4', 'ff00::/8'].map(parseRange)
const IPV6_LINK_LOCAL = parseRange('fe80::/10')

/** Splits a server into its address and port text (53 without a port), or null when its shape is wrong. */
function splitServer(value: string): { address: string; port: string } | null {
  if (IPV4.test(value)) return { address: value, port: '53' }
  const bracketed = BRACKETED.exec(value)
  if (bracketed) return bracketed[1]!.includes(':') ? { address: bracketed[1]!, port: bracketed[2]! } : null
  const withPort = IPV4_WITH_PORT.exec(value)
  if (withPort) return { address: withPort[1]!, port: withPort[2]! }
  // An IPv6 address without brackets has no port.
  return value.includes(':') && !value.includes('[') && !value.includes(']') ? { address: value, port: '53' } : null
}

/**
 * Why `value` is not a DNS server, or null when it is one: the syntax (`syntax`, `zone`) and the unicast rules
 * (`notUnicast`, `linkLocal`) of every DNS server setting; with `override`, also the ranges only the node environment
 * may name (`alwaysRefused`, internal/resolver AlwaysRefused after unmapping an IPv4-mapped address).
 */
export function dnsServerProblem(value: string, options: { override: boolean }): DnsServerProblem | null {
  const parts = splitServer(value)
  if (!parts || !PORT.test(parts.port)) return 'syntax'
  const zone = parts.address.indexOf('%')
  if (zone >= 0) return parseIpv6(parts.address.slice(0, zone)) ? 'zone' : 'syntax'
  const parsed = parts.address.includes(':') ? parseIpv6(parts.address) : parseIpv4(parts.address)
  if (!parsed) return 'syntax'
  const address = unmap(parsed)
  if (address.every((byte) => byte === 0) || MULTICAST.some((range) => contains(range, address))) return 'notUnicast'
  if (contains(IPV6_LINK_LOCAL, address)) return 'linkLocal'
  if (options.override && REFUSED.some((range) => contains(range, address))) return 'alwaysRefused'
  return null
}

/** A DNS server of any setting (the syntax and unicast rules of dnsServerProblem, without the override ranges). */
export function isDnsServer(value: string): boolean {
  return dnsServerProblem(value, { override: false }) === null
}

/** The validation message of a DNS server problem; `allowHost` for lists that also take the keyword `host`. */
export function dnsServerProblemMessage(problem: DnsServerProblem, allowHost: boolean): string {
  switch (problem) {
    case 'syntax':
      return allowHost ? 'must be an IP address, ip:port, [v6]:port or host' : 'must be an IP address, ip:port or [v6]:port'
    case 'zone':
      return 'zoned addresses are not supported'
    case 'notUnicast':
      return 'must be a unicast address (not unspecified or multicast)'
    case 'linkLocal':
      return 'IPv6 link-local addresses are not supported'
    case 'alwaysRefused':
      return 'private and special-purpose servers can only be configured in the node environment (SCANTOR_NODE_DNS_*)'
  }
}
