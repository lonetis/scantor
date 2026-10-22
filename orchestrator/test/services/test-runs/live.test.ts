import { describe, expect, it } from 'vitest'
import {
  isTestRunLive,
  openTestRunChannel,
  publishTestRunEvent,
  recentTestRunLogs,
  subscribeTestRun,
  testRunChannelCount,
  type TestRunEvent,
} from '../../../server/services/test-runs/live'

const log = (text: string): TestRunEvent => ({ event: 'log', data: { seq: null, stream: 'build', text, at: '2026-10-21T09:00:00.000Z' } })

describe('test-run live channels', () => {
  it('drops the channel of a run this process does not execute with its last subscriber', () => {
    const before = testRunChannelCount()
    const unsubscribe = subscribeTestRun('settled-run', () => {})
    expect(testRunChannelCount()).toBe(before + 1)
    expect(isTestRunLive('settled-run')).toBe(false)
    unsubscribe()
    expect(testRunChannelCount()).toBe(before)
  })

  it('keeps a live channel without subscribers and replays recent logs to late subscribers', () => {
    openTestRunChannel('live-run')
    publishTestRunEvent('live-run', log('step 1'))
    const received: TestRunEvent[] = []
    const unsubscribe = subscribeTestRun('live-run', (event) => received.push(event))
    unsubscribe()
    expect(isTestRunLive('live-run')).toBe(true)
    expect(recentTestRunLogs('live-run').map((line) => line.text)).toEqual(['step 1'])

    const late: TestRunEvent[] = []
    const again = subscribeTestRun('live-run', (event) => late.push(event))
    publishTestRunEvent('live-run', log('step 2'))
    expect(late.map((event) => event.event)).toEqual(['log'])
    publishTestRunEvent('live-run', { event: 'state', data: { state: 'completed' } })
    expect(isTestRunLive('live-run')).toBe(true)
    again()
  })

  it('a subscriber that arrives before the job shares the channel the job opens', () => {
    const received: string[] = []
    const unsubscribe = subscribeTestRun('queued-run', (event) => received.push(event.event))
    openTestRunChannel('queued-run')
    publishTestRunEvent('queued-run', { event: 'state', data: { state: 'building' } })
    expect(received).toEqual(['state'])
    expect(isTestRunLive('queued-run')).toBe(true)
    unsubscribe()
    expect(isTestRunLive('queued-run')).toBe(true)
  })
})
