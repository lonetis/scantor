import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import tar from 'tar-stream'
import { parseDocument } from 'yaml'
import type { Revision } from '#shared/types/revisions'
import type { Task } from '#shared/types/tasks'
import { ApiError, ok, type ApiClient } from './api-client'
import { env } from './env'

// Task folders for tests (docs/testing.md §7.8): deterministic tar.gz packs with the manifest name rewritten (so
// every test uploads its own task), copies for the CLI, upload, publish and wait. Fixture tasks live in
// tests/fixtures/tasks/<name>, the examples in tasks/<name> of the repository.

/** Entries a pack never contains (local outputs and VCS data, like the task pipeline's hard excludes). */
const SKIPPED = new Set(['.git', '.scantor', 'node_modules', '__pycache__', '.venv'])

export const fixtureTaskDir = (name: string) => join(env.paths.tests, 'fixtures', 'tasks', name)
export const exampleTaskDir = (name: string) => join(env.paths.repo, 'tasks', name)

async function listFiles(root: string, dir = root): Promise<string[]> {
  const out: string[] = []
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIPPED.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listFiles(root, path)))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/** The manifest with `name` replaced; comments and formatting are kept. */
export function renameManifest(manifest: string, name: string): string {
  const doc = parseDocument(manifest)
  if (doc.errors.length > 0) throw new Error(`invalid scantor.yaml: ${doc.errors[0]?.message}`)
  doc.set('name', name)
  return doc.toString()
}

export async function manifestName(dir: string): Promise<string> {
  const doc = parseDocument(await readFile(join(dir, 'scantor.yaml'), 'utf8'))
  const name = doc.get('name')
  if (typeof name !== 'string') throw new Error(`${dir}/scantor.yaml has no name`)
  return name
}

/** A deterministic tar.gz of a task folder (sorted entries, zero mtimes and owners), optionally renamed. */
export async function packTask(dir: string, options: { name?: string } = {}): Promise<Buffer> {
  const pack = tar.pack()
  const chunks: Buffer[] = []
  pack.on('data', (chunk: unknown) => chunks.push(chunk as Buffer))
  const finished = new Promise<void>((resolve, reject) => {
    pack.on('end', resolve)
    pack.on('error', reject)
  })
  for (const file of await listFiles(dir)) {
    const name = relative(dir, file).split(sep).join('/')
    let content = await readFile(file)
    if (name === 'scantor.yaml' && options.name) content = Buffer.from(renameManifest(content.toString('utf8'), options.name))
    const executable = ((await stat(file)).mode & 0o111) !== 0
    await new Promise<void>((resolve, reject) =>
      pack.entry({ name, size: content.length, mode: executable ? 0o755 : 0o644, mtime: new Date(0), uid: 0, gid: 0 }, content, (error) =>
        error ? reject(error) : resolve(),
      ),
    )
  }
  pack.finalize()
  await finished
  return gzipSync(Buffer.concat(chunks), { level: 9 })
}

/** Copies a task folder to a new temporary directory with the manifest renamed; remove it with `rm`. */
export async function copyTask(dir: string, name: string): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), `${name}-`))
  await cp(dir, target, { recursive: true, filter: (source) => !SKIPPED.has(source.split(sep).pop() ?? '') })
  const manifest = join(target, 'scantor.yaml')
  await writeFile(manifest, renameManifest(await readFile(manifest, 'utf8'), name))
  return target
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

export interface UploadedTask {
  task: Task
  revision: Revision
}

/**
 * Uploads a task folder under `name` and publishes a revision; waits (≤ timeoutMs) until the revision is built and
 * returns it. Fails with the revision's build errors unless `expectState` says otherwise.
 */
export async function uploadAndPublish(
  api: ApiClient,
  dir: string,
  name: string,
  options: { timeoutMs?: number; expectState?: Revision['state'] } = {},
): Promise<UploadedTask> {
  const timeoutMs = options.timeoutMs ?? 300_000
  const uploaded = ok(await api.uploadTask(await packTask(dir, { name }), { publish: true, wait: 120 }), 'uploadTask')
  if (!uploaded.revision) throw new Error(`uploadTask of ${name} published no revision`)
  const revision = await waitForRevision(api, uploaded.task.id, uploaded.revision.id, timeoutMs)
  expectRevisionState(revision, options.expectState ?? 'ready')
  return { task: uploaded.task, revision }
}

/** Publishes a revision of the task's current workspace and waits until it is built (ready unless `expectState`). */
export async function publishAndWait(
  api: ApiClient,
  task: string,
  options: { message?: string; timeoutMs?: number; expectState?: Revision['state'] } = {},
): Promise<Revision> {
  const published = ok(await api.publishRevision(task, { message: options.message }, 120), 'publishRevision')
  const revision = await waitForRevision(api, task, published.id, options.timeoutMs ?? 300_000)
  expectRevisionState(revision, options.expectState ?? 'ready')
  return revision
}

function expectRevisionState(revision: Revision, expected: Revision['state']): void {
  if (revision.state !== expected) {
    throw new Error(`revision ${revision.ref} is ${revision.state}, expected ${expected}; errors: ${JSON.stringify(revision.errors)}`)
  }
}

/** Waits until a revision is ready or failed (long-polls getRevision). */
export async function waitForRevision(api: ApiClient, task: string, revision: string, timeoutMs = 300_000): Promise<Revision> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const wait = Math.max(1, Math.min(120, Math.ceil((deadline - Date.now()) / 1000)))
    const current = ok(await api.getRevision(task, revision, wait), 'getRevision')
    if (current.state === 'ready' || current.state === 'failed') return current
    if (Date.now() >= deadline) throw new Error(`revision ${current.ref} is still ${current.state} after ${timeoutMs / 1000} s`)
  }
}

/** Deletes a task (202 with a taskDelete job); 404 counts as deleted. */
export async function deleteTask(api: ApiClient, task: string): Promise<void> {
  const response = await api.deleteTask(task)
  if (response.status !== 202 && response.status !== 404) throw new ApiError(`deleteTask ${task}`, response)
}
