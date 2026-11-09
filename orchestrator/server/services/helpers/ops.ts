import type { Readable, Writable } from 'node:stream'
import type { Config } from '../../utils/config'
import { executeHelper, useHelperRuntime } from './executor'
import { checkHelperResult, HelperError, type HelperErrorContext, isHelperCode, parseHelperStdout } from './protocol'
import type {
  CommitExpectation,
  CommitOutput,
  DeleteFilesOutput,
  ExtractOutput,
  FolderKind,
  FolderRef,
  GitCloneOutput,
  GitPullOutput,
  HelperOp,
  HelperResult,
  HelperRunOptions,
  ListOutput,
  ReadOutput,
  SnapshotSummary,
  WorkspaceFolder,
  WorkspaceSummary,
  WriteFilesOutput,
} from './types'

// Typed workspace operations (docs/editor.md §9.4): each builds the exact flags of `scantor workspace <op>`, runs the
// helper and parses its single JSON document. Limits are passed as flags, never through the environment
// (docs/editor.md §9.2). Folder operations take a FolderRef: a task name, or `{script: name}` for a script folder
// (`--script <name>`); the helper alone maps it to a path.

export const FILE_LIST_MAX_ENTRIES = 5000
export const FILE_READ_MAX_BYTES = 1024 ** 2

function limitFlags(config: Config, which: { files?: boolean; bytes?: boolean; workspace?: boolean; pack?: boolean }): string[] {
  const flags: string[] = []
  if (which.files) flags.push('--max-files', String(config.taskMaxFiles))
  if (which.bytes) flags.push('--max-bytes', String(config.taskMaxBytes))
  if (which.workspace) flags.push('--max-workspace-bytes', String(config.workspaceMaxBytes))
  if (which.pack) flags.push('--max-pack-bytes', String(config.taskMaxPackBytes))
  return flags
}

async function runJson<T>(op: HelperOp, options: HelperRunOptions, secrets: readonly string[] = [], context: HelperErrorContext = {}): Promise<T> {
  const result = await executeHelper(op, options)
  checkHelperResult(op, result, secrets, context)
  return parseHelperStdout<T>(op, result)
}

function config(): Config {
  return useHelperRuntime().config
}

/** The kind and name of a folder reference (a bare string is a task name). */
export function folderOf(ref: FolderRef): { kind: FolderKind; name: string } {
  if (typeof ref === 'string') return { kind: 'task', name: ref }
  return ref.script !== undefined ? { kind: 'script', name: ref.script } : { kind: 'task', name: ref.task }
}

/** The helper flags that address a folder: `--task <name>` or `--script <name>`. */
export function folderArgs(ref: FolderRef): string[] {
  const { kind, name } = folderOf(ref)
  return [`--${kind}`, name]
}

// ── user directories ────────────────────────────────────────────────────────

/** Removes the user's workspace and editor-home directories (`purge`, user deletion). */
export async function purgeUserDirs(userId: string): Promise<{ removed: string[] }> {
  return runJson('purge', { userId, args: ['--user', userId] })
}

// ── browsing ────────────────────────────────────────────────────────────────

export async function listFiles(userId: string, folder: FolderRef, options: { path: string; recursive: boolean }): Promise<ListOutput> {
  return runJson('list', {
    userId,
    args: [...folderArgs(folder), '--path', options.path, `--recursive=${options.recursive}`, '--max-entries', String(FILE_LIST_MAX_ENTRIES)],
  })
}

/** `list --archive`: lists a revision snapshot streamed on stdin (no volume mounted). */
export async function listArchive(userId: string, archive: Readable, options: { path: string; recursive: boolean }): Promise<ListOutput> {
  return runJson('list', {
    userId,
    stdin: archive,
    args: ['--archive', '--path', options.path, `--recursive=${options.recursive}`, '--max-entries', String(FILE_LIST_MAX_ENTRIES)],
  })
}

export async function readFile(userId: string, folder: FolderRef, path: string): Promise<ReadOutput> {
  return runJson('read', { userId, args: [...folderArgs(folder), '--path', path, '--max-bytes', String(FILE_READ_MAX_BYTES)] })
}

/** `read --archive`: reads one file of a revision snapshot streamed on stdin (no volume mounted). */
export async function readArchive(userId: string, archive: Readable, path: string): Promise<ReadOutput> {
  return runJson('read', { userId, stdin: archive, args: ['--archive', '--path', path, '--max-bytes', String(FILE_READ_MAX_BYTES)] })
}

// ── writing ─────────────────────────────────────────────────────────────────

export type FileContentInput = string | { base64: string }

export async function writeFiles(userId: string, folder: FolderRef, files: Record<string, FileContentInput>): Promise<WriteFilesOutput> {
  return runJson('write-files', {
    userId,
    stdin: Buffer.from(JSON.stringify({ files }), 'utf8'),
    args: [...folderArgs(folder), ...limitFlags(config(), { files: true, bytes: true, workspace: true })],
  })
}

export async function deleteFiles(userId: string, folder: FolderRef, path: string, recursive: boolean): Promise<DeleteFilesOutput> {
  return runJson('delete-files', { userId, args: [...folderArgs(folder), '--path', path, `--recursive=${recursive}`] })
}

/** Removes a whole folder (`delete-files --path "" --recursive`, task and script deletion). Missing folders are fine. */
export async function deleteFolder(userId: string, folder: FolderRef): Promise<void> {
  try {
    await deleteFiles(userId, folder, '', true)
  } catch (error) {
    if (!isHelperCode(error, 'notFound')) throw error
  }
}

/** Removes a whole task folder (task deletion). Missing folders are fine. */
export async function deleteTaskFolder(userId: string, task: string): Promise<void> {
  await deleteFolder(userId, task)
}

/** A task scaffold renders a template's entry; a script scaffold renders the language's script scaffold (no template). */
export type ScaffoldInput =
  | { task: string; language: string; template: string; description?: string }
  | { script: string; language: string; description?: string }

export async function scaffold(userId: string, input: ScaffoldInput): Promise<{ workspace: WorkspaceSummary }> {
  const cfg = config()
  const folder = 'script' in input ? folderArgs({ script: input.script }) : folderArgs({ task: input.task })
  const template = 'script' in input ? [] : ['--template', input.template]
  return runJson('scaffold', {
    userId,
    // The scaffold renders BaseImage from the image pair of this deployment (docs/tasks.md §12.1).
    env: { SCANTOR_IMAGE_PREFIX: cfg.imagePrefix, SCANTOR_IMAGE_TAG: cfg.imageTag },
    args: [
      ...folder,
      '--language',
      input.language,
      ...template,
      ...(input.description ? ['--description', input.description] : []),
      ...limitFlags(cfg, { workspace: true }),
    ],
  })
}

// ── staging: extract, git, commit, discard ──────────────────────────────────

/**
 * `extract`: unpacks an uploaded folder archive into a new staging directory and validates its manifest; `kind: 'script'`
 * expects `scantor-script.yaml` instead of `scantor.yaml` (`--kind script`).
 */
export async function extract(userId: string, stagingId: string, archive: Readable, options: { kind?: FolderKind } = {}): Promise<ExtractOutput> {
  return runJson('extract', {
    userId,
    stdin: archive,
    args: [
      '--staging',
      stagingId,
      ...(options.kind === 'script' ? ['--kind', 'script'] : []),
      ...limitFlags(config(), { files: true, bytes: true, workspace: true, pack: true }),
    ],
  }, [], { kind: options.kind })
}

export interface GitHelperAccess {
  /** container environment: the git credential (GIT_CONFIG_*) and SCANTOR_CA_CERT */
  env: Record<string, string>
  /** secret values removed from every error message */
  secrets: string[]
}

export async function gitClone(
  userId: string,
  input: { url: string; ref: string; path: string; stagingId: string },
  access: GitHelperAccess,
): Promise<GitCloneOutput> {
  const cfg = config()
  return runJson(
    'git-clone',
    {
      userId,
      network: 'egress',
      env: access.env,
      args: [
        '--url',
        input.url,
        '--ref',
        input.ref,
        '--path',
        input.path,
        '--staging',
        input.stagingId,
        ...(cfg.gitAllowPrivate ? ['--allow-private'] : []),
        ...limitFlags(cfg, { files: true, bytes: true, workspace: true }),
      ],
    },
    access.secrets,
  )
}

export async function gitPull(
  userId: string,
  input: { task: string; url: string; ref: string; path: string; baseCommit: string; stagingId: string },
  access: GitHelperAccess,
): Promise<GitPullOutput> {
  const cfg = config()
  return runJson(
    'git-pull',
    {
      userId,
      network: 'egress',
      env: access.env,
      args: [
        '--task',
        input.task,
        '--url',
        input.url,
        '--ref',
        input.ref,
        '--path',
        input.path,
        '--base-commit',
        input.baseCommit,
        '--staging',
        input.stagingId,
        ...(cfg.gitAllowPrivate ? ['--allow-private'] : []),
        ...limitFlags(cfg, { files: true, bytes: true, workspace: true }),
      ],
    },
    access.secrets,
  )
}

/** `commit`: swaps a staged tree into the folder named by `task` or `script`, if its current hash is `expect`. */
export type CommitInput = { stagingId: string; expect: CommitExpectation; from?: string } & WorkspaceFolder

export async function commit(userId: string, input: CommitInput): Promise<CommitOutput> {
  return runJson('commit', {
    userId,
    args: [
      '--staging',
      input.stagingId,
      ...(input.from && input.from !== '.' ? ['--from', input.from] : []),
      ...folderArgs(input),
      '--expect',
      input.expect,
      ...limitFlags(config(), { files: true, bytes: true, workspace: true }),
    ],
  })
}

/** Removes a staging directory; failures are not fatal for the caller (helpers also expire staging after 1 h). */
export async function discard(userId: string, stagingId: string): Promise<void> {
  await runJson('discard', { userId, args: ['--staging', stagingId] })
}

// ── snapshots ───────────────────────────────────────────────────────────────

/** `snapshot --hash-only`: the current summary of a folder, or null when the folder does not exist. */
export async function snapshotHash(userId: string, folder: FolderRef): Promise<WorkspaceSummary | null> {
  try {
    return await runJson<WorkspaceSummary>('snapshot', {
      userId,
      args: [...folderArgs(folder), '--hash-only', ...limitFlags(config(), { files: true, bytes: true, pack: true })],
    })
  } catch (error) {
    if (isHelperCode(error, 'notFound')) return null
    throw error
  }
}

/**
 * `snapshot`: streams the deterministic pack (tar.gz) of a folder into `sink` and returns the helper's summary
 * from its final stderr event. The sink is ended when the helper exits, also with an error exit code. When the helper
 * does not run or does not exit (no free slot, a timeout, a Docker error, `signal` aborted), the sink is destroyed
 * without an error, so its readers end with a premature close instead of waiting forever. Callers discard partial
 * output when this rejects.
 */
export async function snapshotStream(userId: string, folder: FolderRef, sink: Writable, signal?: AbortSignal): Promise<SnapshotSummary> {
  const op: HelperOp = 'snapshot'
  let result: HelperResult
  try {
    result = await executeHelper(
      op,
      { userId, args: [...folderArgs(folder), ...limitFlags(config(), { files: true, bytes: true, pack: true })], signal },
      { stdout: sink },
    )
  } catch (error) {
    sink.destroy()
    throw error
  }
  const stderr = checkHelperResult(op, result)
  if (!stderr.summary) throw new HelperError(op, { code: 'internal', message: 'workspace snapshot reported no summary' }, null, result.stderr)
  return stderr.summary
}
