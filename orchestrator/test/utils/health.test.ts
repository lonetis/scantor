import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `/api/health` (docs/api.md §4.1, docs/queue.md §10): every component `ok` or `down`, the active RabbitMQ alarms,
// and the overall status `degraded` when a component is down or an alarm is active.

const probes = { mongo: true, s3: true, rabbitmq: true as boolean, alarms: [] as ('memory' | 'disk')[] }

vi.mock('../../server/utils/mongo', () => ({ mongoReachable: async () => probes.mongo }))
vi.mock('../../server/utils/s3', () => ({ s3Reachable: async () => probes.s3 }))
vi.mock('../../server/utils/rabbitmq-management', () => ({
  useRabbitmqManagement: () => ({
    activeAlarms: async () => {
      if (!probes.rabbitmq) throw new Error('connect ECONNREFUSED')
      return probes.alarms
    },
  }),
}))

const { checkHealth, overallStatus } = await import('../../server/utils/health')

/** Far enough apart that the 3 s cache never answers. */
let clock = 0
const fresh = () => (clock += 10_000)

beforeEach(() => {
  Object.assign(probes, { mongo: true, s3: true, rabbitmq: true, alarms: [] })
  vi.stubGlobal('fetch', async () => new Response(null, { status: 401 }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('overallStatus', () => {
  const allOk = { mongo: 'ok', rabbitmq: 'ok', s3: 'ok', registry: 'ok' } as const

  it('is ok only when every component is ok and no alarm is active', () => {
    expect(overallStatus(allOk, [])).toBe('ok')
    expect(overallStatus({ ...allOk, s3: 'down' }, [])).toBe('degraded')
    expect(overallStatus(allOk, ['memory'])).toBe('degraded')
    expect(overallStatus(allOk, ['disk'])).toBe('degraded')
  })
})

describe('checkHealth', () => {
  it('reports a healthy platform as ok', async () => {
    expect(await checkHealth(fresh())).toMatchObject({ status: 'ok', components: { mongo: 'ok', rabbitmq: 'ok', s3: 'ok', registry: 'ok' }, alarms: [] })
  })

  it('is degraded with every component ok while a RabbitMQ memory alarm lasts', async () => {
    probes.alarms = ['memory']
    expect(await checkHealth(fresh())).toMatchObject({
      status: 'degraded',
      components: { mongo: 'ok', rabbitmq: 'ok', s3: 'ok', registry: 'ok' },
      alarms: ['memory'],
    })
    probes.alarms = []
    expect((await checkHealth(fresh())).status).toBe('ok')
  })

  it('is degraded when a component is down', async () => {
    probes.rabbitmq = false
    expect(await checkHealth(fresh())).toMatchObject({ status: 'degraded', components: { rabbitmq: 'down' }, alarms: [] })
  })
})
