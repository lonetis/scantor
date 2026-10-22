import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { PassThrough } from 'node:stream'
import Docker from 'dockerode'
import { type Config, parseConfig, setConfigForTesting } from '../../../server/utils/config'
import { useLogger } from '../../../server/utils/logger'
import { closeMongo, connectMongo, ensureIndexes, useMongo } from '../../../server/utils/mongo'

/*
 * Harness of the node, runtime and registry integration tests: throwaway infrastructure containers (MongoDB replica
 * set, RustFS, registry) next to the test process. The tests run only where they can: Linux, inside a container
 * (whose name prefixes every container they create) on a user-defined network, with the Docker socket mounted. They
 * never pull images. From the repository root, with Linux node_modules in a volume:
 *
 *   docker network create scantor-test-net
 *   docker run --rm --name scantor-test-node-it --network scantor-test-net \
 *     -v "$PWD":/src:ro -v scantor-test-node-modules:/src/orchestrator/node_modules -w /src/orchestrator \
 *     -v /var/run/docker.sock:/var/run/docker.sock node:26.12.1-trixie-slim \
 *     npx --no-install vitest run test/services/nodes test/services/runtime test/services/registry
 *
 * (the node_modules volume filled once with `npm ci --ignore-scripts` in the same container layout).
 */

export const DOCKER_SOCKET = '/var/run/docker.sock'
export const MONGO_IMAGE = 'mongo:9.0.4'
export const RUSTFS_IMAGE = 'rustfs/rustfs:1.0.3'
export const REGISTRY_IMAGE = 'registry:3.1.2'
export const ALPINE_IMAGE = 'alpine:3.24'
/** the image of the loopback forwarder (the test runner's own image, so it is present) */
export const NODE_IMAGE = 'node:26.12.1-trixie-slim'

/** Linux, inside a container, with the Docker socket mounted. */
export const integrationEnabled = process.platform === 'linux' && existsSync('/.dockerenv') && existsSync(DOCKER_SOCKET)

export interface Environment {
  docker: Docker
  /** this container's name; containers the tests create are named after it */
  ownName: string
  /** the network this container is attached to; created containers join it */
  network: string
  /** this container's address on that network (reachable from the Docker daemon) */
  ownAddress: string
  /** the network's gateway: the Docker host as seen from this container (reaches host-network containers) */
  gateway: string
}

export async function discoverEnvironment(): Promise<Environment> {
  const docker = new Docker({ socketPath: DOCKER_SOCKET })
  const self = await docker.getContainer(hostname()).inspect()
  const networks = Object.entries(self.NetworkSettings.Networks).filter(([name]) => !['bridge', 'host', 'none'].includes(name))
  const [network, endpoint] = networks[0] ?? []
  if (!network || !endpoint?.IPAddress || !endpoint.Gateway) throw new Error('run the integration tests in a container attached to a user-defined network')
  return { docker, ownName: self.Name.replace(/^\//, ''), network, ownAddress: endpoint.IPAddress, gateway: endpoint.Gateway }
}

export async function requireImages(docker: Docker, images: readonly string[]): Promise<void> {
  for (const image of images) {
    try {
      await docker.getImage(image).inspect()
    } catch {
      throw new Error(`pull ${image} before running this test (the integration tests never pull)`)
    }
  }
}

export async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false>, timeoutMs = 60_000, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  for (;;) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${lastError ? `: ${(lastError as Error).message}` : ''}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

export interface RunningContainer {
  name: string
  /** address on the shared network (empty for host-network containers: use the environment's gateway) */
  address: string
  container: Docker.Container
}

/** Containers of one test file, removed together. */
export class TestContainers {
  private readonly created: Docker.Container[] = []

  constructor(readonly env: Environment) {}

  nameOf(suffix: string): string {
    return `${this.env.ownName}-${suffix}`
  }

  async run(suffix: string, options: Docker.ContainerCreateOptions): Promise<RunningContainer> {
    const name = this.nameOf(suffix)
    await this.env.docker.getContainer(name).remove({ force: true, v: true }).catch(() => undefined)
    const container = await this.env.docker.createContainer({
      ...options,
      name,
      Labels: { ...options.Labels, 'scantor.test': 'true' },
      HostConfig: { NetworkMode: this.env.network, ...options.HostConfig },
    })
    this.created.push(container)
    await container.start()
    if (options.HostConfig?.NetworkMode === 'host') return { name, address: '', container }
    const inspected = await container.inspect()
    const address = inspected.NetworkSettings.Networks[this.env.network]?.IPAddress
    if (!address) throw new Error(`container ${name} has no address on ${this.env.network}`)
    return { name, address, container }
  }

  async removeAll(): Promise<void> {
    for (const container of this.created.splice(0).reverse()) await container.remove({ force: true, v: true }).catch(() => undefined)
  }
}

/** Runs a command in a container and returns its exit code and combined output. */
export async function execIn(docker: Docker, container: Docker.Container, cmd: string[]): Promise<{ exitCode: number | null; output: string }> {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true })
  const stream = await exec.start({ hijack: true, stdin: false })
  const sink = new PassThrough()
  let output = ''
  sink.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })
  docker.modem.demuxStream(stream, sink, sink)
  await new Promise<void>((resolve, reject) => {
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  return { exitCode: (await exec.inspect()).ExitCode ?? null, output }
}

export interface MongoInstance {
  url: string
  user: string
  password: string
}

/** A single-node replica set `rs0` with a keyFile and a root user, as in docker-compose.prod.yml. */
export async function startMongo(containers: TestContainers, suffix = 'mongo'): Promise<MongoInstance> {
  const user = 'scantor'
  const password = 'mongo-integration-test'
  const mongo = await containers.run(suffix, {
    Image: MONGO_IMAGE,
    Entrypoint: [
      'bash',
      '-c',
      'set -euo pipefail; openssl rand -base64 756 > /tmp/kf; chmod 400 /tmp/kf; chown mongodb:mongodb /tmp/kf; exec docker-entrypoint.sh "$@"',
      'mongo-entrypoint',
    ],
    Cmd: ['mongod', '--replSet', 'rs0', '--keyFile', '/tmp/kf', '--noscripting', '--bind_ip_all', '--wiredTigerCacheSizeGB', '0.25'],
    Env: [`MONGO_INITDB_ROOT_USERNAME=${user}`, `MONGO_INITDB_ROOT_PASSWORD=${password}`],
  })
  const initiate = `try { rs.status().ok } catch (e) { rs.initiate({_id: 'rs0', members: [{_id: 0, host: '${mongo.name}:27017'}]}).ok }`
  await waitFor(
    'the MongoDB replica set',
    async () => {
      const result = await execIn(containers.env.docker, mongo.container, ['mongosh', '--quiet', '-u', user, '-p', password, '--authenticationDatabase', 'admin', '--eval', initiate])
      if (result.exitCode !== 0) return false
      const primary = await execIn(containers.env.docker, mongo.container, ['mongosh', '--quiet', '-u', user, '-p', password, '--authenticationDatabase', 'admin', '--eval', 'db.hello().isWritablePrimary'])
      return primary.output.trim() === 'true'
    },
    120_000,
    1000,
  )
  return { url: `mongodb://${mongo.name}:27017/?replicaSet=rs0&authSource=admin`, user, password }
}

export interface RustfsInstance {
  url: string
  accessKey: string
  secretKey: string
}

export async function startRustfs(containers: TestContainers, suffix = 'rustfs'): Promise<RustfsInstance> {
  const accessKey = 'scantor'
  const secretKey = 'rustfs-integration-test'
  const rustfs = await containers.run(suffix, {
    Image: RUSTFS_IMAGE,
    Env: [`RUSTFS_ACCESS_KEY=${accessKey}`, `RUSTFS_SECRET_KEY=${secretKey}`, 'RUSTFS_OBS_LOG_DIRECTORY=', 'RUSTFS_CHECK_UPDATE=false'],
  })
  const url = `http://${rustfs.name}:9000`
  await waitFor('RustFS', async () => (await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(2000) })).ok, 60_000, 500)
  return { url, accessKey, secretKey }
}

/**
 * A TCP forwarder in the Docker host's network namespace: `127.0.0.1:<port>` there forwards to `target`. The Docker
 * daemon reaches loopback directly, never through an HTTP proxy (Docker Desktop proxies every other address through
 * the macOS host, which cannot reach container addresses), so a token realm on this container is served as
 * `http://127.0.0.1:<port>`.
 */
export async function startLoopbackForwarder(containers: TestContainers, suffix: string, target: { host: string; port: number }): Promise<number> {
  const port = 40_000 + Math.floor(Math.random() * 10_000)
  const script = [
    "const net = require('node:net')",
    'net.createServer((client) => {',
    `  const upstream = net.connect(${target.port}, ${JSON.stringify(target.host)})`,
    '  client.pipe(upstream).pipe(client)',
    '  client.on("error", () => upstream.destroy())',
    '  upstream.on("error", () => client.destroy())',
    `}).listen(${port}, '127.0.0.1')`,
  ].join('\n')
  const forwarder = await containers.run(suffix, { Image: NODE_IMAGE, Cmd: ['node', '-e', script], HostConfig: { NetworkMode: 'host' } })
  const probe = `require('node:net').connect(${port}, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))`
  await waitFor('the loopback forwarder', async () => (await execIn(containers.env.docker, forwarder.container, ['node', '-e', probe])).exitCode === 0, 30_000, 250)
  return port
}

/** Points the orchestrator configuration at the test database (and further variables) and connects MongoDB. */
export async function connectIntegrationDatabase(mongo: MongoInstance, env: Record<string, string> = {}): Promise<Config> {
  const { config } = parseConfig({
    SCANTOR_SECRET: 'integration test secret of the node, runtime and registry areas',
    SCANTOR_MONGO_URL: mongo.url,
    SCANTOR_MONGO_USER: mongo.user,
    SCANTOR_MONGO_PASSWORD: mongo.password,
    SCANTOR_MONGO_DB: 'scantor_it',
    ...env,
  })
  setConfigForTesting(config)
  await connectMongo({ timeoutMs: 60_000, log: useLogger('mongo') })
  await ensureIndexes(useMongo().db, config)
  return config
}

export async function disconnectIntegrationDatabase(): Promise<void> {
  await closeMongo()
  setConfigForTesting(null)
}
