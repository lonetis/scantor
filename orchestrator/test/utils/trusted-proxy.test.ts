import { describe, expect, it, vi } from 'vitest'
import { useLogger } from '../../server/utils/logger'
import { MISS_REFRESH_MS, TrustedProxies, type TrustedProxySource } from '../../server/utils/trusted-proxy'

// Trusted reverse proxies (docs/auth.md §4.3, security.md AUTH-6): only the configured peers may set the client IP.

function source(hosts: Record<string, string[] | Error>, subnets: string[] | Error = []): TrustedProxySource & { lookups: string[] } {
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

  it('follows a new address after a miss, at most every few seconds', async () => {
    let now = 0
    const hosts: Record<string, string[]> = { traefik: ['10.10.1.5'] }
    const lookup = source(hosts)
    const proxies = new TrustedProxies(['traefik'], lookup, log, () => now)
    await proxies.refresh()
    hosts.traefik = ['10.10.1.8']

    // Within MISS_REFRESH_MS of the last refresh a miss does not look up again.
    now = MISS_REFRESH_MS - 1
    expect(proxies.isTrusted('10.10.1.8')).toBe(false)
    expect(lookup.lookups).toHaveLength(1)

    now = MISS_REFRESH_MS
    expect(proxies.isTrusted('10.10.1.8')).toBe(false)
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
