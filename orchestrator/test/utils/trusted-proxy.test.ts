import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseConfig, setConfigForTesting } from '../../server/utils/config'
import { useLogger } from '../../server/utils/logger'
import { SANDBOX_NETWORK, SCRIPTS_NETWORK } from '../../server/utils/docker'
import {
  attachedSubnetsOf,
  MISS_REFRESH_MS,
  networkSubnets,
  proxyTrust,
  TRUST_NO_PROXY,
  TrustedProxies,
  trustedProxyEntries,
  type TrustedProxySource,
  UNTRUSTED_NETWORKS,
  useTrustedProxies,
} from '../../server/utils/trusted-proxy'
import { TUNNEL_PROXY_HOST } from '../../server/utils/tunnel'

// Trusted reverse proxies (docs/auth.md §4.3, security.md AUTH-6): only the configured peers may set the client IP.

/** A fake source; the process is attached to `attached` (10.10.0.0/16, the compose networks of these tests). */
function source(
  hosts: Record<string, string[] | Error>,
  subnets: string[] | Error = [],
  attached: string[] = ['10.10.0.0/16'],
): TrustedProxySource & { lookups: string[] } {
  const lookups: string[] = []
  return {
    lookups,
    async resolve(host) {
      lookups.push(host)
      const answer = hosts[host]
      if (answer instanceof Error) throw answer
      return answer ?? []
    },
    async untrustedSubnets() {
      if (subnets instanceof Error) throw subnets
      return subnets
    },
    attachedSubnets: () => attached,
  }
}

const log = useLogger('trusted-proxy-test')

describe('TrustedProxies', () => {
  it('trusts the addresses a host name resolves to, and nothing before the first refresh', async () => {
    const proxies = new TrustedProxies(['traefik'], source({ traefik: ['10.10.1.5', '::ffff:10.10.1.6'] }), log)
    expect(proxies.isTrusted('10.10.1.5')).toBe(false)
    await proxies.refresh()
    expect(proxies.isTrusted('10.10.1.5')).toBe(true)
    expect(proxies.isTrusted('::ffff:10.10.1.6')).toBe(true)
    expect(proxies.isTrusted('10.10.1.7')).toBe(false)
    expect(proxies.isTrusted('unknown')).toBe(false)
  })

  it('trusts literal addresses and CIDR ranges without any lookup', () => {
    const lookup = source({})
    const proxies = new TrustedProxies(['192.0.2.1', '198.51.100.0/24', 'fd00::/8'], lookup, log)
    expect(proxies.isTrusted('192.0.2.1')).toBe(true)
    expect(proxies.isTrusted('::ffff:198.51.100.77')).toBe(true)
    expect(proxies.isTrusted('fd12::1')).toBe(true)
    expect(proxies.isTrusted('192.0.2.2')).toBe(false)
    expect(lookup.lookups).toEqual([])
  })

  it('never trusts a peer in the scantor-sandbox subnets, whatever the list says', async () => {
    const proxies = new TrustedProxies(['10.0.0.0/8', 'traefik'], source({ traefik: ['10.10.2.9', '10.10.1.5'] }, ['10.10.2.0/24']), log)
    await proxies.refresh()
    expect(proxies.isTrusted('10.10.2.9')).toBe(false)
    expect(proxies.isTrusted('10.10.2.200')).toBe(false)
    expect(proxies.isTrusted('10.10.1.5')).toBe(true)
    expect(proxies.isTrusted('10.20.0.1')).toBe(true)
  })

  it('never trusts a peer in the scantor-scripts subnets either, even when the list covers it', async () => {
    const networks = new Map<string, string[]>([
      [SANDBOX_NETWORK, ['10.10.2.0/24']],
      [SCRIPTS_NETWORK, ['10.10.3.0/24', 'fd00:3::/64']],
    ])
    const docker = {
      getNetwork: (name: string) => ({
        inspect: async () => {
          const subnets = networks.get(name)
          if (!subnets) throw Object.assign(new Error('no such network'), { statusCode: 404 })
          return { IPAM: { Config: subnets.map((subnet) => ({ Subnet: subnet })) } }
        },
      }),
    }
    expect(UNTRUSTED_NETWORKS).toEqual([SANDBOX_NETWORK, SCRIPTS_NETWORK])
    const subnets = await networkSubnets(docker as never, UNTRUSTED_NETWORKS)
    expect(subnets).toEqual(['10.10.2.0/24', '10.10.3.0/24', 'fd00:3::/64'])
    const proxies = new TrustedProxies(['10.0.0.0/8', 'fd00::/8'], source({}, subnets), log)
    await proxies.refresh()
    expect(proxies.isTrusted('10.10.3.7')).toBe(false)
    expect(proxies.isTrusted('fd00:3::7')).toBe(false)
    expect(proxies.isTrusted('10.10.2.7')).toBe(false)
    expect(proxies.isTrusted('10.10.1.5')).toBe(true)
    // A missing network contributes nothing; another Docker error is passed on (the refresh keeps the last result).
    networks.delete(SCRIPTS_NETWORK)
    expect(await networkSubnets(docker as never, UNTRUSTED_NETWORKS)).toEqual(['10.10.2.0/24'])
    const failing = { getNetwork: () => ({ inspect: async () => Promise.reject(Object.assign(new Error('daemon down'), { statusCode: 500 })) }) }
    await expect(networkSubnets(failing as never, UNTRUSTED_NETWORKS)).rejects.toThrow('daemon down')
  })

  it('follows a new address after a miss, at most every few seconds', async () => {
    let now = 0
    const hosts: Record<string, string[]> = { traefik: ['10.10.1.5'] }
    const lookup = source(hosts)
    const proxies = new TrustedProxies(['traefik'], lookup, log, () => now)
    await proxies.refresh()
    // Counted on the call itself: a wrongly started refresh reaches the lookup only some microtasks later.
    const refresh = vi.spyOn(proxies, 'refresh')
    hosts.traefik = ['10.10.1.8']

    // Within MISS_REFRESH_MS of the last refresh a miss does not look up again.
    now = MISS_REFRESH_MS - 1
    expect(proxies.isTrusted('10.10.1.8')).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
    expect(lookup.lookups).toHaveLength(1)

    now = MISS_REFRESH_MS
    expect(proxies.isTrusted('10.10.1.8')).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(proxies.isTrusted('10.10.1.8')).toBe(true))
    expect(proxies.isTrusted('10.10.1.5')).toBe(false)
    expect(lookup.lookups).toHaveLength(2)
  })

  it('keeps the previous addresses when a lookup fails, and drops them when the name is gone', async () => {
    const hosts: Record<string, string[] | Error> = { traefik: ['10.10.1.5'] }
    const proxies = new TrustedProxies(['traefik'], source(hosts), log)
    await proxies.refresh()
    hosts.traefik = new Error('EAI_AGAIN')
    await proxies.refresh()
    expect(proxies.isTrusted('10.10.1.5')).toBe(true)
    hosts.traefik = []
    await proxies.refresh()
    expect(proxies.isTrusted('10.10.1.5')).toBe(false)
  })

  it('shares one refresh between concurrent callers', async () => {
    const lookup = source({ traefik: ['10.10.1.5'] })
    const proxies = new TrustedProxies(['traefik'], lookup, log)
    await Promise.all([proxies.refresh(), proxies.refresh(), proxies.refresh()])
    expect(lookup.lookups).toEqual(['traefik'])
  })
})

describe('TrustedProxies.isHostPeer (the tunnel peer, utils/tunnel.ts)', () => {
  it('is true only for an address of that very host name', async () => {
    const proxies = new TrustedProxies(['traefik', 'cloudflared'], source({ traefik: ['10.10.1.5'], cloudflared: ['10.10.1.9', '::ffff:10.10.1.10'] }), log)
    expect(proxies.isHostPeer('cloudflared', '10.10.1.9')).toBe(false)
    await proxies.refresh()
    expect(proxies.isHostPeer('cloudflared', '10.10.1.9')).toBe(true)
    expect(proxies.isHostPeer('cloudflared', '::ffff:10.10.1.9')).toBe(true)
    expect(proxies.isHostPeer('cloudflared', '10.10.1.10')).toBe(true)
    // Traefik is a trusted proxy, but never the tunnel peer, and the other way round.
    expect(proxies.isHostPeer('cloudflared', '10.10.1.5')).toBe(false)
    expect(proxies.isHostPeer('traefik', '10.10.1.9')).toBe(false)
    expect(proxies.isTrusted('10.10.1.5')).toBe(true)
    expect(proxies.isTrusted('10.10.1.9')).toBe(true)
    for (const peer of ['10.10.1.77', 'not an address', '']) expect(proxies.isHostPeer('cloudflared', peer), peer).toBe(false)
    expect(proxies.isHostPeer('unknown', '10.10.1.9')).toBe(false)
  })

  it('never takes an address in the sandbox or scripts subnets for the host (a container aliased cloudflared)', async () => {
    const proxies = new TrustedProxies(['cloudflared'], source({ cloudflared: ['10.10.2.9', '10.10.3.9', '10.10.1.9'] }, ['10.10.2.0/24', '10.10.3.0/24']), log)
    await proxies.refresh()
    expect(proxies.isHostPeer('cloudflared', '10.10.2.9')).toBe(false)
    expect(proxies.isHostPeer('cloudflared', '10.10.3.9')).toBe(false)
    expect(proxies.isTrusted('10.10.2.9')).toBe(false)
    expect(proxies.isHostPeer('cloudflared', '10.10.1.9')).toBe(true)
  })

  it('looks the host up again after a miss only when asked to, and at most every few seconds', async () => {
    let now = 0
    const hosts: Record<string, string[]> = { cloudflared: ['10.10.1.9'] }
    const lookup = source(hosts)
    const proxies = new TrustedProxies(['cloudflared'], lookup, log, () => now)
    await proxies.refresh()
    // Counted on the call itself: a wrongly started refresh reaches the lookup only some microtasks later.
    const refresh = vi.spyOn(proxies, 'refresh')
    hosts.cloudflared = ['10.10.1.11']

    // A request for another host misses without any lookup, however long ago the last refresh was.
    now = 10 * MISS_REFRESH_MS
    expect(proxies.isHostPeer('cloudflared', '10.10.1.11')).toBe(false)
    expect(proxies.isHostPeer('cloudflared', '10.10.1.11', false)).toBe(false)
    expect(refresh).not.toHaveBeenCalled()

    // A request for the tunnel host refreshes, but not again within MISS_REFRESH_MS.
    expect(proxies.isHostPeer('cloudflared', '10.10.1.11', true)).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(proxies.isHostPeer('cloudflared', '10.10.1.11')).toBe(true))
    expect(lookup.lookups).toHaveLength(2)
    expect(proxies.isHostPeer('cloudflared', '10.10.1.9')).toBe(false)
    hosts.cloudflared = ['10.10.1.12']
    now += MISS_REFRESH_MS - 1
    expect(proxies.isHostPeer('cloudflared', '10.10.1.12', true)).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(lookup.lookups).toHaveLength(2)
  })

  it('takes cloudflared only at addresses on an attached network, never wherever DNS points', async () => {
    // With no container called cloudflared, Docker's DNS asks the host's resolvers, and a LAN host can answer.
    const hosts = { cloudflared: ['192.168.1.50', '10.10.4.9'], traefik: ['192.168.1.60'] }
    const proxies = new TrustedProxies(['traefik', 'cloudflared'], source(hosts, [], ['10.10.4.0/24', 'fd00:4::/64']), log)
    await proxies.refresh()
    expect(proxies.isHostPeer('cloudflared', '192.168.1.50')).toBe(false)
    expect(proxies.isTrusted('192.168.1.50')).toBe(false)
    expect(proxies.isHostPeer('cloudflared', '10.10.4.9')).toBe(true)
    expect(proxies.isTrusted('10.10.4.9')).toBe(true)
    // The operator's entries may name a proxy elsewhere: no restriction for them.
    expect(proxies.isTrusted('192.168.1.60')).toBe(true)
    // Once cloudflared leaves the attached network, its old address no longer counts either.
    hosts.cloudflared = ['192.168.1.50']
    await proxies.refresh()
    expect(proxies.isHostPeer('cloudflared', '10.10.4.9')).toBe(false)
    expect(proxies.isTrusted('10.10.4.9')).toBe(false)
  })
})

describe('attachedSubnetsOf', () => {
  it('lists the subnets of the network interfaces without loopback and IPv6 link-local ones', () => {
    const entry = (family: 'IPv4' | 'IPv6', cidr: string | null, internal = false, scopeid = 0) =>
      ({ address: '', netmask: '', mac: '', family, cidr, internal, ...(family === 'IPv6' ? { scopeid } : {}) }) as never
    expect(
      attachedSubnetsOf({
        lo: [entry('IPv4', '127.0.0.1/8', true), entry('IPv6', '::1/128', true)],
        eth0: [entry('IPv4', '172.20.0.3/16'), entry('IPv6', 'fd00:4::3/64'), entry('IPv6', 'fe80::42:acff:fe14:3/64', false, 2)],
        eth1: [entry('IPv4', '172.21.0.2/16')],
        eth2: undefined,
      }),
    ).toEqual(['172.20.0.3/16', 'fd00:4::3/64', '172.21.0.2/16'])
  })
})

describe('trustedProxyEntries and useTrustedProxies', () => {
  afterEach(() => {
    setConfigForTesting(null)
  })

  it('adds cloudflared whenever a tunnel URL is set, whatever SCANTOR_TRUST_PROXY says', () => {
    const tunnelUrl = 'https://tunnel.example.com'
    expect(TUNNEL_PROXY_HOST).toBe('cloudflared')
    expect(trustedProxyEntries({ trustProxy: false, trustedProxies: ['traefik'], tunnelUrl: null })).toEqual([])
    expect(trustedProxyEntries({ trustProxy: false, trustedProxies: ['traefik'], tunnelUrl })).toEqual(['cloudflared'])
    expect(trustedProxyEntries({ trustProxy: true, trustedProxies: ['traefik', '10.0.0.0/8'], tunnelUrl: null })).toEqual(['traefik', '10.0.0.0/8'])
    expect(trustedProxyEntries({ trustProxy: true, trustedProxies: ['traefik'], tunnelUrl })).toEqual(['traefik', 'cloudflared'])
    expect(trustedProxyEntries({ trustProxy: true, trustedProxies: ['cloudflared', 'traefik'], tunnelUrl })).toEqual(['cloudflared', 'traefik'])
  })

  it('trusts no proxy without SCANTOR_TRUST_PROXY and without a tunnel URL, and a resolver with the tunnel URL', () => {
    setConfigForTesting(parseConfig({ SCANTOR_TRUST_PROXY: 'false' }).config)
    expect(useTrustedProxies()).toBeNull()
    expect(proxyTrust()).toBe(TRUST_NO_PROXY)
    // Creating the resolver looks nothing up; the first refresh does.
    setConfigForTesting(parseConfig({ SCANTOR_TRUST_PROXY: 'false', SCANTOR_TUNNEL_URL: 'https://tunnel.example.com' }).config)
    const proxies = useTrustedProxies()
    expect(proxies).toBeInstanceOf(TrustedProxies)
    expect(proxyTrust()).toBe(proxies!.isTrusted)
  })
})
