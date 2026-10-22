import { createHash } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { gunzipSync } from 'node:zlib'
import Docker from 'dockerode'
import type { ContainerCreateOptions } from 'dockerode'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/*
 * Integration test of the workspace helpers (docs/editor.md §9) against the real Docker daemon and the real
 * `scantor workspace` operations: the typed operations of server/services/helpers/ops.ts run through the executor
 * and runner with the production container profile. Skipped unless SCANTOR_TEST_SCANTOR_IMAGE names a scantor image
 * `<prefix>scantor:<tag>` whose prefix ends with "/" (for example one built from the root Dockerfile). The test creates its own volumes and
 * network and renames the helper containers with the prefix `scantor-impl-orch-tasks-it-`, so it never touches the
 * objects of a real deployment; everything is removed afterwards.
 */

const image = process.env.SCANTOR_TEST_SCANTOR_IMAGE ?? ''
const enabled = image !== ''
const PREFIX = 'scantor-impl-orch-tasks-it-'
const WORKSPACES = `${PREFIX}workspaces`
const EDITOR_HOME = `${PREFIX}editor-home`
const EGRESS = `${PREFIX}egress`
const USER = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'

const at = image.lastIndexOf(':')
const imageName = at > 0 ? image.slice(0, at) : image
const config = {
  imagePrefix: imageName.endsWith('scantor') ? imageName.slice(0, -'scantor'.length) : '',
  imageTag: at > 0 ? image.slice(at + 1) : 'latest',
  helperConcurrency: 4,
  helperMemoryLimitBytes: 256 * 1024 ** 2,
  helperPidsLimit: 128,
  helperTimeoutMs: 60_000,
  taskMaxFiles: 1000,
  taskMaxBytes: 50 * 1024 ** 2,
  workspaceMaxBytes: 200 * 1024 ** 2,
  taskMaxPackBytes: 20 * 1024 ** 2,
  gitAllowPrivate: false,
}

vi.mock('../../../server/utils/config', () => ({ useConfig: () => config }))

const docker = new Docker()
const { setHelperRuntimeForTesting } = await import('../../../server/services/helpers/executor')
const { KeyedRwLock, Semaphore } = await import('../../../server/services/helpers/concurrency')
const ops = await import('../../../server/services/helpers/ops')
const { ensureUserDirs } = await import('../../../server/services/helpers')
const { HelperError } = await import('../../../server/services/helpers/protocol')
const { useLogger } = await import('../../../server/utils/logger')

/** The production spec with this test's object names. */
function rename(spec: ContainerCreateOptions): ContainerCreateOptions {
  const mounts = (spec.HostConfig?.Mounts ?? []).map((mount) => ({
    ...mount,
    Source: mount.Source === 'scantor-workspaces' ? WORKSPACES : mount.Source === 'scantor-editor-home' ? EDITOR_HOME : mount.Source,
  }))
  return {
    ...spec,
    name: spec.name?.replace(/^scantor-h-/, `${PREFIX}h-`),
    HostConfig: { ...spec.HostConfig, Mounts: mounts, NetworkMode: spec.HostConfig?.NetworkMode === 'scantor-egress' ? EGRESS : spec.HostConfig?.NetworkMode },
  }
}

const renamingDocker = {
  createContainer: (spec: ContainerCreateOptions) => docker.createContainer(rename(spec)),
  modem: docker.modem,
} as unknown as Docker

class Collect extends Writable {
  chunks: Buffer[] = []
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.chunks.push(chunk)
    callback()
  }
  value(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

describe.skipIf(!enabled)('workspace helpers (Docker)', () => {
  beforeAll(async () => {
    await docker.createVolume({ Name: WORKSPACES })
    await docker.createVolume({ Name: EDITOR_HOME })
    await docker.createNetwork({ Name: EGRESS, Driver: 'bridge', Options: { 'com.docker.network.bridge.enable_icc': 'false' } })
    setHelperRuntimeForTesting({
      docker: renamingDocker,
      config: config as never,
      log: useLogger('helpers-it'),
      slots: new Semaphore(config.helperConcurrency),
      userLocks: new KeyedRwLock(),
      initialized: new Set(),
      initializing: new Map(),
    })
  }, 60_000)

  afterAll(async () => {
    setHelperRuntimeForTesting(null)
    const leftovers = await docker.listContainers({ all: true, filters: { name: [`${PREFIX}h-`] } })
    for (const container of leftovers) await docker.getContainer(container.Id).remove({ force: true })
    await docker.getNetwork(EGRESS).remove().catch(() => undefined)
    await docker.getVolume(WORKSPACES).remove().catch(() => undefined)
    await docker.getVolume(EDITOR_HOME).remove().catch(() => undefined)
  }, 60_000)

  let pack = Buffer.alloc(0)
  let packSha256 = ''

  it('creates the user directories and scaffolds a task', async () => {
    await ensureUserDirs(USER)
    const { workspace } = await ops.scaffold(USER, { task: 'echo', language: 'python', template: 'single', description: 'Echo' })
    expect(workspace.packSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(workspace.fileCount).toBeGreaterThan(3)
    const listing = await ops.listFiles(USER, 'echo', { path: '', recursive: true })
    const paths = listing.entries.map((entry) => entry.path)
    expect(paths).toEqual(expect.arrayContaining(['scantor.yaml', 'Dockerfile', 'main.py']))
    const manifest = await ops.readFile(USER, 'echo', 'scantor.yaml')
    expect(manifest.encoding).toBe('utf8')
    expect(manifest.content).toContain('name: echo')
  }, 120_000)

  it('refuses to scaffold over an existing task folder', async () => {
    await expect(ops.scaffold(USER, { task: 'echo', language: 'python', template: 'single' })).rejects.toMatchObject({ code: 'alreadyExists' })
  }, 60_000)

  it('writes, reads and deletes files with the path rules', async () => {
    const written = await ops.writeFiles(USER, 'echo', { 'notes/a.txt': 'hello', 'bin.dat': { base64: Buffer.from([0, 1, 2, 255]).toString('base64') } })
    expect(written.written.sort()).toEqual(['bin.dat', 'notes/a.txt'])
    const binary = await ops.readFile(USER, 'echo', 'bin.dat')
    expect(binary).toMatchObject({ encoding: 'base64', content: Buffer.from([0, 1, 2, 255]).toString('base64'), size: 4 })
    await expect(ops.readFile(USER, 'echo', 'notes/../../etc/passwd')).rejects.toMatchObject({ code: 'invalidPath' })
    await expect(ops.readFile(USER, 'echo', 'missing.txt')).rejects.toBeInstanceOf(HelperError)
    const deleted = await ops.deleteFiles(USER, 'echo', 'notes', true)
    expect(deleted.deleted).toContain('notes')
    await ops.deleteFiles(USER, 'echo', 'bin.dat', false)
  }, 120_000)

  it('snapshots the folder deterministically and reports the hash of the uncompressed tar', async () => {
    const summary = await ops.snapshotHash(USER, 'echo')
    expect(summary).not.toBeNull()
    const sink = new Collect()
    const streamed = await ops.snapshotStream(USER, 'echo', sink)
    pack = sink.value()
    packSha256 = createHash('sha256').update(gunzipSync(pack)).digest('hex')
    expect(streamed.packSha256).toBe(summary!.packSha256)
    expect(packSha256).toBe(summary!.packSha256)
    expect(streamed.packBytes).toBe(pack.length)
    expect(await ops.snapshotHash(USER, 'missing')).toBeNull()
  }, 120_000)

  it('lists and reads a snapshot on stdin without a volume', async () => {
    const listing = await ops.listArchive(USER, Readable.from([pack]), { path: '', recursive: true })
    expect(listing.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining(['scantor.yaml', 'main.py']))
    const file = await ops.readArchive(USER, Readable.from([pack]), 'scantor.yaml')
    expect(file.content).toContain('name: echo')
  }, 120_000)

  it('extracts an upload into staging and commits it atomically with --expect', async () => {
    const staging = '11111111-2222-4333-8444-555555555555'
    const extracted = await ops.extract(USER, staging, Readable.from([pack]))
    expect(extracted.manifest).toMatchObject({ name: 'echo', language: 'python' })
    expect(extracted.summary.packSha256).toBe(packSha256)
    // An edit after the conflict decision: the commit must refuse the stale expectation.
    const edited = await ops.writeFiles(USER, 'echo', { 'edit.txt': 'edited in the editor' })
    await expect(ops.commit(USER, { stagingId: staging, task: 'echo', expect: packSha256 })).rejects.toMatchObject({ code: 'workspaceDirty' })
    const committed = await ops.commit(USER, { stagingId: staging, task: 'echo', expect: edited.workspace.packSha256 })
    expect(committed).toMatchObject({ task: 'echo', changed: true, previousPackSha256: edited.workspace.packSha256, workspace: { packSha256 } })
    expect((await ops.listFiles(USER, 'echo', { path: '', recursive: false })).entries.map((entry) => entry.path)).not.toContain('edit.txt')
  }, 120_000)

  it('rejects archives with path traversal', async () => {
    const { pack: tarPack } = await import('tar-stream')
    const { gzipSync } = await import('node:zlib')
    const archive = tarPack()
    archive.entry({ name: '../escape.txt' }, 'x')
    archive.finalize()
    const chunks: Buffer[] = []
    for await (const chunk of archive) chunks.push(chunk as Buffer)
    await expect(ops.extract(USER, '21111111-2222-4333-8444-555555555555', Readable.from([gzipSync(Buffer.concat(chunks))]))).rejects.toMatchObject({ code: 'invalidPath' })
  }, 120_000)

  it('purges the user directories', async () => {
    const { removed } = await ops.purgeUserDirs(USER)
    expect(removed.length).toBeGreaterThan(0)
    const leftovers = await docker.listContainers({ all: true, filters: { name: [`${PREFIX}h-`] } })
    expect(leftovers).toHaveLength(0)
  }, 120_000)
})
