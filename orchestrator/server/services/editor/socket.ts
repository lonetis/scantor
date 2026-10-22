import { closeSync, constants as fsConstants, fstatSync, openSync } from 'node:fs'
import { chmod, lchown, lstat, mkdir, unlink } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { isUuid } from '#shared/utils/slug'

/*
 * The editors' unix sockets (docs/editor.md §3, §8.5, security.md ED-3, ED-10). The orchestrator mounts the volume
 * `scantor-editor-sockets` whole at /run/scantor/editor-sockets; each editor mounts only its subpath `<userId>` at
 * /run/scantor-editor, where code-server listens on `code.sock` (mode 0600, uid 1000).
 *
 * The user controls the contents of their directory and could replace `code.sock` with a symlink to the Docker
 * socket or to another user's socket, both of which exist in the orchestrator's mount namespace. A plain
 * `connect(path)` follows symlinks and cannot be checked without a race, so the connection goes through a file
 * descriptor that pins the inode: open with O_PATH | O_NOFOLLOW (a symlink is opened as the link itself), fstat
 * must report a socket owned by the editor uid, and the connection targets /proc/self/fd/<n>. The per-user
 * directory sits in the volume root, which no editor can write to.
 */

export const EDITOR_SOCKETS_ROOT = '/run/scantor/editor-sockets'
export const EDITOR_SOCKET_NAME = 'code.sock'
/** uid:gid of every editor container (docs/editor.md §3) */
export const EDITOR_UID = 1000
export const EDITOR_GID = 1000

/** Linux O_PATH; the same value on amd64 and arm64. Node does not export it. */
const O_PATH = 0o10000000

export interface EditorSocketOptions {
  /** where the orchestrator sees the socket volume */
  root: string
  /** required owner of the socket and the per-user directory */
  uid: number
  gid: number
}

export const DEFAULT_SOCKET_OPTIONS: EditorSocketOptions = { root: EDITOR_SOCKETS_ROOT, uid: EDITOR_UID, gid: EDITOR_GID }

/** The editor's socket cannot be used: missing, not a socket, wrong owner, or a symlink. */
export class EditorSocketUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EditorSocketUnavailableError'
  }
}

function assertUserId(userId: string): void {
  // The id becomes a path segment: only a canonical uuid is ever accepted.
  if (!isUuid(userId) || userId !== userId.toLowerCase()) throw new Error(`invalid user id for an editor socket path: ${userId}`)
}

export function editorSocketDir(userId: string, options: EditorSocketOptions = DEFAULT_SOCKET_OPTIONS): string {
  assertUserId(userId)
  return join(options.root, userId)
}

export function editorSocketPath(userId: string, options: EditorSocketOptions = DEFAULT_SOCKET_OPTIONS): string {
  return join(editorSocketDir(userId, options), EDITOR_SOCKET_NAME)
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

/**
 * Connects to exactly the socket inode at the user's `code.sock` (docs/editor.md §8.5). Throws
 * EditorSocketUnavailableError synchronously when the path is missing, is a symlink, is not a socket or has another
 * owner; connection errors arrive as the socket's `error` event.
 */
export function connectEditorSocket(userId: string, options: EditorSocketOptions = DEFAULT_SOCKET_OPTIONS): Socket {
  if (process.platform !== 'linux') throw new EditorSocketUnavailableError('safe editor socket connects need Linux (O_PATH, /proc/self/fd)')
  const path = editorSocketPath(userId, options)
  let fd: number
  try {
    fd = openSync(path, O_PATH | fsConstants.O_NOFOLLOW)
  } catch (error) {
    throw new EditorSocketUnavailableError(`editor socket of user ${userId} cannot be opened (${errorCode(error) ?? 'error'})`, { cause: error })
  }
  let pinned = false
  try {
    const stats = fstatSync(fd)
    if (!stats.isSocket()) {
      const kind = stats.isSymbolicLink() ? 'a symlink' : 'not a socket'
      throw new EditorSocketUnavailableError(`editor socket of user ${userId} is ${kind}; refusing to connect`)
    }
    if (stats.uid !== options.uid) {
      throw new EditorSocketUnavailableError(`editor socket of user ${userId} is owned by uid ${stats.uid}, expected ${options.uid}`)
    }
    const socket = createConnection({ path: `/proc/self/fd/${fd}` })
    pinned = true
    // The descriptor only pins the inode until the connection exists or failed; release it exactly once.
    let released = false
    const release = () => {
      if (released) return
      released = true
      closeSync(fd)
    }
    socket.once('connect', release)
    socket.once('error', release)
    socket.once('close', release)
    return socket
  } finally {
    if (!pinned) closeSync(fd)
  }
}

/**
 * Prepares the user's socket directory before an editor start (docs/editor.md §6.2 step 2): create it (0700) when
 * missing, require a real directory (never a symlink), make it owned by the editor uid, and remove a stale
 * `code.sock` so readiness never sees the previous container's socket.
 */
export async function prepareSocketDirectory(userId: string, options: EditorSocketOptions = DEFAULT_SOCKET_OPTIONS): Promise<void> {
  const dir = editorSocketDir(userId, options)
  try {
    await mkdir(dir, { mode: 0o700 })
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
  }
  const stats = await lstat(dir)
  if (!stats.isDirectory()) throw new Error(`editor socket directory of user ${userId} is not a directory`)
  await lchown(dir, options.uid, options.gid)
  await chmod(dir, 0o700)
  await removeSocketFile(userId, options)
}

/** Removes the user's `code.sock` (a socket or whatever the user put there); a missing file is fine. */
export async function removeSocketFile(userId: string, options: EditorSocketOptions = DEFAULT_SOCKET_OPTIONS): Promise<void> {
  try {
    await unlink(editorSocketPath(userId, options))
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
}
