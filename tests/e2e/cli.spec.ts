import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, cp, link, mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import tar from 'tar-stream'
import { parse as parseYaml } from 'yaml'
import type { Scan } from '#shared/types/scans'
import { ok } from '../helpers/api-client'
import { FIXTURE_DATA_SOURCES, scantor } from '../helpers/cli'
import { CONTAINERS, docker } from '../helpers/docker'
import { createAdminWithKey, extendExamplesCli } from '../helpers/e2e-examples-cli-fixtures'
import { copyGitRepo, GIT_REPOS, moveGitMain } from '../helpers/fixtures-server'
import { exampleTaskDir } from '../helpers/tasks'
import { deleteUser } from '../helpers/users'
import { buildTarGz } from '../helpers/tar'
import { CliProcess, jsonLines, scantorBytes, scantorEnv, spawnScantor } from '../helpers/e2e-examples-cli-process'
import { childEnv } from '../helpers/env'
import {
  describeRun,
  errorJson,
  exampleVariant,
  findPipelineResult,
  localEvents,
  localResults,
  pipelineEvents,
  pipelineResult,
  PROBE_MAIN_PY,
  listFiles,
  removeDevImages,
  removeTree,
  settleAll,
  tempDir,
  writeFiles,
} from '../helpers/e2e-examples-cli-tasks'
import { expect, test as base, unique, type ScansFixture } from '../fixtures'

// The scantor CLI end to end (docs/guide/cli.md, docs/tasks.md §9, §11–§12, docs/runtime.md §15): the task pipeline
// commands, templates estimate, the node daemon's start-up checks, the local development loop and every command group
// against the test stack. Local commands run the runner's own binary against the inner dockerd; platform commands
// use the worker tenant's API key. Every folder, image, task and scan a test creates is removed again.

// Sessions that survive concurrent runs on one stack, and examples published once per worker.
const test = extendExamplesCli(base)

const ECHO = exampleTaskDir('echo')

interface TarEntryInfo {
  name: string
  type: string
  mode: number
  uid: number
  gid: number
  mtime: number
  linkname: string | null
  size: number
}

/** The entries of a tar.gz in archive order and the uncompressed tar bytes. */
async function readPack(tgz: Buffer): Promise<{ entries: TarEntryInfo[]; tarBytes: Buffer }> {
  const tarBytes = gunzipSync(tgz)
  const extract = tar.extract()
  const entries: TarEntryInfo[] = []
  const done = new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      entries.push({
        name: header.name,
        type: header.type ?? 'file',
        mode: header.mode ?? 0,
        uid: header.uid ?? -1,
        gid: header.gid ?? -1,
        mtime: header.mtime?.getTime() ?? -1,
        linkname: header.linkname ?? null,
        size: header.size ?? 0,
      })
      stream.on('end', next)
      stream.resume()
    })
    extract.on('finish', resolve)
    extract.on('error', reject)
  })
  extract.end(tarBytes)
  await done
  return { entries, tarBytes }
}

/** `scantor task pack <dir> --output <file>`: the summary of the result event and the archive. */
async function packToFile(dir: string, out: string, env: Record<string, string> = {}) {
  const run = await scantor(['task', 'pack', dir, '--output', out], { env })
  expect(run.exitCode, describeRun(run)).toBe(0)
  const result = pipelineResult(run.stdout)
  expect(result.ok).toBe(true)
  return { summary: result.pack!, archive: await readFile(out) }
}

/** The pipeline errors of a failing `task pack`, asserting exit 2. */
async function packErrors(input: string, env: Record<string, string> = {}) {
  const run = await scantor(['task', 'pack', input], { env })
  expect(run.exitCode, describeRun(run)).toBe(2)
  const result = pipelineResult(run.stdout)
  expect(result.ok).toBe(false)
  expect(result.errors.length).toBeGreaterThan(0)
  for (const error of result.errors) expect(error.phase).toBe('pack')
  return result.errors
}

/** Per-process resources small enough for parallel scans on the built-in node. */
const SMALL_RESOURCES = JSON.stringify({ resources: { cpus: 0.25, memoryMiB: 256 } })

/** `scantor scans start … -o json` without waiting; the scan is tracked for cleanup. */
async function startScanCli(token: string, scans: ScansFixture, args: string[], options: { cwd?: string; input?: string } = {}): Promise<Scan> {
  const run = await scantor(['scans', 'start', ...args, '-o', 'json'], { token, ...options })
  const scan = run.json as Scan | undefined
  if (scan?.id) scans.track(scan.id)
  expect(run.exitCode, describeRun(run)).toBe(0)
  return scan!
}

// The tests that scan the shared examples come first and run in order in one worker, which publishes the two examples
// once (a publish waits for one of the stack's build slots); the other worker meanwhile runs the rest of the file.
test.describe('scans and results', () => {
  test.describe.configure({ mode: 'default' })
  test.beforeAll(({ shared }) => shared.prefetch(['throws', 'files']))

  test.describe('scan commands', () => {
    test(
      'scans start takes configs and settings from flags, files and stdin and waits for the result',
      { tag: ['@CLI-005', '@CLI-004'] },
      async ({ user, scans, shared }) => {
        const [throws, files] = await Promise.all([shared.example('throws'), shared.example('files')])
        const root = await tempDir('scans-start')
        const token = user.apiKey
        try {
          // Above the confirmation threshold of the stack (1000; an unwrapped template has an estimate, a custom schedule
          // has none) the start needs --confirm, and is refused with exit 2 otherwise. The scan config comes from a file.
          const items = Array.from({ length: 1001 }, (_, i) => `item-${i}`)
          await writeFile(join(root, 'items.json'), JSON.stringify({ items }))
          const big = ['--revision', files.revision.ref, '--scan-config', '@items.json', '--settings', SMALL_RESOURCES]
          const refused = await scantor(['scans', 'start', ...big, '-o', 'json'], { token, cwd: root })
          expect(refused.exitCode, describeRun(refused)).toBe(2)
          expect(errorJson(refused)).toMatchObject({ error: { code: 'confirmationRequired', exitCode: 2, details: { expectedTotal: 1001 } } })
          const confirmed = await startScanCli(token, scans, [...big, '--confirm'], { cwd: root })
          expect(confirmed.scanConfig).toMatchObject({ items })
          const cancelled = await scantor(['scans', 'cancel', confirmed.id, '-o', 'json'], { token })
          expect(cancelled.exitCode, describeRun(cancelled)).toBe(0)

          // The task config from a file (relative to the working directory), the scan config from stdin, the settings
          // inline, flags on top; --wait settles on the finished scan and prints it.
          await writeFile(join(root, 'task-config.json'), '{"mode": "ok"}')
          const settings = JSON.stringify({ resources: { cpus: 0.25, memoryMiB: 256 }, maxAttempts: 2 })
          const run = await scantor(
            [
              'scans',
              'start',
              `${throws.task.name}@latest`,
              '--name',
              'cli scan',
              '--task-config',
              '@task-config.json',
              '--scan-config',
              '-',
              '--settings',
              settings,
              '--workers',
              '1',
              '--processes',
              '2',
              '--wait',
              '-o',
              'json',
            ],
            { token, cwd: root, input: '{"start": 2, "end": 5}' },
          )
          const scan = run.json as Scan
          if (scan?.id) scans.track(scan.id)
          expect(run.exitCode, describeRun(run)).toBe(0)
          expect(scan).toMatchObject({
            name: 'cli scan',
            state: 'completed',
            revision: { id: throws.revision.id },
            taskConfig: { mode: 'ok', work_seconds: 0 },
            scanConfig: { start: 2, end: 5, step: 1 },
            settings: { workers: 1, processes: 2, maxAttempts: 2, resources: { cpus: 0.25, memoryMiB: 256 } },
          })
          expect(await scans.counts(scan.id)).toEqual({ succeeded: 3 })
        } finally {
          await removeTree(root)
        }
      },
    )

    test(
      'scans watch follows a scan to its end and honours pauses, the breaker and timeouts',
      { tag: ['@CLI-006', '@CLI-001'] },
      async ({ user, api, scans, shared }) => {
        const throws = await shared.example('throws')
        const token = user.apiKey
        // Both scans run at the same time: one the user pauses, one whose failures trip the breaker.
        const [scan, failing] = await Promise.all([
          startScanCli(token, scans, [
            throws.revision.ref,
            '--task-config',
            '{"mode": "ok", "work_seconds": 3}',
            '--scan-config',
            '{"end": 3}',
            '--settings',
            SMALL_RESOURCES,
          ]),
          startScanCli(token, scans, [
            throws.revision.ref,
            '--task-config',
            '{"mode": "fatal"}',
            '--scan-config',
            '{"end": 300}',
            '--settings',
            SMALL_RESOURCES,
          ]),
        ])

        // A scan the user pauses is watched until it is resumed and completes.
        const pausedAndResumed = async () => {
          const watch = spawnScantor(['scans', 'watch', scan.id, '--interval', '500ms', '-o', 'json'], { token })
          try {
            await watch.waitFor((p) => (p.events().some((e) => e.state === 'running') ? true : undefined), 120_000, 'a running scan')
            // --timeout gives up with exit 3 while the scan still runs.
            const timedOut = await scantor(['scans', 'watch', scan.id, '--timeout', '1s', '--interval', '500ms'], { token })
            expect(timedOut.exitCode, describeRun(timedOut)).toBe(3)
            expect(ok(await api.call<Scan>('pauseScan', { path: { scanId: scan.id } }), 'pauseScan').state).toMatch(/^(paused|running)$/)
            await watch.waitFor((p) => (p.events().some((e) => e.state === 'paused') ? true : undefined), 120_000, 'the paused scan')
            ok(await api.call<Scan>('resumeScan', { path: { scanId: scan.id } }), 'resumeScan')
            const exit = await watch.wait(180_000)
            expect(exit.exitCode, watch.output()).toBe(0)
            const states = watch.events().map((e) => e.state)
            expect(states.at(-1)).toBe('completed')
            expect(states.indexOf('paused')).toBeLessThan(states.lastIndexOf('running'))
            // One NDJSON scan per change.
            for (const event of watch.events()) expect(event.id).toBe(scan.id)
          } finally {
            await watch.stop()
          }
        }

        // A breaker pause ends the watch with exit 1, and so does `scans get --wait`.
        const trippedBreaker = async () => {
          const breaker = await scantor(['scans', 'watch', failing.id, '--interval', '1s', '-o', 'json'], { token, timeoutMs: 240_000 })
          expect(breaker.exitCode, describeRun(breaker)).toBe(1)
          const last = jsonLines(breaker.stdout).at(-1) as unknown as Scan
          expect(last).toMatchObject({ state: 'paused', stateReason: { code: 'failureRate' } })
          const get = await scantor(['scans', 'get', failing.id, '--wait'], { token })
          expect(get.exitCode, describeRun(get)).toBe(1)
        }

        await Promise.all([pausedAndResumed(), trippedBreaker()])
      },
    )

    test('the waiting scan commands exit 1 for failed analyses and errors print as JSON', { tag: ['@CLI-001'] }, async ({ user, scans, shared }) => {
      const throws = await shared.example('throws')
      const start = await scantor(
        [
          'scans',
          'start',
          throws.revision.ref,
          '--task-config',
          '{"mode": "fatal"}',
          '--scan-config',
          '{"end": 2}',
          '--settings',
          SMALL_RESOURCES,
          '--wait',
          '-o',
          'json',
        ],
        { token: user.apiKey },
      )
      const scan = start.json as Scan
      if (scan?.id) scans.track(scan.id)
      expect(start.exitCode, describeRun(start)).toBe(1)
      expect(scan).toMatchObject({ state: 'completed' })
      expect(await scans.counts(scan.id)).toEqual({ failed: 2 })
      const watch = await scantor(['scans', 'watch', scan.id], { token: user.apiKey })
      expect(watch.exitCode, describeRun(watch)).toBe(1)

      // Invalid input: usage errors and API 4xx exit 2; with -o json the error is printed as JSON.
      const usage = await scantor(['scans', 'start', '-o', 'json'], { token: user.apiKey })
      expect(usage.exitCode).toBe(2)
      const missing = await scantor(['scans', 'get', '00000000-0000-4000-8000-000000000000', '-o', 'json'], { token: user.apiKey })
      expect(missing.exitCode, describeRun(missing)).toBe(2)
      expect(errorJson(missing)).toEqual({ error: expect.objectContaining({ code: 'notFound', message: expect.any(String), exitCode: 2 }) })

      // Platform failures (network) exit 3.
      const unreachable = await scantor(['whoami', '-o', 'json'], { token: user.apiKey, env: { SCANTOR_URL: 'https://127.0.0.1:1' } })
      expect(unreachable.exitCode, describeRun(unreachable)).toBe(3)
      expect(errorJson(unreachable)).toEqual({ error: expect.objectContaining({ code: 'platform', exitCode: 3 }) })
    })

    test('the scan control commands map to their operations and a conflict exits 2', { tag: ['@CLI-007'] }, async ({ user, api, scans, shared }) => {
      const throws = await shared.example('throws')
      const cli = (args: string[]) => scantor([...args, '-o', 'json'], { token: user.apiKey })
      // A long scan for the controls and, at the same time, a failing one for retry-failed and delete.
      const [scan, failing] = await Promise.all([
        startScanCli(user.apiKey, scans, [
          throws.revision.ref,
          '--task-config',
          '{"mode": "ok", "work_seconds": 60}',
          '--scan-config',
          '{"end": 2}',
          '--settings',
          JSON.stringify({ resources: { cpus: 0.25, memoryMiB: 256 }, timeoutMs: 120_000 }),
        ]),
        startScanCli(user.apiKey, scans, [
          throws.revision.ref,
          '--task-config',
          '{"mode": "fatal"}',
          '--scan-config',
          '{"end": 2}',
          '--settings',
          SMALL_RESOURCES,
        ]),
      ])

      const controls = async () => {
        await expect
          .poll(async () => ((await cli(['scans', 'inflight', scan.id])).json as { items: unknown[] }).items.length, { timeout: 180_000, intervals: [2000] })
          .toBeGreaterThan(0)
        const inflight = (await cli(['scans', 'inflight', scan.id])).json as { items: { seq: number; workerId: string }[] }
        expect(inflight.items[0]).toMatchObject({ seq: expect.any(Number), workerId: expect.any(String) })

        const workers = (await cli(['scans', 'workers', scan.id])).json as { items: { id: string; role: string; scanId: string }[] }
        const runner = workers.items.find((w) => w.role === 'runner')
        expect(runner).toBeDefined()
        for (const worker of workers.items) expect(worker.scanId).toBe(scan.id)
        const logs = await cli(['scans', 'worker', 'logs', scan.id, runner!.id, '--max-wait', '30s'])
        expect(logs.exitCode, describeRun(logs)).toBe(0)
        expect(logs.json).toMatchObject({ text: expect.any(String) })

        const conditions = await cli(['scans', 'conditions', scan.id])
        expect(conditions.exitCode).toBe(0)
        expect(conditions.json).toMatchObject({ items: expect.any(Array) })
        const events = await cli(['scans', 'events', scan.id])
        expect(events.exitCode).toBe(0)
        expect((events.json as { items: { type: string }[] }).items.length).toBeGreaterThan(0)

        const scaled = await cli(['scans', 'scale', scan.id, '--processes', '2'])
        expect(scaled.exitCode, describeRun(scaled)).toBe(0)
        expect(scaled.json).toMatchObject({ id: scan.id, settings: { processes: 2 } })

        const paused = await cli(['scans', 'pause', scan.id])
        expect(paused.exitCode, describeRun(paused)).toBe(0)
        expect((paused.json as Scan).state).toBe('paused')
        expect((await cli(['scans', 'pause', scan.id])).exitCode).toBe(0) // idempotent
        const resumed = await cli(['scans', 'resume', scan.id])
        expect(resumed.exitCode, describeRun(resumed)).toBe(0)
        expect((resumed.json as Scan).state).toBe('running')

        const cancelled = await cli(['scans', 'cancel', scan.id])
        expect(cancelled.exitCode, describeRun(cancelled)).toBe(0)
        expect((cancelled.json as Scan).state).toBe('cancelled')
        const conflict = await cli(['scans', 'resume', scan.id])
        expect(conflict.exitCode, describeRun(conflict)).toBe(2)
        expect(errorJson(conflict)).toMatchObject({ error: { code: 'invalidState', exitCode: 2 } })

        const restarted = await cli(['scans', 'restart', scan.id, '--name', 'restarted', '--workers', '1', '--processes', '1'])
        const clone = restarted.json as Scan
        if (clone?.id) scans.track(clone.id)
        expect(restarted.exitCode, describeRun(restarted)).toBe(0)
        expect(clone).toMatchObject({
          name: 'restarted',
          clonedFrom: scan.id,
          revision: { id: throws.revision.id },
          taskConfig: { mode: 'ok', work_seconds: 60 },
        })
        expect((await cli(['scans', 'cancel', clone.id])).exitCode).toBe(0)
      }

      // retry-failed runs the failed analyses of a finished scan again in a new round; delete starts the scanDelete job
      // (its --wait would only add the job's queue time on a shared stack).
      const retryAndDelete = async () => {
        const finished = await scans.wait(failing.id, { timeoutMs: 180_000 })
        // A runner that is still stopping when the round starts reconnects with a backoff of up to 30 s; a fresh one
        // starts at once.
        const active = ['pending', 'assigned', 'pulling', 'starting', 'running', 'backoff', 'draining']
        await expect
          .poll(
            async () =>
              ok(await api.listScanWorkers(failing.id, { limit: 200 }), 'listScanWorkers')
                .items.filter((w) => active.includes(w.state))
                .map((w) => `${w.role} ${w.state}`),
            { timeout: 60_000, intervals: [500] },
          )
          .toEqual([])
        // The ingestor checks a scan's completion at most once per 10 s and skips a check inside that window
        // (docs/queue.md §6.9): round-2 results that arrive within 10 s of round 1's last check leave the completion to
        // the reconciler's 60 s recount. Starting the round after the window lets their flush complete the scan.
        const windowLeft = Date.parse(finished.completedAt!) + 10_500 - Date.now()
        if (windowLeft > 0) await new Promise((resolve) => setTimeout(resolve, windowLeft))
        const retry = await cli(['scans', 'retry-failed', failing.id])
        expect(retry.exitCode, describeRun(retry)).toBe(0)
        const again = await scantor(['scans', 'get', failing.id, '--wait', '-o', 'json'], { token: user.apiKey })
        expect(again.exitCode).toBe(1) // the analyses fail again
        expect(again.json).toMatchObject({ state: 'completed', round: 2 })

        const deleted = await cli(['scans', 'delete', failing.id])
        expect(deleted.exitCode, describeRun(deleted)).toBe(0)
        expect(deleted.json).toMatchObject({ scan: { id: failing.id }, job: { id: expect.any(String) } })
        const gone = await api.getScan(failing.id)
        expect(gone.status === 404 || ['deleting', 'deleted'].includes((gone.body as Scan).state), JSON.stringify(gone.body)).toBe(true)
      }

      await Promise.all([controls(), retryAndDelete()])
    })
  })

  test.describe('result commands', () => {
    test('uploads, analyses, export and files work against a list-template scan', { tag: ['@CLI-011'] }, async ({ user, scans, shared }) => {
      const files = await shared.example('files')
      const root = await tempDir('results')
      const token = user.apiKey
      const cli = (args: string[], input?: string) => scantor(args, { token, cwd: root, input })
      try {
        const marker = unique('item')
        await writeFile(join(root, 'items.txt'), `one\n\n  two  \n${marker}\n`)
        const upload = await cli(['uploads', 'create', 'items.txt', '-o', 'json'])
        expect(upload.exitCode, describeRun(upload)).toBe(0)
        const uploadId = (upload.json as { id: string; lines: number }).id
        expect(upload.json).toMatchObject({ lines: 3 })

        const start = await cli([
          'scans',
          'start',
          files.revision.ref,
          '--scan-config',
          JSON.stringify({ upload: uploadId }),
          '--task-config',
          '{"copies": 1}',
          '--settings',
          SMALL_RESOURCES,
          '--wait',
          '-o',
          'json',
        ])
        const scan = start.json as Scan
        if (scan?.id) scans.track(scan.id)
        expect(start.exitCode, describeRun(start)).toBe(0)
        expect(await scans.counts(scan.id)).toEqual({ succeeded: 3 })

        const query = await cli([
          'analyses',
          'query',
          scan.id,
          '--filter',
          '{"result.item": "two"}',
          '--projection',
          '{"seq": 1, "result.item": 1}',
          '-o',
          'json',
        ])
        expect(query.exitCode, describeRun(query)).toBe(0)
        expect((query.json as { items: unknown[] }).items).toEqual([{ id: `${scan.id}-1`, seq: 1, result: { item: 'two' } }])
        const aggregate = await cli(['analyses', 'aggregate', scan.id, '--pipeline', '-', '-o', 'json'], '[{"$group": {"_id": "$status", "n": {"$sum": 1}}}]')
        expect(aggregate.exitCode, describeRun(aggregate)).toBe(0)
        expect((aggregate.json as { items: unknown[] }).items).toEqual([{ _id: 'succeeded', n: 3 }])

        // Inline exports stream to stdout (or --file); --background creates an export job, and with --wait (implied by
        // --file) the command waits until it is ready and downloads it.
        const jsonl = await cli(['export', scan.id])
        expect(jsonl.exitCode, describeRun(jsonl)).toBe(0)
        expect(jsonLines(jsonl.stdout).map((row) => (row.result as { item: string }).item)).toEqual(['one', 'two', marker])
        const csv = await cli(['export', scan.id, '--format', 'csv', '--fields', 'seq,status,result.item'])
        expect(csv.exitCode, describeRun(csv)).toBe(0)
        expect(csv.stdout.trim().split(/\r?\n/)).toEqual(['seq,status,result.item', '0,succeeded,one', '1,succeeded,two', `2,succeeded,${marker}`])
        const background = await cli(['export', scan.id, '--background', '-o', 'json'])
        expect(background.exitCode, describeRun(background)).toBe(0)
        expect(background.json).toMatchObject({ id: expect.any(String), format: 'jsonl' })
        const waited = await cli(['export', scan.id, '--background', '--wait', '--format', 'csv', '--fields', 'seq', '--file', 'export.csv'])
        expect(waited.exitCode, describeRun(waited)).toBe(0)
        expect((await readFile(join(root, 'export.csv'), 'utf8')).trim().split(/\r?\n/)).toEqual(['seq', '0', '1', '2'])
        const saved = await cli(['export', scan.id, '--background', '--file', 'export.jsonl'])
        expect(saved.exitCode, describeRun(saved)).toBe(0)
        expect(jsonLines(await readFile(join(root, 'export.jsonl'), 'utf8'))).toHaveLength(3)
        const inline = await cli(['export', scan.id, '--file', 'inline.jsonl'])
        expect(inline.exitCode, describeRun(inline)).toBe(0)
        expect(jsonLines(await readFile(join(root, 'inline.jsonl'), 'utf8'))).toHaveLength(3)
        const usage = await cli(['export', scan.id, '--wait'])
        expect(usage.exitCode, describeRun(usage)).toBe(2) // --wait needs --background

        // files get downloads and verifies a file.
        const analysis = jsonLines(jsonl.stdout)[0] as { id: string; files: { id: string; name: string; sha256: string }[] }
        const file = analysis.files.find((f) => f.name === 'image.png')!
        const got = await cli(['files', 'get', analysis.id, file.id, '--file', 'pixel.png'])
        expect(got.exitCode, describeRun(got)).toBe(0)
        expect(
          createHash('sha256')
            .update(await readFile(join(root, 'pixel.png')))
            .digest('hex'),
        ).toBe(file.sha256)
        const again = await cli(['files', 'get', analysis.id, file.id, '--file', 'pixel.png'])
        expect(again.exitCode).toBe(2) // an existing file is only replaced with --force
        expect((await cli(['files', 'get', analysis.id, file.id, '--file', 'pixel.png', '--force'])).exitCode).toBe(0)
      } finally {
        await removeTree(root)
      }
    })
  })
})

test.describe('platform commands', () => {
  test('scantor push packs, uploads and publishes, and reports failed revisions', { tag: ['@DEV-015'] }, async ({ user, api, tasks }) => {
    const name = unique('push')
    const dir = await exampleVariant(ECHO, name)
    tasks.track(name)
    const broken = unique('push-broken')
    const brokenDir = await exampleVariant(ECHO, broken, { 'main.py': 'import httpx_is_not_installed\n' })
    tasks.track(broken)
    try {
      // A revision that fails on its content exits 2; its build queues together with the good one below.
      const failing = scantor(['push', brokenDir, '--wait'], { token: user.apiKey, cwd: brokenDir })

      // --no-publish creates the task and fills its workspace only.
      const upload = await scantor(['push', dir, '--no-publish', '-o', 'json'], { token: user.apiKey, cwd: dir })
      expect(upload.exitCode, describeRun(upload)).toBe(0)
      expect(upload.json).toMatchObject({ task: { name }, created: true })
      expect((upload.json as { revision?: unknown }).revision ?? null).toBeNull()
      expect(ok(await api.call<{ items: unknown[] }>('listRevisions', { path: { task: name } }), 'listRevisions').items).toEqual([])

      const published = await scantor(['push', dir, '-m', 'first push', '--wait', '-o', 'json'], { token: user.apiKey, cwd: dir })
      expect(published.exitCode, describeRun(published)).toBe(0)
      expect(published.json).toMatchObject({
        task: { name },
        revision: { ref: `${name}@1`, state: 'ready', message: 'first push', source: { kind: 'upload' } },
      })

      const failed = await failing
      expect(failed.exitCode, describeRun(failed)).toBe(2)

      // Workspace changes that were never published block an upload until --force, which replaces them.
      const edit = await scantor(['tasks', 'files', 'put', name, 'notes.txt=-'], { token: user.apiKey, input: 'edited on the platform\n' })
      expect(edit.exitCode, describeRun(edit)).toBe(0)
      await writeFiles(dir, { 'extra.txt': 'local change\n' })
      const dirty = await scantor(['push', dir, '-o', 'json'], { token: user.apiKey, cwd: dir })
      expect(dirty.exitCode, describeRun(dirty)).toBe(2)
      expect(errorJson(dirty)).toMatchObject({ error: { code: 'workspaceDirty', exitCode: 2 } })
      const forced = await scantor(['push', dir, '--force', '--no-publish', '-o', 'json'], { token: user.apiKey, cwd: dir })
      expect(forced.exitCode, describeRun(forced)).toBe(0)
      expect(forced.json).toMatchObject({ task: { name }, created: false })
      const workspace = (await scantor(['tasks', 'files', 'ls', name, '-o', 'json'], { token: user.apiKey })).json as { entries: { path: string }[] }
      expect(workspace.entries.map((e) => e.path)).toContain('extra.txt')
      expect(workspace.entries.map((e) => e.path)).not.toContain('notes.txt')

      // --wait needs a published revision; a platform failure (the API unreachable) exits 3.
      const usage = await scantor(['push', dir, '--no-publish', '--wait'], { token: user.apiKey, cwd: dir })
      expect(usage.exitCode, describeRun(usage)).toBe(2)
      const unreachable = await scantor(['push', dir, '--wait', '-o', 'json'], { token: user.apiKey, cwd: dir, env: { SCANTOR_URL: 'https://127.0.0.1:1' } })
      expect(unreachable.exitCode, describeRun(unreachable)).toBe(3)
      expect(errorJson(unreachable)).toMatchObject({ error: { code: 'platform', exitCode: 3 } })
    } finally {
      await removeTree(dir)
      await removeTree(brokenDir)
    }
  })

  test('dev run --remote syncs the folder, runs a test run and downloads its files', { tag: ['@DEV-013'] }, async ({ user, api, tasks }) => {
    const name = unique('files-remote')
    const dir = await exampleVariant(exampleTaskDir('files'), name)
    tasks.track(name)
    const probe = unique('probe-remote')
    const probeDir = await probeTask(probe)
    tasks.track(probe)
    try {
      const run = await scantor(['dev', 'run', dir, '--remote', '-o', 'json', '--scan-config', '{"items": ["x"]}', '--task-config', '{"copies": 0}'], {
        token: user.apiKey,
        cwd: dir,
      })
      expect(run.exitCode, describeRun(run)).toBe(0)
      const events = jsonLines(run.stdout) as { type: string; data: Record<string, unknown> }[]
      for (const event of events) expect(Object.keys(event).sort()).toEqual(['data', 'type'])
      const analyses = events.filter((e) => e.type === 'analysis').map((e) => e.data)
      expect(analyses.at(-1)).toMatchObject({ seq: 0, status: 'succeeded', result: expect.objectContaining({ item: 'x' }) })
      expect(events.at(-1)?.type).toBe('end')
      // The five files of the analysis were downloaded into .scantor/out.
      const outDirs = await readdir(join(dir, '.scantor', 'out'))
      expect(outDirs).toHaveLength(1)
      const downloaded = await listFiles(join(dir, '.scantor', 'out', outDirs[0]!))
      expect(downloaded.map((f) => f.split('/').pop()).sort()).toEqual(['data.json', 'image.png', 'nested.json', 'nested.png', 'notes.txt'])

      // The workspace was synced without publishing.
      expect(ok(await api.call<{ items: unknown[] }>('listRevisions', { path: { task: name } }), 'listRevisions').items).toEqual([])

      // Unsynced platform changes block the sync until --force; SCANTOR_DEV_MODE=remote selects remote mode. The local
      // folder stays as it was, so the forced sync restores the first pack and its test run reuses the draft image.
      const edit = await scantor(['tasks', 'files', 'put', name, 'notes.txt=-'], { token: user.apiKey, input: 'platform edit\n' })
      expect(edit.exitCode, describeRun(edit)).toBe(0)
      const dirty = await scantor(['dev', 'run', dir, '--scan-config', '{"items": ["y"]}', '-o', 'json'], {
        token: user.apiKey,
        cwd: dir,
        env: { SCANTOR_DEV_MODE: 'remote' },
      })
      expect(dirty.exitCode, describeRun(dirty)).toBe(2)
      expect(errorJson(dirty)).toMatchObject({ error: { code: 'workspaceDirty', exitCode: 2 } })
      const forced = await scantor(['dev', 'run', dir, '--force', '--scan-config', '{"items": ["y"]}', '--task-config', '{"copies": 0}'], {
        token: user.apiKey,
        cwd: dir,
        env: { SCANTOR_DEV_MODE: 'remote' },
      })
      expect(forced.exitCode, describeRun(forced)).toBe(0)

      // Earlier failed attempts are printed.
      const retried = await scantor(
        ['dev', 'run', probeDir, '--remote', '--analysis-config', '{"n": 3}', '--task-config', '{"fail_attempts": 1}', '--max-attempts', '2'],
        {
          token: user.apiKey,
          cwd: probeDir,
        },
      )
      expect(retried.exitCode, describeRun(retried)).toBe(0)
      expect(retried.stdout).toMatch(/attempt 1 failed: .*probe failure in attempt 1.*; retrying/)
    } finally {
      await removeTree(dir)
      await removeTree(probeDir)
    }
  })
})

test.describe('task pipeline commands', () => {
  test('task pack is deterministic and applies .dockerignore with the hard excludes', { tag: ['@PIPE-001'] }, async () => {
    const root = await tempDir('pack')
    try {
      const first = join(root, 'first')
      await cp(ECHO, first, { recursive: true })
      await writeFiles(first, {
        // scantor.yaml, Dockerfile and .dockerignore are matched here but always packed; !keep.log is an exception.
        '.dockerignore': '*.log\n!keep.log\nbuild/\nscantor.yaml\nDockerfile\n.dockerignore\n',
        'keep.log': 'kept\n',
        'drop.log': 'dropped\n',
        'build/out.bin': 'ignored\n',
        'data/a.txt': 'a\n',
        'run.sh': '#!/bin/sh\necho run\n',
        '.git/HEAD': 'ref: refs/heads/main\n',
        'sub/.git/config': '[core]\n',
        '.scantor/out/x.json': '{}\n',
        'sub/.scantor/y': 'y\n',
        'sub/nested.txt': 'nested\n',
      })
      await chmod(join(first, 'run.sh'), 0o700)
      await chmod(join(first, 'data/a.txt'), 0o600)

      const { summary, archive } = await packToFile(first, join(root, 'first.tgz'))
      const { entries, tarBytes } = await readPack(archive)
      const names = entries.map((e) => e.name.replace(/\/$/, ''))

      // The summary describes exactly this archive: the hash is over the uncompressed tar.
      expect(summary).toEqual({
        packSha256: createHash('sha256').update(tarBytes).digest('hex'),
        packBytes: archive.length,
        fileCount: entries.filter((e) => e.type === 'file').length,
        bytes: tarBytes.length,
      })

      expect(names).toEqual(
        expect.arrayContaining(['scantor.yaml', 'Dockerfile', '.dockerignore', 'keep.log', 'main.py', 'data/a.txt', 'run.sh', 'sub/nested.txt']),
      )
      for (const excluded of ['drop.log', 'build/out.bin', '.git', '.git/HEAD', 'sub/.git/config', '.scantor', 'sub/.scantor/y']) {
        expect(names, excluded).not.toContain(excluded)
      }
      // Sorted bytewise, each directory before its contents; owners, mtimes and modes normalised.
      expect([...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))).toEqual(names)
      for (const entry of entries) {
        const name = entry.name.replace(/\/$/, '')
        const parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : null
        if (parent) expect(names.indexOf(parent), `${parent} before ${name}`).toBeLessThan(names.indexOf(name))
        expect(entry, name).toMatchObject({ uid: 0, gid: 0, mtime: 0 })
        const expectedMode = entry.type === 'directory' || name === 'run.sh' ? 0o755 : 0o644
        expect(entry.mode & 0o7777, name).toBe(expectedMode)
      }

      // The same tree elsewhere, with other mtimes and permission bits, packs to the same hash.
      const second = join(root, 'second')
      await cp(first, second, { recursive: true })
      await utimes(join(second, 'main.py'), new Date('2001-02-03T04:05:06Z'), new Date('2001-02-03T04:05:06Z'))
      await chmod(join(second, 'run.sh'), 0o755)
      await chmod(join(second, 'data/a.txt'), 0o640)
      const again = await packToFile(second, join(root, 'second.tgz'))
      expect(again.summary.packSha256).toBe(summary.packSha256)

      // Content changes the hash; a change in an ignored or hard-excluded file does not.
      await writeFiles(second, { 'drop.log': 'other\n', '.git/HEAD': 'other\n' })
      expect((await packToFile(second, join(root, 'third.tgz'))).summary.packSha256).toBe(summary.packSha256)
      await writeFiles(second, { 'keep.log': 'changed\n' })
      expect((await packToFile(second, join(root, 'fourth.tgz'))).summary.packSha256).not.toBe(summary.packSha256)
    } finally {
      await removeTree(root)
    }
  })

  test('packing keeps in-tree symlinks and rejects every unsafe entry, path and cap', { tag: ['@PIPE-002'] }, async () => {
    const root = await tempDir('pack-rules')
    const variant = async (id: string) => {
      const dir = join(root, id)
      await cp(ECHO, dir, { recursive: true })
      return dir
    }
    try {
      // Relative symlinks inside the folder stay symlinks.
      const links = await variant('links')
      await symlink('main.py', join(links, 'alias.py'))
      await mkdir(join(links, 'lib'))
      await symlink('../main.py', join(links, 'lib', 'up.py'))
      const { archive } = await packToFile(links, join(root, 'links.tgz'))
      const { entries } = await readPack(archive)
      expect(entries.find((e) => e.name === 'alias.py')).toMatchObject({ type: 'symlink', linkname: 'main.py' })
      expect(entries.find((e) => e.name === 'lib/up.py')).toMatchObject({ type: 'symlink', linkname: '../main.py' })

      const cases: { id: string; prepare: (dir: string) => Promise<void>; file?: string; message: RegExp }[] = [
        { id: 'absolute-symlink', prepare: (d) => symlink('/etc/passwd', join(d, 'abs')), file: 'abs', message: /absolute path/ },
        { id: 'escaping-symlink', prepare: (d) => symlink('../../etc', join(d, 'esc')), file: 'esc', message: /outside the task folder/ },
        {
          id: 'outside-hardlink',
          prepare: async (d) => {
            const outside = join(root, 'outside.txt')
            await writeFile(outside, 'outside\n')
            await link(outside, join(d, 'hl'))
          },
          file: 'hl',
          message: /hard link/,
        },
        { id: 'fifo', prepare: (d) => mkfifo(join(d, 'pipe')), file: 'pipe', message: /named pipe/ },
        {
          id: 'socket',
          prepare: async (d) => {
            const server = createNetServer()
            await new Promise<void>((resolve) => server.listen(join(d, 'sock'), resolve))
            server.unref()
          },
          file: 'sock',
          message: /socket/,
        },
        { id: 'device', prepare: (d) => mknodChar(join(d, 'null2')), file: 'null2', message: /device/ },
        {
          id: 'invalid-utf8',
          prepare: (d) => writeFile(Buffer.concat([Buffer.from(`${d}/bad`), Buffer.from([0xff]), Buffer.from('.txt')]), 'x'),
          message: /not valid UTF-8/,
        },
        { id: 'backslash', prepare: (d) => writeFile(join(d, 'a\\b.txt'), 'x'), file: 'a\\b.txt', message: /backslash/ },
        {
          id: 'long-path',
          prepare: async (d) => {
            let dir = d
            for (let i = 0; i < 5; i++) dir = join(dir, 'z'.repeat(220))
            await mkdir(dir, { recursive: true })
            await writeFile(join(dir, 'f.txt'), 'x')
          },
          message: /1024/,
        },
      ]
      for (const c of cases) {
        const dir = await variant(c.id)
        await c.prepare(dir)
        const errors = await packErrors(dir)
        expect(errors[0]!.message, c.id).toMatch(c.message)
        if (c.file) expect(errors[0]!.file, c.id).toBe(c.file)
      }

      // Names a file system cannot hold arrive in packs: a reading pack applies the same entry rules.
      const manifest = await readFile(join(ECHO, 'scantor.yaml'), 'utf8')
      const base = [
        { name: 'scantor.yaml', content: manifest },
        { name: 'Dockerfile', content: await readFile(join(ECHO, 'Dockerfile'), 'utf8') },
        { name: 'main.py', content: 'x = 1\n' },
      ]
      const packCases: { id: string; entry: Parameters<typeof buildTarGz>[0][number]; message: RegExp }[] = [
        { id: 'long-segment', entry: { name: 's'.repeat(256), content: 'x' }, message: /segment/ },
        { id: 'nul', entry: { name: 'nul', globalPax: { path: 'a\u0000b.txt' }, content: 'x' }, message: /./ },
        { id: 'device-entry', entry: { name: 'dev', type: 'char', devmajor: 1, devminor: 3 }, message: /entry type/ },
      ]
      for (const c of packCases) {
        const file = join(root, `${c.id}.tgz`)
        await writeFile(file, await buildTarGz([...base, c.entry]))
        const errors = await packErrors(file)
        expect(errors[0]!.message, c.id).toMatch(c.message)
      }

      // The caps fail the pack and name themselves.
      const capped = await variant('caps')
      for (const [cap, value] of [
        ['SCANTOR_TASK_MAX_FILES', '3'],
        ['SCANTOR_TASK_MAX_BYTES', '1000'],
        ['SCANTOR_TASK_MAX_PACK_BYTES', '200'],
      ] as const) {
        const errors = await packErrors(capped, { [cap]: value })
        expect(errors[0]!.message, cap).toContain(cap)
      }
    } finally {
      await removeTree(root)
    }
  })

  test('the manifest rules M1–M10 report static errors with file and line', { tag: ['@PIPE-003'] }, async () => {
    const root = await tempDir('manifest-rules')
    try {
      const cases: { id: string; manifest: string; args?: string[]; line?: number; message: string | RegExp }[] = [
        { id: 'duplicate', manifest: 'scantor: 1\nname: echo\nname: echo\nlanguage: python\n', line: 3, message: 'duplicate key "name"' },
        { id: 'not-a-mapping', manifest: '- a\n- b\n', line: 1, message: 'the manifest root must be a mapping' },
        { id: 'oversized', manifest: `scantor: 1\nname: echo\nlanguage: python\ndescription: ${'x'.repeat(70_000)}\n`, message: /limit is 65536/ },
        { id: 'schema', manifest: 'scantor: 1\nname: echo\nlanguage: python\ndefaults:\n  timeout: 5x\n', line: 5, message: /^\/defaults\/timeout: / },
        { id: 'unknown-key', manifest: 'scantor: 1\nname: echo\nlanguage: python\n$schema: x\n', line: 4, message: /\$schema/ },
        { id: 'language', manifest: 'scantor: 1\nname: echo\nlanguage: rust\n', line: 3, message: /^\/language: / },
        {
          id: 'entry',
          manifest: 'scantor: 1\nname: echo\nlanguage: typescript\nentry: src/main.rs\n',
          line: 4,
          message: 'entry "src/main.rs" must end in .ts or .mts',
        },
        {
          id: 'backoff',
          manifest: 'scantor: 1\nname: echo\nlanguage: python\ndefaults:\n  backoff:\n    initial: 5s\n    max: 2s\n',
          line: 7,
          message: '/defaults/backoff/max: 2s is shorter than initial 5s',
        },
        {
          id: 'memory',
          manifest: 'scantor: 1\nname: echo\nlanguage: python\ndefaults:\n  resources:\n    memory: 1000KiB\n',
          line: 6,
          message: /whole number of MiB/,
        },
        {
          id: 'limits',
          manifest: 'scantor: 1\nname: echo\nlanguage: python\ndefaults:\n  processes: 200\n',
          line: 5,
          message: "/defaults/processes: 200 exceeds this instance's maximum 64",
        },
        {
          id: 'rename',
          manifest: 'scantor: 1\nname: echo2\nlanguage: python\n',
          args: ['--expect-name', 'echo'],
          line: 2,
          message: 'name "echo2" does not match task "echo"; task names are immutable',
        },
        { id: 'privileged', manifest: 'scantor: 1\nname: echo\nlanguage: python\ndefaults:\n  privileged: true\n', line: 5, message: /canRunPrivileged/ },
      ]
      for (const c of cases) {
        const dir = join(root, c.id)
        await cp(ECHO, dir, { recursive: true })
        await writeFiles(dir, { 'scantor.yaml': c.manifest })
        const run = await scantor(['task', 'check-static', dir, ...(c.args ?? [])])
        expect(run.exitCode, `${c.id}: ${describeRun(run)}`).toBe(2)
        const result = pipelineResult(run.stdout)
        const error = result.errors[0]!
        expect(error, c.id).toMatchObject({ phase: 'static', file: 'scantor.yaml' })
        if (c.line !== undefined) expect(error.line, c.id).toBe(c.line)
        if (typeof c.message === 'string') expect(error.message, c.id).toContain(c.message)
        else expect(error.message, c.id).toMatch(c.message)
      }
    } finally {
      await removeTree(root)
    }
  })

  test('the required files are checked and a valid manifest is normalised', { tag: ['@PIPE-004'] }, async () => {
    const root = await tempDir('required-files')
    try {
      const manifest = await readFile(join(ECHO, 'scantor.yaml'), 'utf8')
      const cases: { id: string; files: Record<string, string | null>; file: string }[] = [
        { id: 'yml', files: { 'scantor.yaml': null, 'scantor.yml': manifest }, file: 'scantor.yaml' },
        { id: 'dockerfile', files: { Dockerfile: null }, file: 'Dockerfile' },
        { id: 'entry', files: { 'main.py': null }, file: 'main.py' },
      ]
      for (const c of cases) {
        const dir = join(root, c.id)
        await cp(ECHO, dir, { recursive: true })
        await writeFiles(dir, c.files)
        const run = await scantor(['task', 'check-static', dir])
        expect(run.exitCode, `${c.id}: ${describeRun(run)}`).toBe(2)
        const errors = pipelineResult(run.stdout).errors
        expect(
          errors.some((e) => e.phase === 'static' && (e.file === c.file || e.message.includes(c.file))),
          JSON.stringify(errors),
        ).toBe(true)
      }

      const dir = join(root, 'normalised')
      await cp(ECHO, dir, { recursive: true })
      await writeFiles(dir, { 'scantor.yaml': `${manifest}defaults:\n  timeout: 2m\n  resources:\n    memory: 768MiB\n  backoff:\n    initial: 10s\n` })
      const run = await scantor(['task', 'check-static', dir])
      expect(run.exitCode, describeRun(run)).toBe(0)
      const result = pipelineResult(run.stdout)
      expect(result).toMatchObject({ ok: true, language: 'python', privileged: false, errors: [] })
      expect(result.manifest).toMatchObject({
        scantor: 1,
        name: 'echo',
        language: 'python',
        entry: 'main.py',
        defaults: { timeout: '2m', resources: { memory: '768MiB' } },
      })
      expect(result.settingsDefaults).toEqual({
        workers: 1,
        processes: 1,
        timeoutMs: 120_000,
        maxAttempts: 3,
        backoff: { initialMs: 10_000, factor: 2, maxMs: 600_000, jitter: true },
        resources: { cpus: 1, memoryMiB: 768 },
        maxAnalysesPerProcess: 1000,
        privileged: false,
      })
    } finally {
      await removeTree(root)
    }
  })

  test('Dockerfile warnings W1–W3 never fail the build', { tag: ['@PIPE-005'] }, async () => {
    const name = unique('warnings')
    const dockerfile = await readFile(join(ECHO, 'Dockerfile'), 'utf8')
    const dir = await exampleVariant(ECHO, name, {
      Dockerfile: `${dockerfile}ENV SCANTOR_CHECK_CMD="python -m scantor.check {entry}"\nCMD ["python"]\nENTRYPOINT ["python"]\nHEALTHCHECK NONE\nSTOPSIGNAL SIGKILL\n`,
      '.dockerignore': null,
    })
    try {
      const run = await scantor(['validate', dir, '-o', 'json'], { cwd: dir })
      expect(run.exitCode, describeRun(run)).toBe(0)
      const result = pipelineResult(run.stdout)
      expect(result.ok).toBe(true)
      const expected = [
        /CMD is ignored; the runtime is the entrypoint \(W1\)/,
        /ENTRYPOINT .*\(W1\)/,
        /HEALTHCHECK .*\(W1\)/,
        /STOPSIGNAL .*\(W1\)/,
        /SCANTOR_CHECK_CMD.*\(W2\)/,
        /\.dockerignore.*\(W3\)/,
      ]
      const logged = pipelineEvents(run.stdout)
        .filter((e) => e.type === 'log' && e.level === 'warning')
        .map((e) => String(e.text))
      for (const pattern of expected) {
        expect(
          result.warnings.some((w) => pattern.test(w)),
          `${pattern} in ${JSON.stringify(result.warnings)}`,
        ).toBe(true)
        expect(
          logged.some((w) => pattern.test(w)),
          `${pattern} in the log`,
        ).toBe(true)
      }
    } finally {
      await removeDevImages(name)
      await removeTree(dir)
    }
  })

  test('the build pulls an absent base image anonymously and pins it by digest', { tag: ['@PIPE-006'] }, async ({ docker: inner, env }) => {
    // A throwaway registry without authentication serves a copy of the Python base image under a reference the
    // daemon does not have; SCANTOR_IMAGE_PREFIX and SCANTOR_IMAGE_TAG make the pipeline use that reference.
    const name = unique('base-pull')
    const registry = unique('scantor-test-registry')
    const tag = unique('pull')
    const base = (JSON.parse(await readFile(join(env.paths.repo, 'schemas', 'languages.json'), 'utf8')) as { languages: Record<string, { image: string }> })
      .languages.python!.image
    // The registry image of the stack, so nothing is pulled.
    const registryImage = (await inner.inspect<{ Config: { Image: string } }>(CONTAINERS.registry)).Config.Image
    const dir = await exampleVariant(ECHO, name)
    let ref: string | undefined
    try {
      await docker(['run', '--detach', '--name', registry, '--label', 'scantor.test=true', '--publish', '127.0.0.1::5000', registryImage])
      const port = (await docker(['port', registry, '5000/tcp'])).stdout.trim().split('\n')[0]!.split(':').pop()!
      const prefix = `127.0.0.1:${port}/`
      await expect
        .poll(async () => (await fetch(`http://${prefix}v2/`).catch(() => undefined))?.status, { timeout: 30_000, intervals: [250] })
        .toBe(200)
      ref = `${prefix}${base}:${tag}`
      await docker(['tag', `${base}:dev`, ref])
      await docker(['push', ref], { timeoutMs: 180_000 })
      // Untagging leaves the base image of the stack (scantor-base-python:dev) in place.
      await docker(['rmi', ref])

      const run = await scantor(['validate', dir, '-o', 'json'], { cwd: dir, env: { SCANTOR_IMAGE_PREFIX: prefix, SCANTOR_IMAGE_TAG: tag } })
      expect(run.exitCode, describeRun(run)).toBe(0)
      const logged = pipelineEvents(run.stdout).filter((e) => e.phase === 'build' && e.type === 'log').map((e) => String(e.text))
      expect(logged, 'the pull').toContain(`pulling the base image ${ref}`)

      // The pulled base is pinned by its registry digest, and the image records its platform.
      const repoDigests = JSON.parse((await docker(['image', 'inspect', ref, '--format', '{{json .RepoDigests}}'])).stdout) as string[]
      const pinned = repoDigests.find((d) => d.startsWith(`${prefix}${base}@sha256:`))
      expect(pinned, JSON.stringify(repoDigests)).toBeDefined()
      const result = pipelineResult(run.stdout)
      expect(result.baseImage).toEqual({ ref, digest: pinned!.slice(pinned!.indexOf('@') + 1) })
      expect(logged).toContain(`base image ${ref} (${result.baseImage!.digest})`)
      expect(result.image?.platform).toMatchObject({ os: 'linux', arch: expect.stringMatching(/^(amd64|arm64)$/) })
    } finally {
      await docker(['rm', '--force', '--volumes', registry], { allowFailure: true })
      if (ref) await docker(['rmi', ref], { allowFailure: true })
      await removeDevImages(name)
      await removeTree(dir)
    }
  })

  test('the check phase turns type-checker diagnostics into check errors', { tag: ['@PIPE-007'] }, async () => {
    const name = unique('power-typo')
    const source = await readFile(join(exampleTaskDir('power'), 'main.js'), 'utf8')
    const lines = source.split('\n')
    const index = lines.findIndex((line) => line.includes('BigInt(taskConfig.exponent)'))
    expect(index).toBeGreaterThanOrEqual(0)
    const column = lines[index]!.indexOf('taskConfig.exponent') + 'taskConfig.'.length + 1
    // A property with no similar name gives TS2339 (a near miss would be TS2551 "Did you mean").
    lines[index] = lines[index]!.replace('taskConfig.exponent', 'taskConfig.scale')
    const dir = await exampleVariant(exampleTaskDir('power'), name, { 'main.js': lines.join('\n') })
    try {
      const human = await scantor(['validate', dir], { cwd: dir })
      expect(human.exitCode, describeRun(human)).toBe(2)
      expect(human.stdout + human.stderr).toContain(`[check] main.js:${index + 1}:${column}: TS2339`)

      const json = await scantor(['validate', dir, '-o', 'json'], { cwd: dir })
      expect(json.exitCode).toBe(2)
      const result = pipelineResult(json.stdout)
      expect(result.ok).toBe(false)
      expect(result.errors).toEqual([
        expect.objectContaining({ phase: 'check', file: 'main.js', line: index + 1, column, message: expect.stringContaining('TS2339') }),
      ])
    } finally {
      await removeDevImages(name)
      await removeTree(dir)
    }
  })

  test('pipeline events are versioned NDJSON ending in the result', { tag: ['@PIPE-010'] }, async () => {
    const name = unique('events')
    const main = await readFile(join(ECHO, 'main.py'), 'utf8')
    // A 40 KiB line printed while the module loads arrives as describe log events of at most 16 KiB each.
    const dir = await exampleVariant(ECHO, name, { 'main.py': `print("x" * 40000)\n${main}` })
    try {
      const run = await scantor(['validate', dir, '-o', 'json'], { cwd: dir })
      expect(run.exitCode, describeRun(run)).toBe(0)
      const events = pipelineEvents(run.stdout)
      expect(events.length).toBeGreaterThan(3)
      events.forEach((event, i) => {
        expect(event.v).toBe(1)
        expect(event.seq).toBe(i)
        expect(String(event.at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
        expect(['pack', 'static', 'build', 'describe', 'check', 'push', 'platform']).toContain(event.phase)
        expect(['log', 'error', 'result']).toContain(event.type)
        if (event.type === 'log') {
          expect(['pipeline', 'build', 'stdout', 'stderr', 'check']).toContain(event.stream)
          expect(Buffer.byteLength(String(event.text))).toBeLessThanOrEqual(16 * 1024)
          if (event.level !== undefined) expect(['info', 'warning']).toContain(event.level)
        }
      })
      const printed = events.filter((e) => e.phase === 'describe' && e.type === 'log' && /^x+$/.test(String(e.text)))
      expect(printed.length).toBeGreaterThanOrEqual(3)
      expect(printed.reduce((n, e) => n + String(e.text).length, 0)).toBe(40_000)

      const last = events.at(-1)!
      expect(last.type).toBe('result')
      expect(Object.keys(last.result as object).sort()).toEqual(
        [
          'ok',
          'pack',
          'manifest',
          'settingsDefaults',
          'language',
          'privileged',
          'baseImage',
          'image',
          'description',
          'errors',
          'warnings',
          'durationsMs',
        ].sort(),
      )
      expect(last.result).toMatchObject({ ok: true, errors: [], language: 'python' })
    } finally {
      await removeDevImages(name)
      await removeTree(dir)
    }
  })

  test('pipeline commands exit 0, 2 for invalid content and 3 for platform failures', { tag: ['@PIPE-011'] }, async () => {
    const name = unique('exits')
    const dir = await exampleVariant(ECHO, name)
    const broken = await exampleVariant(ECHO, unique('exits-broken'), { Dockerfile: 'FROM python:3\n' })
    const root = await tempDir('exits')
    try {
      const tag = `scantor-dev/${name}:pipeline`
      const ok = await Promise.all([
        scantor(['task', 'pack', dir]),
        scantor(['task', 'check-static', dir]),
        scantor(['task', 'build', dir, '--tag', tag, '--skip-check']),
        scantor(['validate', dir], { cwd: dir }),
      ])
      for (const run of ok) expect(run.exitCode, describeRun(run)).toBe(0)

      const invalid = await Promise.all([
        scantor(['task', 'pack', join(root, 'missing')]),
        scantor(['task', 'check-static', broken]),
        scantor(['task', 'build', broken, '--tag', `scantor-dev/${name}:broken`]),
        scantor(['validate', broken], { cwd: broken }),
      ])
      for (const run of invalid) expect(run.exitCode, describeRun(run)).toBe(2)

      // Docker unreachable and a push without the registry credential are platform failures.
      const unreachable = { DOCKER_HOST: `unix://${join(root, 'no-docker.sock')}` }
      const platform = await Promise.all([
        scantor(['validate', dir], { cwd: dir, env: unreachable }),
        scantor(['task', 'build', dir, '--tag', tag, '--skip-check'], { env: unreachable }),
        scantor(['task', 'build', dir, '--tag', `localhost:5000/tasks/${name}:x`, '--skip-check', '--reuse-existing', '--push']),
      ])
      for (const run of platform) expect(run.exitCode, describeRun(run)).toBe(3)
    } finally {
      await removeDevImages(name)
      await docker(['rmi', '--force', `localhost:5000/tasks/${name}:x`], { allowFailure: true })
      await removeTree(dir)
      await removeTree(broken)
      await removeTree(root)
    }
  })
})

function run(file: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => execFile(file, args, (error) => (error ? reject(error) : resolve())))
}

const mkfifo = (path: string) => run('mkfifo', [path])

/** A character device (the runner is privileged and runs as root). */
async function mknodChar(path: string): Promise<void> {
  await run('mknod', [path, 'c', '1', '3'])
  expect((await stat(path)).isCharacterDevice()).toBe(true)
}

test.describe('templates estimate', () => {
  test('templates estimate applies the defaults and validates the scan config', { tag: ['@CAT-009'] }, async () => {
    const root = await tempDir('estimate')
    try {
      const estimate = async (args: string[], input?: string) => {
        const run = await scantor(['templates', 'estimate', ...args], { cwd: root, input })
        return { exitCode: run.exitCode, out: JSON.parse(run.stdout) as Record<string, unknown>, run }
      }
      expect(await estimate(['range', '--config', '{"end": 4}'])).toMatchObject({ exitCode: 0, out: { expectedTotal: 4, exact: true } })
      // Without --config the defaults apply (range 0…10).
      expect(await estimate(['range'])).toMatchObject({ exitCode: 0, out: { expectedTotal: 10, exact: true } })
      await writeFile(join(root, 'repeat.json'), '{"times": 7}')
      expect(await estimate(['repeat', '--config', '@repeat.json'])).toMatchObject({ exitCode: 0, out: { expectedTotal: 7, exact: true } })
      expect(await estimate(['cidr', '--scan-config', '-'], '{"cidrs": ["10.0.0.0/29"]}')).toMatchObject({
        exitCode: 0,
        out: { expectedTotal: 8, exact: true },
      })
      expect(await estimate(['crux'])).toMatchObject({ exitCode: 0, out: { expectedTotal: 1000, exact: false } })

      // Uploads are counted with --upload <id>=<lines>; an upload without its count is an issue.
      const upload = '4e3d2c1b-0a9f-4e8d-8c7b-6a5f4e3d2c1b'
      expect(await estimate(['list', '--config', JSON.stringify({ items: ['a'], upload }), '--upload', `${upload}=7`])).toMatchObject({
        exitCode: 0,
        out: { expectedTotal: 8, exact: true },
      })
      expect(await estimate(['list', '--config', JSON.stringify({ upload })])).toMatchObject({
        exitCode: 2,
        out: { issues: [{ path: '/upload', message: expect.stringContaining(upload) }] },
      })

      // Invalid scan configs exit 2 with the issues as JSON.
      expect(await estimate(['range', '--config', '{"step": 0}'])).toMatchObject({
        exitCode: 2,
        out: { issues: [{ path: '/step', message: 'must not be 0' }] },
      })
      const unknown = await estimate(['range', '--config', '{"stop": 3}'])
      expect(unknown.exitCode).toBe(2)
      expect(unknown.out.issues).toEqual([expect.objectContaining({ path: '', message: expect.stringContaining('stop') })])
    } finally {
      await removeTree(root)
    }
  })
})

/** A syntactically valid node token (snt_ + 43 base64url characters) that no orchestrator knows. */
const FAKE_NODE_TOKEN = `snt_${Buffer.alloc(32, 7).toString('base64url')}`

test.describe('node daemon command', () => {
  test('scantor node healthcheck follows the age of the status file', { tag: ['@NODE-029'] }, async ({ docker: inner }) => {
    // No status report yet: unhealthy, and no configuration is needed to say so.
    const none = await docker(['run', '--rm', '--label', 'scantor.test=true', 'scantor:dev', 'node', 'healthcheck'], { allowFailure: true })
    expect(none.exitCode, none.stderr).toBe(1)
    expect(none.stderr).toContain('no successful status report yet')

    const check = async (ageMs: number, intervalMs: number) => {
      const name = unique('scantor-test-healthcheck')
      const status = JSON.stringify({ at: Date.now() - ageMs, nodeId: 'test', statusIntervalMs: intervalMs })
      await docker([
        'create',
        '--interactive',
        '--name',
        name,
        '--label',
        'scantor.test=true',
        '--entrypoint',
        'sh',
        'scantor:dev',
        '-c',
        'cat > /tmp/scantor-node.status && exec scantor node healthcheck',
      ])
      try {
        await docker(['start', '-a', '-i', name], { input: status, allowFailure: true })
        const state = await inner.inspect<{ State: { ExitCode: number } }>(name)
        return state.State.ExitCode
      } finally {
        await docker(['rm', '--force', name], { allowFailure: true })
      }
    }
    expect(await check(1000, 10_000)).toBe(0) // younger than three intervals
    expect(await check(29_000, 10_000)).toBe(0)
    expect(await check(31_000, 10_000)).toBe(1) // three intervals or older
    expect(await check(4000, 1000)).toBe(1) // the interval comes from the file

    // It is the healthcheck of the compose service and of the join snippet.
    const node = await inner.inspect<{ Config: { Healthcheck: { Test: string[] } }; State: { Health: { Status: string } } }>('scantor-node')
    expect(node.Config.Healthcheck.Test).toEqual(['CMD', '/usr/local/bin/scantor', 'node', 'healthcheck'])
    expect(node.State.Health.Status).toBe('healthy')
    const live = await inner.exec('scantor-node', ['scantor', 'node', 'healthcheck'])
    expect(live.exitCode, live.stderr).toBe(0)
  })

  test('scantor node exits 2 on invalid configuration and refuses plaintext to public addresses', { tag: ['@NODE-030'] }, async ({ docker: inner }) => {
    const node = (env: Record<string, string>) =>
      docker(['run', '--rm', '--label', 'scantor.test=true', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), 'scantor:dev', 'node'], {
        allowFailure: true,
        timeoutMs: 60_000,
      })
    const cases: { env: Record<string, string>; message: RegExp }[] = [
      {
        env: { SCANTOR_NODE_BUILTIN: 'true', SCANTOR_NODE_TOKEN: FAKE_NODE_TOKEN, SCANTOR_SECRET: 'x' },
        message: /SCANTOR_NODE_TOKEN: must not be set together with SCANTOR_NODE_BUILTIN=true/,
      },
      { env: { SCANTOR_NODE_TOKEN: FAKE_NODE_TOKEN, SCANTOR_NODE_DIND: 'maybe' }, message: /SCANTOR_NODE_DIND/ },
      { env: { SCANTOR_NODE_TOKEN: FAKE_NODE_TOKEN, SCANTOR_NODE_EGRESS_DENY: '10.0.0.1/8' }, message: /SCANTOR_NODE_EGRESS_DENY: invalid CIDR/ },
      {
        env: { SCANTOR_NODE_TOKEN: FAKE_NODE_TOKEN, SCANTOR_URL: 'http://203.0.113.10:3000' },
        message: /SCANTOR_URL: .*plaintext transport to a public address is refused/,
      },
    ]
    for (const c of cases) {
      const run = await node(c.env)
      expect(run.exitCode, `${JSON.stringify(c.env)}: ${run.stderr}`).toBe(2)
      expect(run.stderr).toMatch(c.message)
    }

    // With SCANTOR_ALLOW_INSECURE_TRANSPORT=true the same URL passes the start-up checks: the daemon goes on to wait
    // for Docker (no socket in this container) instead of exiting.
    const name = unique('scantor-test-insecure-node')
    await docker([
      'run',
      '--detach',
      '--name',
      name,
      '--label',
      'scantor.test=true',
      '-e',
      `SCANTOR_NODE_TOKEN=${FAKE_NODE_TOKEN}`,
      '-e',
      'SCANTOR_URL=http://203.0.113.10:3000',
      '-e',
      'SCANTOR_ALLOW_INSECURE_TRANSPORT=true',
      'scantor:dev',
      'node',
    ])
    try {
      await expect.poll(async () => inner.logs(name), { timeout: 30_000 }).toContain('Docker is not available yet; retrying')
      const state = await inner.inspect<{ State: { Running: boolean } }>(name)
      expect(state.State.Running).toBe(true)
      expect(await inner.logs(name)).not.toContain('plaintext transport')
    } finally {
      await docker(['rm', '--force', name], { allowFailure: true })
    }
  })
})

/** `scantor dev run <dir> -o json …` with the runner's binary; returns the run and its local-mode events. */
async function devRun(dir: string, args: string[], options: { env?: Record<string, string>; input?: string } = {}) {
  const run = await scantor(['dev', 'run', dir, '-o', 'json', ...args], { cwd: dir, env: options.env, input: options.input })
  return { run, events: localEvents(run.stdout), results: localResults(run.stdout) }
}

/** A copy of tasks/echo whose main.py is the probe task (helpers/e2e-examples-cli-tasks.ts). */
const probeTask = (name: string) => exampleVariant(ECHO, name, { 'main.py': PROBE_MAIN_PY })

test.describe('local development loop', () => {
  test('scantor init writes a scaffold, derives the name and refuses non-empty folders', { tag: ['@DEV-001'] }, async () => {
    const root = await tempDir('init')
    try {
      const none = await scantor(['init', '--language', 'python'], { cwd: root })
      expect(none.exitCode, describeRun(none)).toBe(2)
      expect(none.stderr).toContain('give a directory or --name')

      const created = await scantor(['init', 'My_Task', '--language', 'go', '--template', 'cidr', '--description', 'hello world'], { cwd: root })
      expect(created.exitCode, describeRun(created)).toBe(0)
      expect(created.stdout).toContain('Created task "my-task" (go, template cidr) in My_Task')
      expect(created.stdout).toContain('scantor dev run My_Task')
      expect(parseYaml(await readFile(join(root, 'My_Task', 'scantor.yaml'), 'utf8'))).toEqual({
        scantor: 1,
        name: 'my-task',
        language: 'go',
        description: 'hello world',
      })
      expect(await readFile(join(root, 'My_Task', 'main.go'), 'utf8')).toContain('cidr.Schedule')

      // dir defaults to ./<name>, the template to single.
      const named = await scantor(['init', '--name', 'only-name', '--language', 'python', '-o', 'json'], { cwd: root })
      expect(named.exitCode, describeRun(named)).toBe(0)
      expect(named.json).toMatchObject({ dir: join(root, 'only-name'), name: 'only-name', language: 'python', template: 'single' })
      expect((named.json as { files: string[] }).files).toEqual(expect.arrayContaining(['scantor.yaml', 'Dockerfile', 'main.py', 'AGENTS.md']))
      expect(await readFile(join(root, 'only-name', 'main.py'), 'utf8')).not.toContain('schedule=')

      const again = await scantor(['init', 'My_Task', '--language', 'go'], { cwd: root })
      expect(again.exitCode).toBe(2)
      expect(again.stderr).toContain('already exists and is not empty')
      await mkdir(join(root, 'empty'))
      const empty = await scantor(['init', 'empty', '--language', 'javascript', '--template', 'range'], { cwd: root })
      expect(empty.exitCode, describeRun(empty)).toBe(0)

      const unknown = await Promise.all([
        scantor(['init', 'x', '--language', 'rust'], { cwd: root }),
        scantor(['init', 'y', '--language', 'python', '--template', 'nope'], { cwd: root }),
      ])
      for (const run of unknown) expect(run.exitCode, describeRun(run)).toBe(2)
    } finally {
      await removeTree(root)
    }
  })

  test('scantor validate runs every publish check locally with the server verdicts', { tag: ['@DEV-004'] }, async ({ tasks }) => {
    const name = unique('validate')
    const dir = await exampleVariant(ECHO, name, { 'scantor.yaml': `scantor: 1\nname: ${name}\nlanguage: python\ndefaults:\n  privileged: true\n` })
    const policyName = unique('validate-policy')
    const dockerfile = await readFile(join(ECHO, 'Dockerfile'), 'utf8')
    const policy = await exampleVariant(ECHO, policyName, {
      Dockerfile: `${dockerfile}ADD https://example.com/x.tar.gz /x\nRUN --mount=type=cache,target=/root/.cache true\n`,
    })
    try {
      // The server publish of the policy variant queues while the local checks run.
      const published = tasks.upload(policy, { expectState: 'failed' })
      published.catch(() => undefined) // awaited below; this only keeps an early failure from going unhandled

      // Privileged tasks are accepted locally; every phase runs; nothing is pushed.
      const [run, local] = await Promise.all([
        scantor(['validate', dir, '-o', 'json'], { cwd: dir }),
        scantor(['validate', policy, '-o', 'json'], { cwd: policy }),
      ])
      expect(run.exitCode, describeRun(run)).toBe(0)
      const result = pipelineResult(run.stdout)
      expect(result).toMatchObject({ ok: true, privileged: true, errors: [] })
      // Every phase ran (the static checks log nothing when they pass, their duration shows them); none pushed.
      expect(Object.keys(result.durationsMs)).toEqual(expect.arrayContaining(['pack', 'static', 'build', 'describe', 'check']))
      expect(Object.keys(result.durationsMs)).not.toContain('push')
      const phases = new Set(pipelineEvents(run.stdout).map((e) => e.phase))
      for (const phase of ['pack', 'build', 'describe', 'check']) expect([...phases]).toContain(phase)
      expect([...phases]).not.toContain('push')
      expect(result.image?.ref).toBe(`scantor-dev/${name}:${result.pack!.packSha256.slice(0, 12)}`)
      const privileged = await scantor(['task', 'check-static', dir])
      expect(privileged.exitCode).toBe(2) // without --allow-privileged, as on the server for users without the permission

      // Docker unreachable is a platform failure.
      const unreachable = await scantor(['validate', dir], { cwd: dir, env: { DOCKER_HOST: `unix://${join(dir, 'no-docker.sock')}` } })
      expect(unreachable.exitCode, describeRun(unreachable)).toBe(3)

      // The Dockerfile policy gives the same verdicts and messages as a server publish.
      expect(local.exitCode, describeRun(local)).toBe(2)
      const localErrors = pipelineResult(local.stdout).errors
      expect(localErrors.map((e) => e.message).join('\n')).toMatch(/D7/)
      expect(localErrors.map((e) => e.message).join('\n')).toMatch(/D8/)
      const serverErrors = (await published).revision.errors.map(({ phase, file, line, column, message }) => ({ phase, file, line, column, message }))
      expect(serverErrors).toEqual(localErrors.map(({ phase, file, line, column, message }) => ({ phase, file, line, column, message })))
    } finally {
      await removeDevImages(name)
      await removeDevImages(policyName)
      await removeTree(dir)
      await removeTree(policy)
    }
  })

  test('validate and dev debug need local Docker under SCANTOR_DEV_MODE=remote', { tag: ['@DEV-005'] }, async () => {
    const remote = { SCANTOR_DEV_MODE: 'remote' }
    const validate = await scantor(['validate', ECHO], { env: remote })
    expect(validate.exitCode, describeRun(validate)).toBe(3)
    expect(validate.stderr).toContain('validate needs local Docker')
    const debug = await scantor(['dev', 'debug', ECHO], { env: remote })
    expect(debug.exitCode, describeRun(debug)).toBe(3)
    expect(debug.stderr).toContain('debugging needs local Docker')
    const json = await scantor(['validate', ECHO, '-o', 'json'], { env: remote })
    expect(json.exitCode).toBe(3)
    expect(errorJson(json)).toEqual({ error: expect.objectContaining({ code: 'platform', exitCode: 3, message: expect.stringContaining('local Docker') }) })
  })

  test('dev run takes configs inline, from files and stdin and honours limit, attempts and timeout', { tag: ['@DEV-006'] }, async () => {
    const name = unique('throws-dev')
    const dir = await exampleVariant(exampleTaskDir('throws'), name)
    try {
      await writeFile(join(dir, 'flaky.json'), '{"mode": "flaky", "fail_attempts": 1}')
      const flaky = await scantor(['dev', 'run', dir, '--scan-config', '{"end": 1}', '--task-config', `@${join(dir, 'flaky.json')}`, '--max-attempts', '2'], {
        cwd: dir,
      })
      expect(flaky.exitCode, describeRun(flaky)).toBe(0)
      expect(flaky.stdout).toContain('[#0] attempt 1 failed: taskError: RuntimeError: demo failure in attempt 1; retrying')
      expect(flaky.stdout).toMatch(/\[#0\] succeeded \(attempt 2/)

      const timeout = await scantor(['dev', 'run', dir, '--scan-config', '{"end": 1}', '--task-config', '{"mode": "timeout"}', '--timeout', '2s'], { cwd: dir })
      expect(timeout.exitCode, describeRun(timeout)).toBe(1)
      expect(timeout.stdout).toContain('run exceeded 2000 ms')

      const invalid = await scantor(['dev', 'run', dir, '--task-config', '{"mode": "nope"}'], { cwd: dir })
      expect(invalid.exitCode, describeRun(invalid)).toBe(2)
      expect(invalid.stdout + invalid.stderr).toContain('taskConfig /mode')

      // --limit defaults to 5; the task config from stdin.
      const limited = await devRun(dir, ['--scan-config', '{"end": 7}', '--task-config', '-'], { input: '{"mode": "ok"}' })
      expect(limited.run.exitCode, describeRun(limited.run)).toBe(0)
      expect(limited.results.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4])
      expect(limited.events.at(-1)).toMatchObject({ type: 'end', reason: 'limit' })

      const single = await devRun(dir, ['--analysis-config', '{"value": 42}', '--task-config', '{"mode": "ok"}'])
      expect(single.run.exitCode, describeRun(single.run)).toBe(0)
      expect(single.results).toEqual([expect.objectContaining({ seq: 0, status: 'succeeded', result: { value: 42, attempt: 1 } })])
    } finally {
      await removeDevImages(name)
      await removeTree(dir)
    }
  })

  test('local runs use the configured data sources and refuse uploads', { tag: ['@DEV-007'] }, async () => {
    const origins = unique('origins-dev')
    const crux = unique('http-status-dev')
    const files = unique('files-dev')
    const originsDir = await exampleVariant(exampleTaskDir('origins'), origins)
    const cruxDir = await exampleVariant(exampleTaskDir('http-status'), crux)
    const filesDir = await exampleVariant(exampleTaskDir('files'), files)
    try {
      // The three folders build and run at the same time.
      const trancoRuns = async () => {
        const tranco = await devRun(originsDir, ['--scan-config', '{"limit": 2}'])
        expect(tranco.run.exitCode, describeRun(tranco.run)).toBe(0)
        const resolved = tranco.events.find((e) => e.type === 'resolved')
        expect(resolved).toMatchObject({ template: 'tranco', provenance: { sourceUrl: expect.stringContaining(FIXTURE_DATA_SOURCES.SCANTOR_TRANCO_URL) } })
        expect(tranco.results.map((r) => (r.config as { origin: string }).origin)).toEqual(['https://site1.example', 'https://site2.example'])

        const elsewhere = await devRun(originsDir, ['--scan-config', '{"limit": 2}'], { env: { SCANTOR_TRANCO_URL: 'http://127.0.0.1:9/tranco' } })
        expect(elsewhere.run.exitCode, describeRun(elsewhere.run)).toBe(1)
        expect(JSON.stringify(elsewhere.events.find((e) => e.type === 'error'))).toContain('http://127.0.0.1:9/tranco')
      }

      const cruxRun = async () => {
        const run = await devRun(cruxDir, ['--limit', '1', '--task-config', '{"timeoutMs": 1000}'])
        expect(run.run.exitCode, describeRun(run.run)).toBe(0)
        expect(JSON.stringify(run.events.find((e) => e.type === 'resolved'))).toContain(FIXTURE_DATA_SOURCES.SCANTOR_CRUX_URL)
      }

      const uploadRun = async () => {
        const upload = await scantor(['dev', 'run', filesDir, '--scan-config', '{"upload": "4e3d2c1b-0a9f-4e8d-8c7b-6a5f4e3d2c1b"}'], { cwd: filesDir })
        expect(upload.exitCode, describeRun(upload)).toBe(2)
        expect(upload.stderr).toContain('local runs cannot read platform uploads')
      }

      await settleAll([trancoRuns(), cruxRun(), uploadRun()])
    } finally {
      for (const name of [origins, crux, files]) await removeDevImages(name)
      for (const dir of [originsDir, cruxDir, filesDir]) await removeTree(dir)
    }
  })

  test('dev run -o json prints the local-mode events', { tag: ['@DEV-008', '@CONN-004'] }, async () => {
    const probe = unique('probe-events')
    const throws = unique('throws-events')
    const probeDir = await probeTask(probe)
    const throwsDir = await exampleVariant(exampleTaskDir('throws'), throws)
    try {
      const run = await devRun(probeDir, ['--scan-config', '{"count": 2}', '--task-config', '{"fail_attempts": 1}', '--max-attempts', '2'])
      expect(run.run.exitCode, describeRun(run.run)).toBe(0)
      // Every stdout line is a JSON local-mode event (the task-pipeline events go to stderr).
      for (const line of run.run.stdout.trim().split('\n')) expect(() => JSON.parse(line), line).not.toThrow()
      const types = run.events.map((e) => e.type)
      expect(types[0]).toBe('start')
      expect(types.at(-1)).toBe('end')
      for (const type of types) expect(['start', 'resolved', 'scheduled', 'log', 'attempt', 'result', 'error', 'end']).toContain(type)
      const iso = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(run.events[0]).toMatchObject({
        at: iso,
        runtimeVersion: expect.any(String),
        language: 'python',
        protocolVersion: 1,
        connector: { language: 'python', version: expect.any(String) },
        schedule: { kind: 'custom' },
        limit: 5,
        processes: 1,
      })
      expect(run.events.filter((e) => e.type === 'scheduled')).toEqual([
        expect.objectContaining({ at: iso, seq: 0, config: { n: 0 } }),
        expect.objectContaining({ at: iso, seq: 1, config: { n: 1 } }),
      ])
      expect(run.events.find((e) => e.type === 'log')).toMatchObject({
        at: iso,
        seq: expect.any(Number),
        attempt: expect.any(Number),
        stream: expect.stringMatching(/^std(out|err)$/),
        text: expect.any(String),
      })
      // ctx.log lines are stderr log events `[<level>] <message> <fields>`.
      expect(run.events.filter((e) => e.type === 'log' && e.text === '[info] hello n=1')).toEqual(
        expect.arrayContaining([expect.objectContaining({ seq: 1, stream: 'stderr' })]),
      )
      expect(run.events.find((e) => e.type === 'attempt')).toMatchObject({
        at: iso,
        seq: expect.any(Number),
        attempt: 1,
        error: expect.objectContaining({ type: 'taskError' }),
        nextAttemptAt: iso,
      })
      expect(run.results[0]).toMatchObject({
        at: iso,
        seq: 0,
        status: 'succeeded',
        attempt: 2,
        config: { n: 0 },
        result: expect.objectContaining({ n: 0 }),
        error: null,
        files: [],
        logTail: expect.any(String),
        attempts: [expect.objectContaining({ attempt: 1 })],
        timings: { scheduledAt: iso, startedAt: iso, finishedAt: iso, durationMs: expect.any(Number) },
      })
      expect(run.events.at(-1)).toMatchObject({ at: iso, reason: 'done', summary: { analyses: 2, succeeded: 2, failed: 0 }, exitCode: 0 })

      // A wrapped template call is reported as resolved; a failing schedule as an error event.
      const failing = await devRun(throwsDir, ['--scan-config', '{"end": 3}', '--task-config', '{"fail_in_schedule": true}'])
      expect(failing.run.exitCode, describeRun(failing.run)).toBe(1)
      expect(failing.events.find((e) => e.type === 'resolved')).toMatchObject({
        key: 'call:0',
        template: 'range',
        scanConfig: { start: 0, end: 3, step: 1 },
        expectedTotal: 3,
      })
      expect(failing.events.find((e) => e.type === 'error')).toMatchObject({
        at: iso,
        error: expect.objectContaining({ type: 'taskError', message: expect.stringContaining('demo exception in schedule') }),
      })
      expect(failing.events.at(-1)).toMatchObject({ type: 'end', reason: 'scheduleFailed', exitCode: 1 })
    } finally {
      await removeDevImages(probe)
      await removeDevImages(throws)
      await removeTree(probeDir)
      await removeTree(throwsDir)
    }
  })

  test('local-mode exit codes follow the worst outcome', { tag: ['@DEV-009'] }, async () => {
    const probe = unique('probe-exits')
    const broken = unique('broken-exits')
    const throws = unique('throws-exits')
    const probeDir = await probeTask(probe)
    const brokenDir = await exampleVariant(ECHO, broken, { 'main.py': 'raise RuntimeError("cannot load")\n' })
    const throwsDir = await exampleVariant(exampleTaskDir('throws'), throws)
    try {
      // One chain of runs per folder; the folders build and run at the same time.
      const probeRuns = async () => {
        const ok = await devRun(probeDir, [])
        expect(ok.run.exitCode, describeRun(ok.run)).toBe(0)
        const empty = await devRun(probeDir, ['--scan-config', '{"count": 0}'])
        expect(empty.run.exitCode, describeRun(empty.run)).toBe(0)
        expect(empty.events.at(-1)).toMatchObject({ type: 'end', summary: { analyses: 0 }, exitCode: 0 })

        const failed = await devRun(probeDir, ['--scan-config', '{"count": 2}', '--task-config', '{"fail_attempts": 5}'])
        expect(failed.run.exitCode, describeRun(failed.run)).toBe(1)
        expect(failed.events.at(-1)).toMatchObject({ type: 'end', summary: { failed: 2 }, exitCode: 1 })

        const unreachable = await scantor(['dev', 'run', probeDir], { cwd: probeDir, env: { DOCKER_HOST: `unix://${join(probeDir, 'no-docker.sock')}` } })
        expect(unreachable.exitCode, describeRun(unreachable)).toBe(3)
      }

      const throwsRuns = async () => {
        const schedule = await devRun(throwsDir, ['--task-config', '{"fail_in_schedule": true}'])
        expect(schedule.run.exitCode, describeRun(schedule.run)).toBe(1)
        const validation = await devRun(throwsDir, ['--scan-config', '{"step": 0}', '--task-config', '{"mode": "ok"}'])
        expect(validation.run.exitCode, describeRun(validation.run)).toBe(2)
        expect(validation.events.find((e) => e.type === 'error')).toMatchObject({ error: expect.objectContaining({ type: 'validation' }) })
      }

      const brokenRun = async () => {
        const describeFailure = await scantor(['dev', 'run', brokenDir], { cwd: brokenDir })
        expect(describeFailure.exitCode, describeRun(describeFailure)).toBe(2)
      }

      await settleAll([probeRuns(), throwsRuns(), brokenRun()])
    } finally {
      for (const name of [probe, broken, throws]) await removeDevImages(name)
      for (const dir of [probeDir, brokenDir, throwsDir]) await removeTree(dir)
    }
  })

  test('local mode skips schedule for an analysis config, caps items and delays and runs as scan local', { tag: ['@DEV-010'] }, async () => {
    const probe = unique('probe-local')
    const dir = await probeTask(probe)
    try {
      const single = await devRun(dir, ['--analysis-config', '{"n": 7}'])
      expect(single.run.exitCode, describeRun(single.run)).toBe(0)
      expect(single.events.filter((e) => e.type === 'scheduled')).toEqual([expect.objectContaining({ seq: 0, config: { n: 7 } })])
      expect(single.results).toEqual([
        expect.objectContaining({ seq: 0, status: 'succeeded', result: expect.objectContaining({ n: 7, scan_id: 'local', analysis_id: 'local-0', seq: 0 }) }),
      ])

      const limited = await devRun(dir, ['--scan-config', '{"count": 10}', '--limit', '3'])
      expect(limited.run.exitCode, describeRun(limited.run)).toBe(0)
      expect(limited.events.filter((e) => e.type === 'scheduled').map((e) => e.seq)).toEqual([0, 1, 2])
      expect(limited.events.at(-1)).toMatchObject({ type: 'end', reason: 'limit', summary: { analyses: 3 } })

      // The manifest backoff (initial 5s) and a Retry delay of 30 s are both capped at 2 s.
      for (const taskConfig of ['{"fail_attempts": 1}', '{"fail_attempts": 1, "retry_delay": 30}']) {
        const retried = await devRun(dir, ['--analysis-config', '{"n": 1}', '--task-config', taskConfig, '--max-attempts', '2'])
        expect(retried.run.exitCode, describeRun(retried.run)).toBe(0)
        const attempt = retried.events.find((e) => e.type === 'attempt')!
        const delay = Date.parse(String(attempt.nextAttemptAt)) - Date.parse(String(attempt.at))
        expect(delay, taskConfig).toBeGreaterThanOrEqual(0)
        expect(delay, taskConfig).toBeLessThanOrEqual(2000)
        expect(retried.results[0]).toMatchObject({ status: 'succeeded', attempt: 2 })
      }
    } finally {
      await removeDevImages(probe)
      await removeTree(dir)
    }
  })

  test('files of a local run are copied into .scantor/out for the invoking user', { tag: ['@DEV-011'] }, async () => {
    const name = unique('files-out')
    const dir = await exampleVariant(exampleTaskDir('files'), name)
    try {
      // The CLI image runs as an unprivileged user with the Docker socket's group, as the scantor.sh shim does.
      await chmod(dir, 0o777)
      const uid = 4321
      const socketGid = (await stat('/var/run/docker.sock')).gid
      const cli = spawnScantor(['dev', 'run', dir, '-o', 'json', '--scan-config', '{"items": ["a", "b"]}', '--task-config', '{"copies": 1}'], {
        cwd: dir,
        image: true,
        dockerArgs: ['-u', `${uid}:${uid}`, '--group-add', String(socketGid), '-e', 'HOME=/tmp'],
      })
      const exit = await cli.wait(300_000)
      expect(exit.exitCode, cli.output()).toBe(0)
      const results = localResults(cli.stdout)
      expect(results).toHaveLength(2)
      for (const result of results) {
        const files = result.files as { id: string; name: string; size: number; sha256: string; path: string }[]
        expect(files).toHaveLength(6)
        for (const file of files) {
          expect(file.path).toBe(`files/${result.seq}/${file.id}/${file.name}`)
          const outDirs = await readdir(join(dir, '.scantor', 'out'))
          expect(outDirs).toHaveLength(1)
          const local = join(dir, '.scantor', 'out', outDirs[0]!, file.path)
          const content = await readFile(local)
          expect(createHash('sha256').update(content).digest('hex')).toBe(file.sha256)
          expect(content.length).toBe(file.size)
          const info = await stat(local)
          expect({ uid: info.uid, gid: info.gid }).toEqual({ uid, gid: uid })
        }
        // The FileRefs of the result match the copied files.
        const refs = JSON.stringify(result.result)
        for (const file of files) expect(refs).toContain(file.sha256)
      }
    } finally {
      await removeDevImages(name)
      await removeTree(dir)
    }
  })

  test('an interrupt kills the connector and reports in-flight analyses as cancelled', { tag: ['@DEV-012', '@DEV-006', '@DEV-009'] }, async () => {
    const name = unique('interrupt')
    const dir = await exampleVariant(ECHO, name, {
      'main.py': [
        'import time',
        'from pydantic import BaseModel',
        'import scantor',
        '',
        'class Result(BaseModel):',
        '    done: bool',
        '',
        'def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: scantor.Empty) -> Result:',
        '    ctx.log("info", "started")',
        '    time.sleep(600)',
        '    return Result(done=True)',
        '',
        'task = scantor.Task(result=Result, run=run)',
        '',
      ].join('\n'),
    })
    const cli = spawnScantor(['dev', 'run', dir, '-o', 'json'], { cwd: dir })
    let image: string | undefined
    try {
      // Events arrive while the run is in progress.
      image = await cli.waitFor((p) => findPipelineResult(p.stderr)?.image?.ref, 300_000, 'the built image')
      await cli.waitFor(
        (p) => (localEvents(p.stdout).some((e) => e.type === 'log' && String(e.text).includes('[info] started')) ? true : undefined),
        120_000,
        'the started log line',
      )
      cli.signal('SIGINT')
      const exit = await cli.wait(60_000)
      expect(exit.exitCode, cli.output()).toBe(3)
      expect(localResults(cli.stdout)).toEqual([expect.objectContaining({ seq: 0, status: 'failed', error: expect.objectContaining({ type: 'cancelled' }) })])
      expect(localEvents(cli.stdout).at(-1)).toMatchObject({ type: 'end', reason: 'interrupted', exitCode: 3 })
      // The local-mode container and its connector processes are gone.
      const left = await docker(['ps', '--all', '--quiet', '--filter', `ancestor=${image}`])
      expect(left.stdout.trim()).toBe('')
    } finally {
      await cli.stop()
      // A CLI killed before its own cleanup leaves the local-mode container behind, and it holds the image.
      if (image) {
        const left = (await docker(['ps', '--all', '--quiet', '--filter', `ancestor=${image}`])).stdout.split('\n').filter(Boolean)
        if (left.length > 0) await docker(['rm', '--force', ...left], { allowFailure: true })
      }
      await removeDevImages(name)
      await removeTree(dir)
    }
  })
})

test.describe('configuration and containers', () => {
  test('credentials come only from SCANTOR_URL and SCANTOR_TOKEN and are validated', { tag: ['@CLI-002'] }, async ({ user, env }) => {
    const whoami = await scantor(['whoami', '-o', 'json'], { token: user.apiKey })
    expect(whoami.exitCode, describeRun(whoami)).toBe(0)
    expect(whoami.json).toMatchObject({ url: env.publicUrl, id: user.id, email: user.email })

    // No token, a token of the wrong shape, and an image prefix without "/" are configuration errors.
    const anonymous = await scantor(['whoami'])
    expect(anonymous.exitCode, describeRun(anonymous)).toBe(2)
    const wrongShape = await scantor(['whoami', '-o', 'json'], { env: { SCANTOR_TOKEN: 'not-a-key' } })
    expect(wrongShape.exitCode, describeRun(wrongShape)).toBe(2)
    expect(errorJson(wrongShape)).toMatchObject({ error: { code: 'validation', exitCode: 2, message: expect.stringContaining('sk_scantor_') } })
    const prefix = await scantor(['whoami'], { token: user.apiKey, env: { SCANTOR_IMAGE_PREFIX: 'ghcr.io/lonetis' } })
    expect(prefix.exitCode, describeRun(prefix)).toBe(2)
    expect(prefix.stderr).toContain('SCANTOR_IMAGE_PREFIX')

    const version = await scantor(['version'])
    expect(version.exitCode).toBe(0)
    expect(version.stdout).toMatch(/^scantor \S+/)
    expect(version.stdout).toMatch(/commit:\s+\S+/)
    expect(version.stdout).toMatch(/image prefix:\s+\(local images\)/)
    const versionJson = await scantor(['version', '-o', 'json'], { env: { SCANTOR_IMAGE_PREFIX: 'example.org/x/', SCANTOR_IMAGE_TAG: '' } })
    expect(versionJson.exitCode, describeRun(versionJson)).toBe(0)
    expect(versionJson.json).toMatchObject({ version: expect.any(String), commit: expect.any(String) })
  })

  test('a containerised CLI reaches a localhost URL through host.docker.internal', { tag: ['@CLI-003'] }, async ({ user, env }) => {
    const requests: { host: string; path: string }[] = []
    const server = createHttpServer((request, response) => {
      requests.push({ host: request.headers.host ?? '', path: request.url ?? '' })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: user.id, email: user.email, name: user.name, role: 'user', canRunPrivileged: false, maxWorkers: 1 }))
    })
    // Loopback only, like the dev stack's ports on SCANTOR_BIND_ADDRESS: the runner's dockerd is a Linux Docker
    // Engine, whose host gateway does not reach a port bound to 127.0.0.1, so this needs the shim's host network.
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        // scantor.sh itself, with the image pair of the stack (scantor:dev).
        const cwd = env.paths.tests
        const child = spawn('sh', [join(env.paths.repo, 'scantor.sh'), 'whoami', '-o', 'json'], {
          cwd,
          env: childEnv(scantorEnv({ token: user.apiKey, env: { SCANTOR_URL: `http://${host}:${port}` } }), { inherit: false }),
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const cli = new CliProcess(child, `scantor.sh whoami (${host})`)
        const exit = await cli.wait(120_000)
        expect(exit.exitCode, cli.output()).toBe(0)
        expect(JSON.parse(cli.stdout)).toMatchObject({ url: `http://host.docker.internal:${port}` })
        expect(requests.at(-1)).toEqual({ host: `host.docker.internal:${port}`, path: '/api/account' })
      }
      // Other hosts are kept.
      const cli = spawnScantor(['whoami', '-o', 'json'], { image: true, token: user.apiKey })
      expect((await cli.wait(120_000)).exitCode, cli.output()).toBe(0)
      expect(JSON.parse(cli.stdout)).toMatchObject({ url: env.publicUrl })
    } finally {
      server.close()
    }
  })
})

test.describe('task, revision and node commands', () => {
  test('tasks files work on the platform workspace and revision snapshots', { tag: ['@CLI-008'] }, async ({ user, api, tasks }) => {
    const name = unique('files-cmd')
    const root = await tempDir('files-cmd')
    const token = user.apiKey
    const cli = (args: string[], input?: string) => scantor(args, { token, cwd: root, input })
    tasks.track(name)
    try {
      const created = await cli(['tasks', 'create', name, '--language', 'python', '-o', 'json'])
      expect(created.exitCode, describeRun(created)).toBe(0)
      const listed = (await cli(['tasks', 'files', 'ls', name, '-o', 'json'])).json as { entries: { path: string; type: string }[] }
      expect(listed.entries.map((e) => e.path)).toEqual(expect.arrayContaining(['scantor.yaml', 'Dockerfile', 'main.py']))

      // A binary round trip keeps the bytes.
      const binary = randomBytes(4096)
      await writeFile(join(root, 'blob.bin'), binary)
      const put = await cli(['tasks', 'files', 'put', name, `data/blob.bin=${join(root, 'blob.bin')}`, 'data/sub/note.txt=-'], 'from stdin\n')
      expect(put.exitCode, describeRun(put)).toBe(0)
      const raw = await scantorBytes(['tasks', 'files', 'cat', name, 'data/blob.bin'], { token, cwd: root })
      expect(raw.exitCode, raw.stderr).toBe(0)
      expect(createHash('sha256').update(raw.stdout).digest('hex')).toBe(createHash('sha256').update(binary).digest('hex'))
      const json = (await cli(['tasks', 'files', 'cat', name, 'data/blob.bin', '-o', 'json'])).json as { encoding: string; content: string; sha256: string }
      expect(json.encoding).toBe('base64')
      expect(Buffer.from(json.content, 'base64').equals(binary)).toBe(true)
      expect(json.sha256).toBe(createHash('sha256').update(binary).digest('hex'))
      expect((await cli(['tasks', 'files', 'cat', name, 'data/sub/note.txt'])).stdout).toBe('from stdin\n')

      // rm -r removes a folder; traversal is rejected.
      const rm = await cli(['tasks', 'files', 'rm', name, 'data', '-r'])
      expect(rm.exitCode, describeRun(rm)).toBe(0)
      const after = (await cli(['tasks', 'files', 'ls', name, '-o', 'json'])).json as { entries: { path: string }[] }
      expect(after.entries.filter((e) => e.path.startsWith('data'))).toEqual([])
      for (const args of [
        ['tasks', 'files', 'cat', name, '../escape.txt'],
        ['tasks', 'files', 'put', name, '../escape.txt=-'],
        ['tasks', 'files', 'rm', name, '../../etc'],
      ]) {
        const refused = await cli(args, 'x')
        expect(refused.exitCode, `${args.join(' ')}: ${describeRun(refused)}`).toBe(2)
      }

      // --revision reads the published snapshot, not the live workspace.
      const published = await cli(['revisions', 'publish', name, '--wait', '-o', 'json'])
      expect(published.exitCode, describeRun(published)).toBe(0)
      const original = (await cli(['tasks', 'files', 'cat', name, 'main.py'])).stdout
      await cli(['tasks', 'files', 'put', name, 'main.py=-'], `${original}\n# edited\n`)
      expect((await cli(['tasks', 'files', 'cat', name, 'main.py', '--revision', '1'])).stdout).toBe(original)
      expect((await cli(['tasks', 'files', 'cat', name, 'main.py'])).stdout).toContain('# edited')
      const snapshot = (await cli(['tasks', 'files', 'ls', name, '--revision', 'latest', '-o', 'json'])).json as { entries: { path: string }[] }
      expect(snapshot.entries.map((e) => e.path)).toContain('main.py')

      const deleted = await cli(['tasks', 'delete', name, '--wait'])
      expect(deleted.exitCode, describeRun(deleted)).toBe(0)
      expect((await api.getTask(name)).status).toBe(404)
    } finally {
      await removeTree(root)
    }
  })

  test(
    'tasks import-git selects candidates and tasks pull --force replaces a diverged folder',
    { tag: ['@CLI-008'] },
    async ({ freshUser, freshApi, request }) => {
      const token = freshUser.apiKey
      const listing = await scantor(['tasks', 'import-git', GIT_REPOS.multi, '-o', 'json'], { token })
      expect(listing.exitCode, describeRun(listing)).toBe(0)
      expect(listing.json).toMatchObject({
        imported: [],
        candidates: expect.arrayContaining([expect.objectContaining({ path: 'alpha' }), expect.objectContaining({ path: 'beta' })]),
      })
      const selected = await scantor(['tasks', 'import-git', GIT_REPOS.multi, '--select', 'alpha', '-o', 'json'], { token })
      expect(selected.exitCode, describeRun(selected)).toBe(0)
      const imported = (selected.json as { imported: { name: string }[] }).imported
      expect(imported).toHaveLength(1)
      expect((await freshApi.getTask(imported[0]!.name)).status).toBe(200)

      const url = await copyGitRepo(request, 'diverge')
      const diverge = await scantor(['tasks', 'import-git', url, '-o', 'json'], { token })
      expect(diverge.exitCode, describeRun(diverge)).toBe(0)
      const task = (diverge.json as { imported: { name: string }[] }).imported[0]!.name
      expect((await scantor(['tasks', 'pull', task, '-o', 'json'], { token })).json).toMatchObject({ changed: false })
      await moveGitMain(request, url, 'rewritten')
      const refused = await scantor(['tasks', 'pull', task, '-o', 'json'], { token })
      expect(refused.exitCode, describeRun(refused)).toBe(2)
      expect(errorJson(refused)).toMatchObject({ error: { code: 'gitDiverged', exitCode: 2 } })
      const forced = await scantor(['tasks', 'pull', task, '--force', '-o', 'json'], { token })
      expect(forced.exitCode, describeRun(forced)).toBe(0)
      expect(forced.json).toMatchObject({ changed: true, task: { name: task } })
    },
  )

  test('revisions get, list, logs and publish work on revisions', { tag: ['@CLI-009'] }, async ({ user, tasks }) => {
    const name = unique('revisions')
    const dir = await exampleVariant(ECHO, name)
    tasks.track(name)
    const token = user.apiKey
    const cli = (args: string[], input?: string) => scantor(args, { token, cwd: dir, input })
    try {
      expect((await cli(['push', dir, '--no-publish'])).exitCode).toBe(0)
      const first = await cli(['revisions', 'publish', name, '-m', 'one', '--wait', '-o', 'json'])
      expect(first.exitCode, describeRun(first)).toBe(0)
      const revision = first.json as { id: string; number: number; state: string; message: string; ref: string }
      expect(revision).toMatchObject({ number: 1, state: 'ready', message: 'one', ref: `${name}@1` })

      for (const ref of [`${name}@1`, `${name}@latest`, name, `${name}@${revision.id}`]) {
        const got = await cli(['revisions', 'get', ref, '-o', 'json'])
        expect(got.exitCode, describeRun(got)).toBe(0)
        expect(got.json, ref).toMatchObject({ id: revision.id, number: 1 })
      }
      const logs = await cli(['revisions', 'logs', `${name}@1`, '-o', 'json'])
      expect(logs.exitCode, describeRun(logs)).toBe(0)
      const lines = jsonLines(logs.stdout)
      expect(lines.map((l) => l.line)).toEqual(lines.map((_, i) => i + 1))
      expect(lines.at(-1)).toMatchObject({ type: 'result' })
      expect(lines.some((l) => l.phase === 'push' && l.text === 'waiting for push gate')).toBe(true)

      // --follow prints a build while it is queued or runs and ends with its result; a failed build makes get --wait
      // exit 2 (a Dockerfile that breaks the policy fails before the image build).
      expect((await cli(['tasks', 'files', 'put', name, 'Dockerfile=-'], 'FROM python:3\n')).exitCode).toBe(0)
      const second = await cli(['revisions', 'publish', name, '-o', 'json'])
      expect(second.exitCode, describeRun(second)).toBe(0)
      expect(second.json).toMatchObject({ number: 2 })
      const followed = await cli(['revisions', 'logs', `${name}@2`, '--follow', '-o', 'json'])
      expect(followed.exitCode, describeRun(followed)).toBe(0)
      expect(jsonLines(followed.stdout).at(-1)).toMatchObject({ type: 'result', result: expect.objectContaining({ ok: false }) })
      const failed = await cli(['revisions', 'get', `${name}@2`, '--wait'])
      expect(failed.exitCode, describeRun(failed)).toBe(2)

      const list = await cli(['revisions', 'list', name, '-o', 'json'])
      expect((list.json as { items: { number: number; state: string }[] }).items.map((r) => [r.number, r.state])).toEqual([
        [2, 'failed'],
        [1, 'ready'],
      ])
    } finally {
      await removeTree(dir)
    }
  })

  test('nodes commands manage a node and print its token once', { tag: ['@CLI-010'] }, async ({ adminApi, openapi }) => {
    const admin = await createAdminWithKey(adminApi, openapi, 'cli-nodes')
    const name = unique('cli-node')
    const pool = unique('pool')
    const cli = (args: string[]) => scantor(args, { token: admin.apiKey })
    let nodeId: string | undefined
    try {
      const human = await cli(['nodes', 'create', name, '--pool', pool, '--label', 'zone=test', '--label', 'tier=a'])
      expect(human.exitCode, describeRun(human)).toBe(0)
      const token = /snt_[A-Za-z0-9_-]{43}/.exec(human.stdout)?.[0]
      expect(token, human.stdout).toBeDefined()
      expect(human.stdout).toContain('docker run')
      const node = ok(await adminApi.listNodes({ pool }), 'listNodes').items.find((n) => n.name === name)!
      nodeId = node.id
      expect(node).toMatchObject({ state: 'pending', pool, labels: { zone: 'test', tier: 'a' } })

      const list = await cli(['nodes', 'list', '--pool', pool, '-o', 'json'])
      expect((list.json as { items: { id: string }[] }).items.map((n) => n.id)).toEqual([nodeId])
      expect((await cli(['nodes', 'get', name, '-o', 'json'])).json).toMatchObject({ id: nodeId, state: 'pending' })

      const updated = await cli(['nodes', 'update', name, '--label', 'zone=other', '--cordoned', '--max-workers', '3', '-o', 'json'])
      expect(updated.exitCode, describeRun(updated)).toBe(0)
      expect(updated.json).toMatchObject({ labels: { zone: 'other' }, cordoned: true, maxWorkers: 3 })
      expect((updated.json as { labels: Record<string, string> }).labels).toEqual({ zone: 'other' })

      const join = await cli(['nodes', 'join', name])
      expect(join.exitCode, describeRun(join)).toBe(0)
      expect(join.stdout).toContain('${SCANTOR_NODE_TOKEN}')
      expect(join.stdout).not.toContain(token!)

      const rotated = await cli(['nodes', 'token', 'rotate', name, '-o', 'json'])
      expect(rotated.exitCode, describeRun(rotated)).toBe(0)
      const newToken = (rotated.json as { token: string }).token
      expect(newToken).toMatch(/^snt_/)
      expect(newToken).not.toBe(token)
      const revoked = await cli(['nodes', 'token', 'revoke', name, '-o', 'json'])
      expect(revoked.exitCode, describeRun(revoked)).toBe(0)
      expect((await cli(['nodes', 'get', name, '-o', 'json'])).json).toMatchObject({ state: 'revoked' })

      expect((await cli(['nodes', 'workers', name, '-o', 'json'])).json).toMatchObject({ items: [] })
      const events = await cli(['nodes', 'events', name, '-o', 'json'])
      expect(events.exitCode, describeRun(events)).toBe(0)
      expect((events.json as { items: unknown[] }).items.length).toBeGreaterThan(0)

      const deleted = await cli(['nodes', 'delete', name])
      expect(deleted.exitCode, describeRun(deleted)).toBe(0)
      const gone = await cli(['nodes', 'get', name])
      expect(gone.exitCode).toBe(2)
      nodeId = undefined
    } finally {
      if (nodeId) await adminApi.deleteNode(nodeId)
      await deleteUser(adminApi, admin.id)
    }
  })
})
