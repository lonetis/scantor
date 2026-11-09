import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extract } from 'tar-stream'
import { describe, expect, it } from 'vitest'
import { isScriptRunContainer, runtimeArchive, scriptRunContainerName, scriptRunContainerSpec } from '../../../server/services/script-runs/container'
import { exitOutcome, FrameAssembler } from '../../../server/services/script-runs/job'
import { toApiScriptRun, toScriptRunSummary } from '../../../server/services/script-runs/mappers'
import type { ScriptRunDoc } from '../../../server/types/documents'
import { RUNTIME_HEALTHCHECK, SCRIPTS_NETWORK } from '../../../server/utils/docker'

// The script-run container (docs/scripts.md, security SB-1/SB-3/SB-5): scantor-scripts only, every capability dropped
// and none added, the injected runtime as entrypoint (the shared injection tar with the runtime only), the run token and
// internal URL as its only environment; the exit outcome; Docker frame assembly; and the representation that never
// leaks internal fields.

const RUN_ID = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const USER_ID = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'

describe('runtimeArchive', () => {
  it('holds only the runtime binary with fixed modes and owners', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scantor-script-injection-'))
    const binary = join(dir, 'scantor')
    writeFileSync(binary, 'ELF')
    const entries: [string, string, number, string][] = []
    const extractor = extract()
    await new Promise<void>((resolve, reject) => {
      extractor.on('entry', (header, stream, next) => {
        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', () => {
          entries.push([header.name, (header.mode ?? 0).toString(8), header.uid ?? -1, Buffer.concat(chunks).toString()])
          next()
        })
      })
      extractor.on('finish', resolve)
      extractor.on('error', reject)
      runtimeArchive(binary).pipe(extractor)
    })
    expect(entries).toEqual([
      ['scantor/', '755', 0, ''],
      ['scantor/scantor', '755', 0, 'ELF'],
    ])
  })
})

describe('scriptRunContainerSpec', () => {
  const spec = scriptRunContainerSpec({
    scriptRunId: RUN_ID,
    userId: USER_ID,
    image: 'sha256:abc',
    entry: 'main.py',
    resources: { cpus: 1.5, memoryMiB: 512 },
    url: 'http://orchestrator:3000',
    token: 'ssr_x.y',
  })

  it('runs the injected runtime in script mode with the run token', () => {
    expect(spec.name).toBe(`scantor-s-${RUN_ID}`)
    expect(spec.Image).toBe('sha256:abc')
    expect(spec.Entrypoint).toEqual(['/scantor/scantor', 'runtime', 'script', '--entry', 'main.py'])
    expect(spec.Env).toEqual(['SCANTOR_URL=http://orchestrator:3000', 'SCANTOR_SCRIPT_TOKEN=ssr_x.y'])
    expect(spec.Healthcheck).toEqual(RUNTIME_HEALTHCHECK)
    expect(spec.Labels).toMatchObject({ 'scantor.managed': 'true', 'scantor.kind': 'scriptRun', 'scantor.user': USER_ID, 'scantor.script-run': RUN_ID })
  })

  it('applies the hardening profile on the scripts network only', () => {
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: SCRIPTS_NETWORK,
      Privileged: false,
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges:true'],
      Init: true,
      PidsLimit: 4096,
      Memory: (512 + 256) * 1024 ** 2,
      MemorySwap: (512 + 256) * 1024 ** 2,
      NanoCpus: 1_500_000_000,
      OomScoreAdj: 1000,
      LogConfig: { Type: 'local', Config: { 'max-size': '50m', 'max-file': '5' } },
      RestartPolicy: { Name: 'no' },
    })
    expect(spec.HostConfig?.Binds).toBeUndefined()
    expect(spec.HostConfig?.Mounts).toBeUndefined()
  })

  it('recognises only this run’s managed container by name', () => {
    const labels = spec.Labels as Record<string, string>
    expect(isScriptRunContainer(RUN_ID, `/${scriptRunContainerName(RUN_ID)}`, labels)).toBe(true)
    expect(isScriptRunContainer('6c9b1d2e-7f3a-4b5c-8d9e-0f1a2b3c4d5e', scriptRunContainerName(RUN_ID), labels)).toBe(false)
    expect(isScriptRunContainer(RUN_ID, scriptRunContainerName(RUN_ID), { ...labels, 'scantor.managed': 'false' })).toBe(false)
  })
})

describe('exitOutcome', () => {
  const exit = (exitCode: number, extra: Partial<{ oomKilled: boolean; timedOut: boolean }> = {}) => ({ exitCode, oomKilled: false, timedOut: false, ...extra })

  it('completes on exit 0 and fails otherwise with the reported error, a crash, an OOM kill or the timeout', () => {
    expect(exitOutcome(exit(0), null, undefined, 60_000)).toEqual({ state: 'completed', error: null })
    expect(exitOutcome(exit(1), { type: 'scriptError', message: 'boom' }, 'trace', 60_000)).toEqual({
      state: 'failed',
      error: { type: 'scriptError', message: 'boom' },
    })
    expect(exitOutcome(exit(139), null, 'Segmentation fault', 60_000)).toEqual({
      state: 'failed',
      error: { type: 'crash', message: 'exited with code 139', stack: 'Segmentation fault' },
    })
    expect(exitOutcome(exit(137, { oomKilled: true }), null, undefined, 60_000)).toEqual({
      state: 'failed',
      error: { type: 'crash', message: 'killed: out of memory' },
    })
    expect(exitOutcome(exit(143, { timedOut: true }), { type: 'scriptError', message: 'cancelled' }, undefined, 7_200_000)).toEqual({
      state: 'failed',
      error: { type: 'timeout', message: 'the script run exceeded its timeout of 2h' },
    })
  })
})

describe('FrameAssembler', () => {
  it('joins partial frames, passes the frame timestamp once and cuts endless lines', () => {
    const lines: [string, string | undefined][] = []
    const assembler = new FrameAssembler((text, ts) => lines.push([text, ts]))
    assembler.frame('hel', 't1')
    assembler.frame('lo\r\nwor', 't2')
    assembler.frame('ld\n', 't3')
    assembler.frame('x'.repeat(40_000), 't4')
    assembler.frame('rest of the long line\nnext\n', 't5')
    assembler.frame('unterminated', 't6')
    assembler.end()
    expect(lines.map(([text, ts]) => [text.length > 100 ? `long:${text.length}` : text, ts])).toEqual([
      ['hello', 't2'],
      ['world', 't3'],
      ['long:40000', 't4'],
      ['next', 't5'],
      ['unterminated', 't6'],
    ])
  })
})

describe('toApiScriptRun', () => {
  const now = new Date('2026-11-08T20:00:00Z')
  const doc = {
    _id: RUN_ID,
    userId: USER_ID,
    scriptId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    scriptName: 'csp',
    scanIds: ['a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'],
    state: 'running',
    input: { config: { k: 1 }, settings: { timeoutMs: 1000, resources: { cpus: 1, memoryMiB: 512 }, limit: 100 } },
    secrets: { names: ['API_TOKEN'], enc: 'sealed' },
    source: { key: `script-runs/${RUN_ID}/source.tar.gz`, packSha256: 'f'.repeat(64), packBytes: 10, fileCount: 3 },
    restartedFrom: null,
    image: { ref: 'scripts/x:y', id: 'sha256:abc', cached: true },
    entry: 'main.py',
    container: { id: 'cid', name: `scantor-s-${RUN_ID}`, createdAt: now },
    errors: [],
    error: null,
    exitCode: null,
    progress: { done: 5, total: 10, message: null, updatedAt: now },
    checkpoint: { state: { secret: 'internal' }, savedAt: now, bytes: 20 },
    result: null,
    outputs: [
      {
        id: 'o1',
        name: 'a.csv',
        key: 'k1',
        contentType: 'text/csv',
        state: 'stored',
        uploadId: null,
        reservedBytes: 0,
        size: 3,
        sha256: 'e'.repeat(64),
        createdAt: now,
        storedAt: now,
      },
      {
        id: 'o2',
        name: 'b.csv',
        key: 'k2',
        contentType: 'text/csv',
        state: 'pending',
        uploadId: 'u',
        reservedBytes: 9,
        size: null,
        sha256: null,
        createdAt: now,
        storedAt: null,
      },
    ],
    log: { lines: 7, bytes: 70, firstLine: 1, droppedLines: 0, nextChunk: 1, cursor: { ts: 't', countAtTs: 1 } },
    jobId: 'job',
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    updatedAt: now,
    expiresAt: null,
  } as ScriptRunDoc

  it('lists secret names, stored outputs and the checkpoint size only', () => {
    const run = toApiScriptRun(doc, { scanNames: new Map([[doc.scanIds[0]!, 'files-e2e']]) })
    expect(run.secrets).toEqual(['API_TOKEN'])
    expect(run.scans).toEqual([{ id: doc.scanIds[0], name: 'files-e2e' }])
    expect(run.outputs).toEqual([{ id: 'o1', name: 'a.csv', size: 3, sha256: 'e'.repeat(64), contentType: 'text/csv', createdAt: now.toISOString() }])
    expect(run.checkpoint).toEqual({ savedAt: now.toISOString(), bytes: 20 })
    expect(run.image).toEqual({ ref: 'scripts/x:y', cached: true })
    expect(run.log).toEqual({ lines: 7, firstLine: 1, droppedLines: 0 })
    const json = JSON.stringify(run)
    for (const internal of ['sealed', 'source.tar.gz', 'cid', 'sha256:abc', 'internal', '"job"', 'uploadId', 'cursor']) expect(json).not.toContain(internal)
    expect(run).not.toHaveProperty('logTail')
  })

  it('summarises a run for recentRuns', () => {
    expect(toScriptRunSummary(doc)).toEqual({
      id: RUN_ID,
      state: 'running',
      createdAt: now.toISOString(),
      finishedAt: null,
      progress: { done: 5, total: 10, message: null, updatedAt: now.toISOString() },
    })
  })
})
