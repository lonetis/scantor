import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Analysis } from '#shared/types/analyses'
import type { Page } from '#shared/types/common'
import type { Scan } from '#shared/types/scans'
import type { Script, ScriptRun, ScriptRunLogsPage } from '#shared/types/scripts'
import { ok, type ApiClient } from '../helpers/api-client'
import { CONTAINERS, docker, stackEnv } from '../helpers/docker'
import { RUNTIME_HEALTHCHECK, type WorkerInspect } from '../helpers/security'
import {
  cancelScriptRunIfActive,
  createScriptWithFiles,
  fetchFromScriptsNetwork,
  probeScriptFiles,
  scriptRunContainer,
  scriptRunContainers,
  scriptRunToken,
  SCRIPTS_NETWORK,
  startScriptRun,
  waitForRunningScriptRun,
  waitForScriptRun,
  type ProbeConfig,
  type ProbeResult,
  type ProbeTarget,
} from '../helpers/security-scripts'
import { SECRET_PATHS_TASK } from '../helpers/security-tasks'
import { withSecurityTenants, type SharedTasks } from '../helpers/security-tenants'
import { newApiContext } from '../helpers/users'
import { expect, test as base, unique } from '../fixtures'

// The tenant fixtures of the security specs (helpers/security-tenants.ts).
const test = withSecurityTenants(base)

// Script runs (docs/scripts.md; docs/security.md SB-1, SB-3, SB-5, BLD-2, SEC-1): a script-run container runs with the
// hardening profile on the internal network scantor-scripts only, from where it reaches the orchestrator and the
// object store and nothing else; its run-scoped token works only from that network, only while the run is running and
// only for the run's own scans; script reads mask writeOnly values exactly like the API; and the Dockerfile policy
// forbids local script images. The `probe` script (helpers/security-scripts.ts) looks at all of it from inside its own
// container. Each tenant builds it once (module state per worker process); every run ends within the test.

const MiB = 1024 * 1024
const MASK = '***'
/** Long enough for the test to inspect the running container and send requests with the run's token. */
const HOLD_SECONDS = 45
const MANAGED = { 'traefik.enable': 'false', 'com.docker.compose.project': 'scantor-managed', 'com.docker.compose.service': '', 'scantor.managed': 'true' }
/** The secrets of the secret-paths scan, generated once per worker process (the scan is shared by the worker). */
const SECRET_SEED = `seed-${randomBytes(12).toString('hex')}`
const SECRET_TOKEN = `token-${randomBytes(12).toString('hex')}`

type ScriptRunInspect = WorkerInspect & { HostConfig: WorkerInspect['HostConfig'] & { OomScoreAdj: number } }

const internalUrl = () => (stackEnv().SCANTOR_INTERNAL_URL ?? 'http://orchestrator:3000').replace(/\/+$/, '')

/** Name → value of a container's Env list. */
const envMap = (env: string[] | null) =>
  Object.fromEntries((env ?? []).map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]))

/** The tenant's `probe` script, created once per worker process (tests only start runs of it). */
const probeScripts = new Map<string, Promise<Script>>()
function probeScript(api: ApiClient, userId: string): Promise<Script> {
  let script = probeScripts.get(userId)
  if (!script) {
    const name = unique('probe')
    const created = createScriptWithFiles(api, name, probeScriptFiles(name))
    probeScripts.set(userId, created)
    created.catch(() => probeScripts.get(userId) === created && probeScripts.delete(userId))
    script = created
  }
  return script
}

/** Two completed scans of the `probe` task's mode `files` (an analysis with files each), shared by the worker. */
async function filesScans(shared: SharedTasks): Promise<[Scan, Scan]> {
  const { revision } = await shared.probe()
  const scan = (key: string) => shared.completedScan(key, async () => ({ revision: revision.ref, name: unique(key), taskConfig: { mode: 'files' } }))
  return Promise.all([scan('script-x'), scan('script-y')])
}

/** The only analysis of a scan and the id of its first file. */
async function analysisWithFile(api: ApiClient, scanId: string): Promise<{ id: string; fileId: string }> {
  const [analysis] = ok(await api.call<Page<Analysis>>('listAnalyses', { path: { scanId } }), 'listAnalyses').items
  expect(analysis?.files.length, `the analysis of ${scanId} stored files`).toBeGreaterThan(0)
  return { id: analysis!.id, fileId: analysis!.files[0]!.id }
}

async function ipOn(container: string, network: string): Promise<string> {
  const ip = (await docker(['inspect', '--format', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, container])).stdout.trim()
  if (!ip) throw new Error(`${container} has no address on ${network}`)
  return ip
}

function hostPort(url: string): { host: string; port: number } {
  const parsed = new URL(url)
  return { host: parsed.hostname, port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)) }
}

/**
 * Addresses a script-run container must not reach: RabbitMQ (also on the worker network, which workers and editors
 * share), MongoDB, the registry, the admin GUIs and Traefik on the internal network, the orchestrator and the object
 * store by their addresses on the worker network, and the internet by address and by name.
 */
async function forbiddenTargets(): Promise<ProbeTarget[]> {
  const on = async (name: string, container: string, network: string, port: number): Promise<ProbeTarget> => ({
    name,
    host: await ipOn(container, network),
    port,
  })
  const targets = await Promise.all([
    on('rabbitmq amqp (worker network)', CONTAINERS.rabbitmq, 'scantor-sandbox', 5672),
    on('rabbitmq management (worker network)', CONTAINERS.rabbitmq, 'scantor-sandbox', 15672),
    on('rabbitmq prometheus (worker network)', CONTAINERS.rabbitmq, 'scantor-sandbox', 15692),
    on('rabbitmq amqp', CONTAINERS.rabbitmq, 'scantor', 5672),
    on('mongo', CONTAINERS.mongo, 'scantor', 27017),
    on('registry', CONTAINERS.registry, 'scantor', 5000),
    on('mongo-express', CONTAINERS.mongoExpress, 'scantor', 8081),
    on('traefik', CONTAINERS.traefik, 'scantor', 443),
    on('fixtures', CONTAINERS.fixtures, 'scantor', 8089),
    on('orchestrator (worker network)', CONTAINERS.orchestrator, 'scantor-sandbox', 3000),
    on('rustfs (worker network)', CONTAINERS.rustfs, 'scantor-sandbox', 9000),
  ])
  return [...targets, { name: 'internet by address', host: '1.1.1.1', port: 443 }, { name: 'internet by name', host: 'example.com', port: 443 }]
}

/** Starts a probe run (0.5 CPU, 256 MiB; the instance's default timeout) and returns it. */
async function startProbe(
  api: ApiClient,
  script: Script,
  body: { scans: string[]; config: ProbeConfig; secrets?: Record<string, string> },
): Promise<ScriptRun> {
  return startScriptRun(api, script.id, {
    scans: body.scans,
    config: body.config as Record<string, unknown>,
    secrets: body.secrets,
    settings: { resources: { cpus: 0.5, memoryMiB: 256 } },
  })
}

/** A completed probe run and its result. */
async function probeResult(api: ApiClient, scriptRunId: string): Promise<{ run: ScriptRun; result: ProbeResult }> {
  const run = await waitForScriptRun(api, scriptRunId)
  expect(run.state, JSON.stringify({ errors: run.errors, error: run.error, logTail: run.logTail })).toBe('completed')
  return { run, result: run.result as ProbeResult }
}

/** Every stored log line of a run, as text. */
async function logText(api: ApiClient, scriptRunId: string): Promise<string> {
  const lines: string[] = []
  let afterLine: number | undefined
  for (let page = 0; page < 50; page++) {
    const logs = ok(await api.call<ScriptRunLogsPage>('getScriptRunLogs', { path: { scriptRunId }, query: { limit: 1000, afterLine } }), 'getScriptRunLogs')
    lines.push(...logs.lines.map((line) => line.text))
    if (logs.lines.length === 0) return lines.join('\n')
    afterLine = logs.nextLine
  }
  return lines.join('\n')
}

/** The status of a request to the orchestrator's internal URL sent directly from the node daemon's container. */
async function statusFromNodeContainer(path: string, token: string): Promise<number> {
  const result = await docker(
    ['exec', CONTAINERS.node, 'wget', '-S', '-O', '/dev/null', '-T', '15', '--header', `Authorization: Bearer ${token}`, `${internalUrl()}${path}`],
    {
      allowFailure: true,
    },
  )
  const status = /HTTP\/1\.[01] (\d{3})/.exec(`${result.stdout}\n${result.stderr}`)?.[1]
  if (!status) throw new Error(`no HTTP status from wget in ${CONTAINERS.node}: ${result.stdout}${result.stderr}`)
  return Number(status)
}

test.describe('script runs', () => {
  test(
    'a script-run container runs hardened on scantor-scripts only and reaches nothing but the orchestrator and the object store',
    { tag: ['@SEC-025', '@SEC-007'] },
    async ({ api, user, shared }) => {
      test.setTimeout(420_000)
      const [script, [scan]] = await Promise.all([probeScript(api, user.id), filesScans(shared)])
      const orchestrator = hostPort(internalUrl())
      const s3 = hostPort(stackEnv().SCANTOR_S3_INTERNAL_URL ?? 'http://rustfs:9000')
      const forbidden = await forbiddenTargets()
      const allowed: ProbeTarget[] = [
        { name: 'orchestrator', ...orchestrator },
        { name: 'rustfs', ...s3 },
      ]
      const started = await startProbe(api, script, { scans: [scan.id], config: { targets: [...allowed, ...forbidden], hold_seconds: HOLD_SECONDS } })
      try {
        const running = await waitForRunningScriptRun(api, started.id)
        expect(running.image?.ref).toBe(`scripts/${script.id}:${running.source.packSha256}`)

        // The container as Docker sees it (docs/scripts.md, docs/security.md SB-1).
        const inspect = JSON.parse((await docker(['inspect', scriptRunContainer(started.id)])).stdout)[0] as ScriptRunInspect
        const host = inspect.HostConfig
        expect(inspect.Name).toBe(`/${scriptRunContainer(started.id)}`)
        expect(inspect.Config.Entrypoint).toEqual(['/scantor/scantor', 'runtime', 'script', '--entry', 'main.py'])
        expect(inspect.Config.Cmd ?? []).toEqual([])
        expect(inspect.Config.Healthcheck).toEqual(RUNTIME_HEALTHCHECK)
        expect(inspect.Config.Labels).toMatchObject({ ...MANAGED, 'scantor.kind': 'scriptRun', 'scantor.user': user.id, 'scantor.script-run': started.id })
        const env = envMap(inspect.Config.Env)
        expect(env.SCANTOR_URL).toBe(internalUrl())
        expect(env.SCANTOR_SCRIPT_TOKEN).toBe(scriptRunToken(running))
        expect(
          Object.keys(env).filter((name) => /SECRET|PASSWORD|TOKEN|ACCESS_KEY|MONGO|RABBIT|AMQP/.test(name)),
          'the run-scoped token is the container’s only credential',
        ).toEqual(['SCANTOR_SCRIPT_TOKEN'])
        expect(host.Privileged).toBe(false)
        expect(host.CapDrop).toEqual(['ALL'])
        expect(host.CapAdd ?? []).toEqual([])
        expect(host.SecurityOpt).toContain('no-new-privileges:true')
        expect((host.SecurityOpt ?? []).filter((opt) => /unconfined/.test(opt))).toEqual([])
        expect(host.Init).toBe(true)
        expect(host.PidsLimit).toBe(4096)
        expect(host.Memory).toBe(256 * MiB + 256 * MiB)
        expect(host.MemorySwap).toBe(host.Memory)
        expect(host.NanoCpus).toBe(500_000_000)
        expect(host.OomScoreAdj).toBe(1000)
        expect(host.Ulimits).toEqual([{ Name: 'nofile', Soft: 65536, Hard: 65536 }])
        expect(host.LogConfig).toEqual({ Type: 'local', Config: { 'max-size': '50m', 'max-file': '5' } })
        expect(host.RestartPolicy.Name).toBe('no')
        expect(host.Binds ?? []).toEqual([])
        expect(inspect.Mounts).toEqual([])
        expect(Object.keys(host.PortBindings ?? {})).toEqual([])
        expect(host.NetworkMode).toBe(SCRIPTS_NETWORK)
        expect(Object.keys(inspect.NetworkSettings.Networks)).toEqual([SCRIPTS_NETWORK])

        // The network is internal (no gateway to the outside), and only the orchestrator, the object store, script-run
        // containers and test containers are attached to it.
        const network = JSON.parse((await docker(['network', 'inspect', SCRIPTS_NETWORK])).stdout)[0] as {
          Internal: boolean
          Containers: Record<string, { Name: string }>
        }
        expect(network.Internal).toBe(true)
        const attached = Object.values(network.Containers ?? {}).map((container) => container.Name)
        const services: string[] = [CONTAINERS.orchestrator, CONTAINERS.rustfs]
        expect(attached).toEqual(expect.arrayContaining([...services, scriptRunContainer(started.id)]))
        for (const name of attached) expect.soft(services.includes(name) || /^scantor-(s|test)-/.test(name), `${name} is on ${SCRIPTS_NETWORK}`).toBe(true)

        // What the script saw from inside: no capability, no new privileges, the OOM killer's first choice, no Docker
        // socket; the orchestrator and the object store reachable, and no route to any other address.
        const { result } = await probeResult(api, started.id)
        for (const key of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
          if (key in result.process) expect.soft(result.process[key], key).toBe('0000000000000000')
        }
        expect(result.process).toMatchObject({ NoNewPrivs: '1', oom_score_adj: '1000', docker_socket: 'false' })
        for (const target of allowed) expect.soft(result.connections[target.name], `${target.name} is reachable`).toEqual({ reachable: true, error: null })
        for (const target of forbidden) {
          const connection = result.connections[target.name]
          expect.soft(connection?.reachable, `${target.name} (${target.host}:${target.port}): ${JSON.stringify(connection)}`).toBe(false)
          // A refused connection would mean the host is routable and only the port is closed.
          expect.soft(connection?.error, `${target.name} (${target.host}:${target.port}) is unroutable`).not.toBe('ECONNREFUSED')
        }

        // The finished run's container is removed.
        await expect.poll(() => scriptRunContainers(started.id), { timeout: 60_000, message: 'the container of the finished run is removed' }).toEqual([])
      } finally {
        await cancelScriptRunIfActive(api, started.id)
      }
    },
  )

  test(
    'a script-run token works only from the scripts network, only while its run is running and only for the run’s own scans',
    { tag: ['@SEC-026'] },
    async ({ api, user, shared }) => {
      test.setTimeout(420_000)
      const [script, [scanX, scanY]] = await Promise.all([probeScript(api, user.id), filesScans(shared)])
      const [x, y] = await Promise.all([analysisWithFile(api, scanX.id), analysisWithFile(api, scanY.id)])
      const runtime = '/api/script-runtime'
      const bootstrap = `${runtime}/bootstrap`
      const expected: Record<string, { status: number; code?: string }> = {
        'bootstrap with the run’s token': { status: 200 },
        'stream of the run’s scan': { status: 200 },
        'stream of another scan of the owner': { status: 404, code: 'notFound' },
        'aggregation of another scan of the owner': { status: 404, code: 'notFound' },
        'file of the run’s scan': { status: 200 },
        'file of another scan': { status: 404, code: 'notFound' },
        'file of another scan under the run’s analysis': { status: 404, code: 'notFound' },
        'output of no run': { status: 404, code: 'notFound' },
        'no token': { status: 401, code: 'unauthorized' },
        'a token with a wrong MAC': { status: 401, code: 'unauthorized' },
        'the owner’s API key': { status: 401, code: 'unauthorized' },
        'the run’s token on an owner route': { status: 401, code: 'unauthorized' },
        'the run’s token on the worker runtime API': { status: 401, code: 'unauthorized' },
      }
      const config: ProbeConfig = {
        hold_seconds: HOLD_SECONDS,
        requests: [
          { name: 'bootstrap with the run’s token', path: bootstrap },
          { name: 'stream of the run’s scan', method: 'POST', path: `${runtime}/scans/${scanX.id}/analyses`, body: { fileUrls: false } },
          { name: 'stream of another scan of the owner', method: 'POST', path: `${runtime}/scans/${scanY.id}/analyses`, body: {} },
          {
            name: 'aggregation of another scan of the owner',
            method: 'POST',
            path: `${runtime}/scans/${scanY.id}/aggregate`,
            body: { pipeline: [{ $count: 'n' }] },
          },
          { name: 'file of the run’s scan', path: `${runtime}/analyses/${x.id}/files/${x.fileId}` },
          { name: 'file of another scan', path: `${runtime}/analyses/${y.id}/files/${y.fileId}` },
          { name: 'file of another scan under the run’s analysis', path: `${runtime}/analyses/${x.id}/files/${y.fileId}` },
          { name: 'output of no run', path: `${runtime}/outputs/${randomUUID()}` },
          { name: 'no token', path: bootstrap, auth: 'none' },
          { name: 'a token with a wrong MAC', path: bootstrap, auth: 'tampered' },
          { name: 'the owner’s API key', path: bootstrap, auth: 'secret:USER_KEY' },
          { name: 'the run’s token on an owner route', path: `/api/scans/${scanX.id}` },
          { name: 'the run’s token on the worker runtime API', path: '/api/runtime/bootstrap' },
        ],
      }
      const started = await startProbe(api, script, { scans: [scanX.id], config, secrets: { USER_KEY: user.apiKey } })
      try {
        const running = await waitForRunningScriptRun(api, started.id)
        const token = scriptRunToken(running)
        const outside = await newApiContext({ headers: { Authorization: `Bearer ${token}` } })
        try {
          // Through Traefik and directly from another internal network the peer check refuses the live token.
          expect((await outside.get(bootstrap)).status(), 'the runner, through Traefik').toBe(403)
          const stream = await outside.post(`${runtime}/scans/${scanX.id}/analyses`, { data: {} })
          expect(stream.status()).toBe(403)
          expect(((await stream.json()) as { error: { code: string } }).error.code).toBe('forbidden')
          expect(await statusFromNodeContainer(bootstrap, token), `${CONTAINERS.node}, directly on the internal network`).toBe(403)
          // From the scripts network the token is good while its run is running (the peer check is per network).
          const [live] = await fetchFromScriptsNetwork([{ method: 'GET', path: bootstrap, headers: { Authorization: `Bearer ${token}` } }])
          expect(live, 'the live token from the scripts network').toEqual({ status: 200, code: null })

          const { run, result } = await probeResult(api, started.id)
          for (const [name, answer] of Object.entries(expected)) {
            expect.soft(result.answers[name], name).toMatchObject(answer.code ? { status: answer.status, code: answer.code } : { status: answer.status })
          }
          // The secret reached the script and is shown nowhere: names only in the run, not in its log.
          expect(run.secrets).toEqual(['USER_KEY'])
          expect(JSON.stringify(run).includes(user.apiKey), 'the run shows the secret value').toBe(false)
          expect((await logText(api, started.id)).includes(user.apiKey), 'the log shows the secret value').toBe(false)

          // Once the run ended its token is refused from the scripts network too.
          const [ended] = await fetchFromScriptsNetwork([{ method: 'GET', path: bootstrap, headers: { Authorization: `Bearer ${token}` } }])
          expect(ended, 'the token of the ended run from the scripts network').toEqual({ status: 401, code: 'unauthorized' })
          expect((await outside.get(bootstrap)).status()).toBe(403)
        } finally {
          await outside.dispose()
        }
      } finally {
        await cancelScriptRunIfActive(api, started.id)
      }
    },
  )

  test(
    'script reads mask writeOnly values like the API, refuse queries on secret paths, and a run’s secrets are never shown',
    { tag: ['@SEC-027'] },
    async ({ api, user, shared }) => {
      test.setTimeout(420_000)
      const [script, { revision }] = await Promise.all([probeScript(api, user.id), shared.generated('secret-paths', SECRET_PATHS_TASK)])
      const scan = await shared.completedScan('script-secret-paths', async () => ({
        revision: revision.ref,
        name: unique('script-secret-paths'),
        taskConfig: { token: SECRET_TOKEN },
        scanConfig: { count: 2, seed: SECRET_SEED },
      }))
      const runSecret = `run-secret-${randomBytes(12).toString('hex')}`
      const analysesPath = `/api/script-runtime/scans/${scan.id}/analyses`
      const aggregatePath = `/api/script-runtime/scans/${scan.id}/aggregate`
      const refused = ['filter on a secret', 'regex on a secret', 'group by a secret', 'project the whole document']
      const started = await startProbe(api, script, {
        scans: [scan.id],
        secrets: { API_TOKEN: runSecret },
        config: {
          print_secret: 'API_TOKEN',
          read_analyses: true,
          requests: [
            { name: 'bootstrap', path: '/api/script-runtime/bootstrap', keep: true },
            { name: 'stream', method: 'POST', path: analysesPath, body: { fileUrls: false }, keep: true },
            { name: 'stream all', method: 'POST', path: analysesPath, body: { fields: 'all', fileUrls: false }, keep: true },
            { name: 'stream secret fields', method: 'POST', path: analysesPath, body: { fields: ['config.key', 'result.echo'], fileUrls: false }, keep: true },
            { name: refused[0]!, method: 'POST', path: analysesPath, body: { filter: { 'config.key': { $exists: true } } } },
            { name: refused[1]!, method: 'POST', path: analysesPath, body: { filter: { 'result.echo': { $regex: '^key-' } } } },
            { name: refused[2]!, method: 'POST', path: aggregatePath, body: { pipeline: [{ $group: { _id: '$result.echo', n: { $sum: 1 } } }] } },
            { name: refused[3]!, method: 'POST', path: aggregatePath, body: { pipeline: [{ $project: { all: '$$ROOT' } }] } },
          ],
        },
      })
      try {
        const { run, result } = await probeResult(api, started.id)
        const rest = ok(await api.call<Page<Analysis>>('listAnalyses', { path: { scanId: scan.id } }), 'listAnalyses').items
        expect(rest).toHaveLength(2)
        const byId = new Map(rest.map((analysis) => [analysis.id, analysis]))

        // The bootstrap names the scan's secret paths (and the run's secrets by name only, in the probe's copy).
        const bootstrap = result.answers.bootstrap!.body as { scriptRun: { secrets: string[] }; scans: { id: string; secretPaths: Record<string, string[]> }[] }
        expect(result.answers.bootstrap!.status).toBe(200)
        expect(bootstrap.scriptRun.secrets).toEqual(['API_TOKEN'])
        expect(bootstrap.scans.map((s) => s.id)).toEqual([scan.id])
        expect(bootstrap.scans[0]!.secretPaths).toMatchObject({ analysisConfig: ['/key'], result: ['/echo'] })

        // Every view the script has of the analyses carries the masks the API shows, and the same values.
        const views: [string, Record<string, unknown>[]][] = [
          ...['stream', 'stream all', 'stream secret fields'].map((name): [string, Record<string, unknown>[]] => {
            expect.soft(result.answers[name]?.status, name).toBe(200)
            return [name, ((result.answers[name]?.body as { analyses?: Record<string, unknown>[] } | null)?.analyses ?? []) as Record<string, unknown>[]]
          }),
          ['the SDK', result.analyses],
        ]
        for (const [name, analyses] of views) {
          expect.soft(analyses.map((analysis) => analysis.id).sort(), name).toEqual([...byId.keys()].sort())
          for (const analysis of analyses) {
            const expected = byId.get(String(analysis.id))
            expect.soft(analysis.config, `${name}: config of ${String(analysis.id)}`).toMatchObject({ key: MASK })
            expect.soft(analysis.result, `${name}: result of ${String(analysis.id)}`).toMatchObject({ echo: MASK })
            if (name !== 'stream secret fields') {
              expect.soft(analysis.config, `${name}: config of ${String(analysis.id)} equals the API's`).toEqual(expected?.config)
              expect.soft(analysis.result, `${name}: result of ${String(analysis.id)} equals the API's`).toEqual(expected?.result)
            }
          }
        }
        // A query that would turn a secret into an oracle is refused, like queryAnalyses and exports.
        for (const name of refused) expect.soft(result.answers[name], name).toMatchObject({ status: 400, code: 'queryRejected' })

        // No secret value anywhere: the scan's (the task saw them) and the run's own (printed by the script, masked in
        // the log).
        const secrets = [SECRET_TOKEN, SECRET_SEED, `key-${SECRET_SEED}-0`, `key-${SECRET_SEED}-1`, runSecret]
        const log = await logText(api, started.id)
        for (const [where, text] of [
          ['the run', JSON.stringify(run)],
          ['the log', log],
        ] as const) {
          for (const secret of secrets) expect.soft(text.includes(secret), `${where} contains a secret value`).toBe(false)
        }
        expect(run.secrets).toEqual(['API_TOKEN'])
        expect(log).toContain(`secret API_TOKEN: ${MASK}`)
      } finally {
        await cancelScriptRunIfActive(api, started.id)
      }
    },
  )

  test(
    'a script whose Dockerfile references a local script image fails in phase static (D5) and never runs a container',
    { tag: ['@SEC-028', '@SEC-002'] },
    async ({ api, shared }) => {
      test.setTimeout(420_000)
      const [[scan], cases] = await Promise.all([
        filesScans(shared),
        Promise.all(
          ['d5-from-local-script', 'd5-copy-from-local-script', 'd5-mount-from-local-script'].map(async (id) => {
            const dir = join(import.meta.dirname, '..', 'corpora', 'dockerfile-policy', id)
            const expected = JSON.parse(await readFile(join(dir, 'expect.json'), 'utf8')) as { errors: { line: number; rule: string }[] }
            return { id, dockerfile: await readFile(join(dir, 'Dockerfile'), 'utf8'), line: expected.errors[0]!.line }
          }),
        ),
      ])
      // One script whose Dockerfile changes between the starts: each run builds the snapshot taken when it started.
      const name = unique('policy-script')
      const script = await createScriptWithFiles(api, name, probeScriptFiles(name))
      const runs: ScriptRun[] = []
      try {
        for (const testCase of cases) {
          ok(await api.call('writeScriptFiles', { path: { script: script.id }, body: { files: { Dockerfile: testCase.dockerfile } } }), 'writeScriptFiles')
          runs.push(await startScriptRun(api, script.id, { scans: [scan.id], settings: { limit: 1 } }))
        }
        for (const [index, started] of runs.entries()) {
          const testCase = cases[index]!
          const run = await waitForScriptRun(api, started.id)
          const label = `${testCase.id}: ${run.state} ${JSON.stringify(run.errors)}`
          expect.soft(run.state, label).toBe('failed')
          expect.soft(run.errors[0], label).toMatchObject({ phase: 'static', file: 'Dockerfile', line: testCase.line })
          expect.soft(run.errors[0]?.message.endsWith('(D5)'), label).toBe(true)
          expect.soft(run.image, label).toBeNull()
          expect.soft(run.startedAt, `${testCase.id}: the run never started`).toBeNull()
          expect.soft(await scriptRunContainers(started.id), `${testCase.id}: no container`).toEqual([])
        }
      } finally {
        for (const run of runs) await cancelScriptRunIfActive(api, run.id)
        await api.call('deleteScript', { path: { script: script.id } })
      }
    },
  )
})
