import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { type IncomingHttpHeaders, request, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { hostname } from 'node:os'
import { join } from 'node:path'
import Docker from 'dockerode'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EditorCodeStore, FailureLimiter } from '../../../server/services/editor/codes'
import {
  dockerEditorOperations,
  EDITOR_SOCKETS_VOLUME,
  editorContainerName,
  type EditorContainerSpec,
  type EditorDocker,
} from '../../../server/services/editor/container'
import { createEditorServer } from '../../../server/services/editor/listener'
import { EditorManager } from '../../../server/services/editor/manager'
import { EditorProxy } from '../../../server/services/editor/proxy'
import { EditorSessions } from '../../../server/services/editor/sessions'
import {
  connectEditorSocket,
  EDITOR_GID,
  EDITOR_SOCKETS_ROOT,
  EDITOR_UID,
  editorSocketPath,
  EditorSocketUnavailableError,
  prepareSocketDirectory,
  removeSocketFile,
} from '../../../server/services/editor/socket'
import type { EditorDoc } from '../../../server/types/documents'
import { EDITOR_HOME_VOLUME, WORKSPACES_VOLUME } from '../../../server/utils/docker'
import { createKeyring } from '../../../server/utils/keys'
import { useLogger } from '../../../server/utils/logger'
import type { CachedUser } from '../../../server/utils/user-cache'
import { FakeCollection } from '../../helpers/fake-collection'
import { FakeEditorKeys, managerConfig, waitFor } from './fakes'

/*
 * The editor end to end against a real code-server (docs/editor.md §4, §6.2, §8; security.md ED-2, ED-3, ED-6, ED-10):
 * the real editor manager starts codercom/code-server with the editor's hardened container spec, waits for readiness
 * through the safe socket connect, and the real editor listener hands off a one-time code and relays HTTP and
 * WebSockets to code-server's unix socket in a volume. A `code.sock` replaced by a symlink (to another user's socket
 * or to the Docker socket) is refused.
 *
 * Stand-ins, because the scantor-editor image and the platform's volumes and networks are not part of a unit run:
 *   - image codercom/code-server:4.141.0, started with `/usr/bin/code-server` as entrypoint (scantor-editor execs it the
 *     same way; the upstream entrypoint's fixuid does not work under no-new-privileges) and its extensions in the home
 *     volume instead of the baked read-only /opt/code-server/extensions;
 *   - the three volumes mounted into this test's container (below) instead of scantor-editor-home, scantor-workspaces
 *     and scantor-editor-sockets, network `none` instead of scantor-sandbox, container names prefixed with this test
 *     container's own name;
 *   - in-memory `editors` documents and editor keys; the `init` helper is replaced by creating the user directories.
 *
 * The test runs only where it can: Linux, as root (it chowns to the editor uid like the orchestrator), with the Docker
 * socket and three volumes mounted. Otherwise it is skipped. From the repository root:
 *
 *   docker volume create scantor-test-editor-home; docker volume create scantor-test-editor-workspaces
 *   docker volume create scantor-test-editor-sockets
 *   docker run --rm --name scantor-test-editor-it -v "$PWD":/src -w /src/orchestrator \
 *     -v /var/run/docker.sock:/var/run/docker.sock -v scantor-test-editor-sockets:/run/scantor/editor-sockets \
 *     -v scantor-test-editor-home:/volumes/editor-home -v scantor-test-editor-workspaces:/volumes/workspaces \
 *     node:26.12.1-trixie-slim npx --no-install vitest run test/services/editor/code-server.integration.test.ts
 *
 * (with Linux node_modules installed; the code-server image must be present locally: it is never pulled).
 */

const CODE_SERVER_IMAGE = 'codercom/code-server:4.141.0'
const DOCKER_SOCKET = '/var/run/docker.sock'
/** where this test's container mounts the volumes standing in for scantor-editor-home and scantor-workspaces */
const HOME_ROOT = '/volumes/editor-home'
const WORKSPACES_ROOT = '/volumes/workspaces'
const BAKED_EXTENSIONS_DIR = '/opt/code-server/extensions'

const enabled =
  process.platform === 'linux' && process.getuid?.() === 0 && [DOCKER_SOCKET, EDITOR_SOCKETS_ROOT, HOME_ROOT, WORKSPACES_ROOT].every((path) => existsSync(path))

const EDITOR_HOST = 'editor.test'
const EDITOR_URL = `http://${EDITOR_HOST}`
const PUBLIC_URL = 'http://dashboard.test'
const START_TIMEOUT_MS = 120_000

const USER_A = randomUUID()
/** a user whose `code.sock` is a symlink to USER_A's socket */
const USER_B = randomUUID()
/** a user whose `code.sock` is a symlink to the Docker socket */
const USER_C = randomUUID()
const USERS = [USER_A, USER_B, USER_C]

const keyring = createKeyring('editor code-server integration test secret')
const sign = (userId: string, startedAtMs: number, expiresAtMs: number) => keyring.editorCookie(userId, startedAtMs, expiresAtMs)

interface Environment {
  /** this container's name; containers the test creates are named after it */
  ownName: string
  /** platform volume name → the volume mounted into this container that stands in for it */
  volumes: Record<string, string>
}

async function discoverEnvironment(docker: Docker): Promise<Environment> {
  const self = await docker.getContainer(hostname()).inspect()
  const mounted = new Map(self.Mounts.filter((mount) => mount.Type === 'volume').map((mount) => [mount.Destination, mount.Name!]))
  const volumeAt = (destination: string): string => {
    const name = mounted.get(destination)
    if (!name) throw new Error(`no volume is mounted at ${destination}`)
    return name
  }
  return {
    ownName: self.Name.replace(/^\//, ''),
    volumes: {
      [EDITOR_HOME_VOLUME]: volumeAt(HOME_ROOT),
      [WORKSPACES_VOLUME]: volumeAt(WORKSPACES_ROOT),
      [EDITOR_SOCKETS_VOLUME]: volumeAt(EDITOR_SOCKETS_ROOT),
    },
  }
}

/** The real Docker operations, applied to the stand-ins of this test (see the header). */
function standInDocker(real: EditorDocker, env: Environment): EditorDocker & { nameOf(name: string): string } {
  const nameOf = (name: string) => `${env.ownName}-${name}`
  return {
    nameOf,
    imageExists: () => real.imageExists(CODE_SERVER_IMAGE),
    pullImage: async () => {
      throw new Error(`pull ${CODE_SERVER_IMAGE} before running this test`)
    },
    createAndStart: (spec) => {
      const adapted: EditorContainerSpec & { Entrypoint: string[] } = {
        ...spec,
        name: nameOf(spec.name),
        Image: CODE_SERVER_IMAGE,
        Entrypoint: ['/usr/bin/code-server'],
        Cmd: spec.Cmd.map((arg) => (arg === BAKED_EXTENSIONS_DIR ? '/home/coder/.local/share/code-server/extensions' : arg)),
        Labels: { ...spec.Labels, 'scantor.test': 'true' },
        HostConfig: {
          ...spec.HostConfig,
          NetworkMode: 'none',
          Mounts: spec.HostConfig.Mounts.map((mount) => ({ ...mount, Source: env.volumes[mount.Source]! })),
        },
        NetworkingConfig: { EndpointsConfig: {} },
      }
      return real.createAndStart(adapted)
    },
    stopAndRemove: (name) => real.stopAndRemove(nameOf(name)),
    remove: (name) => real.remove(nameOf(name)),
    inspect: (name) => real.inspect(nameOf(name)),
    listEditors: () => real.listEditors(),
  }
}

/** What the `init` helper does for a user (docs/editor.md §9.4): the home and workspace directories, 1000:1000, 0700. */
function createUserDirs(userId: string): void {
  for (const root of [HOME_ROOT, WORKSPACES_ROOT]) {
    const dir = join(root, userId)
    mkdirSync(dir, { recursive: true })
    chownSync(dir, EDITOR_UID, EDITOR_GID)
    chmodSync(dir, 0o700)
  }
  const task = join(WORKSPACES_ROOT, userId, 'echo')
  mkdirSync(task, { recursive: true })
  writeFileSync(join(task, 'main.py'), 'print("hello")\n')
  chownSync(task, EDITOR_UID, EDITOR_GID)
  chownSync(join(task, 'main.py'), EDITOR_UID, EDITOR_GID)
}

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  /** header lines as received (Node joins repeated headers in `headers`) */
  rawHeaders: string[]
  body: string
}

/** Every value of a header that arrived as separate lines. */
function headerLines(reply: Reply, name: string): string[] {
  const lines: string[] = []
  for (let i = 0; i < reply.rawHeaders.length; i += 2) if (reply.rawHeaders[i]!.toLowerCase() === name) lines.push(reply.rawHeaders[i + 1]!)
  return lines
}

type UpgradeOutcome = { kind: 'upgraded'; socket: Socket; head: Buffer } | { kind: 'rejected'; status: number }

describe.skipIf(!enabled)('editor against a real code-server', () => {
  const log = useLogger('test')
  const editors = new FakeCollection<EditorDoc>('editors')
  const users = new Map<string, CachedUser>(
    USERS.map((id) => [id, { id, email: `${id.slice(0, 8)}@example.com`, name: 'Editor user', role: 'user', banned: false, banExpires: null, canRunPrivileged: false, maxWorkers: 0 }]),
  )
  const codes = new EditorCodeStore()
  const sessions = new EditorSessions({
    sign,
    getUser: async (userId) => users.get(userId) ?? null,
    isBanned: (user) => user.banned,
    loadEditor: (userId) => editors.findOne({ _id: userId }),
    codes,
    stateTtlMs: 0,
  })
  const proxy = new EditorProxy({
    connect: (userId) => connectEditorSocket(userId),
    security: { dashboardOrigin: PUBLIC_URL, https: false },
    dashboardUrl: PUBLIC_URL,
    onRequest: () => {},
    log,
  })

  let docker: Docker
  let stand: ReturnType<typeof standInDocker>
  let manager: EditorManager
  let listener: Server
  let port: number

  beforeAll(async () => {
    docker = new Docker({ socketPath: DOCKER_SOCKET })
    stand = standInDocker(dockerEditorOperations(docker), await discoverEnvironment(docker))
    manager = new EditorManager({
      editors: editors.asCollection(),
      config: managerConfig({ editorStartTimeoutMs: START_TIMEOUT_MS }),
      docker: stand,
      keys: new FakeEditorKeys(),
      sockets: { prepare: (userId) => prepareSocketDirectory(userId), remove: (userId) => removeSocketFile(userId), connect: (userId) => connectEditorSocket(userId) },
      ensureUserDirs: async (userId) => createUserDirs(userId),
      hooks: {
        onStateChanged: (userId) => sessions.invalidate(userId),
        onTeardown: (userId) => {
          proxy.closeUser(userId)
          codes.revokeUser(userId)
          sessions.invalidate(userId)
        },
      },
      log,
    })
    listener = createEditorServer({ editorUrl: EDITOR_URL, publicUrl: PUBLIC_URL, isTrustedProxy: () => false, sessions, proxy, limiter: new FailureLimiter(), log })
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    port = (listener.address() as { port: number }).port
  })

  afterAll(async () => {
    proxy.closeAll()
    if (listener) {
      listener.closeAllConnections()
      await new Promise<void>((resolve) => listener.close(() => resolve()))
    }
    if (stand) for (const userId of USERS) await stand.remove(editorContainerName(userId))
    for (const userId of USERS) {
      for (const root of [EDITOR_SOCKETS_ROOT, HOME_ROOT, WORKSPACES_ROOT]) rmSync(join(root, userId), { recursive: true, force: true })
    }
  })

  function send(path: string, headers: Record<string, string> = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers: { host: EDITOR_HOST, ...headers }, agent: false }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      req.end()
    })
  }

  function upgrade(path: string, headers: Record<string, string>): Promise<UpgradeOutcome> {
    return new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port,
        path,
        agent: false,
        headers: {
          host: EDITOR_HOST,
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': randomBytes(16).toString('base64'),
          'sec-websocket-version': '13',
          ...headers,
        },
      })
      req.on('upgrade', (_res, socket, head) => resolve({ kind: 'upgraded', socket, head }))
      req.on('response', (res) => {
        res.resume()
        resolve({ kind: 'rejected', status: res.statusCode! })
      })
      req.on('error', reject)
      req.end()
    })
  }

  /** A fresh `scantor_editor` cookie through the real handoff (`GET /_auth?code=`). */
  async function handoff(userId: string, open: string | null = null): Promise<{ cookie: string; location: string }> {
    const { code } = codes.issue(userId, open)
    const reply = await send(`/_auth?code=${code}`)
    expect(reply.status).toBe(302)
    const setCookie = reply.headers['set-cookie']?.[0] ?? ''
    expect(setCookie).toMatch(/^scantor_editor=v1\./)
    return { cookie: setCookie.split(';')[0]!, location: String(reply.headers.location) }
  }

  /** An `editors` document for a user without a container (the symlink cases). */
  async function fakeRunningEditor(userId: string): Promise<void> {
    const now = new Date()
    await editors.insertOne({
      _id: userId,
      state: 'running',
      containerId: null,
      containerName: null,
      image: CODE_SERVER_IMAGE,
      apiKeyId: null,
      apiKeyExpiresAt: null,
      startedAt: now,
      lastActivityAt: now,
      stoppedAt: null,
      updatedAt: now,
      error: null,
    })
  }

  it(
    'starts code-server with the hardened editor profile and becomes ready over the safe socket connect',
    async () => {
      const started = await manager.ensureStarted({ id: USER_A, email: users.get(USER_A)!.email })
      expect(started.state).toBe('starting')
      await waitFor(async () => (await editors.findOne({ _id: USER_A }))?.state !== 'starting', START_TIMEOUT_MS)
      const doc = await editors.findOne({ _id: USER_A })
      expect(doc).toMatchObject({ state: 'running', error: null, containerName: editorContainerName(USER_A) })

      const info = await docker.getContainer(stand.nameOf(editorContainerName(USER_A))).inspect()
      expect(info.State.Running).toBe(true)
      expect(info.Config.User).toBe('1000:1000')
      expect(info.Config.Env).toEqual(expect.arrayContaining(['SCANTOR_DEV_MODE=remote', 'SCANTOR_WORKSPACE=/home/coder/workspace']))
      expect(info.Config.Cmd).toEqual(expect.arrayContaining(['--socket', '/run/scantor-editor/code.sock', '--auth', 'none', '--disable-proxy']))
      expect(info.Config.Cmd).not.toContain('--disable-workspace-trust')
      expect(info.HostConfig).toMatchObject({ ReadonlyRootfs: true, CapDrop: ['ALL'], Init: true, PidsLimit: 1024, NetworkMode: 'none' })
      expect(info.HostConfig.SecurityOpt).toContain('no-new-privileges:true')
      expect(info.Mounts.map((mount) => mount.Destination).sort()).toEqual(['/home/coder', '/home/coder/workspace', '/run/scantor-editor'])

      // code-server listens only on the 0600 unix socket of uid 1000 in the user's directory of the socket volume.
      const socket = lstatSync(editorSocketPath(USER_A))
      expect(socket.isSocket()).toBe(true)
      expect(socket.uid).toBe(EDITOR_UID)
      expect(socket.mode & 0o777).toBe(0o600)
    },
    START_TIMEOUT_MS + 10_000,
  )

  it('hands off a one-time code and proxies code-server over HTTP without forwarding credentials', async () => {
    const { cookie, location } = await handoff(USER_A, 'echo')
    expect(location).toBe('/?folder=/home/coder/workspace/echo')

    const page = await send(location, { cookie: `${cookie}; scantor.session_token=dashboard`, authorization: 'Bearer sk_scantor_x' })
    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toMatch(/text\/html/)
    expect(page.body).toMatch(/<!DOCTYPE html>/i)
    expect(page.headers['set-cookie']).toBeUndefined()
    // frame-ancestors is an additional policy: code-server's own CSP arrives unchanged as a separate header line.
    const policies = headerLines(page, 'content-security-policy')
    expect(policies).toContain(`frame-ancestors 'self' ${PUBLIC_URL}`)
    expect(policies.length).toBeGreaterThan(1)
    expect(page.headers['x-content-type-options']).toBe('nosniff')

    // Static assets of the workbench stream through the same agent.
    const asset = /src="(?:\.\/)?([^"]*\/workbench\.js)"/.exec(page.body)?.[1]
    expect(asset).toBeDefined()
    const assetReply = await send(`/${asset}`, { cookie })
    expect(assetReply.status).toBe(200)
    expect(assetReply.body.length).toBeGreaterThan(0)

    const health = await send('/healthz', { cookie })
    expect(health.status).toBe(200)
    expect(JSON.parse(health.body)).toMatchObject({ status: 'alive' })
  })

  it('accepts no dashboard credentials and no used code', async () => {
    expect((await send('/', { cookie: 'scantor.session_token=dashboard' })).status).toBe(401)
    expect((await send('/', { authorization: 'Bearer sk_scantor_x' })).status).toBe(401)
    const { code } = codes.issue(USER_A, null)
    expect((await send(`/_auth?code=${code}`)).status).toBe(302)
    expect((await send(`/_auth?code=${code}`)).status).toBe(401)
  })

  it('relays WebSockets byte for byte: code-server accepts the upgrade with the editor host and origin', async () => {
    const { cookie } = await handoff(USER_A)
    const path = `/?reconnectionToken=${randomUUID()}&reconnection=false&skipWebSocketFrames=false`

    // code-server's own origin check passes only because Host and Origin arrive unchanged.
    const outcome = await upgrade(path, { cookie, origin: EDITOR_URL })
    expect(outcome.kind).toBe('upgraded')
    if (outcome.kind !== 'upgraded') return
    expect(proxy.openWebSockets(USER_A)).toBe(1)

    // A masked ping travels to code-server and its pong comes back through the relay, both unchanged.
    const pong = new Promise<Buffer>((resolve) => {
      let received = outcome.head
      const onData = (chunk: Buffer) => {
        received = Buffer.concat([received, chunk])
        if (received.length < 4) return
        outcome.socket.off('data', onData)
        resolve(received)
      }
      outcome.socket.on('data', onData)
    })
    const mask = [1, 2, 3, 4]
    outcome.socket.write(Buffer.from([0x89, 0x82, ...mask, 0x68 ^ mask[0]!, 0x69 ^ mask[1]!]))
    expect(await pong).toEqual(Buffer.from([0x8a, 0x02, 0x68, 0x69]))

    outcome.socket.destroy()
    await waitFor(() => proxy.openWebSockets(USER_A) === 0)

    // Cross-site WebSocket hijacking is stopped before code-server sees the request.
    expect(await upgrade(path, { cookie, origin: PUBLIC_URL })).toEqual({ kind: 'rejected', status: 403 })
    expect(await upgrade(path, { origin: EDITOR_URL })).toEqual({ kind: 'rejected', status: 401 })
  })

  it('refuses a code.sock replaced by a symlink to another user\'s socket or to the Docker socket', async () => {
    await prepareSocketDirectory(USER_B)
    symlinkSync(editorSocketPath(USER_A), editorSocketPath(USER_B))
    await prepareSocketDirectory(USER_C)
    symlinkSync(DOCKER_SOCKET, editorSocketPath(USER_C))
    await fakeRunningEditor(USER_B)
    await fakeRunningEditor(USER_C)

    for (const userId of [USER_B, USER_C]) {
      expect(() => connectEditorSocket(userId)).toThrow(EditorSocketUnavailableError)
      expect(() => connectEditorSocket(userId)).toThrow(/a symlink/)
      const { cookie } = await handoff(userId)
      const page = await send('/healthz', { cookie })
      expect(page.status).toBe(502)
      expect(page.body).not.toContain('alive')
      expect(await upgrade('/', { cookie, origin: EDITOR_URL })).toEqual({ kind: 'rejected', status: 502 })
    }
    // The symlink targets themselves still work for their owner.
    const { cookie } = await handoff(USER_A)
    expect((await send('/healthz', { cookie })).status).toBe(200)
  })

  it('stops the editor: container and socket removed, open WebSockets closed, cookies end', async () => {
    const { cookie } = await handoff(USER_A)
    const outcome = await upgrade(`/?reconnectionToken=${randomUUID()}&reconnection=false&skipWebSocketFrames=false`, { cookie, origin: EDITOR_URL })
    expect(outcome.kind).toBe('upgraded')
    const closed = outcome.kind === 'upgraded' ? new Promise((resolve) => outcome.socket.once('close', resolve)) : Promise.resolve()

    await manager.stop(USER_A, 'user')
    await closed
    expect(await editors.findOne({ _id: USER_A })).toMatchObject({ state: 'stopped', containerId: null, apiKeyId: null })
    expect(await stand.inspect(editorContainerName(USER_A))).toBeNull()
    expect(existsSync(editorSocketPath(USER_A))).toBe(false)
    expect((await send('/', { cookie })).status).toBe(410)
  })
})
