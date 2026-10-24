import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AnalysisQueryResult } from '#shared/types/analyses'
import type { BuildLogPage } from '#shared/types/revisions'
import type { Worker } from '#shared/types/workers'
import { ok, type ApiClient } from '../helpers/api-client'
import { scantor } from '../helpers/cli'
import { docker } from '../helpers/docker'
import { env } from '../helpers/env'
import { SMALL_SETTINGS } from '../helpers/scans'
import { exampleTaskDir } from '../helpers/tasks'
import { FORGED_STDERR, FORGED_STDOUT, PROBES } from '../helpers/e2e-examples-cli-probes'
import {
  describeRun,
  exampleVariant,
  initScaffold,
  localEvents,
  localResults,
  pipelineResult,
  removeDevImages,
  removeScaffold,
  removeTree,
  settleAll,
} from '../helpers/e2e-examples-cli-tasks'
import { extendExamplesCli } from '../helpers/e2e-examples-cli-fixtures'
import { expect, test as base, unique } from '../fixtures'
import { EXAMPLES, exampleTemplates, type Example } from './examples'

// Every example task under tasks/ is uploaded, built, described and scanned on the built-in node per the table in
// e2e/examples.ts (docs/testing.md §8.3); together the examples cover every language and template, so these tests
// exercise each connector, the task pipeline (base image, push by digest) and each template end to end. The second
// half covers the connector contract through task variants built locally with the CLI (docs/tasks.md §4–§7,
// docs/protocol.md): the start without the runtime, protocol-safe output, describe failures and warnings, secrets,
// the ENV contract of the base images and TLS trust.

// Sessions that survive concurrent runs on one stack (helpers/e2e-examples-cli-fixtures.ts).
const test = extendExamplesCli(base)

const LANGUAGES = JSON.parse(readFileSync(join(env.paths.repo, 'schemas', 'languages.json'), 'utf8')) as {
  languages: Record<string, { image: string; entry: string; base: string }>
}
const TEMPLATE_NAMES = readdirSync(join(env.paths.repo, 'schemas', 'templates'))
  .filter((file) => file.endsWith('.json') && !file.endsWith('.fixtures.json'))
  .map((file) => file.replace(/\.json$/, ''))
  .sort()

/** Example folders: every directory of tasks/ with a scantor.yaml. */
function exampleDirs(): string[] {
  return readdirSync(join(env.paths.repo, 'tasks'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(env.paths.repo, 'tasks', entry.name, 'scantor.yaml')))
    .map((entry) => entry.name)
    .sort()
}

/** The canonical scan and analysis config schemas of a template ($defs of schemas/templates/<name>.json). */
function templateDefs(name: string): { scanConfig: Record<string, unknown>; analysisConfig: Record<string, unknown> } {
  const schema = JSON.parse(readFileSync(join(env.paths.repo, 'schemas', 'templates', `${name}.json`), 'utf8')) as {
    $defs: Record<string, Record<string, unknown>>
  }
  return { scanConfig: schema.$defs.scanConfig!, analysisConfig: schema.$defs.analysisConfig! }
}

const withoutSchemaKeyword = (schema: Record<string, unknown>) => Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$schema'))

/** Every `writeOnly` property of a schema that still carries a `default` (describe removes them; docs/tasks.md §6.5). */
function writeOnlyDefaults(schema: unknown, path = ''): string[] {
  if (Array.isArray(schema)) return schema.flatMap((item, i) => writeOnlyDefaults(item, `${path}/${i}`))
  if (typeof schema !== 'object' || schema === null) return []
  const node = schema as Record<string, unknown>
  const own = node.writeOnly === true && 'default' in node ? [path] : []
  return [...own, ...Object.entries(node).flatMap(([key, value]) => writeOnlyDefaults(value, `${path}/${key}`))]
}

const propertyNames = (schema: Record<string, unknown>) => Object.keys((schema.properties ?? {}) as Record<string, unknown>)

/** Every analysis of a scan by seq (queryAnalyses pages of 1000 with afterSeq). */
async function allAnalyses(api: ApiClient, scanId: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  let afterSeq: number | undefined
  for (;;) {
    const page: AnalysisQueryResult = ok(
      await api.queryAnalyses(scanId, { filter: {}, projection: { seq: 1, status: 1, result: 1, logTail: 1, files: 1, attempt: 1 }, limit: 1000, afterSeq }),
      'queryAnalyses',
    )
    out.push(...page.items)
    if (page.items.length < 1000) return out.sort((a, b) => Number(a.seq) - Number(b.seq))
    afterSeq = Number(page.items.at(-1)!.seq)
  }
}

/** The whole build log of a revision. */
async function buildLog(api: ApiClient, task: string, revision: number) {
  const lines: BuildLogPage['lines'] = []
  let afterLine = 0
  for (;;) {
    const page = ok(await api.call<BuildLogPage>('getRevisionBuildLog', { path: { task, revision }, query: { afterLine, limit: 5000 } }), 'getRevisionBuildLog')
    lines.push(...page.lines)
    if (page.complete || page.lines.length === 0) return lines
    afterLine = page.nextLine
  }
}

/** Creates a list upload with these lines; returns its id. */
async function createListUpload(api: ApiClient, lines: string[]): Promise<string> {
  const upload = ok(
    await api.call<{ id: string }>('createUpload', {
      body: Buffer.from(`${lines.join('\n')}\n`),
      headers: { 'Content-Type': 'text/plain' },
      query: { kind: 'list', name: unique('example-list') },
    }),
    'createUpload',
  )
  return upload.id
}

/**
 * The examples in two groups of about the same duration: http-status scans the whole smallest CrUX bucket (1000
 * analyses, by far the longest scan), so it shares its group only with the one-analysis echo; the other group takes
 * the rest.
 */
const LONG_SCANS = ['http-status', 'echo']
const EXAMPLE_GROUPS = [
  EXAMPLES.filter((example) => LONG_SCANS.includes(example.dir)).sort((a, b) => LONG_SCANS.indexOf(a.dir) - LONG_SCANS.indexOf(b.dir)),
  EXAMPLES.filter((example) => !LONG_SCANS.includes(example.dir)),
]

function exampleTags(example: Example): string[] {
  const tags = ['@PIPE-006', '@PIPE-009', '@CONN-010', '@CONN-012']
  tags.push(example.language === 'python' ? '@CONN-005' : example.language === 'go' ? '@CONN-007' : '@CONN-006')
  if (example.expect.logTail || example.expect.inflightProgress) tags.push('@CONN-004')
  return tags
}

test.describe('example tasks', () => {
  test('every example under tasks/ has an entry in e2e/examples.ts', { tag: ['@CONN-005', '@CONN-006', '@CONN-007'] }, () => {
    const listed = EXAMPLES.map((example) => example.dir).sort()
    expect(new Set(listed).size, 'duplicate entries').toBe(listed.length)
    expect(listed, 'examples without an entry (or entries without an example)').toEqual(exampleDirs())
  })

  test('the examples cover every language and every template', { tag: ['@CONN-005', '@CONN-006', '@CONN-007', '@CONN-012'] }, () => {
    expect([...new Set(EXAMPLES.map((example) => example.language))].sort()).toEqual(Object.keys(LANGUAGES.languages).sort())
    expect([...new Set(EXAMPLES.flatMap(exampleTemplates))].sort()).toEqual(TEMPLATE_NAMES)
    for (const example of EXAMPLES) {
      const manifest = readFileSync(join(exampleTaskDir(example.dir), 'scantor.yaml'), 'utf8')
      expect(manifest, example.dir).toMatch(new RegExp(`^language: ${example.language}$`, 'm'))
    }
  })

  // Two groups, each run in order by one worker: a group publishes all of its examples at once, so their builds queue
  // together instead of one after another, and then scans them one by one.
  for (const group of EXAMPLE_GROUPS) {
    test.describe(`published together: ${group.map((example) => example.dir).join(', ')}`, () => {
      test.describe.configure({ mode: 'default' })
      test.beforeAll(({ shared }) => shared.prefetch(group.map((example) => example.dir)))
      for (const example of group) {
        const title = `${example.dir} (${example.language}, ${exampleTemplates(example).join(' + ')}) builds, describes and scans`
        test(title, { tag: exampleTags(example) }, async ({ api, scans, shared }) => {
          // Published once per worker: the CLI specs scan the same examples.
          const { task, revision } = await shared.example(example.dir)
          const description = revision.description!

          // The build: base image, platform, push by digest through the push gate.
          const baseImage = LANGUAGES.languages[example.language]!.image
          expect(revision.language).toBe(example.language)
          expect(revision.baseImage).toEqual({ ref: `${baseImage}:dev`, digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) })
          expect(revision.image).toMatchObject({
            repository: `tasks/${task.id}`,
            tag: revision.id,
            digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            bytes: expect.any(Number),
            platform: { os: 'linux', arch: expect.stringMatching(/^(amd64|arm64)$/) },
          })
          const log = await buildLog(api, task.name, revision.number)
          const gate = log.findIndex((line) => line.phase === 'push' && line.text === 'waiting for push gate')
          expect(gate, 'the push gate line').toBeGreaterThan(0)
          expect(log.slice(0, gate).some((line) => line.phase === 'push')).toBe(false)
          expect(log.at(-1)).toMatchObject({ type: 'result', result: expect.objectContaining({ ok: true }) })
          expect(JSON.stringify(log.at(-1)!.result)).toContain(revision.image!.digest)

          // Describe: normalised object schemas; unwrapped templates get the canonical schemas.
          expect(description.connector.language).toBe(example.language)
          expect(description.schedule).toEqual(example.schedule)
          for (const [kind, schema] of Object.entries(description.schemas)) {
            expect(schema.$schema, kind).toBe('https://json-schema.org/draft/2020-12/schema')
            expect(schema, kind).not.toHaveProperty('$id')
            expect(schema.type, kind).toBe('object')
            expect(writeOnlyDefaults(schema), kind).toEqual([])
          }
          // Properties keep their source order; upload and FileRef paths are derived from the schemas.
          for (const [kind, names] of Object.entries(example.description?.propertyOrder ?? {})) {
            expect(propertyNames(description.schemas[kind as keyof typeof description.schemas]), kind).toEqual(names)
          }
          expect(description.secretPaths).toEqual({ taskConfig: [], scanConfig: [], analysisConfig: [], result: [] })
          expect(description.uploadPaths).toEqual(example.description?.uploadPaths ?? { taskConfig: [], scanConfig: [] })
          expect([...description.fileRefPaths].sort()).toEqual([...(example.description?.fileRefPaths ?? [])].sort())
          if (example.schedule.kind === 'template' && example.schedule.template !== 'single') {
            const canonical = templateDefs(example.schedule.template)
            expect(withoutSchemaKeyword(description.schemas.scanConfig)).toEqual(canonical.scanConfig)
            expect(withoutSchemaKeyword(description.schemas.analysisConfig)).toEqual(canonical.analysisConfig)
          }
          for (const template of example.wraps ?? []) {
            // A wrapping generator keeps its own schemas: the scan config is the task's, not the template's.
            expect(withoutSchemaKeyword(description.schemas.scanConfig), template).not.toEqual(templateDefs(template).scanConfig)
          }

          // The scan.
          const scanConfig = { ...example.scan.scanConfig }
          if (example.scan.upload) scanConfig.upload = await createListUpload(api, example.scan.upload)
          const started = await scans.start({
            revision: revision.ref,
            taskConfig: example.scan.taskConfig,
            scanConfig,
            settings: { ...SMALL_SETTINGS, ...example.scan.settings },
            confirm: example.scan.confirm,
          })
          if (example.expect.inflightProgress) {
            await expect
              .poll(
                async () => {
                  const list = ok(
                    await api.call<{ items: { progress: unknown }[] }>('listInflightAnalyses', { path: { scanId: started.id } }),
                    'listInflightAnalyses',
                  )
                  return list.items.find((item) => item.progress !== null)?.progress
                },
                { timeout: 180_000, intervals: [1000] },
              )
              .toMatchObject({ fraction: expect.any(Number), message: expect.stringMatching(/ of \d+ s$/) })
          }
          const scan = await scans.wait(started.id, { state: example.expect.state, timeoutMs: example.expect.timeoutMs ?? 300_000 })
          expect(await scans.counts(scan.id)).toEqual(example.expect.counts)

          // Scans and workers reference the image by digest.
          expect(scan.revision).toMatchObject({ id: revision.id, digest: revision.image!.digest, language: example.language, schedule: example.schedule })
          const workers = ok(await api.listScanWorkers(scan.id, { limit: 200 }), 'listScanWorkers').items as Worker[]
          expect(workers.length).toBeGreaterThan(0)
          for (const worker of workers) {
            expect(worker.spec.digest).toBe(revision.image!.digest)
            expect(worker.spec.repository).toMatch(new RegExp(`(^|/)tasks/${task.id}$`))
          }
          for (const template of exampleTemplates(example).filter((t) => t !== 'single')) {
            expect(
              Object.values(scan.scheduling.resolved).map((r) => r.template),
              'resolutions',
            ).toContain(template)
          }

          const analyses = await allAnalyses(api, scan.id)
          expect(analyses).toHaveLength(Object.values(example.expect.counts).reduce((a, b) => a + b, 0))
          for (const analysis of analyses) {
            const seq = Number(analysis.seq)
            expect(analysis.result, `seq ${seq}`).toMatchObject(example.expect.resultMatch(seq))
            if (example.expect.logTail) expect(String(analysis.logTail), `seq ${seq}`).toContain(example.expect.logTail)
            if (example.expect.filesPerAnalysis !== undefined) expect(analysis.files, `seq ${seq}`).toHaveLength(example.expect.filesPerAnalysis)
          }
        })
      }
    })
  }
})

/** The environment and working directory of an image (docs/tasks.md §4.2). */
async function imageConfig(image: string): Promise<{ env: Record<string, string>; workingDir: string }> {
  const inspect = await docker(['image', 'inspect', image, '--format', '{{json .Config}}'])
  const config = JSON.parse(inspect.stdout) as { Env: string[]; WorkingDir: string }
  return { env: Object.fromEntries(config.Env.map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])), workingDir: config.WorkingDir }
}

/** A command template split into arguments (no quoted spans in the base images' commands) with {entry} replaced. */
const commandArgs = (template: string, entry: string) => template.split(/\s+/).map((arg) => arg.replaceAll('{entry}', entry))

/** `scantor validate <dir> -o json` → the run and its pipeline result (exit code checked by the caller). */
async function validate(dir: string) {
  const run = await scantor(['validate', dir, '-o', 'json'], { cwd: dir })
  return { run, result: pipelineResult(run.stdout) }
}

/** The describe error of a failed validate (exit 2). */
async function describeFailure(dir: string): Promise<string> {
  const { run, result } = await validate(dir)
  expect(run.exitCode, describeRun(run)).toBe(2)
  expect(result.ok).toBe(false)
  const error = result.errors.find((e) => e.phase === 'describe')
  expect(error, JSON.stringify(result.errors)).toBeDefined()
  return error!.message
}

/** A renamed copy of an example with some files replaced, its dev images removed by `cleanup`. */
async function variant(example: string, files: Record<string, string | null>) {
  const name = unique(`conn-${example}`)
  const dir = await exampleVariant(exampleTaskDir(example), name, files)
  return { name, dir, cleanup: async () => (await removeDevImages(name), await removeTree(dir)) }
}

/** main.py of a copy of tasks/echo with the given definitions (the run returns a Result with `text`). */
const pythonTask = (body: string) => `from pydantic import BaseModel, Field, RootModel\n\nimport scantor\n\n\n${body}\n`

test.describe('connectors and base images', () => {
  test('every language has a connector probe', { tag: ['@CONN-002'] }, () => {
    expect(Object.keys(PROBES).sort()).toEqual(Object.keys(LANGUAGES.languages).sort())
  })

  test('the base images implement the ENV contract and ship the system CA bundle', { tag: ['@CONN-008', '@CONN-009'] }, async () => {
    const images = new Map<string, string[]>()
    for (const [language, { image }] of Object.entries(LANGUAGES.languages)) images.set(image, [...(images.get(image) ?? []), language])
    for (const [image, languages] of images) {
      const { env: variables, workingDir } = await imageConfig(`${image}:dev`)
      expect(workingDir, image).toBe('/task')
      expect(variables.SCANTOR_LANGUAGE!.split(' ').sort(), image).toEqual([...languages].sort())
      for (const key of ['SCANTOR_CONNECTOR_CMD', 'SCANTOR_CHECK_CMD', 'SCANTOR_DEBUG_CMD']) expect(variables[key], `${image} ${key}`).toBeTruthy()
      expect(variables.SCANTOR_CONNECTOR_CMD, image).toContain('{entry}')
      expect(variables.SCANTOR_DEBUG_CMD, image).toContain('{entry}')
      // The debug port is written literally into the debug command and repeated in SCANTOR_DEBUG_PORT.
      expect(variables.SCANTOR_DEBUG_PORT, image).toMatch(/^\d+$/)
      expect(variables.SCANTOR_DEBUG_CMD, image).toContain(`:${variables.SCANTOR_DEBUG_PORT}`)

      const bundle = await docker(
        [
          'run',
          '--rm',
          '--label',
          'scantor.test=true',
          '--network',
          'none',
          '--entrypoint',
          'sh',
          `${image}:dev`,
          '-c',
          'grep -c "BEGIN CERTIFICATE" /etc/ssl/certs/ca-certificates.crt',
        ],
        { allowFailure: true, timeoutMs: 60_000 },
      )
      expect(bundle.exitCode, `${image}: ${bundle.stderr}`).toBe(0)
      expect(Number(bundle.stdout.trim()), image).toBeGreaterThan(50)
    }
  })

  for (const language of Object.keys(LANGUAGES.languages)) {
    test(`a ${language} task image started without the runtime refuses to run`, { tag: ['@CONN-001'] }, async () => {
      const name = unique(`no-runtime-${language}`)
      const dir = await initScaffold(language, 'single', name)
      try {
        const { run, result } = await validate(dir)
        expect(run.exitCode, describeRun(run)).toBe(0)
        const { env: variables } = await imageConfig(result.image!.ref)
        const command = commandArgs(variables.SCANTOR_CONNECTOR_CMD!, String(result.manifest!.entry))
        const started = await docker(['run', '--rm', '--label', 'scantor.test=true', '--network', 'none', result.image!.ref, ...command], {
          allowFailure: true,
          timeoutMs: 60_000,
        })
        expect(started.exitCode, started.stderr).toBe(2)
        expect(started.stderr).toContain('scantor: this program is a scantor task connector; run it with "scantor dev run"')
      } finally {
        await removeDevImages(name)
        await removeScaffold(dir)
      }
    })
  }

  for (const [language, probe] of Object.entries(PROBES)) {
    const tags = ['@CONN-002', '@CONN-008', '@CONN-009', '@CONN-010']
    tags.push(language === 'python' ? '@CONN-005' : language === 'go' ? '@CONN-007' : '@CONN-006')
    test(`the ${language} connector keeps the protocol clean, honours an ENV override and trusts the system roots`, { tag: tags }, async ({ env }) => {
      const image = `${LANGUAGES.languages[language]!.image}:dev`
      const original = (await imageConfig(image)).env.SCANTOR_CONNECTOR_CMD!
      const dockerfile = readFileSync(join(exampleTaskDir(probe.example), 'Dockerfile'), 'utf8')
      const { dir, cleanup } = await variant(probe.example, {
        [probe.entry]: probe.source,
        Dockerfile: `${dockerfile}ENV SCANTOR_CONNECTOR_CMD="env SCANTOR_PROBE_MARK=override ${original}"\n`,
      })
      try {
        const taskConfig = { url: `${env.publicUrl}/api/health`, ca: readFileSync(env.caCertFile, 'utf8') }
        const run = await scantor(['dev', 'run', dir, '-o', 'json', '--task-config', JSON.stringify(taskConfig), '--scan-config', '{"count": 2}'], { cwd: dir })
        expect(run.exitCode, describeRun(run)).toBe(0)

        // The build warns about the override (W2) and describes a custom schedule with a secret task config field (dev
        // run prints the task-pipeline events on stderr).
        const result = pipelineResult(run.stderr)
        expect(
          result.warnings.some((w) => w.includes('SCANTOR_CONNECTOR_CMD') && w.includes('(W2)')),
          JSON.stringify(result.warnings),
        ).toBe(true)
        expect(result.description!.schedule).toEqual({ kind: 'custom' })
        expect(result.description!.secretPaths.taskConfig).toEqual(['/token'])
        // The secret's default is dropped from the exported schema (an omitted secret stays absent).
        const token = (result.description!.schemas.taskConfig.properties as Record<string, Record<string, unknown>>).token!
        expect(token.writeOnly).toBe(true)
        expect(token).not.toHaveProperty('default')

        // Every analysis ran under the overridden command and trusts exactly the system roots plus the given CA.
        const results = localResults(run.stdout)
        expect(results.map((r) => r.seq)).toEqual([0, 1])
        for (const analysis of results) {
          expect(analysis.status, JSON.stringify(analysis)).toBe('succeeded')
          const value = analysis.result as { n: number; mark: string | null; roots: number; untrusted: string; trusted: string }
          expect(value).toMatchObject({ n: analysis.seq, mark: 'override', trusted: 'status 200' })
          expect(value.roots).toBeGreaterThan(50)
          expect(value.untrusted).toMatch(/^error /)
        }

        // The forged protocol lines are plain log output of their streams.
        const logs = localEvents(run.stdout).filter((e) => e.type === 'log')
        expect(
          logs.some((e) => e.stream === 'stdout' && String(e.text).includes(FORGED_STDOUT)),
          JSON.stringify(logs),
        ).toBe(true)
        expect(
          logs.some((e) => e.stream === 'stderr' && String(e.text).includes(FORGED_STDERR)),
          JSON.stringify(logs),
        ).toBe(true)
        for (const analysis of results) expect(String(analysis.logTail)).toContain(FORGED_STDOUT)
      } finally {
        await cleanup()
      }
    })
  }

  test('a Go panic is a taskError with a stack and a result breaking a struct tag fails as validation', { tag: ['@CONN-007'] }, async () => {
    const probe = PROBES.go!
    const { dir, cleanup } = await variant(probe.example, { [probe.entry]: probe.source })
    try {
      const panicked = await scantor(['dev', 'run', dir, '-o', 'json', '--analysis-config', '{"n": 0}', '--task-config', '{"mode": "panic"}'], { cwd: dir })
      expect(panicked.exitCode, describeRun(panicked)).toBe(1)
      const [failed] = localResults(panicked.stdout) as { status: string; error: { type: string; message: string; stack?: string } }[]
      expect(failed).toMatchObject({ status: 'failed', error: { type: 'taskError', message: expect.stringContaining('probe panic') } })
      expect(failed!.error.stack ?? '').toContain('goroutine')

      const invalid = await scantor(['dev', 'run', dir, '-o', 'json', '--analysis-config', '{"n": 0}', '--task-config', '{"mode": "invalid"}'], { cwd: dir })
      expect(invalid.exitCode, describeRun(invalid)).toBe(1)
      expect(localResults(invalid.stdout)).toEqual([expect.objectContaining({ status: 'failed', error: expect.objectContaining({ type: 'validation' }) })])
    } finally {
      await cleanup()
    }
  })

  test('an import error or an invalid definition fails the revision at describe', { tag: ['@CONN-003', '@CONN-006'] }, async ({ tasks }) => {
    // The two publishes and the local checks run at the same time.
    // A module that cannot be imported: the revision fails at describe with the message and the stack.
    const importError = async () => {
      const broken = await variant('echo', { 'main.py': 'import httpx  # not installed\n' })
      try {
        const { revision } = await tasks.upload(broken.dir, { expectState: 'failed' })
        expect(revision.errors).toEqual([expect.objectContaining({ phase: 'describe' })])
        expect(revision.errors[0]!.message).toContain("ModuleNotFoundError: No module named 'httpx'")
        expect(revision.errors[0]!.message).toContain('Traceback')
      } finally {
        await broken.cleanup()
      }
    }

    // A connector that never says hello (the no-hello fixture).
    const noHello = async () => {
      const { revision } = await tasks.fixture('no-hello', { expectState: 'failed' })
      expect(revision.errors).toEqual([expect.objectContaining({ phase: 'describe' })])
    }

    // Invalid definitions: no `task` in Python, a default export that is not a task in TypeScript and JavaScript, a
    // plain z.object config root.
    const cases: { example: string; files: Record<string, string>; message: string }[] = [
      { example: 'echo', files: { 'main.py': 'value = 1\n' }, message: 'main.py defines no module-level `task`' },
      {
        example: 'http-status',
        files: { 'main.ts': 'export default { run: () => ({}) };\n' },
        message: 'must be the value returned by defineTask(...) from @scantor/connector, but it is a plain object',
      },
      {
        example: 'power',
        files: { 'main.js': 'export default { run: () => ({}) };\n' },
        message: 'must be the value returned by defineTask(...) from @scantor/connector, but it is a plain object',
      },
      {
        example: 'http-status',
        files: {
          'main.ts':
            'import { defineTask, z } from "@scantor/connector";\nexport default defineTask({ taskConfig: z.object({ a: z.string().default("x") }), result: z.object({ a: z.string() }), run: (_ctx, _ac, tc) => ({ a: tc.a }) });\n',
        },
        message: 'taskConfig must be created with config() or z.strictObject()',
      },
    ]
    const invalidDefinition = async (c: (typeof cases)[number]) => {
      const v = await variant(c.example, c.files)
      try {
        expect(await describeFailure(v.dir), `${c.example}: ${JSON.stringify(c.files)}`).toContain(c.message)
      } finally {
        await v.cleanup()
      }
    }
    await settleAll([importError(), noHello(), ...cases.map(invalidDefinition)])
  })

  test(
    'describe rejects open roots, invalid defaults, non-object results and a language mismatch and warns about open nested objects',
    { tag: ['@CONN-011'] },
    async () => {
      const run = 'def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> Result:\n    return Result(text="x")\n'
      const cases: { files: Record<string, string>; message: string; example?: string }[] = [
        {
          files: {
            'main.py': pythonTask(
              `class TaskConfig(BaseModel):\n    a: int = 1\n\n\nclass Result(BaseModel):\n    text: str\n\n\n${run}\n\ntask = scantor.Task(task_config=TaskConfig, result=Result, run=run)`,
            ),
          },
          message: 'the taskConfig root allows unknown keys',
        },
        {
          files: {
            'main.py': pythonTask(
              `class TaskConfig(scantor.Config):\n    limit: int = Field(default=-1, ge=0)\n\n\nclass Result(BaseModel):\n    text: str\n\n\n${run}\n\ntask = scantor.Task(task_config=TaskConfig, result=Result, run=run)`,
            ),
          },
          message: 'the default does not validate against its schema',
        },
        {
          files: {
            'main.py': pythonTask(
              'class TaskConfig(scantor.Config):\n    a: int = 1\n\n\nclass Result(RootModel[list[int]]):\n    pass\n\n\ndef run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> Result:\n    return Result([1])\n\n\ntask = scantor.Task(task_config=TaskConfig, result=Result, run=run)',
            ),
          },
          message: 'the result schema root must be type object',
        },
      ]
      // A TypeScript manifest whose connector command loads a JavaScript entry: the connector reports javascript.
      const js = await imageConfig(`${LANGUAGES.languages.typescript!.image}:dev`)
      const httpStatusDockerfile = readFileSync(join(exampleTaskDir('http-status'), 'Dockerfile'), 'utf8')
      cases.push({
        example: 'http-status',
        files: {
          'main.js':
            'import { defineTask, z } from "@scantor/connector";\nexport default defineTask({ result: z.object({ a: z.string() }), run: () => ({ a: "x" }) });\n',
          Dockerfile: `${httpStatusDockerfile}ENV SCANTOR_CONNECTOR_CMD="${js.env.SCANTOR_CONNECTOR_CMD!.replaceAll('{entry}', 'main.js')}"\n`,
        },
        message: 'the connector loaded the task as javascript, but the manifest language is typescript',
      })
      const rejected = async (c: (typeof cases)[number]) => {
        const v = await variant(c.example ?? 'echo', c.files)
        try {
          expect(await describeFailure(v.dir), JSON.stringify(c.files)).toContain(c.message)
        } finally {
          await v.cleanup()
        }
      }

      // An open nested object is only a warning.
      const warned = async () => {
        const nested = await variant('echo', {
          'main.py': pythonTask(
            `class Inner(BaseModel):\n    x: int = 0\n\n\nclass TaskConfig(scantor.Config):\n    inner: Inner = Inner()\n\n\nclass Result(BaseModel):\n    text: str\n\n\n${run}\n\ntask = scantor.Task(task_config=TaskConfig, result=Result, run=run)`,
          ),
        })
        try {
          const { run: validated, result } = await validate(nested.dir)
          expect(validated.exitCode, describeRun(validated)).toBe(0)
          expect(
            result.description!.warnings.some((w) => w.includes('the nested object allows unknown keys')),
            JSON.stringify(result.description!.warnings),
          ).toBe(true)
        } finally {
          await nested.cleanup()
        }
      }
      await settleAll([...cases.map(rejected), warned()])
    },
  )

  test('a scan config with properties on a task without schedule is a definition error', { tag: ['@CONN-013'] }, async () => {
    const v = await variant('echo', {
      'main.py': pythonTask(
        'class ScanConfig(scantor.Config):\n    count: int = 1\n\n\nclass Result(BaseModel):\n    text: str\n\n\ndef run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: scantor.Empty) -> Result:\n    return Result(text="x")\n\n\ntask = scantor.Task(scan_config=ScanConfig, result=Result, run=run)',
      ),
    })
    try {
      expect(await describeFailure(v.dir)).toContain('needs a schedule')
    } finally {
      await v.cleanup()
    }
  })
})
