import { randomBytes, randomInt } from 'node:crypto'
import { request, type APIRequestContext } from '@playwright/test'
import { ApiClient } from './api-client'
import { CONTAINERS, docker, DockerError, stackEnv } from './docker'
import type { OpenApiIndex } from './openapi'
import { unique } from './unique'

// Throwaway orchestrators (docs/testing.md §8.6): an orchestrator container started by a test, for behaviour that needs
// a fresh or differently configured deployment (zero users and the setup token, the startup guard, the per-IP auth
// rate limits without a trusted proxy, a changed SCANTOR_SECRET). It runs only the `api` component, so it never runs
// the reconciler's sweeps against the shared broker.
//
// Isolation from the shared stack goes further than "own database and bucket":
//   - MongoDB: a private single-node replica set. Boot step 2 creates or updates the global read-only user
//     `scantor_query` (password derived from the orchestrator's secret, role `read` on its own database), so an
//     orchestrator on the stack's mongod would break the stack's query client for every other test.
//   - Docker: a private Docker-in-Docker daemon, mounted as /var/run/docker.sock like the host socket in production
//     (the task pipeline's build subprocess uses that path), also reachable through DOCKER_HOST. The `api` component's
//     editor boot sweep removes every editor container its own database does not know, which on the stack's daemon
//     would stop other tests' editors.
//   - S3: a private RustFS (no bucket to clean up in the stack's store).
//   - RabbitMQ: the stack's broker; boot step 5 only asserts the global topology, which is idempotent.
// Every container carries `scantor.test=true` and the prefix `scantor-test-`, sits on the stack network `scantor`
// (to reach RabbitMQ) and mounts none of the stack's volumes. `dispose()` removes all of them with their volumes.
//
// One infrastructure can serve many orchestrators one after the other (the security specs share one per Playwright
// worker, helpers/security-tenants.ts): every orchestrator gets a database and a bucket of its own (a redeploy keeps
// them), so each one starts with zero users.

const STACK_NETWORK = 'scantor'
const DASHBOARD_PORT = 3000
const TEST_LABELS = ['--label', 'scantor.test=true']

/** Image references of the running stack, so throwaways use exactly the images under test. */
async function stackImage(container: string): Promise<string> {
  const { stdout } = await docker(['inspect', '--format', '{{.Config.Image}}', container])
  return stdout.trim()
}

const randomSecret = () => randomBytes(24).toString('hex')
/** A MongoDB database and S3 bucket name of one orchestrator (lowercase letters and digits, valid for both). */
const storeName = () => `t${randomBytes(6).toString('hex')}`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function removeContainers(names: string[]): Promise<void> {
  if (names.length === 0) return
  const result = await docker(['rm', '-fv', ...names], { allowFailure: true })
  if (result.exitCode !== 0 && !/No such container/i.test(result.stderr)) throw new DockerError(['rm', '-fv', ...names], result)
}

async function containerIp(name: string): Promise<string> {
  const { stdout } = await docker(['inspect', '--format', `{{(index .NetworkSettings.Networks "${STACK_NETWORK}").IPAddress}}`, name])
  const ip = stdout.trim()
  if (!ip || ip === '<no value>') throw new Error(`container ${name} has no address on ${STACK_NETWORK}`)
  return ip
}

async function containerState(name: string): Promise<{ running: boolean; exitCode: number; startedAt: string; finishedAt: string }> {
  const { stdout } = await docker(['inspect', '--format', '{{json .State}}', name])
  const state = JSON.parse(stdout) as { Running: boolean; ExitCode: number; StartedAt: string; FinishedAt: string }
  return { running: state.Running, exitCode: state.ExitCode, startedAt: state.StartedAt, finishedAt: state.FinishedAt }
}

/** Polls `check` every `intervalMs` until it returns a value; throws `describe()` after the timeout. */
async function pollUntil<T>(check: () => Promise<T | undefined>, timeoutMs: number, describe: () => Promise<string>, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(await describe())
    await sleep(intervalMs)
  }
}

/** The private MongoDB, RustFS and Docker daemon of one throwaway orchestrator (also across its restarts). */
export class ThrowawayInfra {
  private constructor(
    readonly name: string,
    readonly mongo: { container: string; user: string; password: string },
    readonly s3: { container: string; accessKey: string; secretKey: string },
    /** the DinD container and the volume holding its unix socket (bind-mounted into orchestrators) */
    readonly docker: { container: string; socketVolume: string },
    /** a test-owned volume for /run/scantor/registry-auth, so the registry key files survive a restart */
    readonly registryAuthVolume: string,
  ) {}

  static async start(name: string): Promise<ThrowawayInfra> {
    const [mongoImage, s3Image, dindImage] = await Promise.all([stackImage(CONTAINERS.mongo), stackImage(CONTAINERS.rustfs), stackImage(CONTAINERS.remoteNode)])
    const infra = new ThrowawayInfra(
      name,
      { container: `${name}-mongo`, user: 'scantor', password: randomSecret() },
      { container: `${name}-s3`, accessKey: 'scantor', secretKey: randomSecret() },
      { container: `${name}-docker`, socketVolume: `${name}-docker-socket` },
      `${name}-registry-auth`,
    )
    try {
      await docker(['volume', 'create', ...TEST_LABELS, infra.registryAuthVolume])
      await docker(['volume', 'create', ...TEST_LABELS, infra.docker.socketVolume])
      // The production compose entrypoint of MongoDB: a keyfile, then a single-node replica set with auth.
      const mongoEntrypoint = [
        'set -euo pipefail',
        'openssl rand -base64 756 > /tmp/mongo-keyfile',
        'chmod 400 /tmp/mongo-keyfile',
        'chown mongodb:mongodb /tmp/mongo-keyfile',
        'exec docker-entrypoint.sh mongod --replSet rs0 --keyFile /tmp/mongo-keyfile --noscripting --bind_ip_all --wiredTigerCacheSizeGB 0.25',
      ].join('\n')
      await Promise.all([
        docker([
          'run',
          '-d',
          '--name',
          infra.mongo.container,
          ...TEST_LABELS,
          '--network',
          STACK_NETWORK,
          '--memory',
          '1g',
          '-e',
          `MONGO_INITDB_ROOT_USERNAME=${infra.mongo.user}`,
          '-e',
          `MONGO_INITDB_ROOT_PASSWORD=${infra.mongo.password}`,
          '--entrypoint',
          'bash',
          mongoImage,
          '-c',
          mongoEntrypoint,
        ]),
        docker([
          'run',
          '-d',
          '--name',
          infra.s3.container,
          ...TEST_LABELS,
          '--network',
          STACK_NETWORK,
          '--memory',
          '512m',
          '-e',
          `RUSTFS_ACCESS_KEY=${infra.s3.accessKey}`,
          '-e',
          `RUSTFS_SECRET_KEY=${infra.s3.secretKey}`,
          '-e',
          'RUSTFS_OBS_LOG_DIRECTORY=',
          '-e',
          'RUSTFS_CHECK_UPDATE=false',
          s3Image,
        ]),
        // TCP without TLS stays inside the stack network; address ranges clear of the runner's and the remote node's.
        docker([
          'run',
          '-d',
          '--privileged',
          '--name',
          infra.docker.container,
          ...TEST_LABELS,
          '--network',
          STACK_NETWORK,
          '-v',
          `${infra.docker.socketVolume}:/run/dind`,
          '-e',
          'DOCKER_TLS_CERTDIR=',
          dindImage,
          'dockerd',
          '--host=unix:///var/run/docker.sock',
          '--host=unix:///run/dind/docker.sock',
          '--host=tcp://0.0.0.0:2375',
          '--tls=false',
          '--bip=10.40.0.1/24',
          '--default-address-pool=base=10.41.0.0/16,size=24',
        ]),
      ])
      await Promise.all([infra.waitForMongo(), infra.waitForS3(), infra.waitForDocker()])
      return infra
    } catch (error) {
      await infra.dispose()
      throw error
    }
  }

  private async waitForMongo(): Promise<void> {
    const { container, user, password } = this.mongo
    const mongosh = (script: string) =>
      docker(['exec', container, 'mongosh', '--quiet', '-u', user, '-p', password, '--authenticationDatabase', 'admin', '--eval', script], {
        allowFailure: true,
      })
    const initiate = `try { rs.status().ok } catch (e) { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '${container}:27017' }] }).ok }`
    const tail = async () =>
      `MongoDB ${container} did not become a writable primary:\n${(await docker(['logs', '--tail', '30', container], { allowFailure: true })).stdout}`
    await pollUntil(async () => ((await mongosh(initiate)).stdout.trim() === '1' ? true : undefined), 90_000, tail, 500)
    await pollUntil(async () => ((await mongosh('db.hello().isWritablePrimary')).stdout.trim() === 'true' ? true : undefined), 60_000, tail, 500)
  }

  private async waitForS3(): Promise<void> {
    const { container } = this.s3
    await pollUntil(
      async () =>
        (await docker(['exec', container, 'curl', '-fsS', 'http://127.0.0.1:9000/health/ready'], { allowFailure: true })).exitCode === 0 ? true : undefined,
      60_000,
      async () => `RustFS ${container} is not ready:\n${(await docker(['logs', '--tail', '30', container], { allowFailure: true })).stdout}`,
    )
  }

  private async waitForDocker(): Promise<void> {
    const { container } = this.docker
    await pollUntil(
      async () => ((await docker(['exec', container, 'docker', 'version'], { allowFailure: true })).exitCode === 0 ? true : undefined),
      60_000,
      async () => `the Docker daemon ${container} is not ready:\n${(await docker(['logs', '--tail', '30', container], { allowFailure: true })).stderr}`,
    )
  }

  /** The variables that point an orchestrator at this infrastructure, with `store` as its database and bucket. */
  env(store: string): Record<string, string> {
    return {
      SCANTOR_MONGO_URL: `mongodb://${this.mongo.container}:27017/?replicaSet=rs0&authSource=admin`,
      SCANTOR_MONGO_USER: this.mongo.user,
      SCANTOR_MONGO_PASSWORD: this.mongo.password,
      SCANTOR_MONGO_DB: store,
      SCANTOR_S3_INTERNAL_URL: `http://${this.s3.container}:9000`,
      SCANTOR_S3_PUBLIC_URL: `http://${this.s3.container}:9000`,
      SCANTOR_S3_ACCESS_KEY: this.s3.accessKey,
      SCANTOR_S3_SECRET_KEY: this.s3.secretKey,
      SCANTOR_S3_BUCKET: store,
      DOCKER_HOST: `tcp://${this.docker.container}:2375`,
    }
  }

  /** The DinD socket's path on the inner Docker host (the runner), for a bind mount at /var/run/docker.sock. */
  async dockerSocketPath(): Promise<string> {
    const { stdout } = await docker(['volume', 'inspect', '--format', '{{.Mountpoint}}', this.docker.socketVolume])
    return `${stdout.trim()}/docker.sock`
  }

  /** Evaluates JavaScript in mongosh against one orchestrator's database (root user). */
  async mongosh(script: string, database: string): Promise<string> {
    const { container, user, password } = this.mongo
    const uri = `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:27017/${database}?authSource=admin&directConnection=true`
    const result = await docker(['exec', container, 'mongosh', '--quiet', uri, '--eval', script], { allowFailure: true })
    if (result.exitCode !== 0) throw new DockerError(['exec', container, 'mongosh', '…'], result)
    return result.stdout.trim()
  }

  async dispose(): Promise<void> {
    await removeContainers([this.mongo.container, this.s3.container, this.docker.container])
    const volumes = [this.registryAuthVolume, this.docker.socketVolume]
    const removed = await docker(['volume', 'rm', '-f', ...volumes], { allowFailure: true })
    if (removed.exitCode !== 0) throw new DockerError(['volume', 'rm', '-f', ...volumes], removed)
  }
}

export interface ThrowawayOptions {
  /** what the orchestrator is for; part of the container name `scantor-test-<name>-…` */
  name: string
  /**
   * Overrides of the environment (null removes a variable). The base is the stack's generated .env (what the stack's
   * orchestrator gets through env_file) pointed at the private infrastructure, with its own random SCANTOR_SECRET, no
   * SCANTOR_ADMIN_*, only the `api` component, no Traefik profile and `http://localhost:<port>` as public URL.
   */
  env?: Record<string, string | null>
  /** private MongoDB, S3 and Docker (default true); without them the process cannot get past boot step 1 */
  infra?: boolean | ThrowawayInfra
  /** publish the dashboard port on 127.0.0.1:<random port> of the runner (the browser's `http://localhost:<port>`) */
  publish?: boolean
  /** the public URL's host: `localhost` (default) or the IP literal `127.0.0.1` (passkeys disabled, docs/auth.md §4.4) */
  publicHost?: 'localhost' | '127.0.0.1'
}

export interface LogLine {
  time?: string
  level?: string
  msg?: string
  [field: string]: unknown
}

/** An orchestrator container of a test; remove it (and its infrastructure) with `dispose()`. */
export class ThrowawayOrchestrator {
  private disposed = false
  private contexts: APIRequestContext[] = []

  private constructor(
    /** what the orchestrator is for (ThrowawayOptions.name) */
    readonly purpose: string,
    /** the container name */
    readonly container: string,
    readonly env: Record<string, string>,
    /** the address the runner connects to (`http://<ip>:3000`, or the published port) */
    private address: string,
    /** whether `address` is the container's IP on the stack network (it can change on a restart) */
    private readonly addressedByIp: boolean,
    readonly infra: ThrowawayInfra | null,
    private ownsInfra: boolean,
  ) {}

  /** The address the runner connects to; read it again after `restart()`. */
  get baseUrl(): string {
    return this.address
  }

  get publicUrl(): string {
    return this.env.SCANTOR_PUBLIC_URL!
  }

  get editorUrl(): string {
    return this.env.SCANTOR_EDITOR_URL!
  }

  /** Starts a throwaway orchestrator. It does not wait: use `waitReady()` or `waitExit()`. */
  static async start(options: ThrowawayOptions): Promise<ThrowawayOrchestrator> {
    const name = unique(`scantor-test-${options.name}`)
    const infra = options.infra instanceof ThrowawayInfra ? options.infra : options.infra === false ? null : await ThrowawayInfra.start(name)
    const ownsInfra = infra !== null && !(options.infra instanceof ThrowawayInfra)
    try {
      return await ThrowawayOrchestrator.run(name, options, infra, ownsInfra)
    } catch (error) {
      if (ownsInfra) await infra?.dispose()
      throw error
    }
  }

  private static async run(name: string, options: ThrowawayOptions, infra: ThrowawayInfra | null, ownsInfra: boolean): Promise<ThrowawayOrchestrator> {
    const image = await stackImage(CONTAINERS.orchestrator)
    for (let attempt = 1; ; attempt++) {
      const port = options.publish ? randomInt(20_000, 30_000) : DASHBOARD_PORT
      // `localhost` itself: @better-auth/mcp accepts plain http only for localhost and loopback IPs (see
      // security/setup-token.spec.ts for `*.localhost`). The port makes the origin; cookies of contexts stay apart.
      const ipLiteral = options.publicHost === '127.0.0.1'
      const environment: Record<string, string> = {
        ...ThrowawayOrchestrator.stackBase(),
        SCANTOR_PUBLIC_URL: ipLiteral ? `http://127.0.0.1:${port}` : `http://localhost:${port}`,
        SCANTOR_EDITOR_URL: ipLiteral ? `http://127.0.0.1:${port + 1}` : `http://editor.localhost:${port}`,
        // a redeploy passes the previous SCANTOR_MONGO_DB in `env`, which wins below
        ...(infra ? infra.env(storeName()) : {}),
      }
      for (const [key, value] of Object.entries(options.env ?? {})) {
        if (value === null) delete environment[key]
        else environment[key] = value
      }
      const args = ['run', '-d', '--name', name, ...TEST_LABELS, '--memory', '1g']
      args.push('--network', infra || options.publish ? STACK_NETWORK : 'none')
      if (options.publish) args.push('-p', `127.0.0.1:${port}:${DASHBOARD_PORT}`)
      if (infra) args.push('-v', `${infra.registryAuthVolume}:/run/scantor/registry-auth`, '-v', `${await infra.dockerSocketPath()}:/var/run/docker.sock`)
      for (const [key, value] of Object.entries(environment)) args.push('-e', `${key}=${value}`)
      args.push(image)
      const result = await docker(args, { allowFailure: true })
      if (result.exitCode === 0) {
        // Without a network (no infrastructure) the process cannot get past boot step 1 and has no address.
        const addressedByIp = Boolean(infra) && !options.publish
        const baseUrl = options.publish
          ? `http://127.0.0.1:${port}`
          : addressedByIp
            ? `http://${await containerIp(name)}:${DASHBOARD_PORT}`
            : 'http://unreachable.invalid'
        return new ThrowawayOrchestrator(options.name, name, environment, baseUrl, addressedByIp, infra, ownsInfra)
      }
      await removeContainers([name])
      // A randomly chosen host port can be taken by another test; choose another one.
      if (!options.publish || attempt >= 5 || !/port is already allocated|address already in use/i.test(result.stderr)) {
        throw new DockerError(['run', '…', image], result)
      }
    }
  }

  /** The stack's generated .env without the stack's secret and first admin, for the `api` component alone. */
  private static stackBase(): Record<string, string> {
    const base: Record<string, string> = {}
    for (const [key, raw] of Object.entries(stackEnv())) base[key] = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
    return {
      ...base,
      SCANTOR_SECRET: randomSecret(),
      SCANTOR_ADMIN_EMAIL: '',
      SCANTOR_ADMIN_PASSWORD: '',
      SCANTOR_COMPONENTS: 'api',
      COMPOSE_PROFILES: '',
      SCANTOR_DOMAIN: '',
      SCANTOR_TRUST_PROXY: 'false',
      SCANTOR_LOG_FORMAT: 'json',
      // The production limits: the stack's multiplier exists only because the suite shares one client IP.
      SCANTOR_AUTH_RATE_LIMIT_SCALE: '1',
    }
  }

  /**
   * Starts a new container on the same infrastructure (database, S3, Docker, registry key volume) with the
   * environment changed by `env`; this one is removed first. Models a redeploy, for example with a new secret.
   */
  async redeploy(env: Record<string, string | null> = {}): Promise<ThrowawayOrchestrator> {
    if (!this.infra) throw new Error('only a throwaway with infrastructure can be redeployed')
    await this.closeContexts()
    await removeContainers([this.container])
    this.disposed = true
    // The new container keeps the public URL and takes over the infrastructure.
    const next = await ThrowawayOrchestrator.run(
      unique(`scantor-test-${this.purpose}`),
      { name: this.purpose, env: { ...this.env, ...env } },
      this.infra,
      this.ownsInfra,
    )
    this.ownsInfra = false
    return next
  }

  /** Evaluates JavaScript in mongosh against this orchestrator's database (root user). */
  async mongosh(script: string): Promise<string> {
    if (!this.infra) throw new Error('only a throwaway with infrastructure has a database')
    return this.infra.mongosh(script, this.env.SCANTOR_MONGO_DB!)
  }

  /**
   * `docker restart` (same container, same environment). The restarted container can get another address on the
   * stack network, and its old one can go to another test's container meanwhile, so the address is read again:
   * contexts and clients made before the restart keep the old one, so make new ones.
   */
  async restart(): Promise<void> {
    await docker(['restart', '--time', '10', this.container])
    if (this.addressedByIp) this.address = `http://${await containerIp(this.container)}:${DASHBOARD_PORT}`
  }

  /** The container's output (stdout and stderr). */
  async logs(): Promise<string> {
    const { stdout, stderr } = await docker(['logs', this.container])
    return stdout + stderr
  }

  /** The JSON log lines of the container (other output lines are skipped). */
  async logLines(): Promise<LogLine[]> {
    const lines: LogLine[] = []
    for (const line of (await this.logs()).split('\n')) {
      if (!line.startsWith('{')) continue
      try {
        lines.push(JSON.parse(line) as LogLine)
      } catch {
        // A partial line at the end of a running container's output.
      }
    }
    return lines
  }

  /** Waits until a JSON log line matches; returns it. */
  async waitForLog(predicate: (line: LogLine) => boolean, timeoutMs = 60_000): Promise<LogLine> {
    return pollUntil(
      async () => (await this.logLines()).find(predicate),
      timeoutMs,
      async () => `no matching log line of ${this.container} within ${timeoutMs / 1000} s:\n${(await this.logs()).slice(-4000)}`,
    )
  }

  /** Waits until boot finished (the setup status answers 200); throws with the log tail when the container exits. */
  async waitReady(timeoutMs = 120_000): Promise<void> {
    const context = await request.newContext({ baseURL: this.baseUrl })
    try {
      await pollUntil(
        async () => {
          const state = await containerState(this.container)
          if (!state.running) throw new Error(`${this.container} exited with ${state.exitCode} during boot:\n${(await this.logs()).slice(-4000)}`)
          const response = await context.get('/api/setup/status', { timeout: 5000 }).catch(() => null)
          return response?.status() === 200 ? true : undefined
        },
        timeoutMs,
        async () => `${this.container} is not ready after ${timeoutMs / 1000} s:\n${(await this.logs()).slice(-4000)}`,
        500,
      )
    } finally {
      await context.dispose()
    }
  }

  /** Waits until the container exits; returns its exit code and how long it ran (ms). */
  async waitExit(timeoutMs = 60_000): Promise<{ exitCode: number; ranMs: number }> {
    const state = await pollUntil(
      async () => {
        const current = await containerState(this.container)
        return current.running ? undefined : current
      },
      timeoutMs,
      async () => `${this.container} is still running after ${timeoutMs / 1000} s:\n${(await this.logs()).slice(-4000)}`,
    )
    return { exitCode: state.exitCode, ranMs: Date.parse(state.finishedAt) - Date.parse(state.startedAt) }
  }

  /** The setup token of the latest `[setup] no users exist` line (one per boot). */
  async setupTokens(): Promise<string[]> {
    const tokens: string[] = []
    for (const line of await this.logLines()) {
      const match = /\[setup\] no users exist; open (\S+)\/setup\?token=(sst_[A-Za-z0-9_-]+) to create the first admin/.exec(line.msg ?? '')
      if (match) tokens.push(match[2]!)
    }
    return tokens
  }

  async waitForSetupToken(timeoutMs = 60_000): Promise<string> {
    await this.waitForLog((line) => (line.msg ?? '').startsWith('[setup] no users exist'), timeoutMs)
    return (await this.setupTokens()).at(-1)!
  }

  /**
   * A request context on this orchestrator that sends the public origin as Origin (better-auth and CSRF need it). Its
   * timeout is above the API's longest `wait` (120 s), so long polls are never cut short (Playwright's default is 30 s).
   */
  async context(headers: Record<string, string> = {}): Promise<APIRequestContext> {
    const context = await request.newContext({ baseURL: this.baseUrl, extraHTTPHeaders: { Origin: this.publicUrl, ...headers }, timeout: 150_000 })
    this.contexts.push(context)
    return context
  }

  /** An ApiClient (operations resolved through the stack's OpenAPI document) on this orchestrator. */
  async api(openapi: OpenApiIndex, headers: Record<string, string> = {}): Promise<ApiClient> {
    return new ApiClient(await this.context(headers), openapi)
  }

  private async closeContexts(): Promise<void> {
    const contexts = this.contexts
    this.contexts = []
    for (const context of contexts) await context.dispose()
  }

  /** Removes the container and, unless it was passed in, its infrastructure. */
  async dispose(): Promise<void> {
    await this.closeContexts()
    if (!this.disposed) await removeContainers([this.container])
    this.disposed = true
    if (this.ownsInfra) await this.infra?.dispose()
  }
}
