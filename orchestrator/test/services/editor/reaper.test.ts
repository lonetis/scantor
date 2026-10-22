import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decideEditor, EditorReaper, KEY_EXPIRY_MARGIN_MS, STOPPING_STALE_MS } from '../../../server/services/editor/reaper'
import type { EditorDoc } from '../../../server/types/documents'
import { useLogger } from '../../../server/utils/logger'
import { createManagerWorld, FakeCodeServer, type ManagerWorld, waitFor } from './fakes'

// The editor reaper (docs/editor.md §6.4): its rule table and a sweep over fakes.

const USER = { id: '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11', email: 'louis@example.com' }
const STRANGER = '2b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const NOW = Date.parse('2026-10-21T12:00:00.000Z')
const config = { editorIdleTimeoutMs: 30 * 60_000, editorStartTimeoutMs: 60_000 }

function doc(overrides: Partial<EditorDoc>): EditorDoc {
  return {
    _id: USER.id,
    state: 'running',
    containerId: 'c',
    containerName: `scantor-editor-${USER.id}`,
    image: 'scantor-editor:dev',
    apiKeyId: 'k',
    apiKeyExpiresAt: new Date(NOW + 24 * 3_600_000),
    startedAt: new Date(NOW - 3_600_000),
    lastActivityAt: new Date(NOW - 60_000),
    stoppedAt: null,
    updatedAt: new Date(NOW - 60_000),
    error: null,
    ...overrides,
  }
}

const context = { now: NOW, config, containerRunning: true, staleTransitions: false }

describe('decideEditor', () => {
  it('probes a healthy, active running editor', () => {
    expect(decideEditor(doc({}), context)).toEqual({ kind: 'probe' })
  })

  it('stops idle editors, editors whose key expires within 5 minutes, and editors without a running container', () => {
    expect(decideEditor(doc({ lastActivityAt: new Date(NOW - config.editorIdleTimeoutMs - 1) }), context)).toEqual({ kind: 'stop', reason: 'idle' })
    expect(decideEditor(doc({ lastActivityAt: new Date(NOW - config.editorIdleTimeoutMs + 1) }), context)).toEqual({ kind: 'probe' })
    expect(decideEditor(doc({ apiKeyExpiresAt: new Date(NOW + KEY_EXPIRY_MARGIN_MS - 1) }), context)).toEqual({ kind: 'stop', reason: 'keyExpired' })
    expect(decideEditor(doc({}), { ...context, containerRunning: false })).toEqual({ kind: 'stop', reason: 'orphan' })
  })

  it('fails starts older than the start timeout plus 30 s', () => {
    expect(decideEditor(doc({ state: 'starting', startedAt: new Date(NOW - 89_000) }), context)).toEqual({ kind: 'keep' })
    expect(decideEditor(doc({ state: 'starting', startedAt: new Date(NOW - 91_000) }), context)).toMatchObject({ kind: 'failStart' })
  })

  it('retries stops that have been stopping for more than 2 minutes', () => {
    expect(decideEditor(doc({ state: 'stopping', updatedAt: new Date(NOW - STOPPING_STALE_MS + 1) }), context)).toEqual({ kind: 'keep' })
    expect(decideEditor(doc({ state: 'stopping', updatedAt: new Date(NOW - STOPPING_STALE_MS - 1) }), context)).toEqual({ kind: 'retryStop' })
  })

  it('treats every transition as abandoned at boot', () => {
    const boot = { ...context, staleTransitions: true }
    expect(decideEditor(doc({ state: 'starting', startedAt: new Date(NOW) }), boot)).toMatchObject({ kind: 'failStart' })
    expect(decideEditor(doc({ state: 'stopping', updatedAt: new Date(NOW) }), boot)).toEqual({ kind: 'retryStop' })
    expect(decideEditor(doc({}), boot)).toEqual({ kind: 'probe' })
  })
})

describe('EditorReaper.sweep', () => {
  const codeServer = new FakeCodeServer()
  beforeAll(() => codeServer.start())
  afterAll(() => codeServer.stop())

  async function runningWorld(): Promise<{ world: ManagerWorld; reaper: EditorReaper }> {
    const world = createManagerWorld(codeServer)
    await world.manager.ensureStarted(USER)
    await waitFor(async () => (await world.editors.findOne({ _id: USER.id }))?.state === 'running')
    const reaper = new EditorReaper({ editors: world.editors.asCollection(), docker: world.docker, keys: world.keys, manager: world.manager, config: world.config, log: useLogger('test') })
    return { world, reaper }
  }

  it('keeps a healthy editor and removes orphan containers and keys of users without a live editor', async () => {
    const { world, reaper } = await runningWorld()
    const orphan = { ...world.docker.containers.get(`scantor-editor-${USER.id}`)! }
    world.docker.containers.set(`scantor-editor-${STRANGER}`, { ...orphan, spec: { ...orphan.spec, Labels: { ...orphan.spec.Labels, 'scantor.user': STRANGER } } })
    await world.keys.mint(STRANGER)

    const report = await reaper.sweep({ staleTransitions: false })
    expect(report).toMatchObject({ stopped: [], removedContainers: [`scantor-editor-${STRANGER}`], deletedKeysOf: [STRANGER], errors: 0 })
    expect((await world.editors.findOne({ _id: USER.id }))!.state).toBe('running')
    expect(world.keys.keys.has(USER.id)).toBe(true)
  })

  it('stops an idle editor', async () => {
    const { world, reaper } = await runningWorld()
    await world.editors.updateOne({ _id: USER.id }, { $set: { lastActivityAt: new Date(Date.now() - world.config.editorIdleTimeoutMs - 1000) } })
    const report = await reaper.sweep({ staleTransitions: false })
    expect(report.stopped).toEqual([{ userId: USER.id, reason: 'idle' }])
    // The stop's teardown removed the container and keys; the orphan sweeps do not report them again.
    expect(report).toMatchObject({ removedContainers: [], deletedKeysOf: [] })
    expect((await world.editors.findOne({ _id: USER.id }))!.state).toBe('stopped')
    expect(world.keys.keys.size).toBe(0)
  })

  it('stops an editor after three failed health checks in a row', async () => {
    const { world, reaper } = await runningWorld()
    codeServer.healthy = false
    try {
      expect((await reaper.sweep({ staleTransitions: false })).stopped).toEqual([])
      expect((await reaper.sweep({ staleTransitions: false })).stopped).toEqual([])
      expect((await reaper.sweep({ staleTransitions: false })).stopped).toEqual([{ userId: USER.id, reason: 'orphan' }])
    } finally {
      codeServer.healthy = true
    }
    expect((await world.editors.findOne({ _id: USER.id }))!.state).toBe('stopped')
  })

  it('stops an editor whose container is gone', async () => {
    const { world, reaper } = await runningWorld()
    world.docker.containers.clear()
    expect((await reaper.sweep({ staleTransitions: false })).stopped).toEqual([{ userId: USER.id, reason: 'orphan' }])
  })

  it('cleans up abandoned transitions at boot', async () => {
    const { world, reaper } = await runningWorld()
    await world.editors.updateOne({ _id: USER.id }, { $set: { state: 'stopping', updatedAt: new Date() } })
    const report = await reaper.sweep({ staleTransitions: true })
    expect(report.retriedStops).toEqual([USER.id])
    expect((await world.editors.findOne({ _id: USER.id }))!.state).toBe('stopped')
    expect(world.docker.containers.size).toBe(0)
  })
})
