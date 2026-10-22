import type { Readable, Writable } from 'node:stream'
import type { Config } from '../../utils/config'
import { executeHelper, useHelperRuntime } from './executor'
import { checkHelperResult, HelperError, isHelperCode, parseHelperStdout } from './protocol'
import type {
  CommitExpectation,
  CommitOutput,
  DeleteFilesOutput,
  ExtractOutput,
  GitCloneOutput,
  GitPullOutput,
  HelperOp,
  HelperRunOptions,
  ListOutput,
  ReadOutput,
  SnapshotSummary,
  WorkspaceSummary,
  WriteFilesOutput,
} from './types'

// Typed workspace operations (docs/editor.md §9.4): each builds the exact flags of `scantor workspace <op>`, runs the
// helper and parses its single JSON document. Limits are passed as flags, never through the environment
// (docs/editor.md §9.2).

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

async function runJson<T>(op: HelperOp, options: HelperRunOptions, secrets: readonly string[] = []): Promise<T> {
  const result = await executeHelper(op, options)
  checkHelperResult(op, result, secrets)
  return parseHelperStdout<T>(op, result)
}

function config(): Config {
  return useHelperRuntime().config
}

// ── user directories ────────────────────────────────────────────────────────

/** Removes the user's workspace and editor-home directories (`purge`, user deletion). */
export async function purgeUserDirs(userId: string): Promise<{ removed: string[] }> {
  return runJson('purge', { userId, args: ['--user', userId] })
}

// ── browsing ────────────────────────────────────────────────────────────────

export async function listFiles(userId: string, task: string, options: { path: string; recursive: boolean }): Promise<ListOutput> {
  return runJson('list', {
    userId,
    args: ['--task', task, '--path', options.path, `--recursive=${options.recursive}`, '--max-entries', String(FILE_LIST_MAX_ENTRIES)],
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

export async function readFile(userId: string, task: string, path: string): Promise<ReadOutput> {
  return runJson('read', { userId, args: ['--task', task, '--path', path, '--max-bytes', String(FILE_READ_MAX_BYTES)] })
}

/** `read --archive`: reads one file of a revision snapshot streamed on stdin (no volume mounted). */
export async function readArchive(userId: string, archive: Readable, path: string): Promise<ReadOutput> {
  return runJson('read', { userId, stdin: archive, args: ['--archive', '--path', path, '--max-bytes', String(FILE_READ_MAX_BYTES)] })
}

// ── writing ─────────────────────────────────────────────────────────────────

export type FileContentInput = string | { base64: string }

export async function writeFiles(userId: string, task: string, files: Record<string, FileContentInput>): Promise<WriteFilesOutput> {
  return runJson('write-files', {
    userId,
    stdin: Buffer.from(JSON.stringify({ files }), 'utf8'),
    args: ['--task', task, ...limitFlags(config(), { files: true, bytes: true, workspace: true })],
  })
}

export async function deleteFiles(userId: string, task: string, path: string, recursive: boolean): Promise<DeleteFilesOutput> {
  return runJson('delete-files', { userId, args: ['--task', task, '--path', path, `--recursive=${recursive}`] })
}

/** Removes a whole task folder (`delete-files --path "" --recursive`, task deletion). Missing folders are fine. */
export async function deleteTaskFolder(userId: string, task: string): Promise<void> {
  try {
    await deleteFiles(userId, task, '', true)
  } catch (error) {
    if (!isHelperCode(error, 'notFound')) throw error
  }
}

export async function scaffold(
  userId: string,
  input: { task: string; language: string; template: string; description?: string },
): Promise<{ workspace: WorkspaceSummary }> {
  const cfg = config()
  return runJson('scaffold', {
    userId,
    // The scaffold renders BaseImage from the image pair of this deployment (docs/tasks.md §12.1).
    env: { SCANTOR_IMAGE_PREFIX: cfg.imagePrefix, SCANTOR_IMAGE_TAG: cfg.imageTag },
    args: [
      '--task',
      input.task,
      '--language',
      input.language,
      '--template',
      input.template,
      ...(input.description ? ['--description', input.description] : []),
      ...limitFlags(cfg, { workspace: true }),
    ],
  })
}

// ── staging: extract, git, commit, discard ──────────────────────────────────

export async function extract(userId: string, stagingId: string, archive: Readable): Promise<ExtractOutput> {
  return runJson('extract', {
    userId,
    stdin: archive,
    args: ['--staging', stagingId, ...limitFlags(config(), { files: true, bytes: true, workspace: true, pack: true })],
  })
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

export async function commit(
  userId: string,
  input: { stagingId: string; task: string; expect: CommitExpectation; from?: string },
): Promise<CommitOutput> {
  return runJson('commit', {
    userId,
    args: [
      '--staging',
      input.stagingId,
      ...(input.from && input.from !== '.' ? ['--from', input.from] : []),
      '--task',
      input.task,
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

/** `snapshot --hash-only`: the current summary of a task folder, or null when the folder does not exist. */
export async function snapshotHash(userId: string, task: string): Promise<WorkspaceSummary | null> {
  try {
    return await runJson<WorkspaceSummary>('snapshot', {
      userId,
      args: ['--task', task, '--hash-only', ...limitFlags(config(), { files: true, bytes: true, pack: true })],
    })
  } catch (error) {
    if (isHelperCode(error, 'notFound')) return null
    throw error
  }
}

/**
 * `snapshot`: streams the deterministic pack (tar.gz) of a task folder into `sink` and returns the helper's summary
 * from its final stderr event. The sink is ended when the helper exits, also on failure; callers discard partial
 * output when this rejects.
 */
export async function snapshotStream(userId: string, task: string, sink: Writable): Promise<SnapshotSummary> {
  const op: HelperOp = 'snapshot'
  const result = await executeHelper(
    op,
    { userId, args: ['--task', task, ...limitFlags(config(), { files: true, bytes: true, pack: true })] },
    { stdout: sink },
  )
  const stderr = checkHelperResult(op, result)
  if (!stderr.summary) throw new HelperError(op, { code: 'internal', message: 'workspace snapshot reported no summary' }, null, result.stderr)
  return stderr.summary
}
