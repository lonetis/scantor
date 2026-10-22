import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { editorContainerSpec } from '../../../server/services/editor/container'
import { ApiError } from '../../../server/utils/errors'
import { createManagerWorld, FakeCodeServer, managerConfig, waitFor } from './fakes'

// The editor container spec (docs/editor.md §4, security.md ED-6) and the `editors` state machine of the manager
// (docs/editor.md §6, docs/data-model.md §6.10) over in-memory fakes.

const USER = { id: '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11', email: 'louis@example.com' }
const OTHER = '1b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'

const codeServer = new FakeCodeServer()
beforeAll(() => codeServer.start())
afterAll(() => codeServer.stop())

describe('editor container spec', () => {
  it('is exactly the Engine API body of docs/editor.md §4', () => {
    const config = managerConfig({ internalUrl: 'http://orchestrator:3000' })
    const spec = editorContainerSpec(
      { userId: USER.id, email: USER.email, image: 'ghcr.io/lonetis/scantor-editor:1.4.0', apiKey: 'sk_scantor_editor_abc' },
      config,
    )
    expect(spec).toEqual({
      name: `scantor-editor-${USER.id}`,
      Image: 'ghcr.io/lonetis/scantor-editor:1.4.0',
      User: '1000:1000',
      Cmd: [
        '--socket', '/run/scantor-editor/code.sock', '--socket-mode', '600', '--auth', 'none',
        '--disable-proxy', '--disable-telemetry', '--disable-update-check', '--disable-getting-started-override',
        '--user-data-dir', '/home/coder/.local/share/code-server', '--extensions-dir', '/opt/code-server/extensions',
        '--app-name', 'scantor (louis@example.com)', '/home/coder/workspace',
      ],
      Env: [
        'SCANTOR_URL=http://orchestrator:3000',
        'SCANTOR_TOKEN=sk_scantor_editor_abc',
        'SCANTOR_DEV_MODE=remote',
        'SCANTOR_WORKSPACE=/home/coder/workspace',
      ],
      Hostname: 'editor',
      Labels: {
        'traefik.enable': 'false',
        'com.docker.compose.project': 'scantor-managed',
        'com.docker.compose.service': '',
        'scantor.managed': 'true',
        'scantor.kind': 'editor',
        'scantor.user': USER.id,
      },
      StopTimeout: 10,
      HostConfig: {
        Init: true,
        RestartPolicy: { Name: 'no' },
        NetworkMode: 'scantor-sandbox',
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        ReadonlyRootfs: true,
        PidsLimit: 1024,
        Memory: 2147483648,
        MemorySwap: 2147483648,
        NanoCpus: 2000000000,
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=536870912' },
        LogConfig: { Type: 'local', Config: { 'max-size': '10m', 'max-file': '2' } },
        Mounts: [
          { Type: 'volume', Source: 'scantor-editor-home', Target: '/home/coder', VolumeOptions: { Subpath: USER.id } },
          { Type: 'volume', Source: 'scantor-workspaces', Target: '/home/coder/workspace', VolumeOptions: { Subpath: USER.id } },
          { Type: 'volume', Source: 'scantor-editor-sockets', Target: '/run/scantor-editor', VolumeOptions: { Subpath: USER.id } },
        ],
      },
      NetworkingConfig: { EndpointsConfig: { 'scantor-sandbox': {} } },
    })
    // Never: the Docker socket, extra mounts, privileges, workspace trust off, infrastructure secrets.
    const serialized = JSON.stringify(spec)
    expect(serialized).not.toContain('docker.sock')
    expect(serialized).not.toContain('disable-workspace-trust')
    expect(serialized).not.toContain('SCANTOR_SECRET')
    expect(spec.HostConfig).not.toHaveProperty('Privileged')
    expect(spec.HostConfig).not.toHaveProperty('Binds')
  })

  it('applies the SCANTOR_EDITOR_* limits', () => {
    const spec = editorContainerSpec(
      { userId: USER.id, email: USER.email, image: 'scantor-editor:dev', apiKey: 'k' },
      managerConfig({ editorMemoryLimitBytes: 1024 ** 3, editorCpus: 0.5, editorPidsLimit: 256, editorTmpfsSizeBytes: 64 * 1024 ** 2 }),
    )
    expect(spec.HostConfig).toMatchObject({
      Memory: 1024 ** 3,
      MemorySwap: 1024 ** 3,
      NanoCpus: 500_000_000,
      PidsLimit: 256,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=67108864' },
    })
  })
})

describe('editor manager', () => {
  it('starts an editor in the background: init, socket dir, fresh key, container, readiness, running', async () => {
    const world = createManagerWorld(codeServer)
    const started = await world.manager.ensureStarted(USER)
    expect(started.state).toBe('starting')
    expect(started.image).toBe('scantor-editor:dev')
    expect(started.startedAt).toBeInstanceOf(Date)
    await waitFor(async () => (await world.editors.findOne({ _id: USER.id }))?.state === 'running')

    const doc = (await world.editors.findOne({ _id: USER.id }))!
    expect(doc).toMatchObject({
      containerId: `id-scantor-editor-${USER.id}`,
      containerName: `scantor-editor-${USER.id}`,
      apiKeyId: 'key-1',
      error: null,
    })
    expect(doc.apiKeyExpiresAt).toBeInstanceOf(Date)
    expect(doc.lastActivityAt).toBeInstanceOf(Date)
    expect(world.events.slice(0, 3)).toEqual([`changed ${USER.id}`, `init ${USER.id}`, `prepare ${USER.id}`])
    expect(world.keys.calls).toEqual([`deleteAll ${USER.id}`, `mint ${USER.id}`])
    expect(world.docker.calls).toEqual([`remove scantor-editor-${USER.id}`, 'imageExists scantor-editor:dev', `create scantor-editor-${USER.id}`])
    const container = world.docker.containers.get(`scantor-editor-${USER.id}`)!
    expect(container.spec.Env).toContain(`SCANTOR_TOKEN=${world.keys.keys.get(USER.id)![0]!.key}`)
    expect(container.spec.Cmd).toContain('scantor (louis@example.com)')
  })

  it('returns the current editor while it is starting or running', async () => {
    const world = createManagerWorld(codeServer)
    const first = await world.manager.ensureStarted(USER)
    const second = await world.manager.ensureStarted(USER)
    expect(second.startedAt).toEqual(first.startedAt)
    await waitFor(async () => (await world.editors.findOne({ _id: USER.id }))?.state === 'running')
    expect((await world.manager.ensureStarted(USER)).state).toBe('running')
    expect(world.keys.calls.filter((call) => call.startsWith('mint'))).toHaveLength(1)
  })

  it('answers 429 above SCANTOR_EDITOR_MAX_RUNNING and reverts the transition', async () => {
    const world = createManagerWorld(codeServer, { editorMaxRunning: 1 })
    await world.editors.insertOne({
      _id: OTHER, state: 'running', containerId: 'c', containerName: `scantor-editor-${OTHER}`, image: 'i', apiKeyId: null,
      apiKeyExpiresAt: null, startedAt: new Date(), lastActivityAt: new Date(), stoppedAt: null, updatedAt: new Date(), error: null,
    })
    const error = await world.manager.ensureStarted(USER).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 'tooManyRequests', statusCode: 429, details: { limit: 1 } })
    expect((await world.editors.findOne({ _id: USER.id }))?.state).toBe('stopped')
    expect(world.docker.calls).toEqual([])
  })

  it('records a failed start: missing local image', async () => {
    const world = createManagerWorld(codeServer)
    world.docker.images.clear()
    await world.manager.ensureStarted(USER)
    await waitFor(async () => (await world.editors.findOne({ _id: USER.id }))?.state === 'stopped')
    const doc = (await world.editors.findOne({ _id: USER.id }))!
    expect(doc.error).toMatch(/editor image scantor-editor:dev does not exist/)
    expect(doc).toMatchObject({ containerId: null, apiKeyId: null, apiKeyExpiresAt: null })
    expect(world.keys.keys.size).toBe(0)
    expect(world.events).toContain(`teardown ${USER.id}`)
    expect((await world.manager.status(USER.id)).error).toBe(doc.error)
  })

  it('pulls a missing image when an image prefix is configured', async () => {
    const world = createManagerWorld(codeServer, { imagePrefix: 'ghcr.io/lonetis/', imageTag: '1.4.0' })
    world.docker.images.clear()
    await world.manager.ensureStarted(USER)
    await waitFor(async () => (await world.editors.findOne({ _id: USER.id }))?.state === 'running')
    expect(world.docker.pulled).toEqual(['ghcr.io/lonetis/scantor-editor:1.4.0'])
  })

  it('fails a start whose container dies before it is ready', async () => {
    const world = createManagerWorld(codeServer)
    world.docker.crashOnStart = true
    await world.manager.ensureStarted(USER)
    await waitFor(async () => (await world.editors.findOne({ _id: USER.id }))?.state === 'stopped')
    expect((await world.editors.findOne({ _id: USER.id }))!.error).toMatch(/exited with code 1 before it became ready/)
  })

  it('fails a start that does not become ready within SCANTOR_EDITOR_START_TIMEOUT', async () => {
    const world = createManagerWorld(codeServer, { editorStartTimeoutMs: 100 })
    codeServer.healthy = false
    try {
      await world.manager.ensureStarted(USER)
      await waitFor(async () => (await world.editors.findOne({ _id: USER.id }))?.state === 'stopped')
    } finally {
      codeServer.healthy = true
    }
    expect((await world.editors.findOne({ _id: USER.id }))!.error).toMatch(/did not become ready within 0 s/)
    expect(world.docker.containers.size).toBe(0)
  })

  it('stops a running editor: container, keys, socket, proxy; cookies invalid at once', async () => {
    const world = createManagerWorld(codeServer)
    await world.manager.ensureStarted(USER)
    await waitFor(async () => (await world.editors.findOne({ _id: USER.id }))?.state === 'running')
    world.events.length = 0
    await world.manager.stop(USER.id, 'user')
    const doc = (await world.editors.findOne({ _id: USER.id }))!
    expect(doc).toMatchObject({ state: 'stopped', containerId: null, containerName: null, apiKeyId: null, apiKeyExpiresAt: null })
    expect(doc.stoppedAt).toBeInstanceOf(Date)
    expect(world.docker.containers.size).toBe(0)
    expect(world.keys.keys.size).toBe(0)
    expect(world.events).toEqual([`changed ${USER.id}`, `removeSocket ${USER.id}`, `teardown ${USER.id}`, `changed ${USER.id}`])
    await world.manager.stop(USER.id, 'user')
    expect((await world.editors.findOne({ _id: USER.id }))!.state).toBe('stopped')
  })

  it('aborts an in-flight start when stopped, and the start never marks the editor running', async () => {
    const world = createManagerWorld(codeServer)
    let release!: () => void
    world.docker.createGate = new Promise<void>((resolve) => {
      release = resolve
    })
    await world.manager.ensureStarted(USER)
    await waitFor(() => world.docker.calls.some((call) => call.startsWith('create')))
    const stopping = world.manager.stop(USER.id, 'user')
    await waitFor(async () => (await world.editors.findOne({ _id: USER.id }))?.state === 'stopping')
    release()
    await stopping
    const doc = (await world.editors.findOne({ _id: USER.id }))!
    expect(doc.state).toBe('stopped')
    expect(doc.error).toBeNull()
    expect(world.docker.containers.size).toBe(0)
    expect(world.keys.keys.size).toBe(0)
  })

  it('keeps a stop whose teardown failed in `stopping`, still deletes the keys, and retries later', async () => {
    const world = createManagerWorld(codeServer)
    await world.manager.ensureStarted(USER)
    await waitFor(async () => (await world.editors.findOne({ _id: USER.id }))?.state === 'running')
    world.docker.failStop = new Error('docker unreachable')
    await expect(world.manager.stop(USER.id, 'user')).rejects.toThrow(/tearing down the editor/)
    expect((await world.editors.findOne({ _id: USER.id }))!.state).toBe('stopping')
    expect(world.keys.keys.size).toBe(0)
    expect(world.events).toContain(`teardown ${USER.id}`)

    world.docker.failStop = null
    expect(await world.manager.retryStop(USER.id, new Date(Date.now() - 60_000))).toBe(false)
    expect(await world.manager.retryStop(USER.id, new Date(Date.now() + 1))).toBe(true)
    expect((await world.editors.findOne({ _id: USER.id }))!.state).toBe('stopped')
  })

  it('waits for a stopping editor before starting it again', async () => {
    const world = createManagerWorld(codeServer)
    await world.manager.ensureStarted(USER)
    await waitFor(async () => (await world.editors.findOne({ _id: USER.id }))?.state === 'running')
    await world.editors.updateOne({ _id: USER.id }, { $set: { state: 'stopping' } })
    setTimeout(() => void world.editors.updateOne({ _id: USER.id }, { $set: { state: 'stopped' } }), 50)
    const restarted = await world.manager.ensureStarted(USER)
    expect(restarted.state).toBe('starting')
  })

  it('fails a stuck start for the reaper and purges a user', async () => {
    const world = createManagerWorld(codeServer)
    let release!: () => void
    world.docker.createGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = await world.manager.ensureStarted(USER)
    await waitFor(() => world.docker.calls.some((call) => call.startsWith('create')))
    const failing = world.manager.failStuckStart(USER.id, started.startedAt!, 'the editor did not finish starting in time')
    release()
    await failing
    expect(await world.editors.findOne({ _id: USER.id })).toMatchObject({ state: 'stopped', error: 'the editor did not finish starting in time' })

    await world.manager.purge(USER.id)
    expect(await world.editors.findOne({ _id: USER.id })).toBeNull()
    expect((await world.manager.status(USER.id)).state).toBe('stopped')
  })

  it('reports a user without an editor document as stopped', async () => {
    const world = createManagerWorld(codeServer, { editorIdleTimeoutMs: 1_800_000 })
    expect(await world.manager.status(OTHER)).toEqual({ state: 'stopped', startedAt: null, lastActivityAt: null, idleTimeoutMs: 1_800_000, error: null })
  })
})
