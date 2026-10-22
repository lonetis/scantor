import { beforeEach, describe, expect, it } from 'vitest'
import {
  bootPhase,
  isBootComplete,
  orderedBootSteps,
  registerBootStep,
  registerComponentTask,
  resetBootRegistry,
  retryUntil,
  runBoot,
  stopComponents,
} from '../../server/utils/boot'
import type { Config } from '../../server/utils/config'
import { useLogger } from '../../server/utils/logger'

// Boot and component registries (docs/architecture.md §4.1).

const log = useLogger('test')
const config = { components: ['api', 'reconciler'] } as unknown as Config

beforeEach(() => {
  resetBootRegistry()
})

describe('boot registry', () => {
  it('runs boot steps by order, then starts the tasks of the enabled components', async () => {
    const events: string[] = []
    registerBootStep({ name: 'rabbitmq', order: 500, run: () => void events.push('rabbitmq') })
    registerBootStep({ name: 'config', order: 100, run: () => void events.push('config') })
    registerBootStep({ name: 'registry-files', order: 610, run: async () => void events.push('registry-files') })
    for (const component of ['api', 'ingestor', 'reconciler'] as const) {
      registerComponentTask({
        component,
        name: `task-${component}`,
        start: () => void events.push(`start ${component}`),
        stop: () => void events.push(`stop ${component}`),
      })
    }
    expect(orderedBootSteps().map((step) => step.name)).toEqual(['config', 'rabbitmq', 'registry-files'])
    expect(isBootComplete()).toBe(false)
    await runBoot({ config: () => config, log })
    expect(isBootComplete()).toBe(true)
    expect(events).toEqual(['config', 'rabbitmq', 'registry-files', 'start api', 'start reconciler'])
    await stopComponents(log)
    expect(events.slice(-2)).toEqual(['stop reconciler', 'stop api'])
    expect(bootPhase()).toBe('stopped')
  })

  it('stops at the first failing step and never starts components', async () => {
    let started = false
    registerBootStep({ name: 'mongodb', order: 200, run: () => Promise.reject(new Error('no primary')) })
    registerBootStep({ name: 'later', order: 300, run: () => void (started = true) })
    registerComponentTask({ component: 'api', name: 'x', start: () => void (started = true), stop: () => {} })
    await expect(runBoot({ config: () => config, log })).rejects.toThrow('no primary')
    expect(started).toBe(false)
    expect(bootPhase()).toBe('failed')
  })

  it('closes registration once boot starts and refuses duplicates', async () => {
    registerBootStep({ name: 'a', order: 1, run: () => {} })
    expect(() => registerBootStep({ name: 'a', order: 2, run: () => {} })).toThrow('registered twice')
    await runBoot({ config: () => config, log })
    expect(() => registerBootStep({ name: 'b', order: 3, run: () => {} })).toThrow('synchronously')
    expect(() => registerComponentTask({ component: 'api', name: 't', start: () => {}, stop: () => {} })).toThrow('synchronously')
  })

  it('passes an abort signal that fires when components stop', async () => {
    let signal: AbortSignal | undefined
    registerComponentTask({ component: 'api', name: 'loop', start: (ctx) => void (signal = ctx.signal), stop: () => {} })
    await runBoot({ config: () => config, log })
    expect(signal?.aborted).toBe(false)
    await stopComponents(log)
    expect(signal?.aborted).toBe(true)
  })
})

describe('retryUntil', () => {
  it('retries until success', async () => {
    let attempts = 0
    const result = await retryUntil(
      'flaky',
      async () => {
        attempts++
        if (attempts < 3) throw new Error('not yet')
        return 'ok'
      },
      { log, initialDelayMs: 1 },
    )
    expect(result).toBe('ok')
    expect(attempts).toBe(3)
  })

  it('rethrows the last error after the deadline', async () => {
    await expect(retryUntil('down', () => Promise.reject(new Error('still down')), { log, timeoutMs: 20, initialDelayMs: 5 })).rejects.toThrow(
      'still down',
    )
  })
})
