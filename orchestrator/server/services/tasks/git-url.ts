import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { apiError, validationError } from '../../utils/errors'

// The git URL pre-check (docs/editor.md §9.7, security.md WS-6), applied by the orchestrator before it starts a git
// helper (which applies the same rules again and pins the validated address): `https://` only, no userinfo, no
// leading `-`, and a host that resolves only to public addresses (not loopback, private, link-local, CGNAT or ULA)
// unless SCANTOR_GIT_ALLOW_PRIVATE=true.

const blocked = new BlockList()
// IPv4: unspecified, private, CGNAT, loopback, link-local, benchmarking, multicast and reserved ranges.
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4')
}
// IPv6: unspecified, loopback, ULA, link-local, multicast.
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6')
}

/** True when an IP address is not a public unicast address (IPv4-mapped IPv6 addresses are checked as IPv4). */
export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return blocked.check(address, 'ipv4')
  if (family === 6) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
    if (mapped) return blocked.check(mapped[1]!, 'ipv4')
    return blocked.check(address, 'ipv6')
  }
  return true
}

export type AddressLookup = (hostname: string) => Promise<string[]>

const systemLookup: AddressLookup = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)

export interface CheckedGitUrl {
  /** the URL as given (trimmed) */
  url: string
  /** `host[:port]` as the credential host match uses it (lowercase, default port dropped) */
  host: string
}

function urlIssue(message: string) {
  return validationError([{ path: 'url', message }], `invalid git URL: ${message}`)
}

/** Validates the syntax of a git URL (no network). */
export function parseGitUrl(raw: string): CheckedGitUrl & { hostname: string } {
  const value = raw.trim()
  if (value.startsWith('-')) throw urlIssue('must not start with "-"')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw urlIssue('is not a valid URL')
  }
  if (url.protocol !== 'https:') throw urlIssue('must use https://')
  if (url.username || url.password) throw urlIssue('must not contain credentials; use a git credential instead')
  if (!url.hostname) throw urlIssue('must name a host')
  if (url.hostname.startsWith('-')) throw urlIssue('the host must not start with "-"')
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  return { url: value, host: url.host.toLowerCase(), hostname }
}

/**
 * Validates a git URL and, unless private hosts are allowed, that every address of its host is public. Syntax
 * errors and private hosts are 400 validationFailed; a host that does not resolve is 422 gitFailed.
 */
export async function checkGitUrl(raw: string, options: { allowPrivate: boolean; lookup?: AddressLookup }): Promise<CheckedGitUrl> {
  const parsed = parseGitUrl(raw)
  if (options.allowPrivate) return { url: parsed.url, host: parsed.host }
  let addresses: string[]
  if (isIP(parsed.hostname)) addresses = [parsed.hostname]
  else {
    try {
      addresses = await (options.lookup ?? systemLookup)(parsed.hostname)
    } catch {
      throw apiError('gitFailed', `cannot resolve host ${parsed.hostname}`, { message: `cannot resolve host ${parsed.hostname}` })
    }
  }
  if (addresses.length === 0) throw apiError('gitFailed', `cannot resolve host ${parsed.hostname}`, { message: `cannot resolve host ${parsed.hostname}` })
  const offending = addresses.find(isNonPublicAddress)
  if (offending) throw urlIssue(`host ${parsed.hostname} resolves to the non-public address ${offending}`)
  return { url: parsed.url, host: parsed.host }
}
