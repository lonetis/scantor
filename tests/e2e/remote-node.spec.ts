import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Analysis } from '#shared/types/analyses'
import type { Node, NodeJoin } from '#shared/types/nodes'
import type { Worker } from '#shared/types/workers'
import { ok, type ApiClient } from '../helpers/api-client'
import { CONTAINERS, stackEnv } from '../helpers/docker'
import { exampleVariant, removeTree } from '../helpers/e2e-examples-cli-tasks'
import { SMALL_SETTINGS } from '../helpers/scans'
import { exampleTaskDir } from '../helpers/tasks'
import { extendExamplesCli } from '../helpers/e2e-examples-cli-fixtures'
import { expect, test as base } from '../fixtures'

// The simulated remote node `remote-1` (pool "remote", label zone=remote; docs/testing.md §7.3, docs/nodes.md §4,
// §10, §11): it was joined with the exact dockerRun snippet of createNode inside its own dockerd, and every request of
// its workers goes through the public endpoint profile (https://*.scantor.localhost through Traefik, trusted through
// SCANTOR_CA_CERT). The tests only read remote-1 and its dockerd; the scans they start are their own.

interface RemoteNodeFile {
  id: string
  name: string
  pool: string
  labels: Record<string, string>
  token: string
}

// Sessions that survive concurrent runs on one stack (helpers/e2e-examples-cli-fixtures.ts).
const test = extendExamplesCli(base)

const remoteNode = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as RemoteNodeFile

const REMOTE_SELECTOR = { pool: 'remote', labels: { zone: 'remote' } }

/**
 * main.py of the probe task (a copy of tasks/files): one analysis per list item that logs, sleeps for the task
 * config's seconds (so a test can look at its running worker) and stores a file referenced by the result.
 */
const REMOTE_PROBE_PY = `"""remote probe: logs, waits and stores one file per item."""

import asyncio

from pydantic import BaseModel, Field

import scantor
from scantor import templates


class TaskConfig(scantor.Config):
    seconds: float = Field(default=0, ge=0, le=600)


class Result(BaseModel):
    item: str
    report: scantor.FileRef


async def run(ctx: scantor.Context, analysis_config: templates.list.AnalysisConfig, task_config: TaskConfig) -> Result:
    ctx.log("info", "remote probe", item=analysis_config.item)
    await asyncio.sleep(task_config.seconds)
    report = ctx.files.put("report.txt", f"report of {analysis_config.item}\\n", "text/plain")
    return Result(item=analysis_config.item, report=report)


task = scantor.Task(task_config=TaskConfig, result=Result, schedule=templates.list.schedule, run=run)
`

interface ContainerInspect {
  Name: string
  Config: { Image: string; Env: string[]; Cmd: string[] | null; Labels: Record<string, string> }
  HostConfig: { RestartPolicy: { Name: string }; Binds: string[] | null; NetworkMode: string }
  State: { Running: boolean }
}

const envOf = (container: ContainerInspect) =>
  Object.fromEntries(container.Config.Env.map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]))

async function scanWorkers(api: ApiClient, scanId: string): Promise<Worker[]> {
  return ok(await api.listScanWorkers(scanId, { limit: 200 }), 'listScanWorkers').items
}

test.describe('remote node', () => {
  test('remote-1 runs the dockerRun join snippet, reports its host and created scantor-workers', { tag: ['@NODE-014'] }, async ({ adminApi, docker, env }) => {
    const remote = remoteNode(env.paths.remoteNode)
    const node = ok(await adminApi.call<Node>('getNode', { path: { nodeId: remote.id } }), 'getNode')
    expect(node).toMatchObject({ name: 'remote-1', builtIn: false, state: 'online', pool: 'remote', labels: { zone: 'remote' }, endpointProfile: 'public' })

    // The reported info is the remote dockerd's.
    const info = JSON.parse((await docker.remote(['info', '--format', '{{json .}}'])).stdout) as Record<string, unknown>
    const version = JSON.parse((await docker.remote(['version', '--format', '{{json .Server}}'])).stdout) as { Os: string; Arch: string }
    expect(node.info).toMatchObject({
      hostname: info.Name,
      os: version.Os,
      arch: version.Arch,
      kernel: info.KernelVersion,
      dockerVersion: info.ServerVersion,
      cpus: info.NCPU,
      memoryBytes: info.MemTotal,
    })
    expect(node.info!.maxWorkers).toBeGreaterThan(0)
    expect(node.info!.diskFreeBytes).toBeGreaterThan(0)

    // The daemon container is the join snippet's: name, restart policy, Docker socket, URL and token, image and command.
    const join = ok(await adminApi.call<NodeJoin>('getNodeJoin', { path: { nodeId: remote.id } }), 'getNodeJoin')
    const snippet =
      /^docker run -d --name scantor-node --restart unless-stopped -v \/var\/run\/docker\.sock:\/var\/run\/docker\.sock -e SCANTOR_URL=(\S+) -e SCANTOR_NODE_TOKEN=\$\{SCANTOR_NODE_TOKEN\} (\S+) node$/.exec(
        join.dockerRun,
      )
    expect(snippet, join.dockerRun).not.toBeNull()
    expect(snippet![1]).toBe(env.publicUrl)
    const daemon = JSON.parse((await docker.remote(['inspect', 'scantor-node'])).stdout)[0] as ContainerInspect
    expect(daemon).toMatchObject({
      Name: '/scantor-node',
      Config: { Image: snippet![2], Cmd: ['node'] },
      HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, Binds: ['/var/run/docker.sock:/var/run/docker.sock'] },
      State: { Running: true },
    })
    expect(envOf(daemon)).toMatchObject({ SCANTOR_URL: join.env.SCANTOR_URL, SCANTOR_NODE_TOKEN: remote.token })

    // The daemon created its worker network: a managed bridge without inter-container traffic.
    const network = JSON.parse((await docker.remote(['network', 'inspect', 'scantor-workers'])).stdout)[0] as {
      Driver: string
      Options: Record<string, string>
      Labels: Record<string, string>
      EnableIPv6: boolean
    }
    expect(network).toMatchObject({
      Driver: 'bridge',
      EnableIPv6: false,
      Options: { 'com.docker.network.bridge.enable_icc': 'false' },
      Labels: { 'scantor.managed': 'true', 'scantor.kind': 'network' },
    })
  })

  test(
    'a scan with pool remote runs end to end on remote-1 over the public endpoint profile',
    { tag: ['@PLACE-005', '@NODE-035', '@NODE-032'] },
    async ({ api, tasks, scans, docker, env, request }) => {
      // A build, a first pull on remote-1 and two short analyses.
      test.setTimeout(300_000)
      const remote = remoteNode(env.paths.remoteNode)
      const registryHost = stackEnv().SCANTOR_REGISTRY_PUBLIC_HOST!
      const dir = await exampleVariant(exampleTaskDir('files'), 'remote-probe', { 'main.py': REMOTE_PROBE_PY })
      try {
        const { task, revision } = await tasks.upload(dir)
        const digest = revision.image!.digest
        const items = ['alpha', 'beta']
        const scan = await scans.start({
          revision: revision.ref,
          // Each analysis waits, so the runner is still running while the test inspects it.
          taskConfig: { seconds: 8 },
          scanConfig: { items },
          settings: { ...SMALL_SETTINGS, nodeSelector: REMOTE_SELECTOR },
        })
        expect(scan.settings).toMatchObject({ nodeSelector: REMOTE_SELECTOR })

        // The runner starts on remote-1 (the image may need a first pull there).
        let runner: Worker | undefined
        await expect
          .poll(
            async () => {
              runner = (await scanWorkers(api, scan.id)).find((w) => w.role === 'runner' && w.state === 'running' && w.container !== null)
              return runner?.id
            },
            { timeout: 240_000, intervals: [1000] },
          )
          .toBeDefined()
        if (!runner) throw new Error('unreachable: the poll found a running runner')
        expect(runner.node?.id).toBe(remote.id)

        // Its container in remote-1's dockerd runs the image by digest from the public registry host and talks to the
        // public URL with the test CA.
        const containers = (await docker.remote(['ps', '-q', '--filter', `label=scantor.worker=${runner.id}`])).stdout.split('\n').filter(Boolean)
        expect(containers).toHaveLength(1)
        const container = JSON.parse((await docker.remote(['inspect', containers[0]!])).stdout)[0] as ContainerInspect
        expect(container.Name).toBe(`/scantor-w-${runner.id}`)
        expect(container.Config.Image).toBe(`${registryHost}/tasks/${task.id}@${digest}`)
        expect(container.HostConfig.NetworkMode).toBe('scantor-workers')
        expect(container.Config.Labels).toMatchObject({ 'scantor.scan': scan.id, 'scantor.node': remote.id, 'scantor.kind': 'worker' })
        const workerEnv = envOf(container)
        expect(workerEnv.SCANTOR_URL).toBe(env.publicUrl)
        expect(workerEnv.SCANTOR_CA_CERT).toContain('BEGIN CERTIFICATE')

        // The image was pulled by digest; the registry answers nothing without a token from the realm, and the node
        // token gets pull on this repository while one of its workers runs it.
        const image = JSON.parse((await docker.remote(['image', 'inspect', `${registryHost}/tasks/${task.id}@${digest}`])).stdout)[0] as {
          RepoDigests: string[]
        }
        expect(image.RepoDigests).toContain(`${registryHost}/tasks/${task.id}@${digest}`)
        const anonymous = await request.get(`https://${registryHost}/v2/tasks/${task.id}/manifests/${digest}`)
        expect(anonymous.status()).toBe(401)
        expect(anonymous.headers()['www-authenticate']).toContain(`realm="${env.publicUrl}/api/registry/token"`)
        const grant = await request.get(`${env.publicUrl}/api/registry/token`, {
          params: { service: 'scantor-registry', scope: `repository:tasks/${task.id}:pull,push` },
          headers: { Authorization: `Basic ${Buffer.from(`node:${remote.token}`).toString('base64')}` },
        })
        expect(grant.status()).toBe(200)
        const jwt = ((await grant.json()) as { token: string }).token
        const claims = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as {
          access: { type: string; name: string; actions: string[] }[]
        }
        expect(claims.access).toEqual([{ type: 'repository', name: `tasks/${task.id}`, actions: ['pull'] }])

        // The daemon never logged in: neither remote-1's Docker host nor the daemon container holds registry credentials.
        const hostConfig = await docker.exec(CONTAINERS.remoteNode, ['sh', '-c', 'cat /root/.docker/config.json 2>/dev/null || true'])
        expect(hostConfig.stdout).not.toContain(registryHost)
        const daemonConfig = await docker.remote(['exec', 'scantor-node', 'sh', '-c', 'cat "$HOME/.docker/config.json" 2>/dev/null || true'])
        expect(daemonConfig.stdout).not.toContain(registryHost)
        expect(daemonConfig.stdout).not.toContain('auth')

        // Worker logs on demand from the remote daemon.
        const logs = ok(
          await api.call<{ text: string; collectedAt: string | null; pending: boolean }>('getWorkerLogs', {
            path: { scanId: scan.id, workerId: runner.id },
            query: { wait: 30 },
          }),
          'getWorkerLogs',
        )
        expect(logs.pending).toBe(false)
        expect(logs.collectedAt).not.toBeNull()
        expect(logs.text.length).toBeGreaterThan(0)

        // Results arrive over AMQPS and files over presigned S3 through Traefik; every worker ran on remote-1.
        const done = await scans.wait(scan.id, { timeoutMs: 180_000 })
        expect(await scans.counts(done.id)).toEqual({ succeeded: items.length })
        const workers = await scanWorkers(api, scan.id)
        expect(workers.map((w) => w.role).sort()).toEqual(expect.arrayContaining(['runner', 'scheduler']))
        for (const worker of workers) expect(worker.node?.id, `${worker.role} ${worker.id}`).toBe(remote.id)

        const analyses = ok(
          await api.queryAnalyses(scan.id, { filter: {}, projection: { seq: 1, result: 1, files: 1, logTail: 1 }, sort: { seq: 1 } }),
          'queryAnalyses',
        ).items as Pick<Analysis, 'seq' | 'result' | 'files' | 'logTail'>[]
        expect(analyses.map((a) => (a.result as { item: string }).item)).toEqual(items)
        for (const analysis of analyses) {
          expect(analysis.logTail).toContain('[info] remote probe')
          expect(analysis.files).toHaveLength(1)
          const file = analysis.files[0]!
          const download = ok(
            await api.call<{ url: string }>('getFileDownload', { path: { analysisId: `${scan.id}-${analysis.seq}`, fileId: file.id } }),
            'getFileDownload',
          )
          expect(new URL(download.url).origin).toBe(stackEnv().SCANTOR_S3_PUBLIC_URL)
          const body = await (await request.get(download.url)).body()
          expect(createHash('sha256').update(body).digest('hex')).toBe(file.sha256)
          expect(body.toString('utf8')).toBe(`report of ${(analysis.result as { item: string }).item}\n`)
        }
      } finally {
        await removeTree(dir)
      }
    },
  )
})
