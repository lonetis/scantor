import { lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  connectEditorSocket,
  editorSocketPath,
  EditorSocketUnavailableError,
  type EditorSocketOptions,
  prepareSocketDirectory,
  removeSocketFile,
} from '../../../server/services/editor/socket'

// The editor sockets (docs/editor.md §3, §8.5, security.md ED-10). The safe connect uses Linux-only primitives
// (O_PATH, /proc/self/fd), so its cases run on Linux (`just test-orchestrator`, CI); the directory preparation runs
// everywhere. The test process owns the files, so its own uid stands in for the editor uid 1000.

const USER_ID = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const OTHER_ID = '1b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const uid = process.getuid?.() ?? 0
const gid = process.getgid?.() ?? 0

let root: string
let options: EditorSocketOptions
const servers: Server[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scantor-sock-'))
  options = { root, uid, gid }
})

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
})

function listen(path: string): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((socket) => socket.end('hello'))
    servers.push(server)
    server.listen(path, () => resolve(server))
  })
}

function connectOutcome(userId: string, socketOptions = options): Promise<string> {
  return new Promise((resolve) => {
    let socket
    try {
      socket = connectEditorSocket(userId, socketOptions)
    } catch (error) {
      resolve(error instanceof EditorSocketUnavailableError ? `refused: ${error.message}` : `error: ${String(error)}`)
      return
    }
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('end', () => resolve(`connected: ${Buffer.concat(chunks).toString('utf8')}`))
    socket.on('error', (error) => resolve(`error: ${error.message}`))
  })
}

describe('editor socket paths', () => {
  it('accepts only canonical uuids as path segments', () => {
    expect(editorSocketPath(USER_ID)).toBe(`/run/scantor/editor-sockets/${USER_ID}/code.sock`)
    expect(() => editorSocketPath('../etc')).toThrow()
    expect(() => editorSocketPath(USER_ID.toUpperCase())).toThrow()
    expect(() => editorSocketPath(`${USER_ID}/x`)).toThrow()
  })
})

describe('prepareSocketDirectory', () => {
  it('creates the user directory 0700 owned by the editor uid and removes a stale socket file', async () => {
    await prepareSocketDirectory(USER_ID, options)
    const dir = join(root, USER_ID)
    const stats = statSync(dir)
    expect(stats.isDirectory()).toBe(true)
    expect(stats.mode & 0o777).toBe(0o700)
    expect(stats.uid).toBe(uid)

    writeFileSync(join(dir, 'code.sock'), 'stale')
    await prepareSocketDirectory(USER_ID, options)
    expect(() => lstatSync(join(dir, 'code.sock'))).toThrow()
  })

  it('refuses a symlink in place of the directory', async () => {
    mkdirSync(join(root, 'elsewhere'))
    symlinkSync(join(root, 'elsewhere'), join(root, USER_ID))
    await expect(prepareSocketDirectory(USER_ID, options)).rejects.toThrow(/not a directory/)
  })

  it('removes a planted symlink, never its target', async () => {
    await prepareSocketDirectory(USER_ID, options)
    const target = join(root, 'target')
    writeFileSync(target, 'keep me')
    symlinkSync(target, join(root, USER_ID, 'code.sock'))
    await removeSocketFile(USER_ID, options)
    expect(() => lstatSync(join(root, USER_ID, 'code.sock'))).toThrow()
    expect(statSync(target).isFile()).toBe(true)
    await removeSocketFile(USER_ID, options)
  })
})

describe.skipIf(process.platform !== 'linux')('connectEditorSocket (Linux)', () => {
  it('connects to a real socket owned by the editor uid', async () => {
    await prepareSocketDirectory(USER_ID, options)
    await listen(editorSocketPath(USER_ID, options))
    expect(await connectOutcome(USER_ID)).toBe('connected: hello')
  })

  it('refuses a code.sock symlink to another socket, which a plain connect would follow', async () => {
    await prepareSocketDirectory(USER_ID, options)
    await prepareSocketDirectory(OTHER_ID, options)
    const victim = editorSocketPath(OTHER_ID, options)
    await listen(victim)
    symlinkSync(victim, editorSocketPath(USER_ID, options))
    expect(await connectOutcome(USER_ID)).toMatch(/^refused: .*a symlink/)
    expect(await connectOutcome(OTHER_ID)).toBe('connected: hello')
  })

  it('refuses a socket of another owner, a regular file and a missing socket', async () => {
    await prepareSocketDirectory(USER_ID, options)
    await listen(editorSocketPath(USER_ID, options))
    expect(await connectOutcome(USER_ID, { ...options, uid: uid + 1 })).toMatch(/^refused: .*owned by uid/)

    await prepareSocketDirectory(OTHER_ID, options)
    writeFileSync(editorSocketPath(OTHER_ID, options), 'not a socket')
    expect(await connectOutcome(OTHER_ID)).toMatch(/^refused: .*not a socket/)

    rmSync(editorSocketPath(OTHER_ID, options))
    expect(await connectOutcome(OTHER_ID)).toMatch(/^refused: .*cannot be opened \(ENOENT\)/)
  })
})

describe.skipIf(process.platform === 'linux')('connectEditorSocket (other platforms)', () => {
  it('refuses to connect without Linux primitives', () => {
    expect(() => connectEditorSocket(USER_ID, options)).toThrow(EditorSocketUnavailableError)
  })
})
