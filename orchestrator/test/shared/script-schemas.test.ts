import { describe, expect, it } from 'vitest'
import {
  createScriptBody,
  getScriptRunLogsQuery,
  listScriptsQuery,
  restartScriptRunBody,
  SCRIPT_RUN_MAX_SCANS,
  scriptParams,
  startScriptRunBody,
} from '../../shared/schemas/scripts'

// Request schemas of the script domain (docs/api.md, docs/scripts.md): strict, bounded, names like task names.

const SCAN = '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f'

describe('script schemas', () => {
  it('accepts script names by the task name rules', () => {
    expect(createScriptBody.parse({ name: 'csp-stats', description: '  Counts CSP headers  ' })).toEqual({
      name: 'csp-stats',
      description: 'Counts CSP headers',
    })
    for (const name of ['upload', 'new', 'latest', 'Upper', '-x', SCAN, 'a'.repeat(65)]) expect(createScriptBody.safeParse({ name }).success, name).toBe(false)
    expect(createScriptBody.safeParse({ name: 'x', description: 'd'.repeat(1025) }).success).toBe(false)
    expect(createScriptBody.safeParse({ name: 'x', language: 'python' }).success).toBe(false)
    expect(scriptParams.safeParse({ script: 'a'.repeat(65) }).success).toBe(false)
    expect(listScriptsQuery.parse({ q: 'csp', limit: '10' })).toEqual({ q: 'csp', limit: 10 })
  })

  it('bounds a new script run: scans, secrets and settings', () => {
    expect(startScriptRunBody.parse({ scans: [SCAN] })).toEqual({ scans: [SCAN], config: {} })
    const full = {
      scans: [SCAN],
      config: { minBytes: 1 },
      secrets: { API_TOKEN: 'secret', B: '' },
      settings: { timeoutMs: 60_000, resources: { cpus: 0.5, memoryMiB: 512 }, limit: 100 },
      confirm: true,
    }
    expect(startScriptRunBody.parse(full)).toEqual(full)
    const invalid: unknown[] = [
      { scans: [] },
      { scans: Array.from({ length: SCRIPT_RUN_MAX_SCANS + 1 }, () => SCAN) },
      { scans: ['nope'] },
      { scans: [SCAN], secrets: { api_token: 'x' } },
      { scans: [SCAN], secrets: { TOKEN: 'x'.repeat(8193) } },
      { scans: [SCAN], secrets: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`S${i}`, 'x'])) },
      { scans: [SCAN], settings: { timeoutMs: 999 } },
      { scans: [SCAN], settings: { resources: { memoryMiB: 255 } } },
      { scans: [SCAN], settings: { resources: { cpus: 0 } } },
      { scans: [SCAN], settings: { limit: 0 } },
      { scans: [SCAN], settings: { limit: null } },
      { scans: [SCAN], settings: { workers: 2 } },
      { scans: [SCAN], extra: true },
    ]
    for (const body of invalid) expect(startScriptRunBody.safeParse(body).success, JSON.stringify(body).slice(0, 80)).toBe(false)
  })

  it('lets a restart resume and clear the original limit', () => {
    expect(restartScriptRunBody.parse({})).toEqual({ resume: false })
    expect(restartScriptRunBody.parse({ resume: true, settings: { limit: null } })).toEqual({ resume: true, settings: { limit: null } })
    expect(restartScriptRunBody.safeParse({ resume: true, scans: [SCAN] }).success).toBe(false)
    expect(restartScriptRunBody.safeParse({ secrets: { A: 'b' } }).success).toBe(false)
  })

  it('pages logs after a line, from the first retained line by default', () => {
    expect(getScriptRunLogsQuery.parse({})).toEqual({ limit: 200 })
    expect(getScriptRunLogsQuery.parse({ afterLine: '10', limit: '1000' })).toEqual({ afterLine: 10, limit: 1000 })
    expect(getScriptRunLogsQuery.safeParse({ limit: '1001' }).success).toBe(false)
    expect(getScriptRunLogsQuery.safeParse({ afterLine: '-1' }).success).toBe(false)
  })
})
