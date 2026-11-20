import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { createGunzip } from 'node:zlib'
import tar, { type Header } from 'tar-stream'
import type { Bundle } from '#shared/types/bundles'
import type { ApiClient } from './api-client'
import { readyBundle, type RevisionRef } from './api-bundles'
import { CONTAINERS, DockerError, innerDocker, type ExecResult } from './docker'
import { childEnv } from './env'

// Bundles from the recipient's side (docs/runtime.md §15.7–§15.9, docs/security.md §6.21) for the e2e and security
// specs. A bundle of a ready revision is created through the API (helpers/api-bundles.ts) and its archive downloaded
// with the presigned URL, verified against the bundle's size and SHA-256. The simulated remote node's own dockerd
// stands in for the recipient's machine: it has only Docker, none of the stack's names and its own image store. The
// archive is streamed into its `docker load`, and every bundle run is a `docker run --rm` there with a fresh folder of
// that machine (owned by uid 1000, a regular user) mounted at /work. Run directories are read back with `docker exec`.
// Every Docker call is an argument array (execFile or spawn), never a shell string.

/** The machine of the bundle's recipient: the remote node's dockerd (tests/docker/stack.tests.yml). */
export const RECIPIENT = CONTAINERS.remoteNode
/** The parent of the recipient's folders on that machine. */
const RECIPIENT_ROOT = '/tmp/scantor-test-bundles'
/** The owner of the recipient's folders: a regular user of the recipient's machine. */
export const RECIPIENT_UID = 1000
export const RECIPIENT_GID = 1000
/** The mount point of a bundle run. */
export const WORK_DIR = '/work'
/** The name of a default run directory below results/ (docs/runtime.md §15.8). */
export const RUN_STAMP = /^\d{8}T\d{6}Z(-\d+)?$/

const ARCHIVE_NAME = /^[a-z0-9][a-z0-9.-]*\.bundle\.tar\.gz$/
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The SHA-256 (hex) of a string or buffer. */
export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

// ── creation and download ──────────────────────────────────────────────────────────────────────────────

/** Creates the bundle of a revision (or reuses it) and waits until it is ready; throws when it failed. */
export async function ensureBundle(api: ApiClient, task: string, revision: RevisionRef, timeoutMs = 600_000): Promise<Bundle> {
  const { created: _created, ...bundle } = await readyBundle(api, task, revision, { timeoutMs })
  return bundle as Bundle
}

export interface DownloadedArchive {
  /** the private temporary directory of the download */
  dir: string
  /** the archive, named download.fileName */
  path: string
  fileName: string
  bytes: number
  sha256: string
}

/**
 * Downloads the archive of a ready bundle with its presigned URL (no credentials) into a temporary file and checks its
 * size and SHA-256 against the bundle. `removeArchive` deletes it.
 */
export async function downloadArchive(bundle: Bundle): Promise<DownloadedArchive> {
  if (bundle.state !== 'ready' || !bundle.download) throw new Error(`the bundle ${bundle.id} is ${bundle.state}, not ready`)
  const { url, fileName } = bundle.download
  if (!ARCHIVE_NAME.test(fileName)) throw new Error(`unexpected archive name ${JSON.stringify(fileName)}`)
  const dir = await mkdtemp(join(tmpdir(), 'scantor-bundle-'))
  try {
    const response = await fetch(url, { redirect: 'manual' })
    if (response.status !== 200 || !response.body) throw new Error(`GET of the bundle archive answered ${response.status}`)
    const hash = createHash('sha256')
    let bytes = 0
    const count = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk)
        bytes += chunk.length
        callback(null, chunk)
      },
    })
    const path = join(dir, fileName)
    await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>), count, createWriteStream(path, { mode: 0o600 }))
    const digest = hash.digest('hex')
    if (bytes !== bundle.bytes || digest !== bundle.sha256) {
      throw new Error(`the archive has ${bytes} bytes with SHA-256 ${digest}; the bundle says ${bundle.bytes} bytes with ${bundle.sha256}`)
    }
    return { dir, path, fileName, bytes, sha256: digest }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

export async function removeArchive(archive: DownloadedArchive | undefined): Promise<void> {
  if (archive) await rm(archive.dir, { recursive: true, force: true })
}

// ── the recipient's Docker ─────────────────────────────────────────────────────────────────────────────

/** `docker load` of an archive on the recipient's machine (`docker load -i <file>`, streamed); returns its output. */
export async function loadIntoRecipient(archivePath: string, image: string, timeoutMs = 600_000): Promise<string> {
  const child = spawn('docker', ['exec', '-i', RECIPIENT, 'docker', 'load'], { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  try {
    const exited = new Promise<number>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => resolve(code ?? 1))
    })
    const [fed, code] = await Promise.allSettled([pipeline(createReadStream(archivePath), child.stdin), exited])
    const exitCode = code.status === 'fulfilled' ? code.value : 1
    if (fed.status === 'rejected' || exitCode !== 0 || !stdout.includes(`Loaded image: ${image}`)) {
      const why = fed.status === 'rejected' ? ` (stdin: ${String(fed.reason)})` : ''
      throw new Error(`docker load of ${image} on the recipient exited with ${exitCode}${why}: ${stdout.trim()} ${stderr.trim()}`)
    }
    return stdout
  } finally {
    clearTimeout(timer)
  }
}

/** Removes images from the recipient's machine; images that are gone or still in use are left alone. */
export async function removeFromRecipient(images: (string | undefined)[]): Promise<void> {
  for (const image of images) if (image) await innerDocker.remote(['image', 'rm', image], { allowFailure: true })
}

/** A command on the recipient's machine (argument array); never throws for a non-zero exit. */
function onRecipient(command: string[], input?: string | Buffer): Promise<ExecResult> {
  return innerDocker.exec(RECIPIENT, command, input === undefined ? {} : { input })
}

async function mustOnRecipient(command: string[], input?: string | Buffer): Promise<string> {
  const result = await onRecipient(command, input)
  if (result.exitCode !== 0) throw new DockerError(['exec', RECIPIENT, ...command], result)
  return result.stdout
}

/** A relative path inside a folder: no absolute paths, no `..`, no empty segments. */
function relativePath(name: string): string {
  const normalized = posix.normalize(name)
  if (name === '' || posix.isAbsolute(name) || normalized.startsWith('..') || normalized !== name.replace(/\/+$/, '')) {
    throw new Error(`not a plain relative path: ${JSON.stringify(name)}`)
  }
  return normalized
}

export interface FolderEntry {
  /** the path relative to the folder the listing started from */
  path: string
  type: 'file' | 'directory' | 'other'
  uid: number
  gid: number
}

/** A folder of the recipient's machine (owned by RECIPIENT_UID), mounted at /work by bundle runs. */
export class RecipientFolder {
  private constructor(readonly path: string) {}

  static async create(label: string): Promise<RecipientFolder> {
    const name = `${label.replace(/[^a-z0-9-]+/g, '-')}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
    const folder = new RecipientFolder(posix.join(RECIPIENT_ROOT, name))
    await mustOnRecipient(['mkdir', '-p', folder.path])
    await mustOnRecipient(['chown', `${RECIPIENT_UID}:${RECIPIENT_GID}`, folder.path])
    return folder
  }

  /** The absolute path of `name` on the recipient's machine. */
  at(name = ''): string {
    return name === '' ? this.path : posix.join(this.path, relativePath(name))
  }

  /** Writes a file (and its missing parents) as the folder's owner would. */
  async write(name: string, content: string | Buffer): Promise<void> {
    const target = this.at(name)
    const parent = posix.dirname(target)
    await mustOnRecipient(['mkdir', '-p', parent])
    await mustOnRecipient(['tee', target], content)
    await mustOnRecipient(['chown', '-R', `${RECIPIENT_UID}:${RECIPIENT_GID}`, this.path])
  }

  /** The content of a file, or undefined when it does not exist. */
  async read(name: string): Promise<string | undefined> {
    const result = await onRecipient(['cat', this.at(name)])
    return result.exitCode === 0 ? result.stdout : undefined
  }

  /** The names in a directory of the folder (sorted); [] when it does not exist. */
  async names(name = ''): Promise<string[]> {
    const result = await onRecipient(['ls', '-A', '-1', this.at(name)])
    return result.exitCode === 0 ? result.stdout.split('\n').filter(Boolean).sort() : []
  }

  /** Every entry below a directory of the folder (not the directory itself), with type and owner. */
  async entries(name = ''): Promise<FolderEntry[]> {
    const base = this.at(name)
    const found = await onRecipient(['find', base, '-mindepth', '1'])
    if (found.exitCode !== 0) return []
    const paths = found.stdout.split('\n').filter(Boolean)
    const entries: FolderEntry[] = []
    for (let i = 0; i < paths.length; i += 200) {
      const output = await mustOnRecipient(['stat', '-c', '%u:%g:%F:%n', ...paths.slice(i, i + 200)])
      for (const line of output.split('\n').filter(Boolean)) {
        const [uid, gid, kind, ...rest] = line.split(':')
        const path = posix.relative(base, rest.join(':'))
        const type = kind === 'directory' ? 'directory' : kind?.includes('regular') ? 'file' : 'other'
        entries.push({ path, type, uid: Number(uid), gid: Number(gid) })
      }
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path))
  }

  /** SHA-256 of the regular files below a directory of the folder, by path relative to it. */
  async hashes(name = ''): Promise<Map<string, string>> {
    const base = this.at(name)
    const files = (await this.entries(name)).filter((entry) => entry.type === 'file').map((entry) => posix.join(base, entry.path))
    const out = new Map<string, string>()
    for (let i = 0; i < files.length; i += 200) {
      const output = await mustOnRecipient(['sha256sum', ...files.slice(i, i + 200)])
      for (const line of output.split('\n').filter(Boolean)) {
        const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line)
        if (match) out.set(posix.relative(base, match[2]!), match[1]!)
      }
    }
    return out
  }

  /** The files below the folder whose content contains `text` (grep -rlF). */
  async filesContaining(text: string): Promise<string[]> {
    const result = await onRecipient(['grep', '-rlF', '--', text, this.path])
    if (result.exitCode > 1) throw new DockerError(['exec', RECIPIENT, 'grep', '-rlF', '…', this.path], result)
    return result.stdout
      .split('\n')
      .filter(Boolean)
      .map((path) => posix.relative(this.path, path))
  }

  async remove(): Promise<void> {
    await onRecipient(['rm', '-rf', this.path])
  }
}

// ── bundle runs ───────────────────────────────────────────────────────────────────────────────────────────

export interface BundleRunOptions {
  /** the bundle image, localhost/scantor/<task>:<n> */
  image: string
  /** the flags of bundle mode after the image */
  args?: string[]
  /** the folder mounted at /work; without one the run has no mount */
  mount?: RecipientFolder
  /** `docker run -e KEY=VALUE` */
  env?: Record<string, string>
  /** `docker run --network <network>` */
  network?: string
  /** `docker run --user <user>` */
  user?: string
  /** the run is removed (docker rm -f) after this time */
  timeoutMs?: number
}

/** One `docker run --rm` of a bundle on the recipient's machine, as a recipient types it (plus a name and a test label). */
export class BundleRun {
  readonly name = `scantor-test-bundle-${randomBytes(6).toString('hex')}`
  stdout = ''
  stderr = ''
  /** null while the run is running */
  exitCode: number | null = null
  readonly exited: Promise<number>

  constructor(readonly options: BundleRunOptions) {
    const args = ['exec', RECIPIENT, 'docker', 'run', '--rm', '--name', this.name, '--label', 'scantor.test=true']
    for (const [key, value] of Object.entries(options.env ?? {})) args.push('-e', `${key}=${value}`)
    if (options.network) args.push('--network', options.network)
    if (options.user) args.push('--user', options.user)
    if (options.mount) args.push('-v', `${options.mount.path}:${WORK_DIR}`)
    args.push(options.image, ...(options.args ?? []))
    const child = spawn('docker', args, { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (this.stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (this.stderr += chunk))
    const timer = setTimeout(() => void this.remove(), options.timeoutMs ?? 240_000)
    this.exited = new Promise<number>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => {
        clearTimeout(timer)
        this.exitCode = code ?? 1
        resolve(this.exitCode)
      })
    })
  }

  get running(): boolean {
    return this.exitCode === null
  }

  /** `docker kill -s <signal>` of the run's container (the signal goes to the bundle's PID 1, which forwards it). */
  async kill(signal: string): Promise<void> {
    await mustOnRecipient(['docker', 'kill', '-s', signal, this.name])
  }

  /** `docker stop` of the run's container (SIGTERM, then SIGKILL after `seconds`). */
  async stop(seconds = 30): Promise<void> {
    await mustOnRecipient(['docker', 'stop', '-t', String(seconds), this.name])
  }

  /** Removes the run's container if it still exists. */
  async remove(): Promise<void> {
    await onRecipient(['docker', 'rm', '-f', this.name])
  }

  /** Diagnostics for assertion messages. */
  output(): string {
    return `docker run … ${this.options.image} ${(this.options.args ?? []).join(' ')} exited with ${this.exitCode}\n--- stdout ---\n${this.stdout.slice(-8000)}\n--- stderr ---\n${this.stderr.slice(-8000)}`
  }
}

/**
 * The bundle runs and folders of one test on the recipient's machine; `cleanup` removes the containers that still run
 * and the folders (the specs call it at teardown).
 */
export class Recipient {
  private readonly runs: BundleRun[] = []
  private readonly folders: RecipientFolder[] = []

  async folder(label = 'run'): Promise<RecipientFolder> {
    const folder = await RecipientFolder.create(label)
    this.folders.push(folder)
    return folder
  }

  /** Starts a bundle run without waiting for it. */
  start(options: BundleRunOptions): BundleRun {
    const run = new BundleRun(options)
    this.runs.push(run)
    return run
  }

  /** Runs a bundle until it exits. */
  async run(options: BundleRunOptions): Promise<BundleRun> {
    const run = this.start(options)
    await run.exited
    return run
  }

  async cleanup(): Promise<void> {
    await Promise.allSettled(this.runs.filter((run) => run.running).map((run) => run.remove()))
    await Promise.allSettled(this.folders.map((folder) => folder.remove()))
  }
}

/** Polls `check` every `intervalMs` until it returns a value other than undefined, or throws after `timeoutMs`. */
export async function until<T>(what: string, timeoutMs: number, check: () => Promise<T | undefined>, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`)
    await sleep(intervalMs)
  }
}

// ── run directories (docs/runtime.md §15.8) ───────────────────────────────────────────────────────────────

export interface RunFileError {
  type: string
  message: string
  retryable?: boolean
  phase?: string
  attempt?: number
}

export interface RunFileFile {
  id: string
  name: string
  size: number
  sha256: string
  contentType: string
  /** relative to the run directory */
  path: string
}

/** One line of results.jsonl. */
export interface ResultLine {
  at: string
  seq: number
  status: string
  attempt: number
  config: Record<string, unknown>
  result: Record<string, unknown> | null
  error: RunFileError | null
  files: RunFileFile[]
  logTail: string
  attempts: { attempt: number; startedAt: string; finishedAt: string; durationMs: number; error: RunFileError | null; logTail: string }[]
  timings: { scheduledAt: string; startedAt: string; finishedAt: string; durationMs: number }
}

/** run.json. */
export interface RunInfo {
  v: number
  bundle: { image: string; ref: string; language: string; platform: { os: string; arch: string; variant?: string } }
  scantorVersion: string
  startedAt: string
  finishedAt: string | null
  taskConfig: Record<string, unknown> | null
  scanConfig: Record<string, unknown> | null
  analysisConfig: Record<string, unknown> | null
  settings: Record<string, unknown>
  limit: number
  totalTimeoutMs: number
  uploads: { pointer: string; path: string; sha256: string; id: string }[]
  resolved: Record<string, { template: string; scanConfig: unknown; provenance: unknown; expectedTotal: number | null }>
  summary: { analyses: number; succeeded: number; failed: number }
  reason: string | null
  exitCode: number | null
}

export interface RunDir {
  /** relative to the folder */
  path: string
  info: RunInfo
  lines: ResultLine[]
  /** every entry below the run directory, paths relative to it */
  entries: FolderEntry[]
  /** SHA-256 of the regular files below files/, by path relative to the run directory */
  files: Map<string, string>
}

/** Parses results.jsonl (complete lines only: a running run may be writing the last one). */
export function parseLines(content: string | undefined): ResultLine[] {
  if (!content) return []
  const complete = content.endsWith('\n') ? content : content.slice(0, content.lastIndexOf('\n') + 1)
  return complete
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ResultLine)
}

/** Reads a run directory of a folder after the run ended. */
export async function readRunDir(folder: RecipientFolder, path: string): Promise<RunDir> {
  const runJson = await folder.read(posix.join(path, 'run.json'))
  if (runJson === undefined) throw new Error(`${folder.at(path)}/run.json does not exist; the folder holds ${JSON.stringify(await folder.entries())}`)
  const entries = await folder.entries(path)
  const hashes = await folder.hashes(path)
  const files = new Map([...hashes].filter(([file]) => file.startsWith('files/')))
  return { path, info: JSON.parse(runJson) as RunInfo, lines: parseLines(await folder.read(posix.join(path, 'results.jsonl'))), entries, files }
}

/** The lines of a run's results.jsonl as they are now. */
export async function currentLines(folder: RecipientFolder, path: string): Promise<ResultLine[]> {
  return parseLines(await folder.read(posix.join(path, 'results.jsonl')))
}

/** The NDJSON events of `-o json` output (complete lines only). */
export function parseEvents(stdout: string): ({ type: string } & Record<string, unknown>)[] {
  return parseLines(stdout) as unknown as ({ type: string } & Record<string, unknown>)[]
}

// ── archive contents (docs/security.md BDL-1, BDL-2) ──────────────────────────────────────────────────────

/** Receives the bytes of one stream of the archive (an entry, or the decompressed content of a layer). */
export interface ByteSink {
  update(chunk: Buffer): void
  end(): void
}

export interface ArchiveContents {
  /** the names of the entries of the archive's outer tar */
  names: string[]
  /** outer entries of at most 1 MiB that are no layers (manifest.json, index.json, repositories, configs), by name */
  small: Map<string, Buffer>
  /** outer entries that are layers (tar, or gzip-compressed tar) */
  layers: string[]
  /** wanted files found in the layers (paths without a leading ./ or /): the layer, size and content */
  files: Map<string, { layer: string; size: number; data: Buffer }>
}

const SMALL_ENTRY_BYTES = 1 << 20

/** A chunk as a Buffer without copying it. */
const asBuffer = (chunk: Uint8Array): Buffer => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))

/** Collects at most `limit` bytes of a stream. */
async function collect(source: AsyncIterable<Buffer>, sink: ByteSink, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of source) {
    sink.update(asBuffer(chunk))
    size += chunk.length
    if (size <= limit) chunks.push(asBuffer(chunk))
  }
  return size <= limit ? Buffer.concat(chunks) : undefined
}

/** The first `bytes` bytes of a stream and the whole stream again. */
async function peek(source: AsyncIterable<Buffer>, bytes: number): Promise<{ head: Buffer; stream: AsyncIterable<Buffer> }> {
  const iterator = source[Symbol.asyncIterator]()
  const chunks: Buffer[] = []
  let size = 0
  let done = false
  while (size < bytes) {
    const next = await iterator.next()
    if (next.done) {
      done = true
      break
    }
    const chunk = asBuffer(next.value)
    chunks.push(chunk)
    size += chunk.length
  }
  const head = Buffer.concat(chunks)
  async function* replay(): AsyncGenerator<Buffer> {
    if (head.length > 0) yield head
    if (done) return
    for (;;) {
      const next = await iterator.next()
      if (next.done) return
      yield asBuffer(next.value)
    }
  }
  return { head, stream: replay() }
}

/** Reads a stream to its end, discarding the bytes. */
async function drain(body: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of body) {
    // discarded
  }
}

const isGzip = (head: Buffer) => head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b
const isTar = (head: Buffer) => head.length >= 262 && head.subarray(257, 262).toString('latin1') === 'ustar'

/** Calls `onEntry` for every entry of a tar stream, one after the other; the entry's body must be consumed. */
async function forEachTarEntry(source: AsyncIterable<Buffer>, onEntry: (header: Header, body: AsyncIterable<Buffer>) => Promise<void>): Promise<void> {
  const extract = tar.extract()
  const state: { failure?: Error } = {}
  const finished = new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, body, next) => {
      onEntry(header, body as unknown as AsyncIterable<Buffer>).then(
        () => next(),
        (error: Error) => next(error),
      )
    })
    extract.on('finish', resolve)
    extract.on('error', (error: Error) => {
      state.failure = error
      reject(error)
    })
  })
  finished.catch(() => {})
  for await (const chunk of source) {
    if (state.failure) break
    if (!extract.write(chunk)) {
      await Promise.race([new Promise<void>((resolve) => extract.once('drain', () => resolve())), finished.catch(() => undefined)])
    }
  }
  if (!state.failure) extract.end(undefined)
  await finished
}

/** Passes every chunk of a stream to `sink` (and ends it) on the way through. */
async function* tapped(source: AsyncIterable<Uint8Array>, sink: ByteSink): AsyncGenerator<Buffer> {
  for await (const chunk of source) {
    const data = asBuffer(chunk)
    sink.update(data)
    yield data
  }
  sink.end()
}

/** Gunzips a stream; an error of the source or of the decompression ends the returned stream with it. */
function gunzip(source: AsyncIterable<Buffer>): AsyncIterable<Buffer> {
  const out = createGunzip()
  pipeline(Readable.from(source), out).catch(() => {}) // pipeline destroys `out` with the error
  return out
}

/**
 * Reads a bundle archive (a gzip `docker save` tar) the way the recipient's `docker load` does, without Docker: every
 * outer entry and the decompressed content of every layer go through a sink of `scan` (named after the entry, with
 * ` (gunzipped)` for decompressed content), small entries are kept, and the layer files named in `wanted` are read.
 */
export async function readArchive(path: string, options: { scan: (where: string) => ByteSink; wanted?: string[] }): Promise<ArchiveContents> {
  const wanted = new Set(options.wanted ?? [])
  const contents: ArchiveContents = { names: [], small: new Map(), layers: [], files: new Map() }

  const readLayer = async (layer: string, source: AsyncIterable<Buffer>, sink: ByteSink) => {
    contents.layers.push(layer)
    await forEachTarEntry(tapped(source, sink), async (header, body) => {
      const name = header.name.replace(/^(\.\/)+|^\/+/, '')
      if (!wanted.has(name) || header.type !== 'file') {
        await drain(body)
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of body) chunks.push(asBuffer(chunk))
      contents.files.set(name, { layer, size: header.size, data: Buffer.concat(chunks) })
    })
  }

  await forEachTarEntry(gunzip(createReadStream(path)), async (header, body) => {
    contents.names.push(header.name)
    if (header.type !== 'file') {
      await drain(body) // directories
      return
    }
    const { head, stream } = await peek(body, 512)
    if (isGzip(head)) {
      const inner = await peek(gunzip(tapped(stream, options.scan(header.name))), 512)
      const where = `${header.name} (gunzipped)`
      if (isTar(inner.head)) {
        await readLayer(header.name, inner.stream, options.scan(where))
      } else {
        const sink = options.scan(where)
        await collect(inner.stream, sink, 0)
        sink.end()
      }
      return
    }
    if (isTar(head)) {
      await readLayer(header.name, stream, options.scan(header.name))
      return
    }
    const sink = options.scan(header.name)
    const data = await collect(stream, sink, SMALL_ENTRY_BYTES)
    sink.end()
    if (data) contents.small.set(header.name, data)
  })
  return contents
}
