import { apiError } from '../../utils/errors'
import { useLogger } from '../../utils/logger'
import { useRabbitmqManagement } from '../../utils/rabbitmq-management'

// RabbitMQ memory and disk alarms for the scan-start path (docs/queue.md §10): while an alarm is active new scans are
// refused with 503 brokerAlarm. The alarm state is read from the management API and cached for a few seconds so
// bursts of starts cost one request.

const CACHE_MS = 5000

let cached: { alarms: string[]; at: number } | null = null

/** Active alarm names (`memory`, `disk`); throws when the management API cannot be reached. */
export async function brokerAlarms(now = Date.now()): Promise<string[]> {
  if (cached && now - cached.at < CACHE_MS) return cached.alarms
  const alarms = await useRabbitmqManagement().activeAlarms()
  cached = { alarms, at: now }
  return alarms
}

/** Records alarms observed elsewhere (the reconciler polls them every tick). */
export function rememberBrokerAlarms(alarms: string[], now = Date.now()): void {
  cached = { alarms, at: now }
}

/** 503 brokerAlarm while an alarm is active; 503 unavailable when RabbitMQ cannot be asked. */
export async function assertNoBrokerAlarm(): Promise<void> {
  let alarms: string[]
  try {
    alarms = await brokerAlarms()
  } catch (error) {
    useLogger('scans').warn('RabbitMQ management API unreachable at scan start', { err: error })
    throw apiError('unavailable', 'the message broker cannot be reached; try again later')
  }
  if (alarms.length > 0) {
    throw apiError('brokerAlarm', `the message broker is out of resources (${alarms.join(', ')} alarm); new scans are refused until it recovers`, {
      alarms,
    })
  }
}
