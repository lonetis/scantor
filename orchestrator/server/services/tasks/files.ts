import { PassThrough, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { H3Event } from 'h3'
import type { DeleteTaskFileResult, TaskFileContent, TaskFileList, WriteTaskFilesResult } from '#shared/types/tasks'
import type { TaskDoc } from '../../types/documents'
import { resolveTaskRevision } from '../../utils/authz'
import { apiError } from '../../utils/errors'
import { useLogger } from '../../utils/logger'
import { getObjectStream } from '../../utils/s3'
import { deleteFiles, type FileContentInput, listArchive, listFiles, readArchive, readFile, snapshotStream, writeFiles } from '../helpers/ops'
import { isDirtyAgainst } from './mappers'
import { applyWorkspaceSummary } from './store'

// Task files (docs/api.md §4.7, docs/editor.md §9.9): browsing reads the workspace through `list`/`read` helpers, or
// with `revision` the immutable S3 snapshot through `list --archive`/`read --archive` helpers (no volume mounted); it
// is never parsed in this process. Writes go through `write-files`/`delete-files`; they refresh the workspace cache
// but never `lastSyncSha256`.

const MAX_PATH_BYTES = 1024
const MAX_SEGMENT_BYTES = 255
const MAX_DEPTH = 32

/**
 * The path rules of docs/editor.md §9.5, checked before a helper starts (the helper re-checks them and is
 * authoritative). Returns the problem or null. `allowRoot` accepts "" (the task root).
 */
export function taskPathProblem(path: string, allowRoot = false): string | null {
  if (path === '') return allowRoot ? null : 'the path must not be empty'
  if (path.includes('\0')) return 'the path must not contain NUL'
  if (path.includes('\\')) return 'the path must not contain backslashes'
  if (path.startsWith('/')) return 'the path must be relative'
  if (Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES) return `the path must be at most ${MAX_PATH_BYTES} bytes`
  const segments = path.split('/')
  if (segments.length > MAX_DEPTH) return `the path must be at most ${MAX_DEPTH} levels deep`
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return 'the path must not contain empty, "." or ".." segments'
    if (Buffer.byteLength(segment, 'utf8') > MAX_SEGMENT_BYTES) return `each path segment must be at most ${MAX_SEGMENT_BYTES} bytes`
  }
  if (segments[0] === '.scantor-staging') return 'the path must not be inside .scantor-staging'
  return null
}

export function assertTaskPath(path: string, allowRoot = false): void {
  const problem = taskPathProblem(path, allowRoot)
  if (problem) throw apiError('invalidPath', problem, { path })
}

async function revisionSnapshot(task: TaskDoc, revision: string): Promise<Readable> {
  const doc = await resolveTaskRevision(task, revision)
  return getObjectStream(doc.snapshotKey)
}

export async function listTaskFiles(task: TaskDoc, options: { path: string; recursive: boolean; revision?: string }): Promise<TaskFileList> {
  assertTaskPath(options.path, true)
  if (options.revision !== undefined) {
    const archive = await revisionSnapshot(task, options.revision)
    return listArchive(task.userId, archive, { path: options.path, recursive: options.recursive })
  }
  return listFiles(task.userId, task.name, { path: options.path, recursive: options.recursive })
}

export async function readTaskFile(task: TaskDoc, options: { path: string; revision?: string }): Promise<TaskFileContent> {
  assertTaskPath(options.path)
  if (options.revision !== undefined) {
    const archive = await revisionSnapshot(task, options.revision)
    return readArchive(task.userId, archive, options.path)
  }
  return readFile(task.userId, task.name, options.path)
}

export async function writeTaskFiles(task: TaskDoc, files: Record<string, FileContentInput>): Promise<WriteTaskFilesResult> {
  for (const path of Object.keys(files)) assertTaskPath(path)
  const output = await writeFiles(task.userId, task.name, files)
  const updated = await applyWorkspaceSummary(task._id, output.workspace)
  return {
    written: output.written,
    workspace: { packSha256: output.workspace.packSha256, dirty: isDirtyAgainst(output.workspace.packSha256, updated ?? task) },
  }
}

export async function deleteTaskFile(task: TaskDoc, options: { path: string; recursive: boolean }): Promise<DeleteTaskFileResult> {
  // Deleting the task root is task deletion (deleteTask), never a file operation.
  assertTaskPath(options.path)
  const output = await deleteFiles(task.userId, task.name, options.path, options.recursive)
  const summary = output.workspace
  const updated = await applyWorkspaceSummary(task._id, summary)
  return {
    deleted: output.deleted,
    workspace: { packSha256: summary?.packSha256 ?? '', dirty: isDirtyAgainst(summary?.packSha256 ?? null, updated ?? task) },
  }
}

/**
 * downloadTaskWorkspace: streams the helper `snapshot` (the deterministic pack) to the client. The response starts
 * only once the helper produced output, so failures before that (a missing folder, no free slot) are ordinary API
 * errors; a failure after that aborts the response, and the client sees a truncated download.
 */
export async function sendWorkspaceArchive(event: H3Event, task: TaskDoc): Promise<void> {
  const body = new PassThrough()
  const snapshot = snapshotStream(task.userId, task.name, body)
  snapshot.catch(() => undefined)
  const readable = new Promise<void>((resolve) => body.once('readable', () => resolve()))
  await Promise.race([readable, snapshot])
  // A pack is never empty: no output means the helper failed (or finished), so its outcome decides.
  if (body.readableLength === 0) await snapshot

  const res = event.node.res
  res.writeHead(200, {
    'content-type': 'application/gzip',
    'content-disposition': `attachment; filename="${task.name}.tar.gz"`,
    'cache-control': 'no-store',
  })
  snapshot.then(
    (summary) => applyWorkspaceSummary(task._id, summary).catch((error: unknown) => useLogger('tasks').warn('refreshing the workspace cache failed', { taskId: task._id, err: error })),
    (error: unknown) => body.destroy(error as Error),
  )
  try {
    await pipeline(body, res)
  } catch (error) {
    useLogger('tasks').warn('workspace download aborted', { taskId: task._id, err: error })
  }
}
