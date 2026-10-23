import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { env } from './env'

// A per-test git smart-HTTP server for the git import specs (api/git.spec.ts) that need repositories the fixtures
// server does not ship: a folder without scantor.yaml, an invalid manifest or an unknown language, a symlink in the
// task folder, a pulled manifest that renames the task, a redirect, and an endpoint that echoes the credential it
// received. It runs inside the Playwright worker (the test runner), listens on a random port with the stack's
// wildcard certificate (signed by the test CA, which the orchestrator passes to git helpers), and is reached by the
// git helpers as https://<name>.<domain>:<port> because *.<domain> resolves to the runner (dnsmasq). Repositories are
// ordinary working repositories committed with fixed authors and dates and served through `git http-backend`.

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'scantor tests',
  GIT_AUTHOR_EMAIL: 'tests@scantor.test',
  GIT_COMMITTER_NAME: 'scantor tests',
  GIT_COMMITTER_EMAIL: 'tests@scantor.test',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
}

/** File content, or a symlink with its target. */
export type RepoFile = string | { symlink: string }

export interface RecordedRequest {
  method: string
  path: string
  /** the Authorization header as received (undefined when absent) */
  authorization: string | undefined
}

interface RepoOptions {
  /** Basic auth the repository requires */
  auth?: { username: string; token: string }
}

export interface GitServer {
  /** `host:port` as a git credential names it */
  readonly host: string
  /** every request the server received, in order */
  readonly requests: RecordedRequest[]
  /** The clone URL of a repository. */
  url(repo: string): string
  /** Creates a repository on branch main with one commit of `files`. */
  createRepo(repo: string, files: Record<string, RepoFile>, options?: RepoOptions): Promise<void>
  /** Adds a commit that writes `files` and removes `remove`; returns the new commit. */
  commit(repo: string, files: Record<string, RepoFile>, options?: { remove?: string[]; message?: string }): Promise<string>
  /** The commit main points at. */
  head(repo: string): Promise<string>
  /** Answers every request for `repo` with a redirect to `location` (plus the requested suffix). */
  redirect(repo: string, location: string): void
  /**
   * Answers the ref advertisement of `repo` with a git `ERR` packet that quotes the Authorization header it received
   * and the decoded password, so git prints them in its error message.
   */
  echoCredential(repo: string): void
  close(): Promise<void>
}

function run(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, ...GIT_IDENTITY } }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(' ')} failed: ${stderr || error.message}`))
      else resolve(String(stdout))
    })
  })
}

async function writeFiles(dir: string, files: Record<string, RepoFile>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path)
    await mkdir(dirname(target), { recursive: true })
    await rm(target, { force: true })
    if (typeof content === 'string') await writeFile(target, content)
    else await symlink(content.symlink, target)
  }
}

/** One pkt-line (4 hex digits of the length including themselves, then the payload). */
function pktLine(payload: string): string {
  return (Buffer.byteLength(payload) + 4).toString(16).padStart(4, '0') + payload
}

function basicAuth(header: string | undefined): { username: string; password: string } | null {
  const match = /^Basic\s+(\S+)$/i.exec(header ?? '')
  if (!match) return null
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  return colon < 0 ? null : { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) }
}

/** Runs `git http-backend` as a CGI program for one request and relays its answer. */
function serveCgi(root: string, req: IncomingMessage, res: ServerResponse, pathname: string, query: string): void {
  const cgiEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    GIT_PROJECT_ROOT: root,
    GIT_HTTP_EXPORT_ALL: '1',
    GATEWAY_INTERFACE: 'CGI/1.1',
    REQUEST_METHOD: req.method ?? 'GET',
    PATH_INFO: pathname,
    QUERY_STRING: query,
    REMOTE_ADDR: req.socket.remoteAddress ?? '127.0.0.1',
    CONTENT_TYPE: req.headers['content-type'] ?? '',
  }
  if (req.headers['content-length']) cgiEnv.CONTENT_LENGTH = req.headers['content-length']
  if (req.headers['content-encoding']) cgiEnv.HTTP_CONTENT_ENCODING = String(req.headers['content-encoding'])
  if (req.headers['git-protocol']) cgiEnv.GIT_PROTOCOL = String(req.headers['git-protocol'])
  const child = spawn('git', ['http-backend'], { env: cgiEnv, stdio: ['pipe', 'pipe', 'pipe'] })
  req.pipe(child.stdin)
  child.stdin.on('error', () => undefined)
  let head = Buffer.alloc(0)
  let headersSent = false
  child.stdout.on('data', (chunk: Buffer) => {
    if (headersSent) {
      res.write(chunk)
      return
    }
    head = Buffer.concat([head, chunk])
    const text = head.toString('latin1')
    const end = text.search(/\r?\n\r?\n/)
    if (end < 0) return
    const separator = /\r?\n\r?\n/.exec(text.slice(end))![0]
    let status = 200
    const headers: Record<string, string> = {}
    for (const line of text.slice(0, end).split(/\r?\n/)) {
      const colon = line.indexOf(':')
      if (colon < 0) continue
      const name = line.slice(0, colon).trim()
      const value = line.slice(colon + 1).trim()
      if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10)
      else headers[name] = value
    }
    res.writeHead(status, headers)
    headersSent = true
    const rest = head.subarray(Buffer.byteLength(text.slice(0, end + separator.length), 'latin1'))
    if (rest.length > 0) res.write(rest)
  })
  child.on('close', (code) => {
    if (!headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(`git http-backend exited with ${code}\n`)
    } else {
      res.end()
    }
  })
}

/** Starts a git server for one test; close it at the end of the test. */
export async function startGitServer(name = 'gitsrv'): Promise<GitServer> {
  const root = await mkdtemp(join(tmpdir(), 'scantor-git-'))
  const certDir = join(env.paths.stack, 'traefik', 'dynamic')
  const [cert, key] = await Promise.all([readFile(join(certDir, 'wildcard.crt')), readFile(join(certDir, 'wildcard.key'))])
  const requests: RecordedRequest[] = []
  const auth = new Map<string, { username: string; token: string }>()
  const redirects = new Map<string, string>()
  const echoes = new Set<string>()

  const server: Server = createServer({ cert, key }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://git.invalid')
    requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search, authorization: req.headers.authorization })
    const match = /^\/([a-z0-9][a-z0-9-]*)\.git(\/.*)$/.exec(url.pathname)
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found\n')
      return
    }
    const [, repo, suffix] = match as unknown as [string, string, string]
    const location = redirects.get(repo)
    if (location !== undefined) {
      res.writeHead(301, { Location: `${location}${suffix}${url.search}` }).end()
      return
    }
    if (echoes.has(repo)) {
      const received = req.headers.authorization ?? 'none'
      const password = basicAuth(req.headers.authorization)?.password ?? 'none'
      res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement', 'Cache-Control': 'no-cache' })
      res.end(pktLine(`ERR received ${received} with password ${password}\n`))
      return
    }
    const required = auth.get(repo)
    if (required) {
      const given = basicAuth(req.headers.authorization)
      if (!given || given.username !== required.username || given.password !== required.token) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="scantor api-tasks tests"', 'Content-Type': 'text/plain' }).end('authentication required\n')
        return
      }
    }
    serveCgi(root, req, res, url.pathname, url.search.replace(/^\?/, ''))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  const host = `${name}.${env.domain}:${port}`
  const repoDir = (repo: string) => join(root, `${repo}.git`)

  return {
    host,
    requests,
    url: (repo) => `https://${host}/${repo}.git`,
    async createRepo(repo, files, options = {}) {
      const dir = repoDir(repo)
      await mkdir(dir, { recursive: true })
      await run(['init', '--quiet', '--initial-branch', 'main'], dir)
      await run(['config', 'uploadpack.allowFilter', 'true'], dir)
      await run(['config', 'uploadpack.allowAnySHA1InWant', 'true'], dir)
      await writeFiles(dir, files)
      await run(['add', '--all'], dir)
      await run(['commit', '--quiet', '--message', 'initial commit'], dir)
      if (options.auth) auth.set(repo, options.auth)
    },
    async commit(repo, files, options = {}) {
      const dir = repoDir(repo)
      await writeFiles(dir, files)
      for (const path of options.remove ?? []) await unlink(join(dir, path))
      await run(['add', '--all'], dir)
      await run(['commit', '--quiet', '--message', options.message ?? 'change'], dir)
      return (await run(['rev-parse', 'HEAD'], dir)).trim()
    },
    async head(repo) {
      return (await run(['rev-parse', 'HEAD'], repoDir(repo))).trim()
    },
    redirect(repo, location) {
      redirects.set(repo, location.replace(/\/+$/, ''))
    },
    echoCredential(repo) {
      echoes.add(repo)
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      await rm(root, { recursive: true, force: true })
    },
  }
}
