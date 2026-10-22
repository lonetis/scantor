import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EditorContainerSpec, EditorContainerState, EditorContainerSummary, EditorDocker } from '../../../server/services/editor/container'
import type { EditorKeyStore, MintedEditorKey } from '../../../server/services/editor/keys'
import { EditorManager, type EditorManagerConfig } from '../../../server/services/editor/manager'
import { EditorSocketUnavailableError } from '../../../server/services/editor/socket'
import type { EditorDoc } from '../../../server/types/documents'
import { parseConfig } from '../../../server/utils/config'
import { useLogger } from '../../../server/utils/logger'
import { FakeCollection } from '../../helpers/fake-collection'

// In-memory stand-ins for the editor manager's dependencies: Docker, the editor key store, the socket directory and
// a fake code-server that answers GET /healthz on a unix socket once its "container" runs.

export class FakeEditorDocker implements EditorDocker {
  readonly calls: string[] = []
  readonly containers = new Map<string, { spec: EditorContainerSpec; running: boolean; exitCode: number | null }>()
  images = new Set<string>()
  pulled: string[] = []
  /** throws from stopAndRemove while set */
  failStop: Error | null = null
  /** resolves createAndStart only when released (a slow start) */
  createGate: Promise<void> | null = null
  /** the container exits right after starting */
  crashOnStart = false

  async imageExists(ref: string): Promise<boolean> {
    this.calls.push(`imageExists ${ref}`)
    return this.images.has(ref)
  }

  async pullImage(ref: string): Promise<void> {
    this.calls.push(`pull ${ref}`)
    this.pulled.push(ref)
    this.images.add(ref)
  }

  async createAndStart(spec: EditorContainerSpec): Promise<string> {
    this.calls.push(`create ${spec.name}`)
    if (this.createGate) await this.createGate
    this.containers.set(spec.name, { spec, running: !this.crashOnStart, exitCode: this.crashOnStart ? 1 : null })
    return `id-${spec.name}`
  }

  async stopAndRemove(name: string): Promise<void> {
    this.calls.push(`stopAndRemove ${name}`)
    if (this.failStop) throw this.failStop
    this.containers.delete(name)
  }

  async remove(name: string): Promise<void> {
    this.calls.push(`remove ${name}`)
    this.containers.delete(name)
  }

  async inspect(name: string): Promise<EditorContainerState | null> {
    const container = this.containers.get(name)
    return container ? { running: container.running, exitCode: container.exitCode } : null
  }

  async listEditors(): Promise<EditorContainerSummary[]> {
    return [...this.containers.entries()].map(([name, container]) => ({
      id: `id-${name}`,
      name,
      userId: container.spec.Labels['scantor.user'] ?? null,
      running: container.running,
    }))
  }

  isRunning(userId: string): boolean {
    return this.containers.get(`scantor-editor-${userId}`)?.running === true
  }
}

export class FakeEditorKeys implements EditorKeyStore {
  readonly calls: string[] = []
  readonly keys = new Map<string, MintedEditorKey[]>()
  private counter = 0

  constructor(private readonly ttlMs = 7 * 24 * 3_600_000) {}

  async mint(userId: string): Promise<MintedEditorKey> {
    this.calls.push(`mint ${userId}`)
    const minted = { id: `key-${++this.counter}`, key: `sk_scantor_editor_${'k'.repeat(63)}${this.counter % 10}`, expiresAt: new Date(Date.now() + this.ttlMs) }
    this.keys.set(userId, [...(this.keys.get(userId) ?? []), minted])
    return minted
  }

  async deleteAll(userId: string): Promise<void> {
    this.calls.push(`deleteAll ${userId}`)
    this.keys.delete(userId)
  }

  async owners(): Promise<string[]> {
    return [...this.keys.keys()]
  }
}

/** A code-server stand-in on a unix socket: `GET /healthz` → 200 while `healthy` says so. */
export class FakeCodeServer {
  readonly dir = mkdtempSync(join(tmpdir(), 'scantor-cs-'))
  readonly path = join(this.dir, 'code.sock')
  healthy = true
  private server: Server | null = null

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      res.writeHead(req.url === '/healthz' && this.healthy ? 200 : 503, { 'content-type': 'application/json' })
      res.end('{"status":"alive"}')
    })
    await new Promise<void>((resolve) => this.server!.listen(this.path, resolve))
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    rmSync(this.dir, { recursive: true, force: true })
  }

  connect(): Socket {
    return createConnection(this.path)
  }
}

export interface ManagerWorld {
  manager: EditorManager
  editors: FakeCollection<EditorDoc>
  docker: FakeEditorDocker
  keys: FakeEditorKeys
  codeServer: FakeCodeServer
  config: EditorManagerConfig
  events: string[]
}

export function managerConfig(overrides: Partial<EditorManagerConfig> = {}): EditorManagerConfig {
  return { ...parseConfig({ SCANTOR_IMAGE_PREFIX: '', SCANTOR_IMAGE_TAG: 'dev' }).config, editorStartTimeoutMs: 2_000, ...overrides }
}

/** A manager over fakes; the fake code-server answers only while the user's fake container runs. */
export function createManagerWorld(codeServer: FakeCodeServer, overrides: Partial<EditorManagerConfig> = {}): ManagerWorld {
  const editors = new FakeCollection<EditorDoc>('editors')
  const docker = new FakeEditorDocker()
  const keys = new FakeEditorKeys()
  const config = managerConfig(overrides)
  docker.images.add(`${config.imagePrefix}scantor-editor:${config.imageTag}`)
  const events: string[] = []
  const manager = new EditorManager({
    editors: editors.asCollection(),
    config,
    docker,
    keys,
    sockets: {
      prepare: async (userId) => {
        events.push(`prepare ${userId}`)
      },
      remove: async (userId) => {
        events.push(`removeSocket ${userId}`)
      },
      connect: (userId) => {
        if (!docker.isRunning(userId)) throw new EditorSocketUnavailableError('no socket yet')
        return codeServer.connect()
      },
    },
    ensureUserDirs: async (userId) => {
      events.push(`init ${userId}`)
    },
    hooks: {
      onStateChanged: (userId) => events.push(`changed ${userId}`),
      onTeardown: (userId) => events.push(`teardown ${userId}`),
    },
    log: useLogger('test'),
    pollIntervalMs: 10,
  })
  return { manager, editors, docker, keys, codeServer, config, events }
}

/** Waits until `predicate` holds (polling every 5 ms, at most `timeoutMs`). */
export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition not reached in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
