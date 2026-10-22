import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { PipelineEvent } from '../../../server/services/pipeline/events'
import { runTaskBuild, taskBuildArgs, type TaskBuildOptions } from '../../../server/services/pipeline/task-build'
import { classifyRevisionBuild, pushGateHandshake } from '../../../server/services/revisions/build'
import { useLogger } from '../../../server/utils/logger'

// The task-pipeline driver with a fake `scantor task build` subprocess (docs/testing.md §4.2, security.md BLD-9):
// event decoding, the push gate on fd 3, the wall-clock limit and the image-size cap.

const FAKE = fileURLToPath(new URL('./fake-task-build.mjs', import.meta.url))
const log = useLogger('test')

function run(mode: string, options: Partial<TaskBuildOptions> = {}) {
  const events: PipelineEvent[] = []
  const outcome = runTaskBuild({
    input: Readable.from([Buffer.from('pack-bytes')]),
    tag: 'localhost:5000/tasks/t:r',
    expectName: 'echo',
    allowPrivileged: false,
    env: { PATH: process.env.PATH ?? '', FAKE_MODE: mode },
    onEvent: (event) => {
      events.push(event)
    },
    timeoutMs: 10_000,
    log,
    binary: FAKE,
    ...options,
  })
  return { outcome, events }
}

describe('taskBuildArgs', () => {
  it('builds the revision and draft invocations of docs/tasks.md §9.1', () => {
    expect(taskBuildArgs({ tag: 'localhost:5000/tasks/t:r', expectName: 'echo', allowPrivileged: true, push: true })).toEqual([
      'task', 'build', '-', '--tag', 'localhost:5000/tasks/t:r', '--push', '--push-gate', '3', '--expect-name', 'echo', '--allow-privileged', '--events', 'ndjson',
    ])
    expect(taskBuildArgs({ tag: 'tasks/t:draft-abc', expectName: 'echo', allowPrivileged: false, skipCheck: true, reuseExisting: true })).toEqual([
      'task', 'build', '-', '--tag', 'tasks/t:draft-abc', '--expect-name', 'echo', '--skip-check', '--reuse-existing', '--events', 'ndjson',
    ])
  })
})

describe('runTaskBuild', () => {
  it('streams the pack in and decodes events in order up to the result', async () => {
    const { outcome, events } = run('ok')
    const result = await outcome
    expect(result.exitCode).toBe(0)
    expect(result.result?.image?.digest).toBe('sha256:d')
    expect(events.map((event) => event.seq)).toEqual([0, 1])
    expect(events[0]!.text).toContain('read 10 bytes')
  })

  it('answers the push gate after the handshake', async () => {
    const gates: string[] = []
    const { outcome } = run('gate', {
      push: true,
      pushGate: async () => {
        gates.push('asked')
      },
    })
    const result = await outcome
    expect(gates).toEqual(['asked'])
    expect(result.exitCode).toBe(0)
    expect(result.result?.ok).toBe(true)
  })

  it('closes the gate when the handshake fails', async () => {
    const { outcome } = run('gate', {
      push: true,
      pushGate: async () => {
        throw new Error('lease lost')
      },
    })
    const result = await outcome
    expect(result.exitCode).toBe(3)
    expect(result.result?.errors[0]?.message).toBe('push gate closed')
  })

  it('kills a pipeline that exceeds its wall-clock limit', async () => {
    const { outcome } = run('hang', { timeoutMs: 300 })
    const result = await outcome
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
  })

  it('reports aborts', async () => {
    const controller = new AbortController()
    const { outcome } = run('hang', { signal: controller.signal })
    setTimeout(() => controller.abort(), 200)
    expect((await outcome).aborted).toBe(true)
  })
})

describe('classifyRevisionBuild', () => {
  const config = { maxImageBytes: 10 ** 9 }

  it('accepts a pushed image within the size cap', async () => {
    expect(classifyRevisionBuild(await run('ok').outcome, config, 1000).state).toBe('ready')
  })

  it('fails images above SCANTOR_MAX_IMAGE_BYTES', async () => {
    const verdict = classifyRevisionBuild(await run('big').outcome, config, 1000)
    expect(verdict).toMatchObject({ state: 'failed', errors: [{ phase: 'build' }] })
  })

  it('fails content errors (exit 2) with the pipeline errors', async () => {
    const verdict = classifyRevisionBuild(await run('content').outcome, config, 1000)
    expect(verdict).toMatchObject({ state: 'failed', errors: [{ phase: 'static', file: 'Dockerfile', line: 3 }] })
  })

  it('retries platform failures (exit 3, no result)', async () => {
    const verdict = classifyRevisionBuild(await run('crash').outcome, config, 1000)
    expect(verdict.state).toBe('retry')
    expect(verdict.state === 'retry' && verdict.errors[0]?.message).toContain('docker unreachable')
  })

  it('fails timeouts as platform errors', async () => {
    const verdict = classifyRevisionBuild(await run('hang', { timeoutMs: 200 }).outcome, config, 200)
    expect(verdict).toMatchObject({ state: 'failed', errors: [{ phase: 'platform' }] })
  })
})

describe('pushGateHandshake', () => {
  it('waits while the registryGc lock is held (docs/deployment.md §14.1)', async () => {
    const phases: string[] = []
    const held = [true, true, false]
    await pushGateHandshake(
      {
        saveCursor: async (cursor) => {
          phases.push(String(cursor.phase))
        },
      },
      new AbortController().signal,
      async () => held.shift() ?? false,
      1,
    )
    expect(phases).toEqual(['push', 'waitRegistry', 'push', 'waitRegistry', 'push'])
  })
})
