import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { extract } from 'tar-stream'
import { describe, expect, it } from 'vitest'
import { injectionArchive, localSpec, testRunContainerSpec } from '../../../server/services/test-runs/container'
import { formatSseEvent } from '../../../server/services/test-runs/stream'

// The test-run container (docs/tasks.md §11.2), its local-mode spec (§11.3, docs/runtime.md §15.1) and the injection
// tar (docs/runtime.md §3.1).

describe('testRunContainerSpec', () => {
  it('uses scantor-egress, the worker hardening profile, PidsLimit 4096 and the manifest resources', () => {
    const spec = testRunContainerSpec({
      testRunId: '3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7d',
      userId: 'u1',
      image: 'sha256:abc',
      resources: { cpus: 0.5, memoryMiB: 768 },
      capAdd: ['NET_BIND_SERVICE', 'NET_RAW'],
    })
    expect(spec).toMatchObject({
      name: 'scantor-t-3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7d',
      Image: 'sha256:abc',
      Entrypoint: ['/scantor/scantor', 'runtime', 'local', '--spec', '/scantor/in/spec.json'],
      Labels: { 'scantor.managed': 'true', 'scantor.kind': 'testRun', 'scantor.user': 'u1', 'traefik.enable': 'false', 'com.docker.compose.project': 'scantor-managed' },
    })
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: 'scantor-egress',
      CapDrop: ['ALL'],
      CapAdd: ['NET_BIND_SERVICE', 'NET_RAW'],
      SecurityOpt: ['no-new-privileges:true'],
      Init: true,
      PidsLimit: 4096,
      Memory: (768 + 256) * 1024 ** 2,
      NanoCpus: 500_000_000,
    })
    expect(spec.HostConfig?.Privileged).toBeUndefined()
    expect(spec.HostConfig?.Mounts).toBeUndefined()
    expect(spec.HostConfig?.Tmpfs).toBeUndefined()
    expect(spec.Env).toBeUndefined()
  })
})

describe('localSpec', () => {
  it('fills the spec of docs/runtime.md §15.1 with processes 1 and no debugging', () => {
    const spec = localSpec(
      {
        testRunId: 'tr',
        entry: 'main.py',
        taskConfig: { greeting: 'Hi' },
        scanConfig: {},
        analysisConfig: null,
        limit: 5,
        timeoutMs: 300_000,
        maxAttempts: 1,
        backoff: { initialMs: 5000, factor: 2, maxMs: 600_000, jitter: true },
        maxAnalysesPerProcess: 1000,
        totalTimeoutMs: 590_000,
        uploads: { u1: { sha256: 'ab' } },
      },
      { trancoUrl: 'https://tranco-list.eu', cruxUrl: 'https://crux.example', maxAnalysisConfigBytes: 1, maxResultBytes: 2, maxFileBytes: 3, maxFilesPerAnalysis: 4 },
    )
    expect(spec).toMatchObject({
      v: 1,
      runId: 'tr',
      processes: 1,
      debug: false,
      totalTimeoutMs: 590_000,
      dataSources: { tranco: 'https://tranco-list.eu', crux: 'https://crux.example' },
      uploads: { u1: { path: '/scantor/in/uploads/u1', sha256: 'ab' } },
      resolved: {},
      limits: { maxAnalysisConfigBytes: 1, maxResultBytes: 2, maxFileBytes: 3, maxFilesPerAnalysis: 4, logTailBytes: 32768, logTailEarlierBytes: 4096 },
      outDir: '/scantor/out',
    })
  })
})

describe('injectionArchive', () => {
  it('contains the runtime, the spec, the uploads and the out directory with fixed modes and owners', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scantor-injection-'))
    const binary = join(dir, 'scantor')
    writeFileSync(binary, 'ELF')
    const archive = injectionArchive(binary, { v: 1 }, [{ id: 'u1', bytes: 3, open: async () => Readable.from([Buffer.from('a\nb')]) }])
    const entries: { name: string; mode: number; uid: number; content: string }[] = []
    const extractor = extract()
    await new Promise<void>((resolve, reject) => {
      extractor.on('entry', (header, stream, next) => {
        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', () => {
          entries.push({ name: header.name, mode: header.mode ?? 0, uid: header.uid ?? -1, content: Buffer.concat(chunks).toString() })
          next()
        })
      })
      extractor.on('finish', resolve)
      extractor.on('error', reject)
      archive.pipe(extractor)
    })
    expect(entries.map((entry) => [entry.name, entry.mode.toString(8), entry.uid])).toEqual([
      ['scantor/', '755', 0],
      ['scantor/scantor', '755', 0],
      ['scantor/in/', '755', 0],
      ['scantor/in/spec.json', '644', 0],
      ['scantor/in/uploads/', '755', 0],
      ['scantor/in/uploads/u1', '644', 0],
      ['scantor/out/', '1777', 0],
    ])
    expect(entries.find((entry) => entry.name === 'scantor/in/spec.json')?.content).toBe('{"v":1}')
    expect(entries.find((entry) => entry.name === 'scantor/in/uploads/u1')?.content).toBe('a\nb')
  })
})

describe('formatSseEvent', () => {
  it('writes one SSE event', () => {
    expect(formatSseEvent('state', { state: 'running' })).toBe('event: state\ndata: {"state":"running"}\n\n')
  })
})
