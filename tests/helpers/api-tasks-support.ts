import { createHash, randomBytes } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { gunzipSync, gzipSync } from 'node:zlib'
import tar from 'tar-stream'
import type { Credential } from '#shared/types/credentials'
import type { Job } from '#shared/types/jobs'
import type { BuildLogPage, RevisionSummary } from '#shared/types/revisions'
import type { Page } from '#shared/types/common'
import type { DeleteTaskFileResult, Task, TaskFileContent, TaskFileList, TaskWorkspaceStatus, WriteTaskFilesResult } from '#shared/types/tasks'
import type { TestRun } from '#shared/types/test-runs'
import type { TestRunState } from '#shared/utils/enums'
import { ok, type ApiClient, type ApiResponse } from './api-client'
import { docker } from './docker'
import { env } from './env'
import { buildTarGz, type TarEntry } from './tar'

// Shared code of the task API specs (api/tasks, task-files, git, credentials, revisions): small in-memory task
// folders and archives, thin wrappers of the task, file and revision operations, waits for jobs and test runs,
// credential tracking, and white-box access to the caller's own workspace folder (as the editor has it).

export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

/** The sha256 of the uncompressed tar inside a tar.gz (the pack hash of a deterministic pack). */
export const packSha256 = (archive: Buffer) => sha256(gunzipSync(archive))

/** A random lowercase token for content that must differ between runs. */
export const token = (bytes = 6) => randomBytes(bytes).toString('hex')

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
export const SHA256 = /^[0-9a-f]{64}$/

const BYTE_UNITS: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }

/** A byte size of the stack's environment (`50MiB`, `512KiB`, `1024`) in bytes. */
export function byteSize(value: string): number {
  const match = /^(\d+)\s*(B|KiB|MiB|GiB)?$/.exec(value.trim())
  if (!match) throw new Error(`not a byte size: ${JSON.stringify(value)}`)
  return Number(match[1]) * BYTE_UNITS[match[2] ?? 'B']!
}

// ── task folders ────────────────────────────────────────────────────────────

/**
 * A small valid Python task folder: one analysis that echoes a text. `text` changes the pack hash; `extra` adds or
 * replaces files.
 */
export function pythonTaskFiles(name: string, options: { description?: string; text?: string; extra?: Record<string, string> } = {}): Record<string, string> {
  const description = options.description ?? 'A task of the task API tests.'
  return {
    'scantor.yaml': `scantor: 1\nname: ${name}\nlanguage: python\ndescription: ${JSON.stringify(description)}\n`,
    Dockerfile: 'ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nCOPY . .\n',
    '.dockerignore': '__pycache__/\n.scantor/\n',
    'main.py': [
      '"""A task of the task API tests: one analysis that echoes a text."""',
      '',
      'from pydantic import BaseModel',
      '',
      'import scantor',
      '',
      '',
      'class TaskConfig(scantor.Config):',
      `    text: str = ${JSON.stringify(options.text ?? 'hello')}`,
      '',
      '',
      'class Result(BaseModel):',
      '    echo: str',
      '',
      '',
      'def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> Result:',
      '    return Result(echo=task_config.text)',
      '',
      '',
      'task = scantor.Task(task_config=TaskConfig, result=Result, run=run)',
      '',
    ].join('\n'),
    ...options.extra,
  }
}

/**
 * A Python task whose single analysis sleeps for the task config's `seconds` (default 600), so scans and test runs of
 * it stay active until they are cancelled.
 */
export function sleepyTaskFiles(name: string): Record<string, string> {
  return pythonTaskFiles(name, {
    description: 'A task of the task API tests that sleeps.',
    extra: {
      'main.py': [
        '"""A task of the task API tests: one analysis that sleeps for a while."""',
        '',
        'import asyncio',
        '',
        'from pydantic import BaseModel, Field',
        '',
        'import scantor',
        '',
        '',
        'class TaskConfig(scantor.Config):',
        '    seconds: float = Field(default=600, ge=0, le=3600)',
        '',
        '',
        'class Result(BaseModel):',
        '    slept: float',
        '',
        '',
        'async def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> Result:',
        '    await asyncio.sleep(task_config.seconds)',
        '    return Result(slept=task_config.seconds)',
        '',
        '',
        'task = scantor.Task(task_config=TaskConfig, result=Result, run=run)',
        '',
      ].join('\n'),
    },
  })
}

/** A tar.gz of a text file map (sorted entries, zero mtimes; modes 0644 unless given in `modes`), plus `extra` entries. */
export function archiveOf(files: Record<string, string>, options: { modes?: Record<string, number>; prefix?: string; extra?: TarEntry[] } = {}) {
  const entries: TarEntry[] = Object.keys(files)
    .sort()
    .map((path) => ({ name: `${options.prefix ?? ''}${path}`, type: 'file' as const, content: files[path]!, mode: options.modes?.[path] ?? 0o644 }))
  return buildTarGz([...entries, ...(options.extra ?? [])])
}

/** One entry of `tarGz`: a file (content) or a directory, with optional owner fields. */
export interface OwnedEntry {
  name: string
  type?: 'file' | 'dir'
  content?: string | Buffer
  mode?: number
  uid?: number
  gid?: number
  uname?: string
  gname?: string
}

/** A tar.gz of entries in the given order, with the owner fields of each entry (tar-stream). */
export async function tarGz(entries: OwnedEntry[], options: { level?: number } = {}): Promise<Buffer> {
  const pack = tar.pack()
  const chunks: Buffer[] = []
  pack.on('data', (chunk: unknown) => chunks.push(chunk as Buffer))
  const done = new Promise<void>((resolve, reject) => {
    pack.on('end', resolve)
    pack.on('error', reject)
  })
  for (const entry of entries) {
    const type = entry.type ?? 'file'
    const body = type === 'file' ? Buffer.from(entry.content ?? '') : Buffer.alloc(0)
    const header = {
      name: entry.name,
      type: type === 'dir' ? ('directory' as const) : ('file' as const),
      mode: entry.mode ?? (type === 'dir' ? 0o755 : 0o644),
      size: body.length,
      mtime: new Date(0),
      uid: entry.uid ?? 0,
      gid: entry.gid ?? 0,
      ...(entry.uname !== undefined ? { uname: entry.uname } : {}),
      ...(entry.gname !== undefined ? { gname: entry.gname } : {}),
    }
    await new Promise<void>((resolve, reject) => pack.entry(header, body, (error) => (error ? reject(error) : resolve())))
  }
  pack.finalize()
  await done
  return gzipSync(Buffer.concat(chunks), { level: options.level ?? 6 })
}

/** The entries of a tar.gz: name, type and content of files. */
export async function readTarGz(archive: Buffer): Promise<{ name: string; type: string; mode: number; content: Buffer }[]> {
  const extract = tar.extract()
  const entries: { name: string; type: string; mode: number; content: Buffer }[] = []
  const done = new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: unknown) => chunks.push(chunk as Buffer))
      stream.on('end', () => {
        entries.push({ name: header.name, type: header.type ?? 'file', mode: header.mode ?? 0, content: Buffer.concat(chunks) })
        next()
      })
      stream.resume()
    })
    extract.on('finish', resolve)
    extract.on('error', reject)
  })
  extract.end(gunzipSync(archive))
  await done
  return entries
}

/** Uploads a file map as a task folder (publish=false unless given); returns the raw response. */
export async function uploadFiles(api: ApiClient, files: Record<string, string>, query: { publish?: boolean; force?: boolean; message?: string; wait?: number } = {}) {
  return api.uploadTask(await archiveOf(files), { publish: false, ...query })
}

// ── task, file and revision operations ─────────────────────────────────────

/** createTask; the caller registers the name for cleanup (tasks.track) before calling. */
export function createTask(api: ApiClient, body: { name: string; language: string; template?: string; description?: string }) {
  return api.call<Task>('createTask', { body })
}

export function listTaskFiles(api: ApiClient, task: string, query: { path?: string; recursive?: boolean; revision?: string | number } = {}) {
  return api.call<TaskFileList>('listTaskFiles', { path: { task }, query })
}

export function readTaskFile(api: ApiClient, task: string, path: string, revision?: string | number) {
  return api.call<TaskFileContent>('readTaskFile', { path: { task }, query: { path, revision } })
}

export function writeTaskFiles(api: ApiClient, task: string, files: Record<string, string | { base64: string }>) {
  return api.call<WriteTaskFilesResult>('writeTaskFiles', { path: { task }, body: { files } })
}

export function deleteTaskFile(api: ApiClient, task: string, path: string, recursive?: boolean) {
  return api.call<DeleteTaskFileResult>('deleteTaskFile', { path: { task }, query: { path, recursive } })
}

export function getTaskWorkspace(api: ApiClient, task: string) {
  return api.call<TaskWorkspaceStatus>('getTaskWorkspace', { path: { task } })
}

export function listRevisions(api: ApiClient, task: string, query: { state?: string; limit?: number; cursor?: string } = {}) {
  return api.call<Page<RevisionSummary>>('listRevisions', { path: { task }, query })
}

export function getBuildLog(api: ApiClient, task: string, revision: string | number, query: { afterLine?: number; limit?: number } = {}) {
  return api.call<BuildLogPage>('getRevisionBuildLog', { path: { task, revision }, query })
}

/** The paths of a task folder listing (workspace or revision snapshot). */
export async function listPaths(api: ApiClient, task: string, query: { path?: string; recursive?: boolean; revision?: string | number } = {}) {
  return ok(await listTaskFiles(api, task, query), 'listTaskFiles').entries.map((entry) => entry.path)
}

/** Waits for a job to finish (long-polls getJob); returns the final job. */
export async function waitForJob(api: ApiClient, jobId: string, timeoutMs = 180_000): Promise<Job> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const wait = Math.max(1, Math.min(120, Math.ceil((deadline - Date.now()) / 1000)))
    const job = ok(await api.getJob(jobId, wait), 'getJob')
    if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') return job
    if (Date.now() >= deadline) throw new Error(`job ${jobId} (${job.kind}) is still ${job.state} after ${timeoutMs / 1000} s`)
  }
}

/** Deletes a task and waits until its taskDelete job succeeded (so the name is free again). */
export async function deleteTaskAndWait(api: ApiClient, task: string): Promise<void> {
  const deleted = await api.deleteTask(task)
  if (deleted.status === 404) return
  const job = await waitForJob(api, ok(deleted, 'deleteTask').job.id)
  if (job.state !== 'succeeded') throw new Error(`the taskDelete job of ${task} ended ${job.state}: ${JSON.stringify(job.error)}`)
}

/** Polls a test run (every second, without holding a wait slot) until it is in one of `states`. */
export async function waitForTestRunState(api: ApiClient, testRunId: string, states: TestRunState[], timeoutMs = 300_000): Promise<TestRun> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const run = ok(await api.call<TestRun>('getTestRun', { path: { testRunId }, query: { analyses: false } }), 'getTestRun')
    if (states.includes(run.state)) return run
    if (['completed', 'failed', 'cancelled'].includes(run.state)) {
      throw new Error(`test run ${testRunId} ended ${run.state} instead of ${states.join('|')}: ${JSON.stringify(run.errors)}`)
    }
    if (Date.now() >= deadline) throw new Error(`test run ${testRunId} is still ${run.state} after ${timeoutMs / 1000} s`)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/** The error envelope of a non-2xx response. */
export function errorOf(response: ApiResponse): { code: string; message: string; details?: Record<string, unknown> } {
  return (response.body as { error: { code: string; message: string; details?: Record<string, unknown> } }).error
}

/** The `details.issues` paths of a 400 validationFailed. */
export function issuePaths(response: ApiResponse): string[] {
  const issues = (errorOf(response).details?.issues ?? []) as { path: string }[]
  return issues.map((issue) => issue.path)
}

/**
 * Streams a task upload with chunked transfer encoding (no Content-Length), as a client that does not know the size
 * in advance does, and returns the status and JSON body. Writing stops once the server answered.
 */
export function streamTaskUpload(apiKey: string, body: Buffer, chunkBytes = 1024 * 1024): Promise<{ status: number; body: unknown }> {
  const url = new URL('/api/tasks/upload?publish=false', env.publicUrl)
  return new Promise((resolve, reject) => {
    let answered = false
    const request = httpsRequest(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/gzip', Authorization: `Bearer ${apiKey}`, Origin: env.publicUrl, 'Transfer-Encoding': 'chunked' },
      },
      (response) => {
        answered = true
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('error', reject)
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown = text
          try {
            parsed = JSON.parse(text)
          } catch {
            // not JSON: the caller sees the text
          }
          resolve({ status: response.statusCode ?? 0, body: parsed })
        })
      },
    )
    // The server may close the connection once it answered while the client is still writing.
    request.on('error', (error) => {
      if (!answered) reject(error)
    })
    let offset = 0
    const writeMore = () => {
      while (!answered && offset < body.length) {
        const chunk = body.subarray(offset, offset + chunkBytes)
        offset += chunk.length
        if (!request.write(chunk)) {
          request.once('drain', writeMore)
          return
        }
      }
      if (!answered) request.end()
    }
    writeMore()
  })
}

// ── credentials ─────────────────────────────────────────────────────────────

export interface CredentialBody {
  kind?: 'gitToken'
  name: string
  host: string
  username?: string
  token: string
}

export interface CredentialsFixture {
  /** createCredential as `client` (default: the tenant's session); a 201 is deleted at teardown. */
  create(body: CredentialBody | Record<string, unknown>, client?: ApiClient): Promise<ApiResponse<Credential>>
  /** createCredential that must succeed. */
  add(body: CredentialBody, client?: ApiClient): Promise<Credential>
}

/** The `credentials` fixture of the specs that create git credentials (test scope; deletes what it created). */
export async function credentialsFixture({ api, otherApi }: { api: ApiClient; otherApi: ApiClient }, use: (fixture: CredentialsFixture) => Promise<void>) {
  const created: { client: ApiClient; id: string }[] = []
  const create = async (body: Record<string, unknown>, client: ApiClient = api) => {
    const response = await client.call<Credential>('createCredential', { body: { kind: 'gitToken', ...body } })
    if (response.status === 201) created.push({ client, id: response.body.id })
    return response
  }
  await use({
    create,
    add: async (body, client) => ok(await create(body as unknown as Record<string, unknown>, client), 'createCredential'),
  })
  for (const { client, id } of created.reverse()) {
    if (client !== api && client !== otherApi) continue
    const response = await client.call('deleteCredential', { path: { credentialId: id } })
    if (response.status !== 204 && response.status !== 404) throw new Error(`deleteCredential ${id} answered ${response.status}`)
  }
}

// ── white-box ───────────────────────────────────────────────────────────────

/**
 * Runs a shell script against the caller's own workspace, as an editor user could: a throwaway container
 * (`scantor-test-*`, label scantor.test=true, removed afterwards) mounts the user's subpath of the workspace volume
 * at /w as uid 1000 without network. Returns stdout. Only ever touch folders of tasks the test created.
 */
export async function runInWorkspace(userId: string, script: string): Promise<string> {
  const { stdout } = await docker([
    'run',
    '--rm',
    '--name',
    `scantor-test-ws-${token(6)}`,
    '--label',
    'scantor.test=true',
    '--network',
    'none',
    '--user',
    '1000:1000',
    '--mount',
    `type=volume,source=scantor-workspaces,target=/w,volume-subpath=${userId}`,
    '--entrypoint',
    'sh',
    'scantor-test-fixtures:dev',
    '-c',
    script,
  ])
  return stdout
}

/** Creates a symlink `path` → `target` inside a task folder of the caller (see runInWorkspace). */
export async function plantSymlink(userId: string, task: string, path: string, target: string): Promise<void> {
  await runInWorkspace(userId, `ln -s -- '${target}' '/w/${task}/${path}'`)
}
