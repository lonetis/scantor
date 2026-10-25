import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import type Docker from 'dockerode'
import { extract } from 'tar-stream'
import { describe, expect, it } from 'vitest'
import { injectionArchive, localSpec, runTestRunContainer, testRunContainerSpec } from '../../../server/services/test-runs/container'
import { formatSseEvent } from '../../../server/services/test-runs/stream'

// The test-run container (docs/tasks.md §11.2), its local-mode spec (§11.3, docs/runtime.md §15.1), the injection
// tar (docs/runtime.md §3.1) and its run from creation to exit, cancellable at every step (§11.1 step 5).

describe('testRunContainerSpec', () => {
  it('uses scantor-egress, the worker hardening profile, PidsLimit 4096 and the manifest resources', () => {
    const spec = testRunContainerSpec({
      testRunId: '3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7d',
      userId: 'u1',
      image: 'sha256:abc',
      resources: { cpus: 0.5, memoryMiB: 768 },
      capAdd: ['NET_BIND_SERVICE', 'NET_RAW'],
    })
    expect(spec).toMatchObject({
      name: 'scantor-t-3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7d',
      Image: 'sha256:abc',
      Entrypoint: ['/scantor/scantor', 'runtime', 'local', '--spec', '/scantor/in/spec.json'],
      Labels: { 'scantor.managed': 'true', 'scantor.kind': 'testRun', 'scantor.user': 'u1', 'traefik.enable': 'false', 'com.docker.compose.project': 'scantor-managed' },
    })
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: 'scantor-egress',
      CapDrop: ['ALL'],
      CapAdd: ['NET_BIND_SERVICE', 'NET_RAW'],
      SecurityOpt: ['no-new-privileges:true'],
      Init: true,
      PidsLimit: 4096,
      Memory: (768 + 256) * 1024 ** 2,
      NanoCpus: 500_000_000,
    })
    expect(spec.HostConfig?.Privileged).toBeUndefined()
    expect(spec.HostConfig?.Mounts).toBeUndefined()
    expect(spec.HostConfig?.Tmpfs).toBeUndefined()
    expect(spec.Env).toBeUndefined()
  })
})

describe('localSpec', () => {
  it('fills the spec of docs/runtime.md §15.1 with processes 1 and no debugging', () => {
    const spec = localSpec(
      {
        testRunId: 'tr',
        entry: 'main.py',
        taskConfig: { greeting: 'Hi' },
        scanConfig: {},
        analysisConfig: null,
        limit: 5,
        timeoutMs: 300_000,
        maxAttempts: 1,
        backoff: { initialMs: 5000, factor: 2, maxMs: 600_000, jitter: true },
        maxAnalysesPerProcess: 1000,
        totalTimeoutMs: 590_000,
        uploads: { u1: { sha256: 'ab' } },
      },
      { trancoUrl: 'https://tranco-list.eu', cruxUrl: 'https://crux.example', maxAnalysisConfigBytes: 1, maxResultBytes: 2, maxFileBytes: 3, maxFilesPerAnalysis: 4 },
    )
    expect(spec).toMatchObject({
      v: 1,
      runId: 'tr',
      processes: 1,
      debug: false,
      totalTimeoutMs: 590_000,
      dataSources: { tranco: 'https://tranco-list.eu', crux: 'https://crux.example' },
      uploads: { u1: { path: '/scantor/in/uploads/u1', sha256: 'ab' } },
      resolved: {},
      limits: { maxAnalysisConfigBytes: 1, maxResultBytes: 2, maxFileBytes: 3, maxFilesPerAnalysis: 4, logTailBytes: 32768, logTailEarlierBytes: 4096 },
      outDir: '/scantor/out',
    })
  })
})

describe('injectionArchive', () => {
  it('contains the runtime, the spec, the uploads and the out directory with fixed modes and owners', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scantor-injection-'))
    const binary = join(dir, 'scantor')
    writeFileSync(binary, 'ELF')
    const archive = injectionArchive(binary, { v: 1 }, [{ id: 'u1', bytes: 3, open: async () => Readable.from([Buffer.from('a\nb')]) }])
    const entries: { name: string; mode: number; uid: number; content: string }[] = []
    const extractor = extract()
    await new Promise<void>((resolve, reject) => {
      extractor.on('entry', (header, stream, next) => {
        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', () => {
          entries.push({ name: header.name, mode: header.mode ?? 0, uid: header.uid ?? -1, content: Buffer.concat(chunks).toString() })
          next()
        })
      })
      extractor.on('finish', resolve)
      extractor.on('error', reject)
      archive.pipe(extractor)
    })
    expect(entries.map((entry) => [entry.name, entry.mode.toString(8), entry.uid])).toEqual([
      ['scantor/', '755', 0],
      ['scantor/scantor', '755', 0],
      ['scantor/in/', '755', 0],
      ['scantor/in/spec.json', '644', 0],
      ['scantor/in/uploads/', '755', 0],
      ['scantor/in/uploads/u1', '644', 0],
      ['scantor/out/', '1777', 0],
    ])
    expect(entries.find((entry) => entry.name === 'scantor/in/spec.json')?.content).toBe('{"v":1}')
    expect(entries.find((entry) => entry.name === 'scantor/in/uploads/u1')?.content).toBe('a\nb')
  })

  it('closes the upload being copied when the archive is destroyed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scantor-injection-'))
    const binary = join(dir, 'scantor')
    writeFileSync(binary, 'ELF')
    const endless = new Readable({ read() { this.push(Buffer.alloc(16 * 1024, 0x61)) } })
    const archive = injectionArchive(binary, { v: 1 }, [{ id: 'u1', bytes: 1024 ** 3, open: async () => endless }])
    let bytes = 0
    await new Promise<void>((resolve) => {
      archive.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 256 * 1024) resolve()
      })
    })
    archive.destroy()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(endless.destroyed).toBe(true)
  })
})

/** A Docker client whose container steps can be held (until `release`) to cancel inside them. */
function fakeDocker(holdAt?: 'create' | 'putArchive' | 'attach' | 'start' | 'wait') {
  const calls: string[] = []
  /** the name or id of every removal */
  const removed: string[] = []
  const state = { exists: false, running: false }
  let reach!: () => void
  const reached = new Promise<void>((resolve) => (reach = resolve))
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  let exit!: (code: number) => void
  const exited = new Promise<number>((resolve) => (exit = resolve))
  const step = async (name: string) => {
    calls.push(name)
    if (name === holdAt) {
      reach()
      await released
    }
  }
  const notFound = () => Object.assign(new Error('no such container'), { statusCode: 404 })
  const container = {
    id: 'c0ffee',
    async putArchive(archive: Readable, options: { abortSignal?: AbortSignal }) {
      calls.push('putArchive')
      if (holdAt !== 'putArchive') return archive.resume()
      reach()
      // docker-modem aborts the upload request with the signal.
      await new Promise((_resolve, reject) => options.abortSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    },
    async attach() {
      await step('attach')
      return new PassThrough()
    },
    async start() {
      await step('start')
      state.running = true
    },
    async kill() {
      calls.push('kill')
      if (!state.running) throw Object.assign(new Error('container is not running'), { statusCode: 409 })
      state.running = false
      exit(137)
    },
    async wait() {
      calls.push('wait')
      if (holdAt === 'wait') reach()
      return { StatusCode: await exited }
    },
  }
  const docker = {
    getContainer: (ref: string) => ({
      async remove() {
        calls.push('remove')
        removed.push(ref)
        if (!state.exists) throw notFound()
        state.exists = false
        state.running = false
      },
    }),
    async createContainer() {
      await step('create')
      state.exists = true
      return container
    },
    modem: { demuxStream: () => {} },
  }
  return { docker: docker as unknown as Docker, calls, removed, state, reached, release, exit }
}

describe('runTestRunContainer', () => {
  const sink = () => new Writable({ write: (_chunk, _encoding, callback) => callback() })
  const options = (docker: Docker, signal: AbortSignal, overrides: { archive?: () => Readable; killAfterMs?: number; onCreated?: (container: Docker.Container) => void } = {}) => ({
    docker,
    create: { name: 'scantor-t-1', Image: 'draft' },
    archive: overrides.archive ?? (() => Readable.from([Buffer.from('tar')])),
    stdout: sink(),
    stderr: sink(),
    killAfterMs: overrides.killAfterMs ?? 60_000,
    signal,
    log: { debug: () => {} },
    onCreated: overrides.onCreated,
  })

  it('replaces a leftover, injects, attaches, starts and returns the exit code', async () => {
    const fake = fakeDocker('wait')
    const run = runTestRunContainer(options(fake.docker, new AbortController().signal))
    await fake.reached
    fake.exit(0)
    await expect(run).resolves.toMatchObject({ exitCode: 0, killed: null })
    expect(fake.calls).toEqual(['remove', 'create', 'putArchive', 'attach', 'start', 'wait'])
  })

  it.each(['create', 'attach'] as const)('a cancel during %s removes the container before it ever starts', async (holdAt) => {
    const fake = fakeDocker(holdAt)
    const controller = new AbortController()
    const run = runTestRunContainer(options(fake.docker, controller.signal))
    await fake.reached
    controller.abort(new Error('test run cancelled'))
    fake.release()
    await expect(run).rejects.toThrow('test run cancelled')
    expect(fake.calls).not.toContain('start')
    expect(fake.state.exists).toBe(false)
  })

  it('removes a leftover by name but its own container only by id', async () => {
    // A runner that lost its lease must never remove the container another runner created under the same name.
    const fake = fakeDocker('attach')
    const controller = new AbortController()
    const created: string[] = []
    const run = runTestRunContainer(options(fake.docker, controller.signal, { onCreated: (container) => created.push(container.id) }))
    await fake.reached
    expect(created).toEqual(['c0ffee'])
    controller.abort(new Error('test run cancelled'))
    fake.release()
    await expect(run).rejects.toThrow('test run cancelled')
    expect(fake.removed).toEqual(['scantor-t-1', 'c0ffee'])
  })

  it('a cancel during the injection aborts the upload and removes the container', async () => {
    const fake = fakeDocker('putArchive')
    const controller = new AbortController()
    const archive = new Readable({ read() {} })
    const run = runTestRunContainer(options(fake.docker, controller.signal, { archive: () => archive }))
    await fake.reached
    controller.abort(new Error('test run cancelled'))
    await expect(run).rejects.toThrow()
    expect(archive.destroyed).toBe(true)
    expect(fake.calls).not.toContain('start')
    expect(fake.state.exists).toBe(false)
  })

  it('a cancel during the start kills the container once it runs', async () => {
    const fake = fakeDocker('start')
    const controller = new AbortController()
    const run = runTestRunContainer(options(fake.docker, controller.signal))
    await fake.reached
    controller.abort(new Error('test run cancelled'))
    fake.release()
    await expect(run).resolves.toMatchObject({ exitCode: 137, killed: 'abort' })
    expect(fake.calls.slice(fake.calls.indexOf('start'))).toEqual(['start', 'kill', 'wait'])
    expect(fake.state.running).toBe(false)
  })

  it('a cancel while it runs kills it', async () => {
    const fake = fakeDocker('wait')
    const controller = new AbortController()
    const run = runTestRunContainer(options(fake.docker, controller.signal))
    await fake.reached
    controller.abort(new Error('test run cancelled'))
    await expect(run).resolves.toMatchObject({ exitCode: 137, killed: 'abort' })
  })

  it('kills a container that outlives killAfterMs', async () => {
    const fake = fakeDocker()
    await expect(runTestRunContainer(options(fake.docker, new AbortController().signal, { killAfterMs: 10 }))).resolves.toMatchObject({ exitCode: 137, killed: 'timeout' })
  })

  it('creates nothing for a run cancelled before', async () => {
    const fake = fakeDocker()
    const controller = new AbortController()
    controller.abort(new Error('test run cancelled'))
    await expect(runTestRunContainer(options(fake.docker, controller.signal))).rejects.toThrow('test run cancelled')
    expect(fake.calls).toEqual([])
  })
})

describe('formatSseEvent', () => {
  it('writes one SSE event', () => {
    expect(formatSseEvent('state', { state: 'running' })).toBe('event: state\ndata: {"state":"running"}\n\n')
  })
})
