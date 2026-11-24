import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  allowedOverrideKeys,
  DAEMON_CONFIG_FIELDS,
  DAEMON_OVERRIDE_FIELDS,
  daemonConfigRows,
  daemonOverrideCount,
  daemonOverrideForm,
  daemonOverridesErrorText,
  daemonOverridesPatch,
  editOverridesBlocker,
  formatByteSizeInput,
  formatDaemonConfigValue,
  formatDurationInput,
  parseByteSizeInput,
  parseDurationInput,
  parseListInput,
  rejectedOverrides,
  resetOverridesBlocker,
  type DaemonOverrideForm,
} from '../../app/utils/daemon-config'
import { ApiError } from '../../app/utils/errors'
import { DAEMON_OVERRIDE_KEYS, type DaemonOverrideKey } from '../../shared/schemas/nodes'
import type { DaemonConfigValues, NodeDaemonConfig, ScantorNode } from '../../shared/types/nodes'

// The daemon configuration table and the daemon overrides form of the node page (docs/ui.md §5.15, docs/nodes.md
// §6.12): every setting has a row with its variable and source, and the form sends only the changed keys as a merge
// patch that updateNodeDaemonOverrides accepts.

const MiB = 1024 * 1024

const VALUES: DaemonConfigValues = {
  url: 'https://scantor.example.com',
  builtIn: false,
  maxWorkers: 0,
  dind: 'disabled',
  egressDeny: ['169.254.0.0/16', 'fd00:ec2::254/128'],
  allowUnisolatedNetworks: false,
  allowInsecureTransport: true,
  caCertificates: [],
  pidsLimit: 4096,
  shmSizeBytes: 256 * MiB,
  nofile: 65536,
  workerLogMaxSizeBytes: 20 * MiB,
  workerLogMaxFiles: 3,
  imageRetentionMs: 86_400_000,
  pullTimeoutMs: 1_800_000,
  logLevel: 'info',
  logFormat: 'json',
  overrides: 'all',
  dns: {
    mode: 'recursive',
    upstreams: ['1.1.1.1', '8.8.8.8'],
    rootServers: [],
    localDomains: [],
    cacheSizeBytes: 256 * MiB,
    maxLookups: 1000,
    upstreamQps: 0,
    authoritativeQps: 200,
  },
}

function daemonConfig(changes: Partial<NodeDaemonConfig> = {}): NodeDaemonConfig {
  return {
    values: structuredClone(VALUES),
    sources: { url: 'env', maxWorkers: 'default', dns: { mode: 'env' } },
    warnings: [],
    overrides: {},
    overridesRev: 0,
    appliedOverridesRev: 0,
    pending: false,
    rejected: {},
    overriddenBy: null,
    overriddenAt: null,
    reportedAt: '2026-11-24T08:00:00.000Z',
    ...changes,
  }
}

function node(changes: Partial<ScantorNode> = {}): ScantorNode {
  return {
    id: '2d9e3f4a-0b1c-4d2e-8f3a-5b6c7d8e9f01',
    name: 'scan-eu-1',
    builtIn: false,
    state: 'online',
    endpointProfile: 'public',
    tokenPrefix: 'snt_abcd',
    tokenRotatedAt: null,
    pool: 'shared',
    labels: {},
    maxWorkers: null,
    cordoned: false,
    instance: { version: 'dev', startedAt: '2026-11-24T07:00:00.000Z', lastSeenAt: '2026-11-24T08:00:00.000Z' },
    info: null,
    assignmentsRev: 1,
    lastSeenAt: '2026-11-24T08:00:00.000Z',
    createdBy: null,
    activeWorkers: 0,
    daemonConfig: daemonConfig(),
    createdAt: '2026-11-24T07:00:00.000Z',
    updatedAt: '2026-11-24T08:00:00.000Z',
    ...changes,
  }
}

function field(key: string) {
  return DAEMON_CONFIG_FIELDS.find((candidate) => candidate.key === key)!
}

function leafKeys(tree: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? leafKeys(value as Record<string, unknown>, `${prefix}${key}.`) : [`${prefix}${key}`],
  )
}

describe('daemon configuration fields', () => {
  it('cover every value of the daemon configuration once', () => {
    const keys = DAEMON_CONFIG_FIELDS.map((candidate) => candidate.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect([...keys].sort()).toEqual(leafKeys(VALUES as unknown as Record<string, unknown>).sort())
  })

  it('make exactly the override keys editable, with the variables of schemas/daemon-overrides.json', () => {
    expect(DAEMON_OVERRIDE_FIELDS.map((candidate) => candidate.key)).toEqual([...DAEMON_OVERRIDE_KEYS])
    const bounds = JSON.parse(readFileSync(join(__dirname, '../../../schemas/daemon-overrides.json'), 'utf8')) as { keys: Record<string, { env: string }> }
    for (const overridable of DAEMON_OVERRIDE_FIELDS) expect(overridable.env, overridable.key).toBe(bounds.keys[overridable.key]!.env)
  })
})

describe('byte sizes and durations in the syntax of the daemon variables', () => {
  it.each([
    [256 * MiB, '256MiB'],
    [1024 * MiB, '1GiB'],
    [2 * 1024 ** 4, '2TiB'],
    [1536, '1536'],
    [0, '0'],
  ])('%d bytes → %s', (bytes, text) => {
    expect(formatByteSizeInput(bytes)).toBe(text)
    expect(parseByteSizeInput(text)).toBe(bytes)
  })

  it('parses suffixes in any case and with a space, and refuses anything else', () => {
    expect(parseByteSizeInput(' 1 GiB ')).toBe(1024 * MiB)
    expect(parseByteSizeInput('10mib')).toBe(10 * MiB)
    expect(parseByteSizeInput('1.5GiB')).toBeNull()
    expect(parseByteSizeInput('-1')).toBeNull()
    expect(parseByteSizeInput('1GB')).toBeNull()
    expect(parseByteSizeInput('')).toBeNull()
    expect(parseByteSizeInput('99999999999TiB')).toBeNull()
  })

  it.each([
    [86_400_000, '24h'],
    [5_400_000, '1h30m'],
    [1500, '1s500ms'],
    [31_536_000_000, '8760h'],
    [0, '0s'],
  ])('%d ms → %s', (ms, text) => {
    expect(formatDurationInput(ms)).toBe(text)
    expect(parseDurationInput(text)).toBe(ms)
  })

  it('parses Go durations with fractions and refuses other text', () => {
    expect(parseDurationInput('1.5h')).toBe(5_400_000)
    expect(parseDurationInput(' 15m ')).toBe(900_000)
    expect(parseDurationInput('500ms')).toBe(500)
    expect(parseDurationInput('0')).toBe(0)
    expect(parseDurationInput('10')).toBeNull()
    expect(parseDurationInput('5d')).toBeNull()
    expect(parseDurationInput('-1s')).toBeNull()
    expect(parseDurationInput('')).toBeNull()
  })

  it('splits lists at lines, commas and spaces', () => {
    expect(parseListInput('1.1.1.1\n 8.8.8.8:53,\n\n[2606:4700:4700::1111]:53 host')).toEqual(['1.1.1.1', '8.8.8.8:53', '[2606:4700:4700::1111]:53', 'host'])
    expect(parseListInput('  \n')).toEqual([])
  })
})

describe('formatDaemonConfigValue', () => {
  it('formats every kind of value', () => {
    expect(formatDaemonConfigValue(field('maxWorkers'), 0)).toBe('number of CPUs')
    expect(formatDaemonConfigValue(field('maxWorkers'), 1200)).toBe('1,200')
    expect(formatDaemonConfigValue(field('builtIn'), true)).toBe('yes')
    expect(formatDaemonConfigValue(field('allowInsecureTransport'), false)).toBe('no')
    expect(formatDaemonConfigValue(field('shmSizeBytes'), 256 * MiB)).toBe('256 MiB')
    expect(formatDaemonConfigValue(field('pullTimeoutMs'), 1_800_000)).toBe('30m')
    expect(formatDaemonConfigValue(field('dns.upstreamQps'), 0)).toBe('no limit')
    expect(formatDaemonConfigValue(field('dns.authoritativeQps'), 200)).toBe('200/s')
    expect(formatDaemonConfigValue(field('dns.upstreams'), ['1.1.1.1', 'host'])).toBe('1.1.1.1, host')
    expect(formatDaemonConfigValue(field('dns.rootServers'), [])).toBe('IANA root servers')
    expect(formatDaemonConfigValue(field('dns.localDomains'), [])).toBe('none')
    expect(formatDaemonConfigValue(field('egressDeny'), [])).toBe('none (egress helper off)')
    expect(formatDaemonConfigValue(field('overrides'), 'all')).toBe('all')
    expect(formatDaemonConfigValue(field('overrides'), ['maxWorkers', 'dns.mode'])).toBe('maxWorkers, dns.mode')
    expect(formatDaemonConfigValue(field('overrides'), [])).toBe('none')
    expect(formatDaemonConfigValue(field('caCertificates'), [])).toBe('none')
    expect(formatDaemonConfigValue(field('caCertificates'), [{ subject: 'CN=Corp CA', sha256: 'ab', notAfter: '2030-01-01T00:00:00Z' }])).toBe(
      'CN=Corp CA (until 2030-01-01)',
    )
  })

  it("shows the daemon's text without escape sequences, and unexpected types as JSON", () => {
    expect(formatDaemonConfigValue(field('url'), 'https://a.example\u001B[31m/x')).toBe('https://a.example/x')
    expect(formatDaemonConfigValue(field('pidsLimit'), '4096')).toBe('4096')
    expect(formatDaemonConfigValue(field('dns.upstreams'), { a: 1 })).toBe('{"a":1}')
  })
})

describe('daemonConfigRows', () => {
  it('lists every reported setting with its variable, value and source; a missing source is a default', () => {
    const rows = daemonConfigRows(daemonConfig({ sources: { url: 'env', dind: 'bogus' as never, dns: { mode: 'override' } } }))
    expect(rows.map((row) => row.key)).toEqual(DAEMON_CONFIG_FIELDS.map((candidate) => candidate.key))
    const row = (key: string) => rows.find((candidate) => candidate.key === key)!
    expect(row('url')).toMatchObject({
      label: 'Orchestrator URL',
      env: 'SCANTOR_URL',
      value: 'https://scantor.example.com',
      mono: true,
      source: 'env',
      note: null,
    })
    expect(row('dns.mode')).toMatchObject({ env: 'SCANTOR_NODE_DNS_MODE', value: 'recursive', source: 'override' })
    expect(row('dind').source).toBe('default')
    expect(row('pidsLimit').source).toBe('default')
    expect(row('shmSizeBytes')).toMatchObject({ value: '256 MiB', title: '268,435,456 bytes' })
    expect(row('imageRetentionMs')).toMatchObject({ value: '24h', title: '86,400,000 ms' })
  })

  it('leaves out settings the daemon did not report', () => {
    const config = daemonConfig()
    delete (config.values as Partial<DaemonConfigValues>).logFormat
    delete (config.values.dns as Partial<DaemonConfigValues['dns']>).maxLookups
    const keys = daemonConfigRows(config).map((row) => row.key)
    expect(keys).not.toContain('logFormat')
    expect(keys).not.toContain('dns.maxLookups')
    expect(keys).toContain('dns.mode')
  })

  it('notes overrides the daemon has not applied yet, removals pending and rejected overrides', () => {
    const config = daemonConfig({
      pending: true,
      overridesRev: 3,
      appliedOverridesRev: 2,
      overrides: { maxWorkers: 16, dns: { mode: 'iterative', upstreams: ['9.9.9.9'] } },
      sources: { maxWorkers: 'env', pidsLimit: 'override', dns: { mode: 'override' } },
      rejected: { dns: { upstreams: 'not allowed on this node\u001B[0m' } },
    })
    config.values.dns.mode = 'iterative'
    const note = (key: string) => daemonConfigRows(config).find((row) => row.key === key)!.note
    expect(note('maxWorkers')).toEqual({ tone: 'pending', text: 'Override 16 pending' })
    expect(note('dns.mode')).toBeNull()
    expect(note('pidsLimit')).toEqual({ tone: 'pending', text: 'Removal of the override pending' })
    expect(note('dns.upstreams')).toEqual({ tone: 'rejected', text: 'Override rejected: not allowed on this node' })
    expect(note('nofile')).toBeNull()

    const applied = daemonConfig({ overrides: { maxWorkers: 16 }, sources: { maxWorkers: 'override' } })
    applied.values.maxWorkers = 16
    expect(daemonConfigRows(applied).find((row) => row.key === 'maxWorkers')!.note).toBeNull()
  })
})

describe('override state of a node', () => {
  it('lists rejected overrides by label, also keys this UI does not know', () => {
    const config = daemonConfig({ rejected: { maxWorkers: 'too large', dns: { upstreams: 'bad' }, futureKey: 'not supported by this daemon version' } })
    expect(rejectedOverrides(config)).toEqual([
      { key: 'maxWorkers', label: 'Max workers', message: 'too large' },
      { key: 'dns.upstreams', label: 'Upstream servers', message: 'bad' },
      { key: 'futureKey', label: 'futureKey', message: 'not supported by this daemon version' },
    ])
  })

  it('counts the overrides set', () => {
    expect(daemonOverrideCount(daemonConfig())).toBe(0)
    expect(daemonOverrideCount(daemonConfig({ overrides: { dns: {} } }))).toBe(0)
    expect(daemonOverrideCount(daemonConfig({ overrides: { maxWorkers: 2, dns: { mode: 'disabled', maxLookups: 10 } } }))).toBe(3)
  })

  it('reads the allowed override keys from SCANTOR_NODE_OVERRIDES', () => {
    expect(allowedOverrideKeys({ ...VALUES, overrides: 'all' }).size).toBe(DAEMON_OVERRIDE_KEYS.length)
    expect(allowedOverrideKeys({ ...VALUES, overrides: 'none' }).size).toBe(0)
    expect([...allowedOverrideKeys({ ...VALUES, overrides: ['dns.mode', 'maxWorkers', 'unknown'] })]).toEqual(['maxWorkers', 'dns.mode'])
  })

  it('explains why overrides cannot be edited or reset', () => {
    expect(editOverridesBlocker(node())).toBeNull()
    expect(editOverridesBlocker(node({ daemonConfig: null }))).toBe(
      'The node has not reported a valid daemon configuration (an old daemon or an invalid report)',
    )
    expect(editOverridesBlocker(node({ instance: null }))).toBe('No daemon instance holds the lease of this node')
    expect(editOverridesBlocker(node({ state: 'revoked' }))).toMatch(/revoked/)
    expect(editOverridesBlocker(node({ daemonConfig: daemonConfig({ values: { ...VALUES, overrides: 'none' } }) }))).toMatch(/SCANTOR_NODE_OVERRIDES/)

    expect(resetOverridesBlocker(node())).toBe('No daemon overrides are set')
    expect(resetOverridesBlocker(node({ daemonConfig: daemonConfig({ overrides: { maxWorkers: 4 } }) }))).toBeNull()
    // Without a daemon configuration the overrides are not visible, but the reset (idempotent) still removes them.
    expect(resetOverridesBlocker(node({ daemonConfig: null }))).toBeNull()
    expect(resetOverridesBlocker(node({ instance: null, daemonConfig: null }))).toBe('No daemon instance holds the lease of this node')
    expect(resetOverridesBlocker(node({ state: 'revoked', daemonConfig: null }))).toMatch(/revoked/)
  })
})

describe('daemonOverrideForm', () => {
  it('starts every setting at its override, else its value, in the syntax of its variable', () => {
    const form = daemonOverrideForm(daemonConfig({ overrides: { pidsLimit: 512, dns: { upstreams: ['9.9.9.9', 'host'] } } }), 8)
    expect(form).toEqual({
      maxWorkers: 8,
      pidsLimit: 512,
      shmSizeBytes: '256MiB',
      nofile: 65536,
      workerLogMaxSizeBytes: '20MiB',
      workerLogMaxFiles: 3,
      imageRetentionMs: '24h',
      pullTimeoutMs: '30m',
      logLevel: 'info',
      'dns.mode': 'recursive',
      'dns.upstreams': '9.9.9.9\nhost',
      'dns.rootServers': '',
      'dns.localDomains': '',
      'dns.cacheSizeBytes': '256MiB',
      'dns.maxLookups': 1000,
      'dns.upstreamQps': 0,
      'dns.authoritativeQps': 200,
    })
  })

  it('leaves max workers empty when the daemon uses the number of CPUs and its capacity is unknown', () => {
    expect(daemonOverrideForm(daemonConfig(), null).maxWorkers).toBeNull()
  })
})

describe('daemonOverridesPatch', () => {
  const initial = daemonOverrideForm(daemonConfig({ overrides: { maxWorkers: 16, dns: { upstreams: ['9.9.9.9'] } } }), 4)
  const none = new Set<DaemonOverrideKey>()

  function edit(changes: Partial<DaemonOverrideForm>, removed: ReadonlySet<DaemonOverrideKey> = none) {
    return daemonOverridesPatch(initial, { ...initial, ...changes }, removed)
  }

  it('sends nothing for an unchanged form, also when a value is written differently', () => {
    expect(edit({})).toEqual({ patch: {}, errors: [] })
    expect(edit({ shmSizeBytes: '256 MiB', imageRetentionMs: '1440m', 'dns.upstreams': ' 9.9.9.9 , ' })).toEqual({ patch: {}, errors: [] })
  })

  it('sends the changed settings, nested under dns', () => {
    const draft = edit({
      maxWorkers: 32,
      shmSizeBytes: '512MiB',
      imageRetentionMs: '12h',
      logLevel: 'debug',
      'dns.mode': 'iterative',
      'dns.rootServers': '198.41.0.4\n[2001:503:ba3e::2:30]:53',
      'dns.localDomains': 'Corp.Example.',
      'dns.upstreamQps': 500,
    })
    expect(draft.errors).toEqual([])
    expect(draft.patch).toEqual({
      maxWorkers: 32,
      shmSizeBytes: 512 * MiB,
      imageRetentionMs: 43_200_000,
      logLevel: 'debug',
      dns: { mode: 'iterative', rootServers: ['198.41.0.4', '[2001:503:ba3e::2:30]:53'], localDomains: ['Corp.Example.'], upstreamQps: 500 },
    })
  })

  it('sends null for a removed override, whatever its input holds', () => {
    const draft = edit({ maxWorkers: 99 }, new Set<DaemonOverrideKey>(['maxWorkers', 'dns.upstreams']))
    expect(draft).toEqual({ patch: { maxWorkers: null, dns: { upstreams: null } }, errors: [] })
  })

  it('names the field of input that does not parse', () => {
    expect(edit({ shmSizeBytes: 'lots', pullTimeoutMs: 'soon', maxWorkers: null }).errors).toEqual([
      { name: 'maxWorkers', message: 'Enter a value' },
      { name: 'shmSizeBytes', message: 'Use a byte count with an optional KiB, MiB, GiB or TiB suffix, such as 512MiB' },
      { name: 'pullTimeoutMs', message: 'Use a duration such as 500ms, 30s, 15m or 24h' },
    ])
  })

  it('explains values updateNodeDaemonOverrides rejects in the units of the field', () => {
    expect(edit({ maxWorkers: 0 }).errors).toEqual([{ name: 'maxWorkers', message: 'Must be between 1 and 100,000' }])
    expect(edit({ maxWorkers: 1.5 }).errors).toEqual([{ name: 'maxWorkers', message: 'Must be a whole number' }])
    expect(edit({ shmSizeBytes: '512KiB' }).errors).toEqual([{ name: 'shmSizeBytes', message: 'Must be between 1 MiB and 64 GiB' }])
    expect(edit({ pullTimeoutMs: '500ms' }).errors).toEqual([{ name: 'pullTimeoutMs', message: 'Must be between 1s and 24h' }])
    expect(edit({ 'dns.cacheSizeBytes': '1TiB' }).errors).toEqual([{ name: 'dns.cacheSizeBytes', message: 'Must be between 16 MiB and 64 GiB' }])
  })

  it('names the list entry that is invalid, and explains list sizes', () => {
    expect(edit({ 'dns.upstreams': '1.1.1.1\nresolver.example' }).errors).toEqual([
      { name: 'dns.upstreams', message: 'resolver.example: must be an IP address, ip:port, [v6]:port or host' },
    ])
    expect(edit({ 'dns.upstreams': '' }).errors).toEqual([{ name: 'dns.upstreams', message: 'Enter at least 1 entry' }])
    const domains = Array.from({ length: 65 }, (_, index) => `d${index}.example`).join('\n')
    expect(edit({ 'dns.localDomains': domains }).errors).toEqual([{ name: 'dns.localDomains', message: 'Enter at most 64 entries' }])
    expect(edit({ 'dns.rootServers': 'host' }).errors).toEqual([{ name: 'dns.rootServers', message: 'host: must be an IP address, ip:port or [v6]:port' }])
  })

  it('refuses servers only the node environment may name, and addresses that are no unicast servers', () => {
    expect(edit({ 'dns.upstreams': '9.9.9.9\n10.0.0.2' }).errors).toEqual([
      {
        name: 'dns.upstreams',
        message: '10.0.0.2: private and special-purpose servers can only be configured in the node environment (SCANTOR_NODE_DNS_*)',
      },
    ])
    expect(edit({ 'dns.rootServers': '172.17.0.1:1053' }).errors).toEqual([
      {
        name: 'dns.rootServers',
        message: '172.17.0.1:1053: private and special-purpose servers can only be configured in the node environment (SCANTOR_NODE_DNS_*)',
      },
    ])
    expect(edit({ 'dns.upstreams': 'fe80::1%eth0' }).errors).toEqual([{ name: 'dns.upstreams', message: 'fe80::1%eth0: zoned addresses are not supported' }])
    expect(edit({ 'dns.upstreams': '224.0.0.1' }).errors).toEqual([
      { name: 'dns.upstreams', message: '224.0.0.1: must be a unicast address (not unspecified or multicast)' },
    ])
    expect(edit({ 'dns.rootServers': 'fe80::53' }).errors).toEqual([
      { name: 'dns.rootServers', message: 'fe80::53: IPv6 link-local addresses are not supported' },
    ])
    expect(edit({ 'dns.upstreams': 'host\n[2620:fe::fe]:53' }).errors).toEqual([])
  })

  it('ignores a setting that started without a parsable value and was left alone', () => {
    const config = daemonConfig()
    delete (config.values as Partial<DaemonConfigValues>).shmSizeBytes
    const start = daemonOverrideForm(config, 4)
    expect(start.shmSizeBytes).toBe('')
    expect(daemonOverridesPatch(start, { ...start, nofile: 1024 }, none)).toEqual({ patch: { nofile: 1024 }, errors: [] })
  })
})

describe('daemonOverridesErrorText', () => {
  const unavailable = (details: Record<string, unknown>) =>
    new ApiError({ status: 409, code: 'daemonOverridesUnavailable', message: 'Daemon overrides unavailable', details })

  it('explains why the daemon overrides are unavailable', () => {
    expect(daemonOverridesErrorText(unavailable({ reason: 'noInstance' }))).toMatch(/No daemon instance holds the lease/)
    expect(daemonOverridesErrorText(unavailable({ reason: 'notReported' }))).toBe(
      'The node has not reported a valid daemon configuration (an old daemon or an invalid report). A daemon that is still connecting reports it shortly.',
    )
    expect(daemonOverridesErrorText(unavailable({ reason: 'notAllowed', keys: ['dns.upstreams', 'maxWorkers', 'other'] }))).toBe(
      "The node's daemon does not accept overrides of Upstream servers, Max workers, other (SCANTOR_NODE_OVERRIDES).",
    )
    expect(daemonOverridesErrorText(unavailable({ reason: 'notAllowed' }))).toMatch(/does not accept these overrides/)
    expect(daemonOverridesErrorText(unavailable({}))).toBe('Daemon overrides unavailable')
  })

  it('adds the issues of a validation failure, and keeps other messages', () => {
    const invalid = new ApiError({
      status: 400,
      code: 'validationFailed',
      message: 'Invalid request body',
      details: { issues: [{ path: 'dns.upstreams.0', message: 'bad' }] },
    })
    expect(daemonOverridesErrorText(invalid)).toBe('Invalid request body dns.upstreams.0: bad')
    expect(daemonOverridesErrorText(new ApiError({ status: 404, code: 'notFound', message: 'Node not found' }))).toBe('Node not found')
  })
})
