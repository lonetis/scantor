import { beforeEach, describe, expect, it } from 'vitest'
import {
  BootStoppedError,
  bootPhase,
  isBootComplete,
  orderedBootSteps,
  registerBootStep,
  registerComponentTask,
  resetBootRegistry,
  retryUntil,
  runBoot,
  shutdownSignal,
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

// The shutdown (server/plugins/99.start.ts): components stop as soon as the signal arrives, while Nitro still drains
// the open requests.
describe('shutdown', () => {
  it('aborts the shutdown signal at once and keeps the API available while the components stop', async () => {
    let release!: () => void
    registerComponentTask({ component: 'api', name: 'slow', start: () => {}, stop: () => new Promise<void>((resolve) => (release = resolve)) })
    await runBoot({ config: () => config, log })
    expect(shutdownSignal().aborted).toBe(false)
    const stopping = stopComponents(log)
    expect(shutdownSignal().aborted).toBe(true)
    expect(bootPhase()).toBe('stopping')
    // The requests Nitro drains are still served.
    expect(isBootComplete()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    await stopping
    expect(bootPhase()).toBe('stopped')
  })

  it('stops once however often it is called', async () => {
    let stops = 0
    registerComponentTask({ component: 'api', name: 'once', start: () => {}, stop: () => void stops++ })
    await runBoot({ config: () => config, log })
    const first = stopComponents(log)
    expect(stopComponents(log)).toBe(first)
    await first
    await stopComponents(log)
    expect(stops).toBe(1)
  })

  it('runs no further boot step and starts no component when the shutdown begins during boot', async () => {
    const events: string[] = []
    let release!: () => void
    registerBootStep({ name: 'mongodb', order: 200, run: () => new Promise<void>((resolve) => (release = resolve)) })
    registerBootStep({ name: 'later', order: 300, run: () => void events.push('later') })
    registerComponentTask({ component: 'api', name: 'x', start: () => void events.push('start'), stop: () => void events.push('stop') })
    const booting = runBoot({ config: () => config, log })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await stopComponents(log)
    release()
    await expect(booting).rejects.toBeInstanceOf(BootStoppedError)
    expect(events).toEqual([])
    expect(bootPhase()).toBe('stopped')
    expect(isBootComplete()).toBe(false)
  })

  it('treats a boot step that fails during the shutdown as stopped, not as a boot failure', async () => {
    let fail!: (error: Error) => void
    registerBootStep({ name: 'rabbitmq', order: 500, run: () => new Promise<void>((_, reject) => (fail = reject)) })
    const booting = runBoot({ config: () => config, log })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const stopping = stopComponents(log)
    fail(new Error('connection closed'))
    const error = await booting.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BootStoppedError)
    expect((error as BootStoppedError).cause).toMatchObject({ message: 'connection closed' })
    await stopping
    expect(bootPhase()).toBe('stopped')
  })

  it('stops a component task that was starting when the shutdown began, and starts no later one', async () => {
    const events: string[] = []
    let release!: () => void
    registerComponentTask({
      component: 'api',
      name: 'slow-start',
      start: () => new Promise<void>((resolve) => (release = resolve)),
      stop: () => void events.push('stop slow-start'),
    })
    registerComponentTask({ component: 'reconciler', name: 'later', start: () => void events.push('start later'), stop: () => void events.push('stop later') })
    const booting = runBoot({ config: () => config, log })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const stopping = stopComponents(log)
    const stopped = expect(booting).rejects.toBeInstanceOf(BootStoppedError)
    release()
    await stopping
    await stopped
    expect(events).toEqual(['stop slow-start'])
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

  it('stops retrying once the shutdown began', async () => {
    let attempts = 0
    await stopComponents(log)
    await expect(
      retryUntil(
        'down',
        () => {
          attempts++
          return Promise.reject(new Error('still down'))
        },
        { log, timeoutMs: 60_000, initialDelayMs: 1 },
      ),
    ).rejects.toThrow('still down')
    expect(attempts).toBe(1)
  })
})
