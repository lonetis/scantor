import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { gunzipSync } from 'node:zlib'
import Docker from 'dockerode'
import { pack as tarPack } from 'tar-stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PipelineEvent } from '../../../server/services/pipeline/events'
import { runTaskBuild } from '../../../server/services/pipeline/task-build'
import { classifyRevisionBuild } from '../../../server/services/revisions/build'
import { useLogger } from '../../../server/utils/logger'

/*
 * Integration test of the task-pipeline driver with the real `scantor task build` (docs/tasks.md §9) on the local
 * Docker daemon: a draft build as the testRun job runs it (`--skip-check --reuse-existing`, no push). Skipped unless
 * SCANTOR_TEST_SCANTOR_BINARY names a scantor binary for this host and SCANTOR_TEST_SCANTOR_IMAGE a scantor image
 * `<prefix>scantor:<tag>` (prefix ending in "/"), from which the binary extracts the runtime. When
 * `<prefix>scantor-base-python:<tag>` does not exist, a minimal stand-in base image with the ENV contract is built and
 * removed afterwards; the draft image is removed as well.
 */

const binary = process.env.SCANTOR_TEST_SCANTOR_BINARY ?? ''
const image = process.env.SCANTOR_TEST_SCANTOR_IMAGE ?? ''
const enabled = binary !== '' && image !== ''
const at = image.lastIndexOf(':')
const prefix = image.slice(0, at > 0 ? at : image.length).replace(/scantor$/, '')
const tag = at > 0 ? image.slice(at + 1) : 'latest'
const BASE = `${prefix}scantor-base-python:${tag}`
const DRAFT = `${prefix}tasks-it:draft-${Date.now()}`

const docker = new Docker()
const log = useLogger('task-build-it')

async function tarOf(files: Record<string, string>): Promise<Buffer> {
  const archive = tarPack()
  for (const [name, content] of Object.entries(files)) archive.entry({ name }, content)
  archive.finalize()
  const chunks: Buffer[] = []
  for await (const chunk of archive) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

describe.skipIf(!enabled)('scantor task build (Docker)', () => {
  let builtBase = false
  let pack = Buffer.alloc(0)
  let dir = ''

  beforeAll(async () => {
    const exists = await docker
      .getImage(BASE)
      .inspect()
      .then(() => true)
      .catch(() => false)
    if (!exists) {
      const context = await tarOf({
        Dockerfile: 'FROM alpine:3.24\nWORKDIR /task\nENV SCANTOR_LANGUAGE=python SCANTOR_CONNECTOR_CMD="python -m scantor.serve {entry}" SCANTOR_CHECK_CMD="" SCANTOR_DEBUG_CMD="" SCANTOR_DEBUG_PORT=5678\n',
      })
      const stream = await docker.buildImage(Readable.from([context]) as never, { t: BASE })
      await new Promise((resolve, reject) => docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve(null))))
      builtBase = true
    }
    dir = mkdtempSync(join(tmpdir(), 'scantor-task-'))
    writeFileSync(join(dir, 'scantor.yaml'), 'scantor: 1\nname: echo\nlanguage: python\n')
    writeFileSync(join(dir, 'Dockerfile'), 'ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nCOPY . .\n')
    writeFileSync(join(dir, 'main.py'), 'print("hi")\n')
    writeFileSync(join(dir, '.dockerignore'), '.git/\n')
    const packed = spawnSync(binary, ['task', 'pack', dir, '-o', '-'], { env: { PATH: process.env.PATH, HOME: tmpdir() } })
    if (packed.status !== 0) throw new Error(`scantor task pack failed: ${packed.stderr.toString()}`)
    pack = packed.stdout
  }, 300_000)

  afterAll(async () => {
    await docker.getImage(DRAFT).remove().catch(() => undefined)
    if (builtBase) await docker.getImage(BASE).remove().catch(() => undefined)
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 120_000)

  it('builds a draft image and reports events and the BuildResult', async () => {
    const events: PipelineEvent[] = []
    const outcome = await runTaskBuild({
      input: Readable.from([pack]),
      tag: DRAFT,
      expectName: 'echo',
      allowPrivileged: false,
      skipCheck: true,
      reuseExisting: true,
      env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), SCANTOR_IMAGE_PREFIX: prefix, SCANTOR_IMAGE_TAG: tag },
      onEvent: (event) => {
        events.push(event)
      },
      timeoutMs: 600_000,
      log,
      binary,
    })
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index))
    expect(events.at(-1)?.type).toBe('result')
    expect(events.some((event) => event.phase === 'build' && event.stream === 'build')).toBe(true)
    const result = outcome.result!
    expect(result.pack?.packSha256).toBe(createHash('sha256').update(gunzipSync(pack)).digest('hex'))
    expect(result.manifest).toMatchObject({ name: 'echo', language: 'python', entry: 'main.py' })
    expect(result.settingsDefaults).toMatchObject({ workers: 1, processes: 1, timeoutMs: 300_000 })
    expect(result.baseImage?.ref).toContain('scantor-base-python')
    if (outcome.exitCode === 0) {
      expect(result.ok).toBe(true)
      expect(result.description?.schemas).toBeDefined()
    } else {
      // A runtime without the describe mode fails the task content after the image build (exit 2).
      expect(outcome.exitCode).toBe(2)
      expect(['describe', 'check']).toContain(result.errors[0]?.phase)
      expect(classifyRevisionBuild(outcome, { maxImageBytes: 10 ** 10 }, 600_000).state).toBe('failed')
    }
    await expect(docker.getImage(DRAFT).inspect()).resolves.toBeDefined()
  }, 600_000)

  it('reuses the existing draft image', async () => {
    const texts: string[] = []
    await runTaskBuild({
      input: Readable.from([pack]),
      tag: DRAFT,
      expectName: 'echo',
      allowPrivileged: false,
      skipCheck: true,
      reuseExisting: true,
      env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), SCANTOR_IMAGE_PREFIX: prefix, SCANTOR_IMAGE_TAG: tag },
      onEvent: (event) => {
        if (event.text) texts.push(event.text)
      },
      timeoutMs: 600_000,
      log,
      binary,
    })
    expect(texts.some((text) => text.includes('#1 [internal] load remote build context'))).toBe(false)
  }, 600_000)

  it('rejects a manifest whose name differs from the task (rule M9)', async () => {
    const outcome = await runTaskBuild({
      input: Readable.from([pack]),
      tag: DRAFT,
      expectName: 'other',
      allowPrivileged: false,
      skipCheck: true,
      env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), SCANTOR_IMAGE_PREFIX: prefix, SCANTOR_IMAGE_TAG: tag },
      onEvent: () => {},
      timeoutMs: 120_000,
      log,
      binary,
    })
    expect(outcome.exitCode).toBe(2)
    expect(outcome.result?.errors[0]).toMatchObject({ phase: 'static', file: 'scantor.yaml' })
  }, 120_000)
})
