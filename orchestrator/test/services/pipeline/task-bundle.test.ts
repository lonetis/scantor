import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { BundleInfo } from '#shared/types/bundles'
import type { PipelineEvent } from '../../../server/services/pipeline/events'
import { runTaskBundle, taskBundleArgs, type TaskBundleOptions } from '../../../server/services/pipeline/task-bundle'
import { useLogger } from '../../../server/utils/logger'
import { readRepoFile } from '../../helpers/repo'

// The bundle driver with a fake `scantor task bundle` subprocess (docs/tasks.md §9.11): the info on stdin, the archive
// on fd 3 through the caller's output reader, the final BundleResult, and the failure paths of the output: a reader
// that rejects kills the pipeline, and a stopped or timed-out pipeline cuts the output with an error, so a reader never
// stores a truncated archive as complete.

const FAKE = fileURLToPath(new URL('./fake-task-bundle.mjs', import.meta.url))
const log = useLogger('test')
const info = JSON.parse(readRepoFile('internal/bundle/testdata/bundle.json')) as BundleInfo

/** Reads a whole stream; rejects when it ends with an error. */
async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

function run(mode: string, options: Partial<TaskBundleOptions> = {}) {
  const events: PipelineEvent[] = []
  let archive: Buffer | null = null
  const outcome = runTaskBundle({
    info,
    image: 'localhost:5000/tasks/t:r',
    pull: `localhost:5000/tasks/t@sha256:${'d'.repeat(64)}`,
    env: { PATH: process.env.PATH ?? '', FAKE_MODE: mode, SCANTOR_REGISTRY_PUSH_PASSWORD: 'push-password' },
    onEvent: (event) => {
      events.push(event)
    },
    output: async (stream) => {
      archive = await readAll(stream)
    },
    timeoutMs: 10_000,
    log,
    binary: FAKE,
    ...options,
  })
  return { outcome, events, archive: () => archive }
}

describe('taskBundleArgs', () => {
  it('builds the invocation of docs/tasks.md §9.11', () => {
    expect(taskBundleArgs({ image: 'localhost:5000/tasks/t:r', pull: 'localhost:5000/tasks/t@sha256:abc' })).toEqual([
      'task',
      'bundle',
      '-',
      '--image',
      'localhost:5000/tasks/t:r',
      '--pull',
      'localhost:5000/tasks/t@sha256:abc',
      '--output-fd',
      '3',
      '--events',
      'ndjson',
    ])
  })
})

describe('runTaskBundle', () => {
  it('sends the info on stdin, reads the archive from fd 3 and returns the BundleResult', async () => {
    const { outcome, events, archive } = run('ok')
    const result = await outcome
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, aborted: false, outputError: null })
    const stored = archive()!
    expect(stored.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
    expect(result.result?.bundle).toMatchObject({
      image: 'localhost/scantor/echo:3',
      bytes: stored.length,
      sha256: createHash('sha256').update(stored).digest('hex'),
    })
    expect(events[0]!.text).toContain('bundling echo@3 as localhost/scantor/echo:3')
    expect(events[0]!.text).toContain('--output-fd 3')
    expect(events[0]!.text).toContain('push password set')
    expect(events.at(-1)?.type).toBe('result')
  })

  it('reports content errors (exit 2) and platform errors (exit 3)', async () => {
    const content = await run('content').outcome
    expect(content.exitCode).toBe(2)
    expect(content.result).toMatchObject({ ok: false, bundle: null, errors: [{ phase: 'build' }] })
    const crash = run('crash')
    const crashed = await crash.outcome
    expect(crashed.exitCode).toBe(3)
    expect(crashed.result).toBeNull()
    expect(crashed.stderrTail).toContain('docker save failed')
    // The reader saw a normal end: the caller must not trust an archive without a successful result.
    expect(crash.archive()!.length).toBeGreaterThan(0)
  })

  it('kills the pipeline when the output reader fails', async () => {
    const started = Date.now()
    const outcome = await run('hang', {
      output: async (stream) => {
        await new Promise<void>((resolve) => stream.once('data', () => resolve()))
        throw new Error('upload refused')
      },
    }).outcome
    expect(outcome.outputError?.message).toBe('upload refused')
    expect(outcome.exitCode).toBeNull()
    expect(outcome.timedOut).toBe(false)
    expect(Date.now() - started).toBeLessThan(8000)
  })

  it('cuts the output with an error when the pipeline times out or is stopped', async () => {
    const timedOut = await run('hang', { timeoutMs: 500 }).outcome
    expect(timedOut.timedOut).toBe(true)
    expect(timedOut.outputError?.message).toMatch(/wall-clock limit/)

    const controller = new AbortController()
    const stopped = run('hang', { signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    const aborted = await stopped.outcome
    expect(aborted.aborted).toBe(true)
    expect(aborted.outputError?.message).toMatch(/stopped/)
    expect(stopped.archive()).toBeNull()
  })

  it('aborts the output reader when an upload outlives the pipeline, at the wall-clock limit or a stop', async () => {
    // Reads the whole archive, then waits like an upload whose last request hangs, until its signal aborts.
    const stall = (drained: () => void) => async (stream: Readable, signal: AbortSignal) => {
      await readAll(stream)
      drained()
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true }))
    }
    let drained = false
    const timedOut = await run('ok', {
      timeoutMs: 3000,
      output: stall(() => {
        drained = true
      }),
    }).outcome
    expect(drained).toBe(true)
    expect(timedOut).toMatchObject({ exitCode: 0, timedOut: true, aborted: false })
    expect(timedOut.outputError?.message).toMatch(/wall-clock limit/)

    // Stopped once the subprocess has (most likely) exited as well.
    const controller = new AbortController()
    const stopped = await run('ok', { signal: controller.signal, output: stall(() => setTimeout(() => controller.abort(), 300)) }).outcome
    expect(stopped).toMatchObject({ timedOut: false, aborted: true })
    expect(stopped.outputError?.message).toMatch(/stopped/)
  })
})
