import { randomBytes, randomUUID } from 'node:crypto'
import type { Bundle } from '#shared/types/bundles'
import type { ApiClient } from '../helpers/api-client'
import {
  currentLines,
  downloadArchive,
  ensureBundle,
  loadIntoRecipient,
  parseEvents,
  readRunDir,
  Recipient,
  RECIPIENT_GID,
  RECIPIENT_UID,
  removeArchive,
  removeFromRecipient,
  RUN_STAMP,
  sha256,
  until,
  type BundleRun,
  type ResultLine,
} from '../helpers/bundles'
import { extendRuntime } from '../helpers/e2e-runtime-fixtures'
import type { UploadedTask } from '../helpers/tasks'
import { expect, test as base } from '../fixtures'

// Bundle runs (docs/runtime.md §15.7–§15.9, docs/guide/bundles.md): the bundles of `tasks/echo` and of the fixture
// `bundle-probe` are created through the API, downloaded with their presigned URLs and loaded with `docker load` into
// the simulated remote node's own dockerd, which stands in for the recipient's machine (helpers/bundles.ts). Every run
// is the recipient's `docker run --rm -v <folder>:/work localhost/scantor/<task>:<n> [flags]` in a fresh folder owned by
// uid 1000, and the tests read the run directory back: run.json, results.jsonl and files/.
//
// One worker runs the tests of this file one after the other: they share the two loaded images, which the file removes
// from the recipient's machine at the end.

interface Loaded {
  /** `<task>@<n>` */
  ref: string
  /** `localhost/scantor/<task>:<n>` */
  image: string
  bundle: Bundle
}

const test = extendRuntime(base).extend<{ recipient: Recipient }>({
  recipient: async ({}, use) => {
    const recipient = new Recipient()
    try {
      await use(recipient)
    } finally {
      await recipient.cleanup()
    }
  },
})

test.describe.configure({ mode: 'default', timeout: 300_000 })

/** The task config of bundle-probe with its schema defaults (the secret `token` has none). */
const PROBE_TASK_DEFAULTS = { failOn: null, retryOn: null, sleepMs: 0, writeFile: true }
/** The settings defaults of bundle-probe (tests/fixtures/tasks/bundle-probe/scantor.yaml). */
const PROBE_SETTINGS = {
  processes: 1,
  timeoutMs: 60_000,
  maxAttempts: 3,
  backoff: { initialMs: 1000, factor: 2, maxMs: 2000, jitter: false },
  resources: { cpus: 0.5, memoryMiB: 256 },
  maxAnalysesPerProcess: 1000,
}

let echo: Loaded
let probe: Loaded

/** Creates the bundle of a published revision, downloads it and loads it on the recipient's machine. */
async function load(api: ApiClient, uploaded: UploadedTask): Promise<Loaded> {
  const bundle = await ensureBundle(api, uploaded.task.name, uploaded.revision.number)
  const archive = await downloadArchive(bundle)
  try {
    await loadIntoRecipient(archive.path, bundle.image)
  } finally {
    await removeArchive(archive)
  }
  return { ref: uploaded.revision.ref, image: bundle.image, bundle }
}

test.beforeAll(async ({ shared, workerApi }) => {
  // Publishing and bundling build images; the stack builds a few at a time for every user, one bundle per user.
  test.setTimeout(900_000)
  const [echoTask, probeTask] = await Promise.all([shared.example('echo'), shared.fixture('bundle-probe')])
  ;[echo, probe] = await Promise.all([load(workerApi, echoTask), load(workerApi, probeTask)])
})

test.afterAll(async () => {
  await removeFromRecipient([echo?.image, probe?.image])
})

const bySeq = (lines: ResultLine[]) => [...lines].sort((a, b) => a.seq - b.seq)
const byItem = (lines: ResultLine[]) => new Map(lines.map((line) => [String(line.result?.item ?? line.config.item), line]))

/** Expects a run that was refused before it started: exit 2, an issue on stderr naming `path`, nothing written. */
function expectRefused(run: BundleRun, path: string): void {
  expect(run.exitCode, run.output()).toBe(2)
  expect(run.stderr).toContain(`${path}:`)
  expect(run.stderr).toContain('nothing was run')
}

test(
  'docker load and docker run with the defaults write run.json, results.jsonl and files/ in results/<stamp>/, owned by the owner of /work',
  { tag: ['@BRUN-001'] },
  async ({ recipient }) => {
    const work = await recipient.folder('defaults')
    const run = await recipient.run({ image: echo.image, mount: work })
    expect(run.exitCode, run.output()).toBe(0)

    const stamps = await work.names('results')
    expect(stamps).toHaveLength(1)
    expect(stamps[0]).toMatch(RUN_STAMP)
    const dir = await readRunDir(work, `results/${stamps[0]}`)
    expect(dir.info).toMatchObject({
      v: 1,
      bundle: { image: echo.image, ref: echo.ref, language: 'python', platform: echo.bundle.platform },
      scantorVersion: echo.bundle.scantorVersion,
      taskConfig: { text: 'Hello, World!' },
      scanConfig: {},
      analysisConfig: null,
      limit: 0,
      totalTimeoutMs: 0,
      uploads: [],
      summary: { analyses: 1, succeeded: 1, failed: 0 },
      reason: 'done',
      exitCode: 0,
    })
    expect(dir.info.finishedAt).not.toBeNull()
    expect(dir.lines).toHaveLength(1)
    expect(dir.lines[0]).toMatchObject({ seq: 0, status: 'succeeded', attempt: 1, result: { echo: 'Hello, World!' }, error: null, files: [], attempts: [] })
    expect(dir.lines[0]!.logTail, 'logTail is kept only on failed lines by default').toBe('')

    // Everything the run created belongs to uid 1000 (the owner of /work), although the runtime ran as root.
    const entries = await work.entries()
    const runDir = `results/${stamps[0]}`
    expect(entries.map((entry) => entry.path).sort()).toEqual(['results', runDir, `${runDir}/files`, `${runDir}/results.jsonl`, `${runDir}/run.json`])
    for (const entry of entries) expect(`${entry.path} ${entry.uid}:${entry.gid}`).toBe(`${entry.path} ${RECIPIENT_UID}:${RECIPIENT_GID}`)

    expect(run.stdout).toContain(`${echo.ref} (`)
    expect(run.stdout).toContain(`results in results/${stamps[0]}`)
    expect(run.stdout).toContain('exit code 0')
  },
)

test(
  'config, settings, --processes and --limit overrides apply, secrets are *** in every file, and invalid configs exit 2 without writing',
  { tag: ['@BRUN-002'] },
  async ({ recipient }) => {
    const work = await recipient.folder('overrides')
    await work.write('scan.json', JSON.stringify({ items: ['a', 'b', 'c', 'd', 'e'] }))
    const secret = `bundle-token-${randomBytes(12).toString('hex')}`
    const run = await recipient.run({
      image: probe.image,
      mount: work,
      args: [
        '--task-config',
        JSON.stringify({ token: secret, sleepMs: 10 }),
        '--scan-config',
        '@scan.json',
        '--settings',
        JSON.stringify({ processes: 1, maxAttempts: 2, timeoutMs: 20_000, backoff: { initialMs: 1500 } }),
        '--processes',
        '2',
        '--limit',
        '3',
        '--out',
        'run',
      ],
    })
    expect(run.exitCode, run.output()).toBe(0)
    const dir = await readRunDir(work, 'run')
    expect(dir.info).toMatchObject({
      taskConfig: { ...PROBE_TASK_DEFAULTS, sleepMs: 10, token: '***' },
      scanConfig: { items: ['a', 'b', 'c', 'd', 'e'], upload: null, offset: 0, limit: null },
      limit: 3,
      summary: { analyses: 3, succeeded: 3, failed: 0 },
      reason: 'limit',
      exitCode: 0,
    })
    // --processes wins over --settings; the backoff is merged field by field.
    expect(dir.info.settings).toEqual({
      ...PROBE_SETTINGS,
      processes: 2,
      maxAttempts: 2,
      timeoutMs: 20_000,
      backoff: { ...PROBE_SETTINGS.backoff, initialMs: 1500 },
    })
    const lines = bySeq(dir.lines)
    expect(lines.map((line) => line.seq)).toEqual([0, 1, 2])
    for (const line of lines) {
      expect(line.status).toBe('succeeded')
      expect(line.result, 'the secret result field is masked').toMatchObject({ hasToken: true, token: '***' })
    }
    expect(lines.map((line) => line.result!.item)).toEqual(['a', 'b', 'c'])
    expect(await work.filesContaining(secret), 'the secret is in no file of the folder').toEqual([])
    expect(run.stdout + run.stderr).not.toContain(secret)
    expect(run.stdout).toContain('2 processes, limit 3')

    // Invalid configs (a bound, and the mask fed back as a secret) are refused before anything is written.
    const empty = await recipient.folder('invalid')
    const refused = await recipient.run({ image: probe.image, mount: empty, args: ['--task-config', JSON.stringify({ sleepMs: -1, token: '***' })] })
    expectRefused(refused, '/taskConfig/sleepMs')
    expect(refused.stderr).toContain('/taskConfig/token:')
    expect(await empty.entries(), 'the folder stays empty').toEqual([])
  },
)

test(
  '--describe prints the defaults, schemas, secret and upload paths and recommended limits, and exits 2 on invalid configs',
  { tag: ['@BRUN-003'] },
  async ({ recipient }) => {
    // No mount is needed to describe.
    const human = await recipient.run({ image: probe.image, args: ['--describe', '--task-config', JSON.stringify({ token: 'describe-secret' })] })
    expect(human.exitCode, human.output()).toBe(0)
    for (const text of [
      `bundle:   ${probe.ref} (${probe.image})`,
      'schedule: template list',
      '"token": "***"',
      'secret paths',
      '/token',
      'upload paths',
      '/upload',
      'task config schema',
      'recommended:',
      '--cap-drop ALL',
      `-v "$PWD:/work"`,
    ]) {
      expect(human.stdout, text).toContain(text)
    }
    expect(human.stdout).not.toContain('describe-secret')

    const described = await recipient.run({ image: probe.image, args: ['--describe', '-o', 'json'] })
    expect(described.exitCode, described.output()).toBe(0)
    const description = JSON.parse(described.stdout) as {
      bundle: Record<string, unknown>
      taskConfig: Record<string, unknown>
      scanConfig: Record<string, unknown>
      analysisConfig: unknown
      settings: Record<string, unknown>
      schemas: { taskConfig: { properties: Record<string, Record<string, unknown>> }; scanConfig: { properties: Record<string, Record<string, unknown>> } }
      secretPaths: unknown
      uploadPaths: unknown
      recommended: { cpus: number; memoryBytes: number; dockerFlags: string }
      issues: unknown[]
    }
    expect(description.bundle).toMatchObject({
      image: probe.image,
      ref: probe.ref,
      language: 'python',
      platform: probe.bundle.platform,
      schedule: { kind: 'template', template: 'list' },
    })
    // The schema defaults fill the configs; the secret has no default and stays absent.
    expect(description.taskConfig).toEqual(PROBE_TASK_DEFAULTS)
    expect(description.scanConfig).toEqual({ items: [], upload: null, offset: 0, limit: null })
    expect(description.analysisConfig).toBeNull()
    expect(description.settings).toEqual(PROBE_SETTINGS)
    expect(Object.keys(description.schemas.taskConfig.properties).sort()).toEqual(['failOn', 'retryOn', 'sleepMs', 'token', 'writeFile'])
    expect(Object.keys(description.schemas.taskConfig.properties.token!)).not.toContain('default')
    expect(description.schemas.scanConfig.properties.upload!['x-scantor']).toBe('upload')
    expect(description.secretPaths).toEqual({ taskConfig: ['/token'], scanConfig: [], analysisConfig: [], result: ['/token'] })
    expect(description.uploadPaths).toEqual({ taskConfig: [], scanConfig: ['/upload'] })
    // A worker with one process of 0.5 CPUs and 256 MiB (plus the worker's memory overhead).
    const { cpus, memoryBytes, dockerFlags } = description.recommended
    expect(cpus).toBe(0.5)
    expect(memoryBytes).toBeGreaterThan(256 * 2 ** 20)
    expect(dockerFlags).toContain('--cap-drop ALL')
    expect(dockerFlags).toContain('--security-opt no-new-privileges')
    expect(dockerFlags).toContain(`--cpus 0.5 --memory ${Math.floor(memoryBytes / 2 ** 20)}m`)
    expect(description.issues).toEqual([])

    const invalid = await recipient.run({ image: probe.image, args: ['--describe', '-o', 'json', '--scan-config', JSON.stringify({ offset: -1 })] })
    expect(invalid.exitCode, invalid.output()).toBe(2)
    const issues = (JSON.parse(invalid.stdout) as { issues: { path: string; message: string }[] }).issues
    expect(issues.map((issue) => issue.path)).toContain('/scanConfig/offset')

    const invalidHuman = await recipient.run({ image: probe.image, args: ['--describe', '--task-config', JSON.stringify({ sleepMs: 'long' })] })
    expect(invalidHuman.exitCode, invalidHuman.output()).toBe(2)
    expect(invalidHuman.stdout).toContain('issues:')
    expect(invalidHuman.stdout).toContain('/taskConfig/sleepMs')
  },
)

test('a list template reads a local file given at an upload field; a platform upload id exits 2', { tag: ['@BRUN-004'] }, async ({ recipient }) => {
  const work = await recipient.folder('upload')
  const targets = 'one\ntwo\nthree\nfour\nfive\n'
  await work.write('targets.txt', targets)
  const run = await recipient.run({ image: probe.image, mount: work, args: ['--scan-config', JSON.stringify({ upload: 'targets.txt' }), '--out', 'run'] })
  expect(run.exitCode, run.output()).toBe(0)
  const dir = await readRunDir(work, 'run')
  const lines = bySeq(dir.lines)
  expect(lines.map((line) => line.config)).toEqual(['one', 'two', 'three', 'four', 'five'].map((item, index) => ({ item, index })))
  expect(lines.every((line) => line.status === 'succeeded')).toBe(true)
  // The path became a content-addressed upload id, recorded with the file it names.
  expect(dir.info.uploads).toEqual([
    { pointer: '/scanConfig/upload', path: '/work/targets.txt', sha256: sha256(targets), id: expect.stringMatching(/^[0-9a-f-]{36}$/) },
  ])
  expect(dir.info.scanConfig).toMatchObject({ upload: dir.info.uploads[0]!.id })
  expect(dir.info.resolved.schedule).toMatchObject({ template: 'list', expectedTotal: 5 })

  const before = await work.entries()
  const refused = await recipient.run({ image: probe.image, mount: work, args: ['--scan-config', JSON.stringify({ upload: randomUUID() })] })
  expectRefused(refused, '/scanConfig/upload')
  expect(refused.stderr).toContain('platform upload')
  expect(await work.entries(), 'the refused run wrote nothing').toEqual(before)
})

test(
  'retryable failures are retried per the settings, a final failure exits 1, and logTail is kept only on failed lines',
  { tag: ['@BRUN-005'] },
  async ({ recipient }) => {
    const work = await recipient.folder('failures')
    const run = await recipient.run({
      image: probe.image,
      mount: work,
      args: [
        '--scan-config',
        JSON.stringify({ items: ['ok', 'flaky', 'broken'] }),
        '--task-config',
        JSON.stringify({ retryOn: 'flaky', failOn: 'broken' }),
        '--out',
        'run',
      ],
    })
    expect(run.exitCode, run.output()).toBe(1)
    const dir = await readRunDir(work, 'run')
    expect(dir.info).toMatchObject({ reason: 'done', exitCode: 1, summary: { analyses: 3, succeeded: 2, failed: 1 } })
    const lines = byItem(dir.lines)

    expect(lines.get('ok')).toMatchObject({ status: 'succeeded', attempt: 1, attempts: [], logTail: '' })

    // The retryable failure of the first attempt is kept with its log; the second attempt waited the backoff (1 s).
    const flaky = lines.get('flaky')!
    expect(flaky).toMatchObject({ status: 'succeeded', attempt: 2, error: null, logTail: '' })
    expect(flaky.attempts).toHaveLength(1)
    expect(flaky.attempts[0]).toMatchObject({ attempt: 1, error: { type: 'retry', message: 'retry flaky in attempt 1' } })
    expect(flaky.attempts[0]!.logTail).toContain('bundle-probe flaky attempt 1')
    expect(Date.parse(flaky.timings.startedAt) - Date.parse(flaky.attempts[0]!.finishedAt)).toBeGreaterThanOrEqual(900)

    // The fatal failure is final at once and keeps its log tail.
    const broken = [...dir.lines].find((line) => line.config.item === 'broken')!
    expect(broken).toMatchObject({ status: 'failed', attempt: 1, result: null, files: [], attempts: [], error: { type: 'fatal', message: 'fatal broken' } })
    expect(broken.logTail).toContain('bundle-probe broken attempt 1')
    expect(run.stdout).toContain(`#${broken.seq} failed (fatal, attempt 1): fatal broken`)

    // files/ holds exactly the files of the lines, at their paths, with their content.
    const listed = dir.lines.flatMap((line) => line.files)
    expect(listed).toHaveLength(2)
    expect([...dir.files.keys()].sort()).toEqual(listed.map((file) => file.path).sort())
    for (const file of listed) {
      expect(file.path).toMatch(new RegExp(`^files/\\d+/${file.id}/probe\\.txt$`))
      expect(dir.files.get(file.path)).toBe(file.sha256)
    }
    const flakyFile = flaky.files[0]!
    expect(await work.read(`run/${flakyFile.path}`)).toBe('bundle-probe flaky\n')
    expect(flaky.result).toMatchObject({ item: 'flaky', attempt: 2, hasToken: false, token: null, file: { id: flakyFile.id, sha256: flakyFile.sha256 } })
    for (const entry of dir.entries) expect(`${entry.path} ${entry.uid}`).toBe(`${entry.path} ${RECIPIENT_UID}`)
  },
)

for (const [how, interrupt] of [
  ['SIGINT', (run: BundleRun) => run.kill('INT')],
  ['docker stop', (run: BundleRun) => run.stop(30)],
] as const) {
  test(`${how} writes cancelled lines and reason interrupted, and exits 3`, { tag: ['@BRUN-006'] }, async ({ recipient }) => {
    const work = await recipient.folder('interrupt')
    const items = Array.from({ length: 6 }, (_, i) => `slow-${i}`)
    const run = recipient.start({
      image: probe.image,
      mount: work,
      args: ['--scan-config', JSON.stringify({ items }), '--task-config', JSON.stringify({ sleepMs: 4000 }), '--out', 'run'],
    })
    await until('the first result line', 120_000, async () => {
      if (!run.running) throw new Error(`the run ended early: ${run.output()}`)
      return (await currentLines(work, 'run')).length > 0 ? true : undefined
    })
    await interrupt(run)
    expect(await run.exited, run.output()).toBe(3)

    const dir = await readRunDir(work, 'run')
    expect(dir.info).toMatchObject({ reason: 'interrupted', exitCode: 3 })
    const lines = bySeq(dir.lines)
    expect(lines[0]).toMatchObject({ seq: 0, status: 'succeeded' })
    const cancelled = lines.filter((line) => line.error?.type === 'cancelled')
    expect(cancelled.length, JSON.stringify(lines.map((line) => [line.seq, line.status, line.error?.type]))).toBeGreaterThan(0)
    for (const line of cancelled) expect(line.status).toBe('failed')
    // Queued items were dropped.
    expect(lines.length).toBeLessThan(items.length)
    expect(dir.info.summary).toEqual({
      analyses: lines.length,
      succeeded: lines.filter((line) => line.status === 'succeeded').length,
      failed: lines.filter((line) => line.status !== 'succeeded').length,
    })
    expect(run.stdout).toContain('finished (interrupted)')
  })
}

test('without a mount the run exits 2 with the -v hint, and a non-empty --out exits 2', { tag: ['@BRUN-007'] }, async ({ recipient }) => {
  const unmounted = await recipient.run({ image: probe.image })
  expectRefused(unmounted, '--out')
  expect(unmounted.stderr).toContain('is inside the container')
  expect(unmounted.stderr).toContain(`-v "$PWD:/work" ${probe.image}`)

  const work = await recipient.folder('nonempty')
  await work.write('full/keep.txt', 'keep\n')
  const before = await work.entries()
  const full = await recipient.run({ image: probe.image, mount: work, args: ['--out', 'full'] })
  expectRefused(full, '--out')
  expect(full.stderr).toContain('is not empty')
  expect(await work.entries()).toEqual(before)
})

test('an unlimited schedule streams: lines appear before it ends, and -o json emits NDJSON events', { tag: ['@BRUN-008'] }, async ({ recipient }) => {
  const work = await recipient.folder('stream')
  const items = Array.from({ length: 200 }, (_, i) => `item-${String(i).padStart(3, '0')}`)
  const run = recipient.start({
    image: probe.image,
    mount: work,
    args: [
      '--scan-config',
      JSON.stringify({ items }),
      '--task-config',
      JSON.stringify({ sleepMs: 100, writeFile: false }),
      '--processes',
      '2',
      '--out',
      'run',
      '-o',
      'json',
    ],
  })
  // results.jsonl gains lines while the run is still going.
  const seen = await until('result lines of the running run', 120_000, async () => {
    const lines = await currentLines(work, 'run')
    if (!run.running) throw new Error(`the run ended before a line was read: ${run.output()}`)
    return lines.length > 0 ? lines.length : undefined
  })
  expect(seen).toBeLessThan(items.length)
  expect(await run.exited, run.output()).toBe(0)

  const dir = await readRunDir(work, 'run')
  expect(dir.info).toMatchObject({ limit: 0, reason: 'done', exitCode: 0, summary: { analyses: 200, succeeded: 200, failed: 0 } })
  expect(new Set(dir.lines.map((line) => line.seq)).size).toBe(200)

  // stdout is the NDJSON event stream: start, scheduled and result events interleaved, end last.
  const events = parseEvents(run.stdout)
  const types = events.map((event) => event.type)
  expect(types[0]).toBe('start')
  expect(types.at(-1)).toBe('end')
  expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'done', exitCode: 0, summary: { analyses: 200, succeeded: 200, failed: 0 } })
  expect(types.filter((type) => type === 'scheduled')).toHaveLength(200)
  expect(types.filter((type) => type === 'result')).toHaveLength(200)
  expect(types.indexOf('result'), 'the first result comes before the schedule ended').toBeLessThan(types.lastIndexOf('scheduled'))
})

test('a task without network needs runs under --network none', { tag: ['@BRUN-009'] }, async ({ recipient }) => {
  const work = await recipient.folder('offline')
  const run = await recipient.run({
    image: echo.image,
    mount: work,
    network: 'none',
    args: ['--task-config', JSON.stringify({ text: 'offline' }), '--out', 'run'],
  })
  expect(run.exitCode, run.output()).toBe(0)
  const dir = await readRunDir(work, 'run')
  expect(dir.info).toMatchObject({ reason: 'done', exitCode: 0, summary: { analyses: 1, succeeded: 1, failed: 0 } })
  expect(dir.lines[0]).toMatchObject({ status: 'succeeded', result: { echo: 'offline' } })
})
