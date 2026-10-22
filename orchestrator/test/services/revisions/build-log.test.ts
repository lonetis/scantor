import { describe, expect, it } from 'vitest'
import { BuildLog, toBuildLogLine } from '../../../server/services/revisions/build-log'
import type { PipelineEvent } from '../../../server/services/pipeline/events'

// Build logs (docs/tasks.md §9.8, §9.10; docs/api.md §4.10 getRevisionBuildLog).

const event = (seq: number, fields: Partial<PipelineEvent>): PipelineEvent => ({ v: 1, seq, at: '2026-10-21T09:01:01.010Z', phase: 'build', type: 'log', ...fields })

describe('BuildLog', () => {
  it('caps log events, adds one truncation marker and keeps errors and the result', () => {
    const log = new BuildLog('build-logs/r.ndjson', 300)
    log.append(event(0, { stream: 'build', text: 'x'.repeat(150) }))
    log.append(event(1, { stream: 'build', text: 'y'.repeat(150) }))
    log.append(event(2, { stream: 'build', text: 'z'.repeat(150) }))
    log.append(event(3, { type: 'error', error: { phase: 'build', message: 'failed' } }))
    log.append(event(4, { type: 'result', result: { ok: false } as never }))
    expect(log.events.map((entry) => `${entry.seq}:${entry.type}:${entry.stream ?? ''}`)).toEqual(['0:log:build', '1:log:pipeline', '3:error:', '4:result:'])
    expect(log.events[1]!.text).toContain('truncated')
    expect(log.toNdjson().split('\n').filter(Boolean)).toHaveLength(4)
  })
})

describe('toBuildLogLine', () => {
  it('numbers lines seq + 1 and keeps only the fields of the event type', () => {
    expect(toBuildLogLine(event(0, { phase: 'pack', stream: 'pipeline', text: 'packed' }))).toEqual({
      line: 1,
      at: '2026-10-21T09:01:01.010Z',
      phase: 'pack',
      type: 'log',
      stream: 'pipeline',
      level: 'info',
      text: 'packed',
    })
    expect(toBuildLogLine(event(5, { phase: 'check', type: 'error', error: { phase: 'check', file: 'main.py', line: 3, message: 'bad' } }))).toEqual({
      line: 6,
      at: '2026-10-21T09:01:01.010Z',
      phase: 'check',
      type: 'error',
      error: { phase: 'check', file: 'main.py', line: 3, message: 'bad' },
    })
  })
})
