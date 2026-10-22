import { describe, expect, it } from 'vitest'
import { draftVerdict, orphanVerdict } from '../../../server/services/tasks/gc'
import { managedLabels } from '../../../server/utils/labels'

// Orphan detection of the task-domain GC (docs/architecture.md §4.1 boot sweeps and GC).

const config = { helperTimeoutMs: 5 * 60_000, testRunTimeoutMs: 10 * 60_000, describeTimeoutMs: 10 * 60_000, buildTimeoutMs: 30 * 60_000 }
const NOW = Date.parse('2026-10-21T12:00:00Z')
const MIN = 60_000

function container(name: string, kind: 'helper' | 'testRun' | 'build' | 'editor' | 'worker', ageMs: number, labels = managedLabels(kind)) {
  return { Id: name, Names: [`/${name}`], Labels: labels, Created: Math.floor((NOW - ageMs) / 1000) }
}

describe('orphanVerdict', () => {
  it('removes helpers older than their timeout plus a margin', () => {
    expect(orphanVerdict(container('scantor-h-1', 'helper', 9 * MIN), NOW, config, new Set())).toBe('keep')
    expect(orphanVerdict(container('scantor-h-1', 'helper', 11 * MIN), NOW, config, new Set())).toBe('remove')
  })

  it('removes test-run containers of runs that are not running, but not fresh ones', () => {
    const id = '3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7d'
    expect(orphanVerdict(container(`scantor-t-${id}`, 'testRun', 6 * MIN), NOW, config, new Set([id]))).toBe('keep')
    expect(orphanVerdict(container(`scantor-t-${id}`, 'testRun', 6 * MIN), NOW, config, new Set())).toBe('remove')
    expect(orphanVerdict(container(`scantor-t-${id}`, 'testRun', 1 * MIN), NOW, config, new Set())).toBe('keep')
    expect(orphanVerdict(container(`scantor-t-${id}`, 'testRun', 16 * MIN), NOW, config, new Set([id]))).toBe('remove')
  })

  it('removes describe/check containers only after the build and describe timeouts', () => {
    expect(orphanVerdict(container('scantor-b-1', 'build', 40 * MIN), NOW, config, new Set())).toBe('keep')
    expect(orphanVerdict(container('scantor-b-1', 'build', 60 * MIN), NOW, config, new Set())).toBe('remove')
  })

  it('never touches other kinds or containers without both labels and name prefix', () => {
    expect(orphanVerdict(container('scantor-editor-u', 'editor', 999 * MIN), NOW, config, new Set())).toBe('keep')
    expect(orphanVerdict(container('scantor-w-1', 'worker', 999 * MIN), NOW, config, new Set())).toBe('keep')
    expect(orphanVerdict(container('other-h-1', 'helper', 999 * MIN), NOW, config, new Set())).toBe('keep')
    expect(orphanVerdict(container('scantor-h-1', 'helper', 999 * MIN, { 'scantor.kind': 'helper' }), NOW, config, new Set())).toBe('keep')
  })
})

describe('draftVerdict', () => {
  const tag = `tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c:draft-${'a'.repeat(64)}`
  const created = (ageMs: number) => Math.floor((NOW - ageMs) / 1000)

  it('removes drafts older than the retention that no active test run uses', () => {
    expect(draftVerdict(tag, created(25 * 60 * MIN), NOW, 24 * 60 * MIN, new Set())).toBe('remove')
    expect(draftVerdict(tag, created(23 * 60 * MIN), NOW, 24 * 60 * MIN, new Set())).toBe('keep')
    expect(draftVerdict(tag, created(25 * 60 * MIN), NOW, 24 * 60 * MIN, new Set([tag]))).toBe('keep')
  })

  it('ignores revision images and other repositories', () => {
    expect(draftVerdict('localhost:5000/tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c:c1d2', 0, NOW, 0, new Set())).toBe('keep')
    expect(draftVerdict('tasks/x:latest', 0, NOW, 0, new Set())).toBe('keep')
  })
})
