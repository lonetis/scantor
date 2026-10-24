import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Revision } from '#shared/types/revisions'
import { ok, type ApiClient } from '../helpers/api-client'
import { mapLimit, containerImage } from '../helpers/security'
import { CONTAINERS, docker, stackEnv } from '../helpers/docker'
import { scantor } from '../helpers/cli'
import { packTask, waitForRevision } from '../helpers/tasks'
import { withSecurityTenants } from '../helpers/security-tenants'
import { expect, test as base, unique } from '../fixtures'

// The tenant fixtures of the security specs (helpers/security-tenants.ts).
const test = withSecurityTenants(base)

// The Dockerfile policy (docs/tasks.md §8.2, docs/security.md §6.2 BLD-1…BLD-8). Every case of
// tests/corpora/dockerfile-policy goes through the pipeline's static check (`scantor task check-static`, the code the
// orchestrator's build subprocess runs), and one sample per rule goes through uploadTask and the real server
// (docs/testing.md §14 decision 11), together with the COPY --from exploit against a real task image and an external
// image with ONBUILD triggers that only the build phase can see.
//
// Every revision build (static rejections included) takes one of the stack's SCANTOR_BUILD_CONCURRENCY slots, served
// FIFO, so each test publishes its whole batch at once and only then waits for the revisions.

interface PolicyCase {
  id: string
  dockerfile: string
  expect: {
    description: string
    options?: { registryPublicHost?: string; publicUrl?: string }
    errors: { phase: string; file: string; line: number; rule: string }[]
    warnings: { line: number; rule: string }[]
  }
}

const CORPUS = join(import.meta.dirname, '..', 'corpora', 'dockerfile-policy')

async function loadCorpus(): Promise<PolicyCase[]> {
  const cases: PolicyCase[] = []
  for (const id of (await readdir(CORPUS)).sort()) {
    const dockerfile = await readFile(join(CORPUS, id, 'Dockerfile'), 'utf8')
    const expected = JSON.parse(await readFile(join(CORPUS, id, 'expect.json'), 'utf8')) as PolicyCase['expect']
    cases.push({ id, dockerfile, expect: expected })
  }
  return cases
}

/**
 * Through the real server: d5-platform-hosts names the unit tests' platform hosts, so it uses the stack's;
 * valid-add-local copies no task code (which only the static check accepts), so the folder is copied as well and
 * describe finds the entry.
 */
function forStack(testCase: PolicyCase): PolicyCase {
  if (testCase.id === 'valid-add-local') return { ...testCase, dockerfile: `${testCase.dockerfile.trimEnd()}\nCOPY . .\n` }
  if (testCase.id !== 'd5-platform-hosts') return testCase
  const stack = stackEnv()
  const dockerfile = testCase.dockerfile
    .replace('registry.scantor.example:443', stack.SCANTOR_REGISTRY_PUBLIC_HOST!)
    .replace('scantor.example/', `${new URL(stack.SCANTOR_PUBLIC_URL!).host}/`)
  return { ...testCase, dockerfile }
}

/** A minimal Python task folder; each case only replaces its Dockerfile. */
const BASE_FILES: Record<string, string | Buffer> = {
  'scantor.yaml': 'scantor: 1\nname: policy\nlanguage: python\n',
  '.dockerignore': '.git\n__pycache__\n.scantor\n',
  'requirements.txt': '',
  'main.py': [
    'from pydantic import BaseModel',
    '',
    'import scantor',
    '',
    '',
    'class Result(BaseModel):',
    '    ok: bool',
    '',
    '',
    'def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: scantor.Empty) -> Result:',
    '    return Result(ok=True)',
    '',
    '',
    'task = scantor.Task(result=Result, run=run)',
    '',
  ].join('\n'),
}

/** Extra files some valid cases ADD (a local archive, a folder, a file named like a git remote). */
async function addLocalFiles(): Promise<Record<string, string | Buffer>> {
  return {
    'vendor.tar.gz': await packTask(join(CORPUS, 'valid-python-minimal')),
    'scripts/run.sh': '#!/bin/sh\necho run\n',
    'repo.git': 'a local file named like a git remote\n',
  }
}

async function writeFolder(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'policy-'))
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
  return dir
}

/**
 * Publishes every Dockerfile through uploadTask at once: `parallel` tasks (tracked for deletion by the tasks fixture)
 * upload their share one after the other without waiting for the builds (publishing snapshots the workspace
 * synchronously, so a later upload never changes an earlier revision), then every revision is awaited. Returns the
 * settled revisions in input order, each with the task it belongs to.
 */
async function publishBatch(
  api: ApiClient,
  tasks: { track(name: string): void },
  prefix: string,
  dockerfiles: readonly string[],
  options: { parallel?: number; extra?: Record<string, string | Buffer> } = {},
): Promise<{ task: string; revision: Revision }[]> {
  const parallel = Math.min(options.parallel ?? 4, dockerfiles.length)
  const names = Array.from({ length: parallel }, () => unique(prefix))
  for (const name of names) tasks.track(name)
  const dirs = await Promise.all(names.map(() => writeFolder({ ...BASE_FILES, ...options.extra })))
  const published: { task: string; taskId: string; revisionId: string }[] = new Array(dockerfiles.length)
  try {
    await Promise.all(
      names.map(async (name, slot) => {
        for (let index = slot; index < dockerfiles.length; index += parallel) {
          await writeFile(join(dirs[slot]!, 'Dockerfile'), dockerfiles[index]!)
          const uploaded = ok(await api.uploadTask(await packTask(dirs[slot]!, { name }), { publish: true, force: true }), 'uploadTask')
          published[index] = { task: name, taskId: uploaded.task.id, revisionId: uploaded.revision!.id }
        }
      }),
    )
  } finally {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  }
  return mapLimit(published, 16, async ({ task, taskId, revisionId }) => ({ task, revision: await waitForRevision(api, taskId, revisionId, 170_000) }))
}

/** The W1/W2 warnings of a case (W3, a missing .dockerignore, never fires: the folder has one). */
function expectPolicyWarnings(testCase: PolicyCase, warnings: string[]): void {
  const policy = warnings.filter((w) => /\(W[12]\)$/.test(w))
  expect.soft(policy.length, `${testCase.id}: ${JSON.stringify(warnings)}`).toBe(testCase.expect.warnings.length)
  for (const expected of testCase.expect.warnings) {
    expect
      .soft(
        policy.some((w) => w.startsWith(`Dockerfile:${expected.line}:`) && w.endsWith(`(${expected.rule})`)),
        `${testCase.id}: W at line ${expected.line} ${expected.rule} in ${JSON.stringify(warnings)}`,
      )
      .toBe(true)
  }
}

interface StaticError {
  phase: string
  file?: string | null
  line?: number | null
  message: string
}

/** Exactly the expected static errors on the Dockerfile, each with its line and rule. */
function expectStaticErrors(errors: StaticError[], testCase: PolicyCase): void {
  const label = `${testCase.id}: ${JSON.stringify(errors)}`
  expect.soft(errors.length, label).toBe(testCase.expect.errors.length)
  for (const expected of testCase.expect.errors) {
    const match = errors.find(
      (error) => error.phase === 'static' && error.file === 'Dockerfile' && (error.line ?? 0) === expected.line && error.message.endsWith(`(${expected.rule})`),
    )
    expect.soft(match, `${testCase.id}: line ${expected.line} ${expected.rule} in ${JSON.stringify(errors)}`).toBeDefined()
  }
}

/** A failed revision whose errors are exactly the static errors of the case, and no image. */
function expectRejectedRevision(revision: Revision, testCase: PolicyCase): void {
  const label = `${testCase.id}: ${revision.state} ${JSON.stringify(revision.errors)}`
  expect.soft(revision.state, label).toBe('failed')
  expect.soft(revision.errors[0], label).toMatchObject({ phase: 'static', file: 'Dockerfile' })
  expectStaticErrors(revision.errors, testCase)
  expect.soft(revision.image, testCase.id).toBeNull()
}

/** The case with the lowest id per rule, plus multiple-violations (every rule of a Dockerfile is reported). */
function samplePerRule(cases: PolicyCase[]): PolicyCase[] {
  const samples = new Map<string, PolicyCase>()
  for (const testCase of cases) {
    for (const { rule } of testCase.expect.errors) if (!samples.has(rule)) samples.set(rule, testCase)
  }
  return [...new Set([...samples.values(), ...cases.filter((c) => c.id === 'multiple-violations')])]
}

/** The documented unspecified-address samples (docs/testing.md §8.6): they reach the host's own registry port. */
const UNSPECIFIED_SAMPLES: PolicyCase[] = ['0.0.0.0:5000/x', '[::]:5000/x'].map((reference) => ({
  id: `sample ${reference}`,
  dockerfile: `ARG SCANTOR_BASE\nFROM ${reference} AS b\nFROM \${SCANTOR_BASE}\n`,
  expect: { description: reference, errors: [{ phase: 'static', file: 'Dockerfile', line: 2, rule: 'D5' }], warnings: [] },
}))

/** Valid cases whose builds need nothing beyond the base image and the task folder (the others pull public images). */
const SELF_CONTAINED = new Set(['valid-python-minimal', 'valid-lowercase-instructions', 'valid-escape-directive', 'valid-labels', 'valid-add-local'])

test.describe('Dockerfile policy', () => {
  test('every case of the corpus gets exactly its static errors and warnings from the pipeline’s static check', { tag: ['@SEC-001', '@SEC-002'] }, async () => {
    const cases = await loadCorpus()
    // The corpus has a sample of every rule D1–D11 and of every D5 host kind of SEC-002.
    expect([...new Set(cases.flatMap((c) => c.expect.errors.map((e) => e.rule)))].sort()).toEqual(
      ['D1', 'D10', 'D11', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9'].sort(),
    )
    expect(cases.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        'd5-dot-localhost',
        'd5-host-docker-internal',
        'd5-loopback-ipv6',
        'd5-private-ip',
        'd5-link-local',
        'd5-unique-local-ipv6',
        'd5-unspecified-ipv4',
        'd5-unspecified-ipv6',
        'd5-registry-service',
        'd5-platform-hosts',
        'd5-tasks-any-host',
        'd5-bare-hex-id',
        'd5-variable',
        'd5-mount-from-registry',
      ]),
    )
    const extra = await addLocalFiles()
    // One folder per case: the CLI packs the folder it is given. The case's own platform hosts (the unit tests'
    // options) are the CLI's SCANTOR_PUBLIC_URL and SCANTOR_REGISTRY_PUBLIC_HOST.
    await mapLimit(cases, 8, async (testCase) => {
      const dir = await writeFolder({ ...BASE_FILES, ...extra, Dockerfile: testCase.dockerfile })
      try {
        const options = testCase.expect.options ?? {}
        const result = await scantor(['task', 'check-static', dir, '--events', 'ndjson'], {
          timeoutMs: 60_000,
          env: {
            ...(options.publicUrl ? { SCANTOR_PUBLIC_URL: options.publicUrl } : {}),
            ...(options.registryPublicHost ? { SCANTOR_REGISTRY_PUBLIC_HOST: options.registryPublicHost } : {}),
          },
        })
        const events = (Array.isArray(result.json) ? result.json : []) as { type: string; level?: string; text?: string; error?: StaticError }[]
        expect.soft(result.exitCode, `${testCase.id}: ${result.stderr.slice(-1000)}`).toBe(testCase.expect.errors.length > 0 ? 2 : 0)
        expectStaticErrors(
          events.filter((event) => event.type === 'error').map((event) => event.error!),
          testCase,
        )
        expectPolicyWarnings(
          testCase,
          events.filter((event) => event.type === 'log' && event.level === 'warning').map((event) => event.text ?? ''),
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })

  test(
    'one sample per rule fails statically through uploadTask with its file, line and rule, and builds nothing',
    { tag: ['@SEC-001', '@SEC-002'] },
    async ({ api, tasks }) => {
      test.setTimeout(180_000)
      const corpus = await loadCorpus()
      const rejecting = corpus.filter((c) => c.expect.errors.length > 0)
      const cases = [...samplePerRule(rejecting), ...rejecting.filter((c) => c.id === 'd5-platform-hosts'), ...UNSPECIFIED_SAMPLES].map(forStack)
      expect([...new Set(cases.flatMap((c) => c.expect.errors.map((e) => e.rule)))]).toHaveLength(11)
      const settled = await publishBatch(
        api,
        tasks,
        'policy',
        cases.map((c) => c.dockerfile),
      )
      settled.forEach(({ revision }, index) => expectRejectedRevision(revision, cases[index]!))
    },
  )

  test('the self-contained valid cases publish ready with the policy warnings in their build log', { tag: ['@SEC-001'] }, async ({ api, tasks }) => {
    test.setTimeout(180_000)
    const corpus = await loadCorpus()
    // warnings-ignored-instructions overrides SCANTOR_CONNECTOR_CMD with a command the base image lacks: its revision
    // fails at describe, after the static check reported its W1/W2 warnings.
    const cases = corpus.filter((c) => SELF_CONTAINED.has(c.id) || c.id === 'warnings-ignored-instructions').map(forStack)
    expect(cases).toHaveLength(SELF_CONTAINED.size + 1)
    const settled = await publishBatch(
      api,
      tasks,
      'policy-ok',
      cases.map((c) => c.dockerfile),
      { extra: await addLocalFiles() },
    )
    await Promise.all(
      settled.map(async ({ task, revision }, index) => {
        const testCase = cases[index]!
        const label = `${testCase.id}: ${revision.state} ${JSON.stringify(revision.errors)}`
        expect
          .soft(
            revision.errors.filter((error) => error.phase === 'static'),
            label,
          )
          .toEqual([])
        if (testCase.id === 'warnings-ignored-instructions') expect.soft(revision.errors[0]?.phase, label).toBe('describe')
        else expect.soft(revision.state, label).toBe('ready')
        // The static warnings are pipeline log events of the build log, whatever the later phases did.
        const log = ok(
          await api.call<{ lines: { phase: string; level?: string; text?: string }[] }>('getRevisionBuildLog', {
            path: { task, revision: revision.id },
            query: { limit: 5000 },
          }),
          'getRevisionBuildLog',
        )
        expectPolicyWarnings(
          testCase,
          log.lines.filter((line) => line.phase === 'static' && line.level === 'warning').map((line) => line.text ?? ''),
        )
      }),
    )
  })

  test(
    'COPY --from another task image on the local registry is rejected with its line and never yields the files',
    { tag: ['@SEC-003', '@SEC-002'] },
    async ({ api, tasks, shared }) => {
      test.setTimeout(180_000)
      // The victim: a real task image of the tenant on the platform registry.
      const victim = await shared.fixture('netprobe')
      const image = victim.revision.image!
      const stack = stackEnv()
      const port = stack.SCANTOR_REGISTRY_PORT ?? '5000'
      const references = [
        `localhost:${port}/${image.repository}:${image.tag}`,
        `localhost:${port}/${image.repository}@${image.digest}`,
        `127.0.0.1:${port}/${image.repository}:${image.tag}`,
        `[::1]:${port}/${image.repository}:${image.tag}`,
        `registry:5000/${image.repository}:${image.tag}`,
        `${stack.SCANTOR_REGISTRY_PUBLIC_HOST}/${image.repository}:${image.tag}`,
        `${image.repository}:${image.tag}`,
      ]
      // Every reference in the exploit's own form; the other two ways to read an image (a stage, a bind mount) with
      // the exploit's reference. Every attempt costs one of the stack's few build slots, so the matrix stays small.
      const attempts = [
        ...references.map((reference) => ({
          reference,
          dockerfile: `ARG SCANTOR_BASE\nFROM \${SCANTOR_BASE}\nCOPY --from=${reference} /task /stolen\nCOPY . .\n`,
          line: 3,
        })),
        {
          reference: references[0]!,
          dockerfile: `ARG SCANTOR_BASE\nFROM ${references[0]} AS victim\nFROM \${SCANTOR_BASE}\nCOPY --from=victim /task /stolen\n`,
          line: 2,
        },
        {
          reference: references[0]!,
          dockerfile: `ARG SCANTOR_BASE\nFROM \${SCANTOR_BASE}\nRUN --mount=type=bind,from=${references[0]},target=/mnt cp -r /mnt /task/stolen\n`,
          line: 3,
        },
      ]
      const settled = await publishBatch(
        api,
        tasks,
        'attacker',
        attempts.map((a) => a.dockerfile),
      )
      settled.forEach(({ revision }, index) => {
        const { reference, line } = attempts[index]!
        expect.soft(revision.state, reference).toBe('failed')
        expect.soft(revision.errors[0], `${reference}: ${JSON.stringify(revision.errors)}`).toMatchObject({
          phase: 'static',
          file: 'Dockerfile',
          line,
          message: expect.stringMatching(/\(D5\)$/),
        })
        // No image was built, so nothing of the victim can end up anywhere.
        expect.soft(revision.image, reference).toBeNull()
      })
    },
  )

  test('an external stage image with ONBUILD triggers fails the build with the image and its line', { tag: ['@SEC-004'] }, async ({ api, tasks }) => {
    test.setTimeout(180_000)
    // A local image with an ONBUILD trigger, built in the master's Docker by the test.
    const image = `scantor-test-onbuild:${unique('t')}`
    await docker(['build', '-t', image, '--label', 'scantor.test=true', '-'], {
      input: `FROM ${await containerImage(CONTAINERS.node)}\nONBUILD RUN echo "an ONBUILD trigger ran"\n`,
      timeoutMs: 120_000,
    })
    try {
      const [{ revision }] = await publishBatch(api, tasks, 'onbuild', [`ARG SCANTOR_BASE\nFROM ${image} AS helper\nFROM \${SCANTOR_BASE}\nCOPY . .\n`])
      expect(revision.state).toBe('failed')
      const [error] = revision.errors
      expect(error, JSON.stringify(revision.errors)).toMatchObject({ phase: 'build' })
      expect(`${error!.file ?? ''}:${error!.line ?? ''} ${error!.message}`).toContain(image)
      expect(error!.line ?? Number(/Dockerfile:(\d+)/.exec(error!.message)?.[1])).toBe(2)
      expect(revision.image).toBeNull()
    } finally {
      await docker(['rmi', '-f', image], { allowFailure: true })
    }
  })
})
