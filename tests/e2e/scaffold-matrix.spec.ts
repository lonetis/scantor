import { readdirSync, readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { parse as parseYaml } from 'yaml'
import { scantor, type CliResult } from '../helpers/cli'
import { docker } from '../helpers/docker'
import { env } from '../helpers/env'
import { describeRun, localResults, pipelineResult, removeDevImages, removeTree, tempDir } from '../helpers/e2e-examples-cli-tasks'
import { extendExamplesCli } from '../helpers/e2e-examples-cli-fixtures'
import { expect, test as base, unique } from '../fixtures'

// The scaffold matrix (docs/testing.md §6, docs/tasks.md §12): for every language of schemas/languages.json × every
// template of schemas/templates/ plus `custom`, `scantor init` writes a scaffold that `scantor validate` accepts and
// `scantor dev run --limit 2` runs with at least one succeeded analysis. The CLI runs from the scantor:dev image through
// the shim pattern (working directory mounted at the same path, the inner Docker socket); the data-source templates
// read the fixtures server (helpers/cli.ts passes SCANTOR_TRANCO_URL and SCANTOR_CRUX_URL). The matrix is derived from
// the two sources at load time, so new languages and templates are covered without editing this file.
//
// One test per combination. The tests of a language run in one worker, and the first of them starts the CLI runs of
// every combination of that language (a few at a time), so the builds overlap; each test then asserts on the runs
// of its own combination and removes its folder and images. A test that runs alone still does all of its own work.

// The same `test` as the other e2e CLI specs, so a worker moves between the files without a restart.
const test = extendExamplesCli(base)

interface Language {
  title: string
  image: string
  entry: string
  entryKind: 'source' | 'binary'
  extensions: string[]
}

const LANGUAGES = (JSON.parse(readFileSync(join(env.paths.repo, 'schemas', 'languages.json'), 'utf8')) as { languages: Record<string, Language> }).languages
const TEMPLATES = readdirSync(join(env.paths.repo, 'schemas', 'templates'))
  .filter((file) => file.endsWith('.json') && !file.endsWith('.fixtures.json'))
  .map((file) => file.replace(/\.json$/, ''))
  .sort()
const COMBINATION_TEMPLATES = [...TEMPLATES, 'custom']
const MANIFEST_SCHEMA = JSON.parse(readFileSync(join(env.paths.repo, 'schemas', 'task-manifest.schema.json'), 'utf8')) as Record<string, unknown>
const validateManifest = new Ajv2020({ strict: false, allErrors: true, validateFormats: false }).compile(MANIFEST_SCHEMA)

/** Scan configs for `dev run` (docs/testing.md §6); every other template runs with its defaults. */
const SCAN_CONFIGS: Record<string, Record<string, unknown>> = {
  list: { items: ['a', 'b', 'c'] }, // local mode has no uploads
  range: { end: 4 },
  repeat: { times: 2 },
}

/** Files every scaffold has (docs/tasks.md §12.1). */
const COMMON_FILES = [
  'scantor.yaml',
  'Dockerfile',
  '.dockerignore',
  '.gitignore',
  '.devcontainer/devcontainer.json',
  '.vscode/launch.json',
  '.vscode/tasks.json',
  '.vscode/settings.json',
  'AGENTS.md',
]

/** Dependency and type-checker files per language (docs/tasks.md §12.1); a language without a row checks only the rest. */
const LANGUAGE_FILES: Record<string, string[]> = {
  python: ['requirements.txt', 'pyrightconfig.json'],
  typescript: ['package.json', 'package-lock.json', 'tsconfig.json'],
  javascript: ['package.json', 'package-lock.json', 'jsconfig.json'],
  go: ['go.mod', 'go.sum'],
}

/** How many combinations of one language run their CLI commands at the same time. */
const PARALLEL_COMBINATIONS = 3

/** The entry file a scaffold writes: the default entry of a source language, main<ext> of a binary language. */
function entryFile(language: Language): string {
  return language.entryKind === 'source' ? language.entry : `main${language.extensions[0]}`
}

/** SCANTOR_DEBUG_PORT of a base image (the scaffold's launch configuration attaches to it). */
async function debugPort(image: string): Promise<number> {
  const inspect = await docker(['image', 'inspect', image, '--format', '{{json .Config.Env}}'])
  const variable = (JSON.parse(inspect.stdout) as string[]).find((v) => v.startsWith('SCANTOR_DEBUG_PORT='))
  if (!variable) throw new Error(`${image} sets no SCANTOR_DEBUG_PORT`)
  return Number(variable.slice('SCANTOR_DEBUG_PORT='.length))
}

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>

/** The CLI runs of one combination: init, then (when init succeeded) validate and dev run. */
interface Combination {
  name: string
  parent: string
  dir: string
  init: CliResult
  validate?: CliResult
  run?: CliResult
}

async function runCombination(language: string, template: string): Promise<Combination> {
  const name = unique(`m-${language}-${template}`)
  const parent = await tempDir(name)
  const dir = join(parent, name)
  const init = await scantor(['init', '--language', language, '--template', template, '--name', name, dir], { cwd: parent, image: true })
  if (init.exitCode !== 0) return { name, parent, dir, init }
  const validate = await scantor(['validate', dir, '-o', 'json'], { cwd: dir, image: true, timeoutMs: 300_000 })
  const scanConfig = SCAN_CONFIGS[template]
  const run = await scantor(['dev', 'run', dir, '--limit', '2', ...(scanConfig ? ['--scan-config', JSON.stringify(scanConfig)] : []), '-o', 'json'], {
    cwd: dir,
    image: true,
    timeoutMs: 300_000,
  })
  return { name, parent, dir, init, validate, run }
}

/** Runs `tasks` with at most `limit` of them at a time. */
function limited(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: (() => void)[] = []
  return async (task) => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve))
    active++
    try {
      return await task()
    } finally {
      active--
      queue.shift()?.()
    }
  }
}

/** The combinations started in this worker, by `<language>/<template>`; removed by their tests or the group's afterAll. */
const started = new Map<string, Promise<Combination>>()
/** Languages whose combinations were all started once in this worker. */
const prefetched = new Set<string>()
const key = (language: string, template: string) => `${language}/${template}`

/**
 * The runs of one combination. The first call for a language also starts every other combination of it (this one
 * first, at most PARALLEL_COMBINATIONS at a time); later calls for a combination whose runs were removed start only
 * that one again (for example with --repeat-each).
 */
function combination(language: string, template: string): Promise<Combination> {
  if (!started.has(key(language, template))) {
    if (prefetched.has(language)) {
      started.set(key(language, template), runCombination(language, template))
    } else {
      prefetched.add(language)
      const slot = limited(PARALLEL_COMBINATIONS)
      for (const t of [template, ...COMBINATION_TEMPLATES.filter((other) => other !== template)]) {
        if (started.has(key(language, t))) continue
        started.set(
          key(language, t),
          slot(() => runCombination(language, t)),
        )
      }
    }
  }
  return started.get(key(language, template))!
}

async function removeCombination(language: string, template: string): Promise<void> {
  const pending = started.get(key(language, template))
  if (!pending) return
  started.delete(key(language, template))
  const done = await pending
  await removeDevImages(done.name)
  await removeTree(done.parent)
}

test('the matrix covers every language and template', { tag: ['@scaffold', '@DEV-003'] }, () => {
  expect(Object.keys(LANGUAGES).length).toBeGreaterThan(0)
  expect(TEMPLATES).toEqual(expect.arrayContaining(['single', 'list', 'range', 'repeat', 'cidr', 'tranco', 'crux']))
})

for (const [languageName, language] of Object.entries(LANGUAGES)) {
  test.describe(`scaffold matrix: ${languageName}`, () => {
    // The combinations of a language share one worker, so their builds overlap (see the header).
    test.describe.configure({ mode: 'default' })

    test.afterAll(async () => {
      for (const template of COMBINATION_TEMPLATES) await removeCombination(languageName, template)
    })

    for (const template of COMBINATION_TEMPLATES) {
      test(`${languageName} × ${template}: init, validate and dev run`, { tag: ['@scaffold', '@DEV-002', '@DEV-003'] }, async () => {
        try {
          const { name, dir, init, validate, run } = await combination(languageName, template)
          expect(init.exitCode, describeRun(init)).toBe(0)

          // The files of a scaffold (docs/tasks.md §12.1).
          for (const file of [...COMMON_FILES, entryFile(language), ...(LANGUAGE_FILES[languageName] ?? [])]) {
            expect((await stat(join(dir, file))).isFile(), file).toBe(true)
          }
          const manifestText = await readFile(join(dir, 'scantor.yaml'), 'utf8')
          expect(manifestText.split('\n')[0]).toMatch(
            /^# yaml-language-server: \$schema=https:\/\/raw\.githubusercontent\.com\/lonetis\/scantor\/\S+\/schemas\/task-manifest\.schema\.json$/,
          )
          const manifest = parseYaml(manifestText) as Record<string, unknown>
          expect(validateManifest(manifest), JSON.stringify(validateManifest.errors)).toBe(true)
          expect(manifest).toMatchObject({ scantor: 1, name, language: languageName })

          const baseImage = `${language.image}:dev`
          const devcontainer = await readJson(join(dir, '.devcontainer', 'devcontainer.json'))
          expect(devcontainer).toMatchObject({
            build: { dockerfile: '../Dockerfile', context: '..', args: { SCANTOR_BASE: baseImage } },
            workspaceFolder: '/task',
          })
          // The attach configuration targets the base image's debug port (debugpy nests it in `connect`).
          const launch = (await readJson(join(dir, '.vscode', 'launch.json'))) as {
            configurations: { name: string; request: string; port?: number; connect?: { host: string; port: number } }[]
          }
          expect(launch.configurations).toEqual([expect.objectContaining({ name: 'scantor: attach to dev debug', request: 'attach' })])
          const attach = launch.configurations[0]!
          expect(attach.connect?.port ?? attach.port).toBe(await debugPort(baseImage))
          const tasks = (await readJson(join(dir, '.vscode', 'tasks.json'))) as { tasks: { label: string }[] }
          expect(tasks.tasks.map((t) => t.label)).toEqual(['scantor: validate', 'scantor: dev run', 'scantor: dev debug', 'scantor: push'])
          const settings = await readJson(join(dir, '.vscode', 'settings.json'))
          expect(JSON.stringify(settings['yaml.schemas'])).toContain('scantor.yaml')
          expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toContain(`# ${name} — a scantor task (${languageName})`)

          // validate: every publish check passes on local Docker.
          expect(validate!.exitCode, describeRun(validate!)).toBe(0)
          const result = pipelineResult(validate!.stdout)
          expect(result).toMatchObject({ ok: true, language: languageName, errors: [] })
          const expectedSchedule = template === 'custom' ? { kind: 'custom' } : { kind: 'template', template }
          expect(result.description?.schedule).toEqual(expectedSchedule)

          // dev run: at least one analysis succeeds, none fails.
          expect(run!.exitCode, describeRun(run!)).toBe(0)
          const results = localResults(run!.stdout)
          expect(results.length, describeRun(run!)).toBeGreaterThanOrEqual(1)
          expect(results.length).toBeLessThanOrEqual(2)
          for (const analysis of results) expect(analysis.status, JSON.stringify(analysis)).toBe('succeeded')
        } finally {
          await removeCombination(languageName, template)
        }
      })
    }
  })
}
