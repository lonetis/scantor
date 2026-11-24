import { describe, expect, it } from 'vitest'
import {
  DAEMON_LOG_LEVELS,
  DAEMON_OVERRIDE_BOUNDS,
  DAEMON_OVERRIDE_KEYS,
  daemonOverrideValues,
  RESOLVER_MODES,
  updateNodeDaemonOverridesBody,
} from '#shared/schemas/nodes'
import { isDnsServer } from '#shared/utils/dns-servers'
import { readRepoFile } from '../helpers/repo'
import { routeOpenApiDocument, routeOperation } from '../helpers/route-openapi'

// schemas/daemon-overrides.json is the one definition of the overridable daemon configuration keys and their bounds
// (docs/nodes.md §6.12), shared with the Go daemon. The zod schemas, DAEMON_OVERRIDE_BOUNDS/KEYS and the OpenAPI body
// of updateNodeDaemonOverrides must state exactly the same keys and bounds.

interface BoundsEntry {
  type: 'integer' | 'string' | 'array'
  min?: number
  max?: number
  enum?: string[]
  minItems?: number
  maxItems?: number
  format?: 'server' | 'serverOrHost' | 'domain'
  env: string
}

const file = JSON.parse(readRepoFile('schemas/daemon-overrides.json')) as { version: number; keys: Record<string, BoundsEntry> }
const entries = Object.entries(file.keys)

/** `{dns: {mode: v}}` for `dns.mode`, `{maxWorkers: v}` for `maxWorkers`. */
function valuesWith(key: string, value: unknown): Record<string, unknown> {
  const [head, tail] = key.split('.') as [string, string | undefined]
  return tail ? { [head]: { [tail]: value } } : { [head]: value }
}

const accepts = (key: string, value: unknown) =>
  daemonOverrideValues.safeParse(valuesWith(key, value)).success && updateNodeDaemonOverridesBody.safeParse(valuesWith(key, value)).success
const rejects = (key: string, value: unknown) =>
  !daemonOverrideValues.safeParse(valuesWith(key, value)).success && !updateNodeDaemonOverridesBody.safeParse(valuesWith(key, value)).success

/** An item of each list format that the format accepts. */
const VALID_ITEM = { server: '9.9.9.9:53', serverOrHost: 'host', domain: 'corp.example' } as const

describe('schemas/daemon-overrides.json', () => {
  it('names the override keys of DAEMON_OVERRIDE_KEYS in the same order', () => {
    expect(file.version).toBe(1)
    expect(Object.keys(file.keys)).toEqual([...DAEMON_OVERRIDE_KEYS])
  })

  it('states the integer bounds of DAEMON_OVERRIDE_BOUNDS', () => {
    const integers = Object.fromEntries(
      entries.filter(([, entry]) => entry.type === 'integer').map(([key, entry]) => [key, { min: entry.min, max: entry.max }]),
    )
    expect(integers).toEqual(DAEMON_OVERRIDE_BOUNDS)
  })

  it('states the enums of the string keys', () => {
    expect(file.keys.logLevel?.enum).toEqual([...DAEMON_LOG_LEVELS])
    expect(file.keys['dns.mode']?.enum).toEqual([...RESOLVER_MODES])
  })

  it('names the environment variable of every key', () => {
    for (const [key, entry] of entries) expect(entry.env, key).toMatch(/^SCANTOR_[A-Z_]+$/)
  })

  it.each(entries.filter(([, entry]) => entry.type === 'integer'))('enforces the bounds of %s in the zod schemas', (key, entry) => {
    expect(accepts(key, entry.min)).toBe(true)
    expect(accepts(key, entry.max)).toBe(true)
    expect(rejects(key, entry.min! - 1)).toBe(true)
    expect(rejects(key, entry.max! + 1)).toBe(true)
    expect(rejects(key, entry.min! + 0.5)).toBe(true)
    expect(rejects(key, String(entry.min))).toBe(true)
  })

  it.each(entries.filter(([, entry]) => entry.type === 'string'))('enforces the enum of %s in the zod schemas', (key, entry) => {
    for (const value of entry.enum!) expect(accepts(key, value), value).toBe(true)
    expect(rejects(key, 'other')).toBe(true)
  })

  it.each(entries.filter(([, entry]) => entry.type === 'array'))('enforces the item counts and format of %s in the zod schemas', (key, entry) => {
    const item = VALID_ITEM[entry.format!]
    expect(
      accepts(
        key,
        Array.from({ length: entry.maxItems! }, () => item),
      ),
    ).toBe(true)
    expect(
      rejects(
        key,
        Array.from({ length: entry.maxItems! + 1 }, () => item),
      ),
    ).toBe(true)
    if (entry.minItems! > 0) expect(rejects(key, [])).toBe(true)
    else expect(accepts(key, [])).toBe(true)
    expect(rejects(key, ['not a server or domain!'])).toBe(true)
  })

  it('accepts the documented server forms and the host keyword only for upstreams', () => {
    for (const server of ['1.1.1.1', '1.1.1.1:5353', '2606:4700:4700::1111', '[2606:4700:4700::1111]:53']) expect(isDnsServer(server), server).toBe(true)
    for (const server of ['host', '1.1.1.256', '1.1.1.1:0', '1.1.1.1:65536', '[::1]', 'dns.google', '2606:4700:4700::1111:53x']) {
      expect(isDnsServer(server), server).toBe(false)
    }
    expect(accepts('dns.upstreams', ['host', '9.9.9.9'])).toBe(true)
    expect(rejects('dns.rootServers', ['host'])).toBe(true)
    // Overrides never name private or special-purpose servers (only the node environment may).
    expect(rejects('dns.upstreams', ['10.0.0.53'])).toBe(true)
    expect(rejects('dns.rootServers', ['172.17.0.1:1053'])).toBe(true)
    // Domains are normalized: lowercase, no trailing dot.
    expect(daemonOverrideValues.parse({ dns: { localDomains: ['Corp.Example.'] } })).toEqual({ dns: { localDomains: ['corp.example'] } })
  })

  it('matches the body of updateNodeDaemonOverrides in the OpenAPI document', () => {
    const operation = routeOperation(routeOpenApiDocument(), 'updateNodeDaemonOverrides')
    const body = (operation.requestBody as { content: Record<string, { schema: { properties: Record<string, Record<string, unknown>> } }> }).content[
      'application/json'
    ]!.schema
    const property = (key: string): Record<string, unknown> => {
      const [head, tail] = key.split('.') as [string, string | undefined]
      return tail ? (body.properties[head]!.properties as Record<string, Record<string, unknown>>)[tail]! : body.properties[head]!
    }
    for (const [key, entry] of entries) {
      const schema = property(key)
      expect(schema, key).toBeDefined()
      if (entry.type === 'integer') expect({ min: schema.minimum, max: schema.maximum }, key).toEqual({ min: entry.min, max: entry.max })
      if (entry.type === 'string') expect(schema.enum, key).toEqual([...entry.enum!, null])
      if (entry.type === 'array') expect({ min: schema.minItems ?? 0, max: schema.maxItems }, key).toEqual({ min: entry.minItems, max: entry.maxItems })
      expect(schema.type, key).toEqual([entry.type, 'null'])
    }
    const documented = Object.keys(body.properties).flatMap((key) =>
      key === 'dns' ? Object.keys(body.properties.dns!.properties as object).map((dnsKey) => `dns.${dnsKey}`) : [key],
    )
    expect(documented).toEqual([...DAEMON_OVERRIDE_KEYS])
  })
})
