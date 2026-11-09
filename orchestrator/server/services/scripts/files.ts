import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { H3Event } from 'h3'
import type { DeleteScriptFileResult, ScriptFileContent, ScriptFileList, WriteScriptFilesResult } from '#shared/types/scripts'
import type { ScriptDoc } from '../../types/documents'
import { useLogger } from '../../utils/logger'
import { deleteFiles, type FileContentInput, listFiles, readFile, snapshotStream, writeFiles } from '../helpers/ops'
import type { WorkspaceFolder } from '../helpers/types'
import { assertTaskPath } from '../tasks/files'
import { applyScriptWorkspaceSummary } from './store'

// Script files (docs/api.md tag `script-files`, docs/scripts.md): the task file operations on the script folder
// (`--script <name>`): browsing through `list`/`read` helpers, writes through `write-files`/`delete-files`, which
// refresh the workspace cache but never `lastSyncSha256`. The path pre-check is the task one (the helper is
// authoritative). Scripts have no revisions, so nothing reads a snapshot and no result carries `dirty`.

export function scriptFolder(script: Pick<ScriptDoc, 'name'>): WorkspaceFolder {
  return { script: script.name }
}

export async function listScriptFiles(script: ScriptDoc, options: { path: string; recursive: boolean }): Promise<ScriptFileList> {
  assertTaskPath(options.path, true)
  return listFiles(script.userId, scriptFolder(script), { path: options.path, recursive: options.recursive })
}

export async function readScriptFile(script: ScriptDoc, options: { path: string }): Promise<ScriptFileContent> {
  assertTaskPath(options.path)
  return readFile(script.userId, scriptFolder(script), options.path)
}

export async function writeScriptFiles(script: ScriptDoc, files: Record<string, FileContentInput>): Promise<WriteScriptFilesResult> {
  for (const path of Object.keys(files)) assertTaskPath(path)
  const output = await writeFiles(script.userId, scriptFolder(script), files)
  await applyScriptWorkspaceSummary(script._id, output.workspace)
  return { written: output.written, workspace: { packSha256: output.workspace.packSha256 } }
}

export async function deleteScriptFile(script: ScriptDoc, options: { path: string; recursive: boolean }): Promise<DeleteScriptFileResult> {
  // Deleting the script root is script deletion (deleteScript), never a file operation.
  assertTaskPath(options.path)
  const output = await deleteFiles(script.userId, scriptFolder(script), options.path, options.recursive)
  await applyScriptWorkspaceSummary(script._id, output.workspace)
  return { deleted: output.deleted, workspace: { packSha256: output.workspace?.packSha256 ?? '' } }
}

/**
 * downloadScriptWorkspace: streams the helper `snapshot --script` (the deterministic pack a run would snapshot) to the
 * client, like the task workspace download. The response starts only once the helper produced output, so failures
 * before that (a missing folder, no free slot) are ordinary API errors; a failure after that aborts the response.
 */
export async function sendScriptWorkspaceArchive(event: H3Event, script: ScriptDoc): Promise<void> {
  const body = new PassThrough()
  const snapshot = snapshotStream(script.userId, scriptFolder(script), body)
  snapshot.catch(() => undefined)
  const readable = new Promise<void>((resolve) => body.once('readable', () => resolve()))
  await Promise.race([readable, snapshot])
  // A pack is never empty: no output means the helper failed (or finished), so its outcome decides.
  if (body.readableLength === 0) await snapshot

  const res = event.node.res
  res.writeHead(200, {
    'content-type': 'application/gzip',
    'content-disposition': `attachment; filename="${script.name}.tar.gz"`,
    'cache-control': 'no-store',
  })
  snapshot.then(
    (summary) =>
      applyScriptWorkspaceSummary(script._id, summary).catch((error: unknown) =>
        useLogger('scripts').warn('refreshing the workspace cache failed', { scriptId: script._id, err: error }),
      ),
    (error: unknown) => body.destroy(error as Error),
  )
  try {
    await pipeline(body, res)
  } catch (error) {
    useLogger('scripts').warn('script workspace download aborted', { scriptId: script._id, err: error })
  }
}
