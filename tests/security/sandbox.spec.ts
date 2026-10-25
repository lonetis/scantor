import { randomBytes, randomUUID } from 'node:crypto'
import { request as playwrightRequest } from '@playwright/test'
import type { Analysis } from '#shared/types/analyses'
import type { Node, NodeWithToken } from '#shared/types/nodes'
import type { Revision } from '#shared/types/revisions'
import type { TestRun } from '#shared/types/test-runs'
import type { Worker } from '#shared/types/workers'
import { ok, type ApiClient } from '../helpers/api-client'
import { CONTAINERS, docker, stackEnv } from '../helpers/docker'
import { stackKeys } from '../helpers/keys'
import { startScan, waitForScanState } from '../helpers/scans'
import {
  captureContainers,
  containerExists,
  containerImage,
  copyImageInto,
  imageEnv,
  inspectWorker,
  pollFor,
  sha256Hex,
  waitForRunningWorker,
  type ContainerInspect,
  type WorkerInspect,
} from '../helpers/security'
import { METADATA_BUILD_TASK, PROBE_MARKERS, PROBE_TASK, removeTaskDir, writeTaskDir } from '../helpers/security-tasks'
import { uploadAndPublish } from '../helpers/tasks'
import { requestScanDeletion, withSecurityTenants } from '../helpers/security-tenants'
import { expect, test as base, unique } from '../fixtures'

// The tenant fixtures of the security specs (helpers/security-tenants.ts).
const test = withSecurityTenants(base)

// The worker sandbox (docs/security.md §6.8 SB-1…SB-6, §6.2 BLD-10/BLD-11, §6.3 WS-2, §6.10 GUI-4/GUI-6; docs/nodes.md
// §6.3, §6.8, §9): the container specs of workers, describe/check, test-run and helper containers as Docker sees them,
// what master and remote workers can reach (the netprobe fixture), the egress deny list, worker logs, and what the
// node daemon refuses to touch. Every container a test creates itself carries scantor.test=true and is removed.

const MANAGED = { 'traefik.enable': 'false', 'com.docker.compose.project': 'scantor-managed', 'com.docker.compose.service': '', 'scantor.managed': 'true' }
const MiB = 1024 * 1024
/** A worker that stays up: the probe task's mode `hang` sleeps past its analysis timeout. */
const HANG = {
  taskConfig: { mode: 'hang' },
  settings: { workers: 1, processes: 1, resources: { cpus: 0.25, memoryMiB: 256 }, timeoutMs: 170_000, maxAttempts: 1 },
}
const REMOTE = { nodeSelector: { pool: 'remote', labels: {} } }

interface ProbeResult {
  reachable: Record<string, boolean>
  errors: Record<string, string>
  env: string[]
}

const caCert = () => (stackEnv().SCANTOR_CA_CERT ?? '').replace(/^"|"$/g, '').replaceAll('\\n', '\n').trim()

/** Name → value of a container's Env list. */
const envMap = (env: string[] | null) =>
  Object.fromEntries((env ?? []).map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]))

/** The hardening profile of docs/nodes.md §6.3 (SB-1) for a 1 × 0.25 CPU × 256 MiB worker. */
function expectWorkerProfile(inspect: WorkerInspect, network: string): void {
  const host = inspect.HostConfig
  expect(inspect.Config.Entrypoint).toEqual(['/scantor/scantor', 'runtime', 'worker'])
  expect(inspect.Config.Cmd ?? []).toEqual([])
  expect(host.Init).toBe(true)
  expect(host.RestartPolicy.Name).toBe('no')
  expect(host.CapDrop).toEqual(['ALL'])
  for (const capability of host.CapAdd ?? []) expect(['NET_BIND_SERVICE', 'NET_RAW', 'CAP_NET_BIND_SERVICE', 'CAP_NET_RAW']).toContain(capability)
  expect(host.SecurityOpt).toContain('no-new-privileges:true')
  expect((host.SecurityOpt ?? []).filter((opt) => /unconfined/.test(opt))).toEqual([])
  expect(host.Privileged).toBe(false)
  expect(host.ReadonlyRootfs).toBe(false)
  expect(host.PidsLimit).toBe(4096)
  expect(host.Memory).toBe(256 * MiB + 256 * MiB)
  expect(host.MemorySwap).toBe(host.Memory)
  expect(host.NanoCpus).toBe(250_000_000)
  expect(host.ShmSize).toBe(256 * MiB)
  expect(host.Ulimits).toEqual([{ Name: 'nofile', Soft: 65536, Hard: 65536 }])
  expect(host.LogConfig.Type).toBe('local')
  expect(host.LogConfig.Config).toMatchObject({ 'max-file': '3' })
  expect(host.LogConfig.Config['max-size']).toBeTruthy()
  expect(host.Binds ?? []).toEqual([])
  expect(inspect.Mounts).toEqual([])
  expect(host.Tmpfs ?? {}).toEqual({})
  expect(Object.keys(host.PortBindings ?? {})).toEqual([])
  expect(host.PublishAllPorts).toBe(false)
  expect(host.NetworkMode).toBe(network)
  expect(Object.keys(inspect.NetworkSettings.Networks)).toEqual([network])
}

function expectManagedLabels(labels: Record<string, string>, kind: string, identity: Record<string, string> = {}): void {
  expect(labels).toMatchObject({ ...MANAGED, 'scantor.kind': kind, ...identity })
}

/** Runs netprobe once (template single) on the given nodes and returns its result. */
async function probe(
  api: ApiClient,
  revision: Revision,
  taskConfig: Record<string, unknown>,
  settings: Record<string, unknown> = {},
): Promise<{ scanId: string; result: ProbeResult }> {
  const scan = await startScan(api, {
    revision: revision.ref,
    taskConfig,
    settings: { workers: 1, processes: 1, resources: { cpus: 0.25, memoryMiB: 256 }, ...settings },
  })
  try {
    await waitForScanState(api, scan.id, 'completed', 150_000)
    const [analysis] = ok(await api.call<{ items: Analysis[] }>('listAnalyses', { path: { scanId: scan.id } }), 'listAnalyses').items
    expect(analysis!.status, JSON.stringify(analysis)).toBe('succeeded')
    return { scanId: scan.id, result: analysis!.result as unknown as ProbeResult }
  } finally {
    await requestScanDeletion(api, scan.id)
  }
}

async function ipOn(container: string, network: string): Promise<string> {
  return (await docker(['inspect', '--format', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, container])).stdout.trim()
}

test.describe('worker containers', () => {
  test(
    'a worker on the built-in node runs with the hardening profile on scantor-sandbox, with only its assignment environment',
    { tag: ['@NODE-021', '@NODE-022', '@NODE-023', '@SEC-007'] },
    async ({ api, user, shared, scans }) => {
      test.setTimeout(180_000)
      const { revision } = await shared.probe()
      const scan = await scans.start({ revision: revision.ref, ...HANG })
      const worker = await waitForRunningWorker(api, scan.id, 'runner')
      const inspect = await inspectWorker(worker.id, 'builtin')

      expect(inspect.Name).toBe(`/scantor-w-${worker.id}`)
      expectWorkerProfile(inspect, 'scantor-sandbox')
      expectManagedLabels(inspect.Config.Labels, 'worker', {
        'scantor.worker': worker.id,
        'scantor.scan': scan.id,
        'scantor.user': user.id,
        'scantor.node': worker.nodeId!,
      })
      expect(inspect.Config.Labels['scantor.spec-hash']).toMatch(/^sha256:[0-9a-f]{64}$/)

      // The environment: the image's own variables plus exactly the assignment's and the daemon's CA.
      const image = envMap(await imageEnv(inspect.Config.Image))
      const added = Object.entries(envMap(inspect.Config.Env)).filter(([name, value]) => image[name] !== value)
      const daemon = envMap((await docker(['inspect', '--format', '{{json .Config.Env}}', CONTAINERS.node]).then((r) => JSON.parse(r.stdout))) as string[])
      // The daemon adds SCANTOR_CA_CERT and SCANTOR_ALLOW_INSECURE_TRANSPORT only when it has them itself (the built-in
      // node talks to the orchestrator inside the stack and has neither).
      const expected = [
        'SCANTOR_URL',
        'SCANTOR_WORKER_TOKEN',
        ...(daemon.SCANTOR_CA_CERT ? ['SCANTOR_CA_CERT'] : []),
        ...(daemon.SCANTOR_ALLOW_INSECURE_TRANSPORT === 'true' ? ['SCANTOR_ALLOW_INSECURE_TRANSPORT'] : []),
      ]
      expect(added.map(([name]) => name).sort()).toEqual(expected.sort())
      const env = Object.fromEntries(added)
      expect(env.SCANTOR_URL).toBe(daemon.SCANTOR_URL)
      expect(env.SCANTOR_WORKER_TOKEN).toBe(stackKeys().workerToken({ workerId: worker.id, scanId: scan.id, role: 'runner', nodeId: worker.nodeId! }))
    },
  )

  test(
    'a worker on a remote node joins scantor-workers, where workers of other scans cannot reach it',
    { tag: ['@NODE-021', '@NODE-022', '@NODE-023', '@SEC-007', '@SEC-016'] },
    async ({ api, user, shared, scans }) => {
      test.setTimeout(180_000)
      const [probeTask, netprobe] = await Promise.all([shared.probe(), shared.fixture('netprobe')])
      const scan = await scans.start({ revision: probeTask.revision.ref, ...HANG, settings: { ...HANG.settings, ...REMOTE } })
      const worker = await waitForRunningWorker(api, scan.id, 'runner', 150_000)
      expect(worker.node?.name).toBe('remote-1')
      const inspect = await inspectWorker(worker.id, 'remote')
      expectWorkerProfile(inspect, 'scantor-workers')
      expectManagedLabels(inspect.Config.Labels, 'worker', {
        'scantor.worker': worker.id,
        'scantor.scan': scan.id,
        'scantor.user': user.id,
        'scantor.node': worker.nodeId!,
      })
      const image = envMap(await imageEnv(inspect.Config.Image, 'remote'))
      const added = Object.entries(envMap(inspect.Config.Env)).filter(([name, value]) => image[name] !== value)
      expect(added.map(([name]) => name).sort()).toEqual(['SCANTOR_CA_CERT', 'SCANTOR_URL', 'SCANTOR_WORKER_TOKEN'])
      expect(Object.fromEntries(added).SCANTOR_URL).toBe(stackEnv().SCANTOR_PUBLIC_URL)
      // The daemon's CA is passed on unchanged, so the worker verifies TLS with the test CA (never disabled).
      expect(Object.fromEntries(added).SCANTOR_CA_CERT!.replaceAll('\\n', '\n').trim()).toBe(caCert())

      // The node-created network: no inter-container traffic, managed labels.
      const network = JSON.parse((await docker(['exec', CONTAINERS.remoteNode, 'docker', 'network', 'inspect', 'scantor-workers'])).stdout)[0] as {
        Options: Record<string, string>
        Labels: Record<string, string>
      }
      expect(network.Options['com.docker.network.bridge.enable_icc']).toBe('false')
      expectManagedLabels(network.Labels, 'network')

      // A worker of another scan on the same node cannot open a connection to it: packets are dropped (a timeout),
      // not refused by a reachable host.
      const target = (inspect.NetworkSettings.Networks['scantor-workers'] as { IPAddress: string }).IPAddress
      const { result } = await probe(api, netprobe.revision, { targets: [`${target}:9`], timeout_seconds: 5 }, REMOTE)
      expect(result.reachable[`${target}:9`]).toBe(false)
      expect(result.errors[`${target}:9`]).toMatch(/timed out/i)
    },
  )

  test('connector processes never see the worker token, the platform URL or the CA', { tag: ['@RT-006'] }, async ({ api, shared }) => {
    test.setTimeout(180_000)
    const { revision } = await shared.fixture('netprobe')
    const probes = await Promise.all([{}, REMOTE].map(async (settings) => ({ settings, ...(await probe(api, revision, { mode: 'env' }, settings)) })))
    for (const { settings, result } of probes) {
      for (const hidden of ['SCANTOR_WORKER_TOKEN', 'SCANTOR_URL', 'SCANTOR_CA_CERT', 'SCANTOR_ALLOW_INSECURE_TRANSPORT', 'SCANTOR_DIND']) {
        expect(result.env, `${JSON.stringify(settings)}: ${hidden}`).not.toContain(hidden)
      }
      expect(result.env).toEqual(expect.arrayContaining(['TMPDIR', 'SCANTOR_PROTOCOL_IN_FD', 'SCANTOR_PROTOCOL_OUT_FD']))
    }
  })
})

test.describe('reachability', () => {
  test(
    'master workers cannot reach MongoDB, the registry or mongo-express, by name, address or published port',
    { tag: ['@SEC-010'] },
    async ({ api, shared }) => {
      test.setTimeout(180_000)
      const { revision } = await shared.fixture('netprobe')
      const sandboxGateway = (await docker(['network', 'inspect', '--format', '{{(index .IPAM.Config 0).Gateway}}', 'scantor-sandbox'])).stdout.trim()
      const forbidden = [
        'mongo:27017',
        'registry:5000',
        'mongo-express:8081',
        // RabbitMQ's Prometheus endpoint would answer without credentials (per-queue series of every scan).
        'rabbitmq:15692',
        `${await ipOn(CONTAINERS.mongo, 'scantor')}:27017`,
        `${await ipOn(CONTAINERS.registry, 'scantor')}:5000`,
        `${await ipOn(CONTAINERS.mongoExpress, 'scantor')}:8081`,
        // the host ports published on the loopback bind addresses, tried through the bridge gateways
        `${sandboxGateway}:5000`,
        `${sandboxGateway}:27017`,
        `${sandboxGateway}:8081`,
        '172.17.0.1:5000',
        '172.17.0.1:27017',
      ]
      // What master workers need: the orchestrator, AMQP and the object store.
      const allowed = ['orchestrator:3000', 'rabbitmq:5672', 'rustfs:9000']
      const { result } = await probe(api, revision, { targets: [...forbidden, ...allowed], timeout_seconds: 3 })
      for (const target of forbidden) expect.soft(result.reachable[target], `${target} is reachable`).toBe(false)
      for (const target of allowed) expect.soft(result.reachable[target], `${target}: ${result.errors[target]}`).toBe(true)
    },
  )

  test(
    'the RabbitMQ management API rejects the scan user and accepts the admin; the object store answers only signed requests',
    { tag: ['@SEC-010', '@TOOLS-004'] },
    async ({ env, api, shared, scans }) => {
      test.setTimeout(180_000)
      const { revision } = await shared.probe()
      const scan = await scans.start({ revision: revision.ref, ...HANG })
      await waitForRunningWorker(api, scan.id, 'runner')
      const stack = stackEnv()
      const image = await containerImage(CONTAINERS.node)
      // From the workers' own network, as a master worker would call it.
      const whoami = async (user: string, password: string) => {
        const auth = Buffer.from(`${user}:${password}`).toString('base64')
        const result = await docker(
          [
            'run',
            '--rm',
            '--name',
            unique('scantor-test-mgmt'),
            '--label',
            'scantor.test=true',
            '--network',
            'scantor-sandbox',
            '--entrypoint',
            'sh',
            image,
            '-c',
            `wget -q -S -O - --header "Authorization: Basic ${auth}" http://rabbitmq:15672/api/whoami 2>&1; true`,
          ],
          { timeoutMs: 60_000 },
        )
        return result.stdout
      }
      expect(await whoami(`scan-${scan.id}`, stackKeys().amqpPassword(scan.id))).toMatch(/401 Unauthorized/)
      expect(await whoami(stack.SCANTOR_RABBITMQ_USER!, stack.SCANTOR_RABBITMQ_PASSWORD!)).toMatch(/"tags":\["administrator"\]/)

      // The object store: neither the bucket nor an object answers without a signature.
      const bare = await playwrightRequest.newContext({ extraHTTPHeaders: {} })
      try {
        for (const path of [`/${stack.SCANTOR_S3_BUCKET}/`, `/${stack.SCANTOR_S3_BUCKET}/?list-type=2`, `/${stack.SCANTOR_S3_BUCKET}/snapshots/`, '/']) {
          const response = await bare.get(`${stack.SCANTOR_S3_PUBLIC_URL}${path}`)
          expect(response.status(), path).toBe(403)
        }
      } finally {
        await bare.dispose()
      }
      const internal = await docker(
        [
          'run',
          '--rm',
          '--name',
          unique('scantor-test-s3'),
          '--label',
          'scantor.test=true',
          '--network',
          'scantor-sandbox',
          '--entrypoint',
          'sh',
          image,
          '-c',
          `wget -q -S -O - http://rustfs:9000/${stack.SCANTOR_S3_BUCKET}/ 2>&1; true`,
        ],
        { timeoutMs: 60_000 },
      )
      expect(internal.stdout).toMatch(/403 Forbidden/)
      expect(env.publicUrl).toBeTruthy()
    },
  )

  test('mongo-express runs read-only', { tag: ['@TOOLS-004'] }, async ({ env, adminApi, docker: inner }) => {
    const stack = stackEnv()
    expect(
      envMap(JSON.parse((await docker(['inspect', '--format', '{{json .Config.Env}}', CONTAINERS.mongoExpress])).stdout) as string[])
        .ME_CONFIG_OPTIONS_READONLY,
    ).toBe('true')
    const adminId = ok(await adminApi.getAccount(), 'getAccount').id
    const now = Math.floor(Date.now() / 1000)
    const cookie = stackKeys().toolsCookie({ iss: 'scantor', aud: 'tools', sub: adminId, role: 'admin', iat: now, exp: now + 600, jti: randomUUID() })
    const auth = `Basic ${Buffer.from(`${stack.SCANTOR_MONGO_EXPRESS_USER ?? 'admin'}:${stack.SCANTOR_MONGO_EXPRESS_PASSWORD}`).toString('base64')}`
    const database = `scantortest${randomBytes(4).toString('hex')}`
    const bare = await playwrightRequest.newContext({ extraHTTPHeaders: {} })
    try {
      const page = await bare.get(`https://mongo-express.${env.domain}/`, { headers: { Cookie: `scantor_tools=${cookie}`, Authorization: auth } })
      expect(page.status()).toBe(200)
      // mongo-express's own "Create Database" form; a read-only instance must not create anything.
      await bare.post(`https://mongo-express.${env.domain}/`, {
        headers: { Cookie: `scantor_tools=${cookie}`, Authorization: auth },
        form: { database },
        maxRedirects: 0,
      })
      const names = await inner.mongosh('print(JSON.stringify(db.getMongo().getDBNames()))', { as: 'root' })
      expect(JSON.parse(names) as string[]).not.toContain(database)
    } finally {
      await bare.dispose()
      await inner.mongosh(`db.getSiblingDB('${database}').dropDatabase()`, { as: 'root' })
    }
  })
})

test.describe('egress deny list', () => {
  test(
    'where egressDenyApplied is true the deny rules are installed and 169.254.169.254 is unreachable from workers',
    { tag: ['@NODE-034', '@SEC-009'] },
    async ({ adminApi, api, shared }) => {
      test.setTimeout(180_000)
      const nodes = ok(await adminApi.listNodes(), 'listNodes').items
      const builtin = nodes.find((node) => node.builtIn)!
      const remote = nodes.find((node) => node.name === 'remote-1')!
      const deny = envMap(
        JSON.parse((await docker(['inspect', '--format', '{{json .Config.Env}}', CONTAINERS.node])).stdout) as string[],
      ).SCANTOR_NODE_EGRESS_DENY!
      const v4 = deny.split(',').filter((cidr) => !cidr.includes(':'))
      const { revision } = await shared.fixture('netprobe')
      const metadata = '169.254.169.254:80'
      const script =
        'iptables-nft -w -S SCANTOR-EGRESS 2>/dev/null || iptables-legacy -w -S SCANTOR-EGRESS; echo ---; iptables-nft -w -S DOCKER-USER 2>/dev/null || iptables-legacy -w -S DOCKER-USER'
      const image = await containerImage(CONTAINERS.node)

      const checked = [
        [builtin, {}, 'builtin'],
        [remote, REMOTE, 'remote'],
      ] as [Node, Record<string, unknown>, 'builtin' | 'remote'][]
      await Promise.all(
        checked.map(async ([node, settings, where]) => {
          if (!node.info?.egressDenyApplied) {
            test.info().annotations.push({ type: 'warning', description: `${node.name} reports egressDenyApplied: false; the metadata check is skipped there` })
            return
          }
          // The helper's rules in the node host's network namespace.
          const rules =
            where === 'builtin'
              ? await docker([
                  ...['run', '--rm', '--name', unique('scantor-test-ipt'), '--label', 'scantor.test=true', '--network', 'host'],
                  ...['--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN', '--cap-add', 'NET_RAW', '--entrypoint', 'sh', image, '-c', script],
                ])
              : await docker([
                  'exec',
                  CONTAINERS.remoteNode,
                  'sh',
                  '-c',
                  script.replaceAll('iptables-nft', 'iptables').replaceAll('iptables-legacy', 'iptables'),
                ])
          for (const cidr of v4) expect(rules.stdout, `${node.name}: ${cidr}`).toContain(`-A SCANTOR-EGRESS -d ${cidr} -j REJECT`)
          expect(rules.stdout, node.name).toContain('-A DOCKER-USER -j SCANTOR-EGRESS')

          // Workers get the rejection at once (EHOSTUNREACH), not a timeout.
          const { result } = await probe(api, revision, { targets: [metadata], timeout_seconds: 10 }, settings)
          expect(result.reachable[metadata], node.name).toBe(false)
          expect(result.errors[metadata], node.name).toMatch(/No route to host|Errno 113|unreachable/i)
        }),
      )
    },
  )

  test('a RUN step that connects to 169.254.169.254 fails the build on the master', { tag: ['@SEC-009'] }, async ({ adminApi, api, tasks }) => {
    test.setTimeout(180_000)
    const builtin = ok(await adminApi.listNodes(), 'listNodes').items.find((node) => node.builtIn)!
    test.skip(!builtin.info?.egressDenyApplied, 'the built-in node reports egressDenyApplied: false')
    const dir = await writeTaskDir(METADATA_BUILD_TASK, 'metadata-build')
    try {
      const { task, revision } = await tasks.upload(dir, { expectState: 'failed' })
      expect(revision.errors[0]).toMatchObject({ phase: 'build' })
      const log = ok(
        await api.call<{ lines: { text?: string }[] }>('getRevisionBuildLog', { path: { task: task.name, revision: revision.id }, query: { limit: 5000 } }),
        'getRevisionBuildLog',
      )
      const text = log.lines.map((line) => line.text ?? '').join('\n')
      expect(text).toMatch(/metadata probe failed: OSError: errno=113|No route to host/)
      expect(text).not.toContain('metadata probe connected')
    } finally {
      await removeTaskDir(dir)
    }
  })
})

test.describe('short-lived containers', () => {
  test(
    'a test run runs on scantor-egress with the worker hardening profile and reaches no platform service',
    { tag: ['@TRUN-011', '@SEC-007'] },
    async ({ api, user, shared }) => {
      test.setTimeout(180_000)
      const { task } = await shared.fixture('netprobe')
      const targets = [
        'mongo:27017',
        'registry:5000',
        'rabbitmq:5672',
        'rabbitmq:15672',
        'orchestrator:3000',
        'rustfs:9000',
        'mongo-express:8081',
        '172.17.0.1:5000',
        '172.17.0.1:27017',
      ]
      let run: TestRun | undefined
      const captured = await captureContainers({ 'scantor.kind': 'testRun', 'scantor.user': user.id }, async () => {
        const started = await api.call<TestRun>('testTask', {
          path: { task: task.name },
          body: { taskConfig: { targets, timeout_seconds: 2 }, timeoutMs: 120_000 },
          query: { wait: 120 },
        })
        expect(started.status, JSON.stringify(started.body)).toBe(201)
        run = ok(await api.call<TestRun>('getTestRun', { path: { testRunId: started.body.id }, query: { wait: 120 } }), 'getTestRun')
      })
      expect(run!.state, JSON.stringify(run!.errors)).toBe('completed')
      const result = run!.analyses![0]!.result as unknown as ProbeResult
      for (const target of targets) expect.soft(result.reachable[target], `${target} is reachable from a test run`).toBe(false)

      const container = captured.find((c) => c.Name === `/scantor-t-${run!.id}`)
      expect(container, `captured: ${captured.map((c) => c.Name).join(', ')}`).toBeDefined()
      const host = container!.HostConfig
      expect(host.NetworkMode).toBe('scantor-egress')
      expect(host.CapDrop).toEqual(['ALL'])
      expect(host.SecurityOpt).toContain('no-new-privileges:true')
      expect(host.Privileged).toBe(false)
      expect(host.PidsLimit).toBe(4096)
      expect(host.Binds ?? []).toEqual([])
      expect(Object.keys(host.PortBindings ?? {})).toEqual([])
      const env = envMap(container!.Config.Env)
      for (const name of ['SCANTOR_DIND', 'SCANTOR_WORKER_TOKEN', 'SCANTOR_URL']) expect(env, name).not.toHaveProperty(name)
      expectManagedLabels(container!.Config.Labels, 'testRun', { 'scantor.user': user.id })
      await expect.poll(() => containerExists(container!.Id), { timeout: 60_000 }).toBe(false)
    },
  )

  test(
    'describe and check containers run without network, tokens or added capabilities, and are removed',
    { tag: ['@PIPE-008', '@SEC-007'] },
    async ({ tasks }) => {
      test.setTimeout(180_000)
      let published: { task: { id: string }; revision: Revision } | undefined
      const captured = await captureContainers({ 'scantor.kind': 'build' }, async () => {
        published = await tasks.fixture('netprobe')
      })
      const repository = `tasks/${published!.task.id}`
      const mine: ContainerInspect[] = []
      for (const container of captured) {
        const tags = await docker(['image', 'inspect', '--format', '{{json .RepoTags}}', container.Image], { allowFailure: true })
        if (tags.exitCode === 0 && tags.stdout.includes(repository)) mine.push(container)
      }
      const modes = mine.map((container) => container.Config.Entrypoint?.[2]).sort()
      expect(modes, `captured ${captured.length} build containers`).toEqual(['check', 'describe'])
      for (const container of mine) {
        const host = container.HostConfig
        expect(container.Name).toMatch(/^\/scantor-b-[0-9a-f-]{36}$/)
        expect(container.Config.Entrypoint!.slice(0, 2)).toEqual(['/scantor/scantor', 'runtime'])
        expect(host.NetworkMode).toBe('none')
        expect(host.CapDrop).toEqual(['ALL'])
        expect(host.CapAdd ?? []).toEqual([])
        expect(host.SecurityOpt).toContain('no-new-privileges:true')
        expect(host.Privileged).toBe(false)
        expect(host.PidsLimit).toBe(256)
        expect(host.Memory).toBeGreaterThanOrEqual(1024 * MiB)
        expect(host.Binds ?? []).toEqual([])
        expect(Object.keys(host.PortBindings ?? {})).toEqual([])
        // Only the image's own environment: no tokens, no platform URLs.
        const image = await imageEnv(container.Image)
        expect([...(container.Config.Env ?? [])].sort()).toEqual([...image].sort())
        expectManagedLabels(container.Config.Labels, 'build')
        expect(await containerExists(container.Id)).toBe(false)
      }
      expect(published!.revision.state).toBe('ready')
    },
  )

  test(
    'workspace helpers run as 1000:1000 without network, read-only, with only the user’s volume, and are removed',
    { tag: ['@WS-012', '@SEC-007'] },
    async ({ api, user, shared, docker: inner }) => {
      test.setTimeout(180_000)
      const { task } = await shared.fixture('netprobe')
      const captured = await captureContainers({ 'scantor.kind': 'helper', 'scantor.user': user.id }, async () => {
        ok(await api.call('writeTaskFiles', { path: { task: task.name }, body: { files: { 'notes.txt': 'helper probe' } } }), 'writeTaskFiles')
        ok(await api.call('getTaskWorkspace', { path: { task: task.name } }), 'getTaskWorkspace')
        ok(await api.call('readTaskFile', { path: { task: task.name }, query: { path: 'notes.txt' } }), 'readTaskFile')
      })
      const ops = new Set(captured.map((c) => c.Config.Labels['scantor.op']))
      expect([...ops]).toEqual(expect.arrayContaining(['write-files', 'snapshot', 'read']))
      for (const container of captured.filter((c) => c.Config.Labels['scantor.op'] !== 'init' && c.Config.Labels['scantor.op'] !== 'purge')) {
        const host = container.HostConfig
        const label = container.Config.Labels['scantor.op']
        expect(container.Name, label).toMatch(/^\/scantor-h-/)
        expect(container.Config.User, label).toBe('1000:1000')
        expect(host.NetworkMode, label).toBe('none')
        expect(host.ReadonlyRootfs, label).toBe(true)
        expect(host.Tmpfs?.['/tmp'] ?? '', label).toMatch(/noexec/)
        expect(host.CapDrop, label).toEqual(['ALL'])
        expect(host.CapAdd ?? [], label).toEqual([])
        expect(host.SecurityOpt, label).toContain('no-new-privileges:true')
        expect(host.Privileged, label).toBe(false)
        expect(host.Memory, label).toBeGreaterThan(0)
        expect(host.PidsLimit ?? 0, label).toBeGreaterThan(0)
        expect(host.NanoCpus, label).toBe(1_000_000_000)
        expect(host.Binds ?? [], label).toEqual([])
        const mounts = host.Mounts ?? []
        expect(mounts.length, label).toBeLessThanOrEqual(1)
        for (const mount of mounts) {
          expect(mount, label).toMatchObject({ Type: 'volume', Source: 'scantor-workspaces', Target: '/workspace', VolumeOptions: { Subpath: user.id } })
        }
        expectManagedLabels(container.Config.Labels, 'helper', { 'scantor.user': user.id })
      }
      for (const container of captured) await expect.poll(() => containerExists(container.Id), { timeout: 30_000 }).toBe(false)
      // The orchestrator itself mounts no workspace volume.
      const orchestrator = await inner.inspect<{ Mounts: { Name?: string; Source: string }[] }>(CONTAINERS.orchestrator)
      expect(orchestrator.Mounts.map((m) => m.Name ?? m.Source)).not.toContain('scantor-workspaces')
    },
  )

  test('git helpers use scantor-egress', { tag: ['@WS-012'] }, async ({ freshApi, freshUser }) => {
    test.setTimeout(180_000)
    // The fixture repository imports as the fixed task name git-single, so a fresh user (purged with the task) imports it.
    const captured = await captureContainers({ 'scantor.kind': 'helper', 'scantor.user': freshUser.id, 'scantor.op': 'git-clone' }, async () => {
      const imported = await freshApi.call('importGitTask', { body: { url: `https://git.${new URL(stackEnv().SCANTOR_PUBLIC_URL!).hostname}/single.git` } })
      expect(imported.status, JSON.stringify(imported.body)).toBe(201)
    })
    expect(captured.length).toBeGreaterThan(0)
    for (const container of captured) {
      expect(container.HostConfig.NetworkMode).toBe('scantor-egress')
      expect(container.Config.User).toBe('1000:1000')
      expect(container.HostConfig.ReadonlyRootfs).toBe(true)
      expect(container.HostConfig.CapDrop).toEqual(['ALL'])
    }
  })
})

test.describe('worker logs', () => {
  test(
    'worker logs are JSON lines with correlation ids that never carry credentials or config values',
    { tag: ['@RT-022'] },
    async ({ api, shared, scans }) => {
      test.setTimeout(180_000)
      const { revision } = await shared.probe()
      const label = `label-${randomBytes(8).toString('hex')}`
      const token = `token-${randomBytes(8).toString('hex')}`
      const scan = await scans.start({ revision: revision.ref, taskConfig: { mode: 'hang', label, token }, settings: { ...HANG.settings } })
      const worker = await waitForRunningWorker(api, scan.id, 'runner')
      let text = ''
      await pollFor(
        async () => {
          const logs = await api.call<{ text: string; pending: boolean }>('getWorkerLogs', {
            path: { scanId: scan.id, workerId: worker.id },
            query: { wait: 30 },
          })
          expect(logs.status, JSON.stringify(logs.body)).toBe(200)
          text = logs.body.text
          return text.includes(PROBE_MARKERS.stdout) && text.includes(PROBE_MARKERS.stderr) ? true : undefined
        },
        120_000,
        () => `the worker log has no connector output yet:\n${text.slice(-3000)}`,
        2000,
      )
      const lines = text.split('\n').filter((line) => line.trim() !== '')
      for (const line of lines) {
        const entry = JSON.parse(line) as Record<string, unknown>
        expect(entry, line).toMatchObject({ scanId: scan.id, workerId: worker.id, nodeId: worker.nodeId, role: 'runner' })
      }
      const output = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.msg === 'connector output')
      expect(output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ stream: 'stdout', line: PROBE_MARKERS.stdout }),
          expect.objectContaining({ stream: 'stderr', line: PROBE_MARKERS.stderr }),
        ]),
      )
      const keys = stackKeys()
      const secrets = {
        'the worker token': keys.workerToken({ workerId: worker.id, scanId: scan.id, role: 'runner', nodeId: worker.nodeId! }),
        'the AMQP password': keys.amqpPassword(scan.id),
        'a config value': label,
        'a secret config value': token,
        'a token hash': sha256Hex(token),
      }
      for (const [what, value] of Object.entries(secrets)) expect(text.includes(value), `the worker log contains ${what}`).toBe(false)
      expect(text).not.toMatch(/X-Amz-Signature=/i)
      expect(text).not.toMatch(/swt_[A-Za-z0-9_-]{20,}/)
    },
  )
})

test.describe('node daemon boundaries', () => {
  test('the daemon never touches containers it cannot attribute to itself', { tag: ['@NODE-024'] }, async ({ adminApi, freshApi, freshUser }) => {
    test.setTimeout(180_000)
    const image = await containerImage(CONTAINERS.node)
    const created: { name: string; where: 'builtin' | 'remote' }[] = []
    const run = (where: 'builtin' | 'remote', args: string[]) =>
      where === 'builtin' ? docker(args) : docker(['exec', CONTAINERS.remoteNode, 'docker', ...args])
    const remote = ok(await adminApi.listNodes(), 'listNodes').items.find((node) => node.name === 'remote-1')!
    // The fresh user may run one worker at a time, so a second scan's workers wait with known ids.
    ok(await adminApi.call('updateUser', { path: { userId: freshUser.id }, body: { maxWorkers: 1 } }), 'updateUser')
    const taskName = unique('probe')
    const probeDir = await writeTaskDir(PROBE_TASK, 'probe')
    const { revision } = await uploadAndPublish(freshApi, probeDir, taskName, { timeoutMs: 170_000 }).finally(() => removeTaskDir(probeDir))
    const scanIds: string[] = []
    try {
      // 1. Containers that look like scantor's but are not the daemon's: copied worker labels under a foreign name, and
      //    helper, build, test-run and editor containers (on the remote node, where only its daemon acts).
      const fakeLabels = (kind: string, extra: Record<string, string>) =>
        Object.entries({ ...MANAGED, 'scantor.kind': kind, ...extra }).flatMap(([k, v]) => ['--label', `${k}=${v}`])
      const fakes = [
        {
          name: unique('scantor-test-copied'),
          labels: fakeLabels('worker', { 'scantor.worker': randomUUID(), 'scantor.node': remote.id, 'scantor.scan': randomUUID() }),
        },
        { name: `scantor-h-${randomUUID()}`, labels: fakeLabels('helper', { 'scantor.node': remote.id }) },
        { name: `scantor-b-${randomUUID()}`, labels: fakeLabels('build', { 'scantor.node': remote.id }) },
        { name: `scantor-t-${randomUUID()}`, labels: fakeLabels('testRun', { 'scantor.node': remote.id }) },
        { name: `scantor-editor-${randomUUID()}`, labels: fakeLabels('editor', { 'scantor.node': remote.id }) },
      ]
      for (const fake of fakes) {
        await run('remote', [
          'run',
          '-d',
          '--name',
          fake.name,
          '--label',
          'scantor.test=true',
          ...fake.labels,
          '--network',
          'none',
          '--entrypoint',
          'sleep',
          image,
          '3600',
        ])
        created.push({ name: fake.name, where: 'remote' })
      }

      // 2. A first scan occupies the user's only slot (on the remote node, so its daemon reconciles after the fakes exist).
      const first = await startScan(freshApi, { revision: revision.ref, ...HANG, settings: { ...HANG.settings, ...REMOTE } })
      scanIds.push(first.id)
      await waitForRunningWorker(freshApi, first.id, 'runner', 150_000)
      for (const fake of fakes) expect(await containerExists(fake.name, 'remote'), `${fake.name} was touched`).toBe(true)

      // 3. A second scan waits for the slot; its scheduler's container name is taken by a foreign container on the
      //    built-in node before the scheduler is placed there.
      const second = await startScan(freshApi, { revision: revision.ref, ...HANG })
      scanIds.push(second.id)
      const pending = await pollFor(
        async () => ok(await freshApi.listScanWorkers(second.id), 'listScanWorkers').items.find((w: Worker) => w.state === 'pending'),
        60_000,
        () => 'the second scan has no pending worker',
      )
      const squatter = `scantor-w-${pending.id}`
      await run('builtin', ['create', '--name', squatter, '--label', 'scantor.test=true', '--network', 'none', '--entrypoint', 'sleep', image, '3600'])
      created.push({ name: squatter, where: 'builtin' })
      ok(await freshApi.cancelScan(first.id), 'cancelScan')

      const failed = await pollFor(
        async () => {
          const worker = ok(await freshApi.listScanWorkers(second.id), 'listScanWorkers').items.find((w: Worker) => w.id === pending.id)
          return worker?.stateReason?.code === 'createFailed' ? worker : undefined
        },
        120_000,
        async () =>
          `no createFailed for ${pending.id}: ${JSON.stringify(ok(await freshApi.listScanWorkers(second.id), 'listScanWorkers').items.map((w: Worker) => [w.id, w.state, w.stateReason, w.node?.name]))}`,
        2000,
      )
      expect(failed.stateReason!.message).toContain('name conflict with a foreign container')
      expect(failed.node?.name).toBe('builtin')
      // The foreign container is never removed, renamed or started.
      const squat = JSON.parse((await docker(['inspect', squatter])).stdout)[0] as { Config: { Labels: Record<string, string> }; State: { Status: string } }
      expect(squat.Config.Labels['scantor.test']).toBe('true')
      expect(squat.State.Status).toBe('created')
      for (const fake of fakes) expect(await containerExists(fake.name, 'remote'), `${fake.name} was touched`).toBe(true)
    } finally {
      // The fresh user's purge removes its scans and task; the test's own containers go now.
      for (const scanId of scanIds) await requestScanDeletion(freshApi, scanId)
      for (const { name, where } of created) await run(where, ['rm', '-f', name])
    }
  })

  test(
    'a node daemon connects only with the CA of SCANTOR_CA_CERT, then runs its one-shot egress helper on the host network with NET_ADMIN and NET_RAW only',
    { tag: ['@SEC-016', '@NODE-034', '@SEC-007'] },
    async ({ adminApi }) => {
      test.setTimeout(180_000)
      // A node of its own in a pool no scan selects, its daemon inside a private Docker engine (a DinD like the remote
      // node: the daemon runs inside the engine it controls, so its self-inspection and egress helper work).
      const created = ok(await adminApi.createNode({ name: unique('egress'), pool: unique('isolated') }), 'createNode') as NodeWithToken
      const dind = unique('scantor-test-node-dind')
      const image = await containerImage(CONTAINERS.node)
      const getNode = async () => ok(await adminApi.call<Node>('getNode', { path: { nodeId: created.node.id } }), 'getNode')
      try {
        await docker([
          ...['run', '-d', '--privileged', '--name', dind, '--label', 'scantor.test=true', '--network', 'scantor', '-e', 'DOCKER_TLS_CERTDIR='],
          await containerImage(CONTAINERS.remoteNode),
          ...['dockerd', '--host=unix:///var/run/docker.sock', '--host=tcp://0.0.0.0:2375', '--tls=false', '--dns=172.17.0.1'],
          ...['--bip=10.42.0.1/24', '--default-address-pool=base=10.43.0.0/16,size=24'],
        ])
        const engine = ['-H', `tcp://${await ipOn(dind, 'scantor')}:2375`]
        await pollFor(
          async () => ((await docker([...engine, 'version'], { allowFailure: true })).exitCode === 0 ? true : undefined),
          60_000,
          () => 'the private Docker engine did not start',
          250,
        )
        await copyImageInto(image, dind)
        // The join command of createNode (docs/nodes.md §4), optionally with the CA.
        const daemon = (name: string, extra: string[]) =>
          docker([
            ...[...engine, 'run', '-d', '--name', name, '-v', '/var/run/docker.sock:/var/run/docker.sock'],
            ...['-e', `SCANTOR_URL=${created.join.env.SCANTOR_URL}`, '-e', `SCANTOR_NODE_TOKEN=${created.token}`, ...extra, image, 'node'],
          ])

        // Without the test CA the TLS verification fails; the token is never logged.
        await daemon('scantor-node-noca', [])
        const logs = await pollFor(
          async () => {
            const { stdout, stderr } = await docker([...engine, 'logs', 'scantor-node-noca'], { allowFailure: true })
            return /x509|certificate signed by unknown authority|tls: failed to verify/i.test(stdout + stderr) ? stdout + stderr : undefined
          },
          60_000,
          async () =>
            `the daemon did not report a TLS verification failure:\n${(await docker([...engine, 'logs', 'scantor-node-noca'], { allowFailure: true })).stderr.slice(-3000)}`,
          500,
        )
        expect(logs).not.toContain(created.token)
        const unconnected = await getNode()
        expect(unconnected.state).not.toBe('online')
        expect(unconnected.lastSeenAt ?? null).toBeNull()
        await docker([...engine, 'rm', '-f', 'scantor-node-noca'])

        // With SCANTOR_CA_CERT it connects, and its session starts by running the egress helper.
        const helpers = await captureContainers(
          { 'scantor.kind': 'egressHelper' },
          async () => {
            await daemon('scantor-node', ['-e', `SCANTOR_CA_CERT=${caCert()}`])
            await expect.poll(async () => (await getNode()).state, { timeout: 60_000 }).toBe('online')
            await expect.poll(async () => (await getNode()).info?.egressDenyApplied, { timeout: 60_000 }).toBe(true)
          },
          { engine },
        )
        expect(helpers.length, 'the egress helper was created').toBeGreaterThan(0)
        const helper = helpers[0]!
        expect(helper.Name).toBe(`/scantor-netpol-${created.node.id}`)
        expect(helper.Config.Cmd?.slice(0, 2)).toEqual(['node', 'egress-apply'])
        expectManagedLabels(helper.Config.Labels, 'egressHelper', { 'scantor.node': created.node.id })
        expect(helper.HostConfig.NetworkMode).toBe('host')
        expect(helper.HostConfig.CapDrop).toEqual(['ALL'])
        // Docker reports capabilities with or without the CAP_ prefix, depending on the engine version.
        expect((helper.HostConfig.CapAdd ?? []).map((cap) => cap.replace(/^CAP_/, '')).sort()).toEqual(['NET_ADMIN', 'NET_RAW'])
        expect(helper.HostConfig.SecurityOpt).toContain('no-new-privileges:true')
        expect(helper.HostConfig.ReadonlyRootfs).toBe(true)
        expect(helper.HostConfig.Privileged).toBe(false)
        // One-shot: removed once it has run.
        await expect.poll(() => docker([...engine, 'inspect', helper.Id], { allowFailure: true }).then((r) => r.exitCode), { timeout: 30_000 }).not.toBe(0)
      } finally {
        await docker(['rm', '-fv', dind], { allowFailure: true })
        await adminApi.deleteNode(created.node.id)
      }
    },
  )
})
