import { describe, expect, it } from 'vitest'
import { daemonOverrideValues, updateNodeDaemonOverridesBody } from '#shared/schemas/nodes'
import { ALWAYS_REFUSED_RANGES, dnsServerProblem, dnsServerProblemMessage, isDnsServer, type DnsServerProblem } from '#shared/utils/dns-servers'
import { readRepoFile } from '../helpers/repo'

// The DNS servers of daemon overrides (docs/nodes.md §6.12, docs/api.md §4.17): the syntax of the Go daemon's
// ParseDNSServer (an IP address, ip:port or [v6]:port; no zone, unicast, not IPv6 link-local), and no server in the
// ranges the node resolver refuses unless the node environment configures it (internal/resolver AlwaysRefused): such
// servers can be configured only in SCANTOR_NODE_DNS_*. internal/cli/nodes_daemon_test.go checks the same cases
// against the CLI.

const CASES: Record<string, DnsServerProblem | null> = {
  '1.1.1.1': null,
  '1.1.1.1:53': null,
  '1.1.1.1:5353': null,
  '2606:4700::1111': null,
  '[2606:4700::1111]:53': null,
  '[::ffff:1.2.3.4]:53': null,
  '::ffff:9.9.9.9': null,
  '192.0.2.1:53': null,
  '100.128.0.1': null,
  '172.32.0.1': null,
  '2001:4860:4860::8888': null,
  '[2620:fe::fe]:65535': null,
  '1:2:3:4:5:6:7::': null,
  host: 'syntax',
  '': 'syntax',
  '1.1.1': 'syntax',
  '01.1.1.1': 'syntax',
  '1.1.1.1:0': 'syntax',
  '1.1.1.1:053': 'syntax',
  '1.1.1.1:65536': 'syntax',
  '[1.1.1.1]:53': 'syntax',
  '[2606:4700::1111]': 'syntax',
  'dns.google': 'syntax',
  '1.1.1.1:': 'syntax',
  '1.2.3.4::53': 'syntax',
  ':::': 'syntax',
  '::::': 'syntax',
  '[1.2.3.4:5]:53': 'syntax',
  '1.2.3.4:53:': 'syntax',
  '::ffff:1.2.3.4:53': 'syntax',
  'abc:def': 'syntax',
  'a:b': 'syntax',
  '1:2:3:4:5:6:7:8:9': 'syntax',
  '::1:2:3:4:5:6:7:8': 'syntax',
  '1::2::3': 'syntax',
  '12345::1': 'syntax',
  '1.2.3.4::': 'syntax',
  '[a:b]:53': 'syntax',
  '1.1.1.1:53.5': 'syntax',
  '1.2.3.4:53:53': 'syntax',
  'fe80::1%eth0': 'zone',
  '[fe80::1%eth0]:53': 'zone',
  'fe80::1%': 'zone',
  'nope%eth0': 'syntax',
  '0.0.0.0': 'notUnicast',
  '::': 'notUnicast',
  '[::]:53': 'notUnicast',
  '224.0.0.1': 'notUnicast',
  '239.255.255.250:1900': 'notUnicast',
  'ff02::1': 'notUnicast',
  '::ffff:0.0.0.0': 'notUnicast',
  'fe80::1': 'linkLocal',
  '[febf::1]:53': 'linkLocal',
  '10.0.0.2': 'alwaysRefused',
  '127.0.0.1:5353': 'alwaysRefused',
  '100.100.100.100': 'alwaysRefused',
  '169.254.169.254': 'alwaysRefused',
  '172.17.0.1:1053': 'alwaysRefused',
  '192.168.1.1': 'alwaysRefused',
  '192.0.0.8': 'alwaysRefused',
  '198.18.0.1': 'alwaysRefused',
  '240.0.0.1': 'alwaysRefused',
  '0.1.2.3': 'alwaysRefused',
  '::1': 'alwaysRefused',
  '[::1]:53': 'alwaysRefused',
  'fd00::53': 'alwaysRefused',
  '64:ff9b::808:808': 'alwaysRefused',
  '64:ff9b:1::1': 'alwaysRefused',
  '::ffff:10.0.0.1': 'alwaysRefused',
}

describe('dnsServerProblem', () => {
  it.each(Object.entries(CASES))('%s → %s', (server, problem) => {
    expect(dnsServerProblem(server, { override: true })).toBe(problem)
  })

  it('leaves the override ranges to overrides: the node environment may name such servers', () => {
    for (const server of ['10.0.0.2', '172.17.0.1:1053', '169.254.169.253', '::1', '[fd00::53]:5353']) {
      expect(dnsServerProblem(server, { override: false }), server).toBeNull()
      expect(isDnsServer(server), server).toBe(true)
    }
    for (const server of ['0.0.0.0', 'fe80::1', 'fe80::1%eth0', 'ff02::1', '1.1.1.1:0']) expect(isDnsServer(server), server).toBe(false)
  })

  it('names the host keyword in the syntax message of lists that take it', () => {
    expect(dnsServerProblemMessage('syntax', true)).toBe('must be an IP address, ip:port, [v6]:port or host')
    expect(dnsServerProblemMessage('syntax', false)).toBe('must be an IP address, ip:port or [v6]:port')
  })
})

describe('the override schemas', () => {
  const issues = (body: unknown) => {
    const result = updateNodeDaemonOverridesBody.safeParse(body)
    return result.success ? [] : result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
  }

  it('answer 400 with the reason per entry', () => {
    expect(issues({ dns: { upstreams: ['host', '10.0.0.2'], rootServers: ['fe80::53', '224.0.0.1:53', 'x'] } })).toEqual([
      { path: 'dns.upstreams.1', message: 'private and special-purpose servers can only be configured in the node environment (SCANTOR_NODE_DNS_*)' },
      { path: 'dns.rootServers.0', message: 'IPv6 link-local addresses are not supported' },
      { path: 'dns.rootServers.1', message: 'must be a unicast address (not unspecified or multicast)' },
      { path: 'dns.rootServers.2', message: 'must be an IP address, ip:port or [v6]:port' },
    ])
    expect(issues({ dns: { upstreams: ['[fe80::1%eth0]:53'] } })).toEqual([{ path: 'dns.upstreams.0', message: 'zoned addresses are not supported' }])
  })

  it('accept public servers, trimmed', () => {
    expect(daemonOverrideValues.parse({ dns: { upstreams: [' 9.9.9.9 ', 'host'], rootServers: ['[2001:503:ba3e::2:30]:53'] } })).toEqual({
      dns: { upstreams: ['9.9.9.9', 'host'], rootServers: ['[2001:503:ba3e::2:30]:53'] },
    })
  })
})

describe('ALWAYS_REFUSED_RANGES', () => {
  it('are the ranges of internal/resolver AlwaysRefused', () => {
    const source = readRepoFile('internal/resolver/dialer.go')
    const list = /var alwaysRefused = func\(\) \[\]netip\.Prefix \{[\s\S]*?range \[\]string\{([\s\S]*?)\} \{/.exec(source)
    expect(list, 'the alwaysRefused list in internal/resolver/dialer.go').not.toBeNull()
    const ranges = [...list![1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1])
    expect(ranges).toEqual([...ALWAYS_REFUSED_RANGES])
  })

  it('refuse an address at both ends of every range and nothing just outside of it', () => {
    for (const [inside, outside] of [
      ['10.255.255.255', '11.0.0.0'],
      ['100.127.255.255', '100.63.255.255'],
      ['172.31.255.255', '172.15.255.255'],
      ['192.0.0.255', '192.0.1.0'],
      ['198.19.255.255', '198.20.0.0'],
      ['255.255.255.254', '223.255.255.255'],
      ['fdff:ffff::1', 'fe00::1'],
      ['64:ff9b::ffff:ffff', '64:ff9b::1:0:0'],
      ['64:ff9b:1:ffff::1', '64:ff9b:2::1'],
    ] as const) {
      expect(dnsServerProblem(inside, { override: true }), inside).toBe('alwaysRefused')
      expect(dnsServerProblem(outside, { override: true }), outside).toBeNull()
    }
  })
})
