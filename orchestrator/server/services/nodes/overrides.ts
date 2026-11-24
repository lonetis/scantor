import { daemonOverrideValues, type UpdateNodeDaemonOverridesBody } from '#shared/schemas/nodes'
import type { DaemonConfigValues, DaemonOverrideValues } from '#shared/types/nodes'
import type { DaemonConfigDoc, DaemonOverridesDoc, NodeDoc } from '../../types/documents'
import { parseOrThrow } from '../../utils/zod'

// Daemon overrides (docs/nodes.md §6.12, docs/api.md §4.17): admin-set values that replace values of the daemon
// configuration in one running daemon instance until it stops. They are stored on the node with the instance id
// they belong to; hello of another instance clears them. Keys are the dotted names of schemas/daemon-overrides.json
// (`maxWorkers`, `dns.mode`, …); the values themselves nest `dns` like the daemon configuration.

export type DaemonOverridesUnavailableReason = 'noInstance' | 'notReported' | 'notAllowed'

/** The daemon overrides of the node's current daemon instance (null when none or another instance's). */
export function instanceOverrides(node: Pick<NodeDoc, 'instance' | 'daemonOverrides'>): DaemonOverridesDoc | null {
  const overrides = node.daemonOverrides
  return overrides && node.instance && overrides.instanceId === node.instance.id ? overrides : null
}

/** The daemon configuration reported by the node's current daemon instance (null when none reported it). */
export function instanceDaemonConfig(node: Pick<NodeDoc, 'instance' | 'daemonConfig'>): DaemonConfigDoc | null {
  const config = node.daemonConfig
  return config && node.instance && config.instanceId === node.instance.id ? config : null
}

/** `daemonOverrides` of the assignments response (docs/api.md §7.2): the complete set of the current instance. */
export function assignedDaemonOverrides(node: Pick<NodeDoc, 'instance' | 'daemonOverrides'>): { rev: number; values: DaemonOverrideValues } {
  const overrides = instanceOverrides(node)
  return overrides ? { rev: overrides.rev, values: overrides.values } : { rev: 0, values: {} }
}

/** The dotted keys that hold a value, in the order of schemas/daemon-overrides.json. */
export function overrideKeys(values: DaemonOverrideValues): string[] {
  const keys: string[] = []
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue
    if (key === 'dns') {
      for (const [dnsKey, dnsValue] of Object.entries(value as Record<string, unknown>)) {
        if (dnsValue !== undefined) keys.push(`dns.${dnsKey}`)
      }
      continue
    }
    keys.push(key)
  }
  return keys
}

function valueAt(values: DaemonOverrideValues, key: string): unknown {
  if (!key.startsWith('dns.')) return (values as Record<string, unknown>)[key]
  return (values.dns as Record<string, unknown> | undefined)?.[key.slice('dns.'.length)]
}

/** The dotted keys whose value differs between two override sets (added, changed or removed). */
export function changedOverrideKeys(before: DaemonOverrideValues, after: DaemonOverrideValues): string[] {
  const keys = [...new Set([...overrideKeys(before), ...overrideKeys(after)])]
  return keys.filter((key) => JSON.stringify(valueAt(before, key)) !== JSON.stringify(valueAt(after, key)))
}

/** The dotted keys a merge patch sets to a value (removals are not listed: removing is always allowed). */
export function patchedOverrideKeys(patch: UpdateNodeDaemonOverridesBody): string[] {
  const keys: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue
    if (key === 'dns') {
      for (const [dnsKey, dnsValue] of Object.entries(value as Record<string, unknown>)) {
        if (dnsValue !== undefined && dnsValue !== null) keys.push(`dns.${dnsKey}`)
      }
      continue
    }
    keys.push(key)
  }
  return keys
}

/** Whether the daemon's SCANTOR_NODE_OVERRIDES allows `key` (an unreported allow-list allows nothing). */
export function overrideAllowed(allowList: DaemonConfigValues['overrides'] | undefined, key: string): boolean {
  if (allowList === 'all') return true
  if (allowList === undefined || allowList === 'none') return false
  return allowList.includes(key)
}

/**
 * Applies a JSON merge patch (RFC 7396) to the current overrides: null removes an override (`dns: null` every dns
 * override), a value sets it, lists replace lists. The result is validated again (400 validationFailed) and has the
 * key order of the schema, so equal sets serialize equally.
 */
export function mergeDaemonOverrides(current: DaemonOverrideValues, patch: UpdateNodeDaemonOverridesBody): DaemonOverrideValues {
  const next: Record<string, unknown> = structuredClone(current) as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (key !== 'dns') {
      if (value === null) Reflect.deleteProperty(next, key)
      else next[key] = value
      continue
    }
    if (value === null) {
      Reflect.deleteProperty(next, 'dns')
      continue
    }
    const dns: Record<string, unknown> = { ...(next.dns as Record<string, unknown> | undefined) }
    for (const [dnsKey, dnsValue] of Object.entries(value as Record<string, unknown>)) {
      if (dnsValue === undefined) continue
      if (dnsValue === null) Reflect.deleteProperty(dns, dnsKey)
      else dns[dnsKey] = dnsValue
    }
    if (Object.keys(dns).length > 0) next.dns = dns
    else Reflect.deleteProperty(next, 'dns')
  }
  return parseOrThrow(daemonOverrideValues, next)
}
