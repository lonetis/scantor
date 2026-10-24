#!/usr/bin/env node
// Generates the index of tests/TESTS.md between its markers (docs/testing.md §10): per Playwright project the spec
// files with their top-level describe titles and test counts, per FEATURES.md id the tests that cover it, the
// uncovered ids and unknown feature tags, and the unit suites by location. `--check` fails when the file is stale or
// when an id is uncovered or a tag unknown. Lists the suite with `playwright test --list` (no stack needed). Parsing
// FEATURES.md also validates its format: unique ids whose prefix matches their section, known surfaces, one line
// per feature.
//
//   just test-index [--check]
//
// The recipe runs it in the Playwright image; inside the test runner `node scripts/test-index.mjs [--check]` works too.
// Anywhere else it refuses to run (containerProblem), because listing loads every spec and helper, and those are
// written for the dockerized runner.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const testsDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repo = resolve(testsDir, '..')
const BEGIN = '<!-- BEGIN GENERATED: test-index -->'
const END = '<!-- END GENERATED: test-index -->'
// Feature ids are `<AREA>-<NNN>`, where an area is one or more uppercase words joined by `-` (`SCAN`, `UI-SCAN`).
const AREA = '[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*'
const FEATURE_TAG = new RegExp(`^@(${AREA}-\\d{3})$`)
const SECTION = new RegExp(`^## (${AREA})\\. \\S`)
const FEATURE = new RegExp(`^- \\*\\*((${AREA})-\\d{3})\\*\\* \\[([a-z0-9, ]+)\\] (\\S.*)$`)
const SURFACES = new Set(['api', 'ui', 'cli', 'mcp', 'e2e', 'authz', 'security', 'chaos'])
const SUMMARY_LENGTH = 100

/**
 * The features of FEATURES.md in document order: `## <AREA>. <Title>` sections holding one
 * `- **<AREA>-<NNN>** [<surface>, …] <behaviour>` line per feature. Returns id → one-line summary.
 */
function readFeatures() {
  const features = new Map()
  let area = null
  readFileSync(join(testsDir, 'FEATURES.md'), 'utf8')
    .split('\n')
    .forEach((line, index) => {
      const where = `FEATURES.md:${index + 1}`
      const section = SECTION.exec(line)
      if (section) {
        area = section[1]
        return
      }
      if (!line.startsWith('- ') || area === null) return
      const match = FEATURE.exec(line)
      if (!match) throw new Error(`${where}: a feature line must read "- **${area}-<NNN>** [<surfaces>] <behaviour>"`)
      const [, id, prefix, surfaces, text] = match
      if (prefix !== area) throw new Error(`${where}: ${id} is listed in section ${area}`)
      if (features.has(id)) throw new Error(`${where}: FEATURES.md defines ${id} twice`)
      for (const surface of surfaces.split(',').map((s) => s.trim())) {
        if (!SURFACES.has(surface)) throw new Error(`${where}: unknown surface "${surface}" (known: ${[...SURFACES].join(', ')})`)
      }
      features.set(id, summary(text))
    })
  return features
}

/** The behaviour text without Markdown emphasis or code marks, cut at a word boundary for the coverage table. */
function summary(text) {
  const plain = text.replaceAll('`', '').replaceAll('**', '')
  if (plain.length <= SUMMARY_LENGTH) return plain
  const cut = plain.slice(0, SUMMARY_LENGTH)
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : SUMMARY_LENGTH)} …`
}

/**
 * Why this process may not list the suite, or null inside a Linux container (Docker's /.dockerenv, Podman's
 * /run/.containerenv). Specs and helpers run module code for the runner (Linux procfs, /src, /run/scantor-test), so
 * a listing on another host fails on unrelated errors or lists a different suite.
 */
export function containerProblem({ platform = process.platform, exists = existsSync } = {}) {
  if (platform === 'linux' && (exists('/.dockerenv') || exists('/run/.containerenv'))) return null
  return (
    'test-index.mjs runs only inside a Linux container, because listing the suite loads every spec and helper, which ' +
    'expect the dockerized runner: run `just test-index` (or `just test-index --check`) instead (docs/testing.md §10)'
  )
}

/** The suite as Playwright lists it: [{project, file, describe, title, tags}]. */
function listTests() {
  // The config needs the runner's variables; listing never contacts the stack, so placeholders do.
  const placeholders = {
    SCANTOR_PUBLIC_URL: 'https://scantor.localhost',
    SCANTOR_EDITOR_URL: 'https://editor.scantor.localhost',
    SCANTOR_ADMIN_EMAIL: 'admin@scantor.test',
    SCANTOR_ADMIN_PASSWORD: 'unused',
    SCANTOR_SECRET: 'unused',
    SCANTOR_TEST_WORKERS: '1',
    NODE_EXTRA_CA_CERTS: '/dev/null',
  }
  const result = spawnSync('npx', ['--no-install', 'playwright', 'test', '--list', '--reporter=json'], {
    cwd: testsDir,
    env: { ...process.env, ...placeholders, CI: '' },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`playwright test --list failed (${result.status}):\n${result.stderr}\n${result.stdout.slice(0, 4000)}`)
  const report = JSON.parse(result.stdout)
  if (report.errors?.length) throw new Error(`playwright test --list reported errors:\n${report.errors.map((e) => e.message).join('\n')}`)
  const tests = []
  const visit = (suite, file, path) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        tests.push({
          project: test.projectName,
          file,
          describe: path[0] ?? '',
          title: [...path, spec.title].join(' › '),
          tags: spec.tags.map((t) => `@${t.replace(/^@/, '')}`),
        })
      }
    }
    for (const child of suite.suites ?? []) visit(child, file, [...path, child.title])
  }
  for (const fileSuite of report.suites ?? []) visit(fileSuite, fileSuite.file ?? fileSuite.title, [])
  return { tests, projects: report.config.projects.map((p) => p.name) }
}

function walk(dir, accept, skip = new Set(['node_modules', '.git', 'testdata'])) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name) || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path, accept, skip))
    else if (accept(entry.name)) out.push(path)
  }
  return out.sort()
}

/** Unit suites by location, without counts. */
function unitSuites() {
  const goPackages = [
    ...new Set(
      walk(repo, (n) => n.endsWith('_test.go'), new Set(['node_modules', '.git', 'testdata', 'tests', 'orchestrator', 'connectors'])).map(
        (f) => relative(repo, resolve(f, '..')) || '.',
      ),
    ),
  ].sort()
  const vitest = walk(join(repo, 'orchestrator', 'test'), (n) => n.endsWith('.test.ts')).map((f) => relative(repo, f))
  const connectors = ['connectors/python/tests', 'connectors/js/test', 'connectors/go'].filter((d) => existsSync(join(repo, d)))
  return { goPackages, vitest, connectors }
}

const code = (s) => `\`${s}\``
const cell = (s) => s.replaceAll('|', '\\|')

export function generate() {
  const features = readFeatures()
  const { tests, projects } = listTests()
  const lines = [BEGIN, '', '<!-- Generated by `just test-index` from the Playwright suite and FEATURES.md; do not edit. -->', '']

  lines.push('## Playwright projects', '')
  for (const project of projects) {
    const ofProject = tests.filter((t) => t.project === project)
    if (ofProject.length === 0) continue
    lines.push(`### ${project} (${ofProject.length} ${ofProject.length === 1 ? 'test' : 'tests'})`, '', '| Spec | Describe blocks | Tests |', '|---|---|---|')
    for (const file of [...new Set(ofProject.map((t) => t.file))].sort()) {
      const inFile = ofProject.filter((t) => t.file === file)
      const describes = [...new Set(inFile.map((t) => t.describe).filter(Boolean))]
      lines.push(`| ${code(file)} | ${cell(describes.join('; ') || '–')} | ${inFile.length} |`)
    }
    lines.push('')
  }

  const covering = new Map()
  const unknown = []
  for (const test of tests) {
    for (const tag of test.tags) {
      const match = FEATURE_TAG.exec(tag)
      if (!match) continue
      if (!features.has(match[1])) unknown.push(`${tag} in ${test.file} › ${test.title}`)
      else covering.set(match[1], [...(covering.get(match[1]) ?? []), `${test.file} › ${test.title}`])
    }
  }
  const uncovered = [...features.keys()].filter((id) => !covering.has(id))
  lines.push('## Feature coverage', '', '| Feature | Behaviour | Tests |', '|---|---|---|')
  for (const [id, title] of features) {
    const covered = [...new Set(covering.get(id) ?? [])]
    lines.push(`| ${id} | ${cell(title)} | ${covered.length ? covered.map((t) => cell(t)).join('<br>') : '**uncovered**'} |`)
  }
  lines.push('', '### Uncovered features', '', ...(uncovered.length ? uncovered.map((id) => `- ${id} ${features.get(id)}`) : ['None.']))
  lines.push('', '### Unknown feature tags', '', ...(unknown.length ? [...new Set(unknown)].map((u) => `- ${u}`) : ['None.']))

  const units = unitSuites()
  lines.push('', '## Unit suites', '', '### Go packages', '', ...units.goPackages.map((p) => `- ${code(p)}`))
  lines.push('', '### Orchestrator (vitest)', '', ...units.vitest.map((f) => `- ${code(f)}`))
  lines.push('', '### Connectors', '', ...units.connectors.map((d) => `- ${code(d)}`))
  lines.push('', END)
  return { block: lines.join('\n'), uncovered, unknown }
}

function main() {
  const problem = containerProblem()
  if (problem) throw new Error(problem)
  const check = process.argv.includes('--check')
  const file = join(testsDir, 'TESTS.md')
  const current = readFileSync(file, 'utf8')
  const begin = current.indexOf(BEGIN)
  const end = current.indexOf(END)
  if (begin < 0 || end < begin) throw new Error(`TESTS.md lacks the markers ${BEGIN} … ${END}`)
  const { block, uncovered, unknown } = generate()
  const next = current.slice(0, begin) + block + current.slice(end + END.length)
  if (check) {
    const problems = []
    if (next !== current) problems.push('TESTS.md is stale: run `just test-index`')
    if (uncovered.length) problems.push(`uncovered FEATURES.md ids: ${uncovered.join(', ')}`)
    if (unknown.length) problems.push(`unknown feature tags: ${[...new Set(unknown)].join('; ')}`)
    if (problems.length) {
      for (const problem of problems) console.error(problem)
      process.exit(1)
    }
    console.log('TESTS.md: ok')
    return
  }
  if (next !== current) writeFileSync(file, next)
  console.log(`TESTS.md: ${next === current ? 'up to date' : 'regenerated'} (${uncovered.length} uncovered, ${unknown.length} unknown tags)`)
}

// Imported by its unit tests (test-index.test.mjs), it only exports.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
