import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { childEnv, env } from './env'
import { stackKeys } from './keys'

// The inner Docker of the runner (docs/testing.md §7.8): white-box access to the test stack for chaos, remote-node and
// security tests. Every call is `docker <args>` through execFile (never a shell string). Containers of the stack are
// addressed by their compose container names; containers scantor creates are found by label (scantor.scan=<id>,
// scantor.kind=worker, …). The remote node's own dockerd is reached with `docker exec scantor-remote-node docker …`.

export const CONTAINERS = {
  orchestrator: 'scantor-orchestrator',
  node: 'scantor-node',
  mongo: 'scantor-mongo',
  rabbitmq: 'scantor-rabbitmq',
  rustfs: 'scantor-rustfs',
  registry: 'scantor-registry',
  mongoExpress: 'scantor-mongo-express',
  traefik: 'scantor-traefik',
  fixtures: 'scantor-fixtures',
  remoteNode: 'scantor-remote-node',
} as const

/** The network of the simulated remote node (partition tests disconnect it). */
export const REMOTE_NODE_NETWORK = 'scantor-remote'

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export class DockerError extends Error {
  constructor(
    readonly args: string[],
    readonly result: ExecResult,
  ) {
    super(`docker ${args.join(' ')} exited with ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`)
  }
}

export interface DockerOptions {
  input?: string | Buffer
  timeoutMs?: number
  /** return a non-zero exit code instead of throwing */
  allowFailure?: boolean
  env?: Record<string, string>
}

/** Runs `docker <args>`; throws DockerError on a non-zero exit unless `allowFailure`. */
export function docker(args: string[], options: DockerOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'docker',
      args,
      { timeout: options.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, env: childEnv(options.env) },
      (error, stdout, stderr) => {
        const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        const result = { exitCode, stdout: String(stdout), stderr: String(stderr) }
        if (exitCode !== 0 && !options.allowFailure) reject(new DockerError(args, result))
        else resolve(result)
      },
    )
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
}

/** Variables of the test stack's generated .env (unquoted values; SCANTOR_CA_CERT is the only quoted one). */
export function stackEnv(): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of readFileSync(join(env.paths.stack, '.env'), 'utf8').split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (match) values[match[1]!] = match[2]!
  }
  return values
}

export const innerDocker = {
  /** `docker inspect` of one object (container, network, volume or image). */
  async inspect<T = Record<string, unknown>>(name: string): Promise<T> {
    const { stdout } = await docker(['inspect', name])
    return (JSON.parse(stdout) as T[])[0]!
  },

  async exec(
    container: string,
    command: string[],
    options: { user?: string; env?: Record<string, string>; input?: string | Buffer } = {},
  ): Promise<ExecResult> {
    const args = ['exec', ...(options.input !== undefined ? ['-i'] : [])]
    if (options.user) args.push('-u', options.user)
    for (const [key, value] of Object.entries(options.env ?? {})) args.push('-e', `${key}=${value}`)
    return docker([...args, container, ...command], { input: options.input, allowFailure: true })
  },

  async kill(container: string, signal = 'KILL'): Promise<void> {
    await docker(['kill', '-s', signal, container])
  },

  async restart(container: string): Promise<void> {
    await docker(['restart', container])
  },

  async pause(container: string): Promise<void> {
    await docker(['pause', container])
  },

  async unpause(container: string): Promise<void> {
    await docker(['unpause', container])
  },

  async networkDisconnect(network: string, container: string): Promise<void> {
    await docker(['network', 'disconnect', network, container])
  },

  async networkConnect(network: string, container: string): Promise<void> {
    await docker(['network', 'connect', network, container])
  },

  async logs(container: string, tail = 200): Promise<string> {
    const { stdout, stderr } = await docker(['logs', '--tail', String(tail), container])
    return stdout + stderr
  },

  /** Ids of the containers whose labels match every filter, for example `{ 'scantor.scan': scanId }`. */
  async containersByLabel(labels: Record<string, string>, options: { all?: boolean } = {}): Promise<string[]> {
    const args = ['ps', '-q', ...(options.all === false ? [] : ['-a'])]
    for (const [key, value] of Object.entries(labels)) args.push('--filter', `label=${key}=${value}`)
    const { stdout } = await docker(args)
    return stdout.split('\n').filter(Boolean)
  },

  /** `docker <args>` against the simulated remote node's own dockerd. */
  remote(args: string[], options: DockerOptions = {}): Promise<ExecResult> {
    return docker(['exec', ...(options.input !== undefined ? ['-i'] : []), CONTAINERS.remoteNode, 'docker', ...args], options)
  },

  /**
   * Evaluates JavaScript in mongosh against the app database: as the read-only `scantor_query` user (default, what
   * user queries run as) or as the root user for white-box changes. Returns the printed output (use EJSON.stringify).
   */
  async mongosh(script: string, options: { as?: 'query' | 'root' } = {}): Promise<string> {
    const stack = stackEnv()
    const database = stack.SCANTOR_MONGO_DB ?? 'scantor'
    const [user, password] =
      options.as === 'root' ? [stack.SCANTOR_MONGO_USER!, stack.SCANTOR_MONGO_PASSWORD!] : ['scantor_query', stackKeys().mongoQueryPassword()]
    const uri = `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:27017/${database}?authSource=admin&directConnection=true`
    const result = await innerDocker.exec(CONTAINERS.mongo, ['mongosh', '--quiet', uri, '--eval', script])
    if (result.exitCode !== 0) throw new DockerError(['exec', CONTAINERS.mongo, 'mongosh', '…'], result)
    return result.stdout.trim()
  },

  /** Exact document count of a collection (read-only user). */
  async mongoCount(collection: string, filter: Record<string, unknown> = {}): Promise<number> {
    const out = await innerDocker.mongosh(
      `print(db.getCollection(${JSON.stringify(collection)}).countDocuments(EJSON.parse(${JSON.stringify(JSON.stringify(filter))})))`,
    )
    return Number(out)
  },

  /** The RabbitMQ queues of the scantor vhost. */
  async rabbitmqQueues(): Promise<{ name: string; messages_ready: number; messages_unacknowledged: number; consumers: number }[]> {
    const vhost = 'scantor'
    const result = await innerDocker.exec(CONTAINERS.rabbitmq, [
      'rabbitmqctl',
      'list_queues',
      '-q',
      '-p',
      vhost,
      'name',
      'messages_ready',
      'messages_unacknowledged',
      'consumers',
      '--formatter',
      'json',
    ])
    if (result.exitCode !== 0) throw new DockerError(['exec', CONTAINERS.rabbitmq, 'rabbitmqctl', 'list_queues'], result)
    return JSON.parse(result.stdout) as { name: string; messages_ready: number; messages_unacknowledged: number; consumers: number }[]
  },
}
