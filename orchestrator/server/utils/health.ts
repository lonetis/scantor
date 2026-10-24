import type { Health } from '#shared/types/instance'
import { useLogger } from './logger'
import { mongoReachable } from './mongo'
import { useRabbitmqManagement } from './rabbitmq-management'
import { s3Reachable } from './s3'
import { scantorVersion } from './version'

// Component health for `/api/health` (docs/api.md §4.1): each dependency `ok` or `down`, active RabbitMQ alarms,
// overall `degraded` when anything is down or a broker alarm is active (docs/queue.md §10: publishers are blocked).
// Results are cached briefly so frequent probes stay cheap.

/** The registry HTTP API on the compose network (docs/architecture.md §4.4); /v2/ answers 401 with token auth. */
export const REGISTRY_INTERNAL_URL = 'http://registry:5000'
const CACHE_MS = 3000

let cached: { health: Health; at: number } | null = null

async function registryReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${REGISTRY_INTERNAL_URL}/v2/`, { signal: AbortSignal.timeout(3000) })
    return response.status === 200 || response.status === 401
  } catch {
    return false
  }
}

async function rabbitmqStatus(): Promise<{ up: boolean; alarms: string[] }> {
  try {
    const alarms = await useRabbitmqManagement().activeAlarms()
    return { up: true, alarms }
  } catch (error) {
    useLogger('health').debug('RabbitMQ management API unreachable', { err: error })
    return { up: false, alarms: [] }
  }
}

/** `ok` only when every component answers and RabbitMQ raises no memory or disk alarm. */
export function overallStatus(components: Health['components'], alarms: readonly string[]): Health['status'] {
  return Object.values(components).every((state) => state === 'ok') && alarms.length === 0 ? 'ok' : 'degraded'
}

export async function checkHealth(now = Date.now()): Promise<Health> {
  if (cached && now - cached.at < CACHE_MS) return cached.health
  const [mongo, rabbitmq, s3, registry] = await Promise.all([mongoReachable(), rabbitmqStatus(), s3Reachable(), registryReachable()])
  const components = {
    mongo: mongo ? 'ok' : 'down',
    rabbitmq: rabbitmq.up ? 'ok' : 'down',
    s3: s3 ? 'ok' : 'down',
    registry: registry ? 'ok' : 'down',
  } as const
  const health: Health = {
    status: overallStatus(components, rabbitmq.alarms),
    version: scantorVersion,
    components,
    alarms: rabbitmq.alarms,
  }
  cached = { health, at: now }
  return health
}
