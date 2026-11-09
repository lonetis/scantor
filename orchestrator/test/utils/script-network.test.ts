import { describe, expect, it } from 'vitest'
import { useLogger } from '../../server/utils/logger'
import { SCRIPT_NETWORK_REFRESH_MS, ScriptNetwork, type ScriptNetworkSource } from '../../server/utils/script-network'

// The peer restriction of the script runtime API (docs/scripts.md, docs/security.md): only peers in the subnets of
// `scantor-scripts`; every peer is refused while the subnets are unknown (fail closed).

const log = useLogger('script-network-test')

function source(answers: (string[] | null | Error)[]): ScriptNetworkSource & { calls: number } {
  const fn = Object.assign(
    async () => {
      const answer = answers[Math.min(fn.calls, answers.length - 1)]
      fn.calls++
      if (answer instanceof Error) throw answer
      return answer ?? null
    },
    { calls: 0 },
  )
  return fn
}

describe('ScriptNetwork', () => {
  it('refuses every peer before the subnets are known', () => {
    const network = new ScriptNetwork(source([null]), log)
    expect(network.subnets).toBeNull()
    expect(network.isPeer('172.30.0.5')).toBe(false)
    expect(network.isPeer(undefined)).toBe(false)
  })

  it('accepts peers inside the inspected subnets, IPv4-mapped IPv6 included', async () => {
    const network = new ScriptNetwork(source([['172.30.0.0/16', 'fd00:5c::/64']]), log)
    expect(await network.refresh()).toBe(true)
    expect(network.subnets).toEqual(['172.30.0.0/16', 'fd00:5c::/64'])
    expect(network.isPeer('172.30.4.2')).toBe(true)
    expect(network.isPeer('::ffff:172.30.4.2')).toBe(true)
    expect(network.isPeer('fd00:5c::7')).toBe(true)
    expect(network.isPeer('172.31.0.1')).toBe(false)
    expect(network.isPeer('127.0.0.1')).toBe(false)
    expect(network.isPeer('::1')).toBe(false)
    expect(network.isPeer('fd00:5d::7')).toBe(false)
    expect(network.isPeer('not an address')).toBe(false)
    expect(network.isPeer('')).toBe(false)
  })

  it('stays closed when the network is missing, has no subnet or Docker fails, and keeps known subnets on errors', async () => {
    const missing = new ScriptNetwork(source([null]), log)
    expect(await missing.refresh()).toBe(false)
    expect(missing.isPeer('172.30.0.5')).toBe(false)

    const empty = new ScriptNetwork(source([[]]), log)
    expect(await empty.refresh()).toBe(false)
    expect(empty.subnets).toBeNull()

    const invalid = new ScriptNetwork(source([['not-a-cidr', '10.0.0.0/33']]), log)
    expect(await invalid.refresh()).toBe(false)
    expect(invalid.isPeer('10.0.0.1')).toBe(false)

    const flaky = new ScriptNetwork(source([['172.30.0.0/16'], new Error('docker is down'), null]), log)
    expect(await flaky.refresh()).toBe(true)
    expect(await flaky.refresh()).toBe(true)
    expect(await flaky.refresh()).toBe(true)
    expect(flaky.isPeer('172.30.0.9')).toBe(true)
  })

  it('inspects again on a refused check while unknown, at most every SCRIPT_NETWORK_REFRESH_MS', async () => {
    let now = 1_000_000
    const lookups = source([null, ['172.30.0.0/16']])
    const network = new ScriptNetwork(lookups, log, () => now)
    // The refused check starts an inspection; refresh() joins it.
    expect(network.isPeer('172.30.0.5')).toBe(false)
    expect(await network.refresh()).toBe(false)
    expect(lookups.calls).toBe(1)
    expect(network.isPeer('172.30.0.5')).toBe(false)
    expect(lookups.calls).toBe(1)
    now += SCRIPT_NETWORK_REFRESH_MS
    expect(network.isPeer('172.30.0.5')).toBe(false)
    expect(await network.refresh()).toBe(true)
    expect(lookups.calls).toBe(2)
    expect(network.isPeer('172.30.0.5')).toBe(true)
  })

  it('setSubnets replaces the subnets directly', () => {
    const network = new ScriptNetwork(source([null]), log)
    network.setSubnets(['10.9.0.0/24'])
    expect(network.isPeer('10.9.0.200')).toBe(true)
    network.setSubnets(['10.8.0.0/24'])
    expect(network.isPeer('10.9.0.200')).toBe(false)
    network.setSubnets([])
    expect(network.subnets).toBeNull()
    expect(network.isPeer('10.8.0.1')).toBe(false)
  })
})
