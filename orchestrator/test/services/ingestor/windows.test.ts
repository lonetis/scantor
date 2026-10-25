import { describe, expect, it } from 'vitest'
import { BREAKER_BUCKET_MS, BreakerWindow, RateWindow } from '../../../server/services/ingestor/windows'

// In-memory windows of the ingestor (docs/queue.md §6.8 rate and its decay, §6.10 circuit breaker).

const SCAN = 'scan-a'
const T0 = Date.parse('2026-10-21T10:00:00.000Z')
const MINUTE = 60_000

describe('RateWindow', () => {
  it('averages over the covered minutes, at most five', () => {
    const rate = new RateWindow()
    rate.record(SCAN, 60, T0)
    expect(rate.ratePerMin(SCAN, T0)).toBe(60)
    rate.record(SCAN, 30, T0 + MINUTE)
    expect(rate.ratePerMin(SCAN, T0 + MINUTE)).toBe(45)
    // After five minutes the first bucket drops out of the window.
    rate.record(SCAN, 10, T0 + 5 * MINUTE)
    expect(rate.ratePerMin(SCAN, T0 + 5 * MINUTE)).toBe(8)
  })

  it('ignores empty records and forgets idle scans on sweep', () => {
    const rate = new RateWindow()
    rate.record(SCAN, 0, T0)
    expect(rate.ratePerMin(SCAN, T0)).toBe(0)
    rate.record(SCAN, 5, T0)
    rate.markStored(SCAN, 0)
    rate.sweep(T0 + 10 * MINUTE)
    expect(rate.ratePerMin(SCAN, T0 + 10 * MINUTE)).toBe(0)
    expect(rate.staleRates(T0 + 10 * MINUTE)).toEqual([])
  })

  it('reports the decaying rate of a scan whose results stopped until 0 is stored, then forgets it', () => {
    const rate = new RateWindow()
    rate.record(SCAN, 60, T0)
    rate.markStored(SCAN, 60)
    expect(rate.staleRates(T0 + 30_000)).toEqual([])
    expect(rate.staleRates(T0 + MINUTE)).toEqual([[SCAN, 30]])
    rate.markStored(SCAN, 30)
    expect(rate.staleRates(T0 + 4 * MINUTE)).toEqual([[SCAN, 12]])
    rate.markStored(SCAN, 12)
    expect(rate.staleRates(T0 + 5 * MINUTE)).toEqual([[SCAN, 0]])
    rate.markStored(SCAN, 0)
    expect(rate.staleRates(T0 + 6 * MINUTE)).toEqual([])
    // Forgotten: the next completion starts a new window.
    rate.record(SCAN, 10, T0 + 6 * MINUTE)
    expect(rate.staleRates(T0 + 6 * MINUTE)).toEqual([[SCAN, 10]])
  })

  it('keeps an idle scan on sweep until its rate of 0 was stored', () => {
    const rate = new RateWindow()
    rate.record(SCAN, 5, T0)
    rate.markStored(SCAN, 5)
    rate.sweep(T0 + 10 * MINUTE)
    expect(rate.staleRates(T0 + 10 * MINUTE)).toEqual([[SCAN, 0]])
  })
})

describe('BreakerWindow', () => {
  it('trips at the minimum attempts and ratio', () => {
    const breaker = new BreakerWindow(5 * MINUTE)
    breaker.record(SCAN, 4, 95, T0)
    expect(breaker.trips(SCAN, T0, 100, 0.95)).toBeNull()
    breaker.record(SCAN, 0, 1, T0 + 1000)
    expect(breaker.trips(SCAN, T0 + 1000, 100, 0.95)).toEqual({ attempts: 100, failures: 96, ratio: 0.96 })
  })

  it('is disabled with SCANTOR_BREAKER_MIN_ATTEMPTS=0', () => {
    const breaker = new BreakerWindow(5 * MINUTE)
    breaker.record(SCAN, 0, 1000, T0)
    expect(breaker.trips(SCAN, T0, 0, 0.5)).toBeNull()
  })

  it('slides in 10-second buckets', () => {
    const breaker = new BreakerWindow(60_000)
    breaker.record(SCAN, 0, 10, T0)
    breaker.record(SCAN, 10, 0, T0 + 30_000)
    expect(breaker.snapshot(SCAN, T0 + 30_000)).toEqual({ attempts: 20, failures: 10, ratio: 0.5 })
    expect(breaker.snapshot(SCAN, T0 + 60_000 + BREAKER_BUCKET_MS)).toEqual({ attempts: 10, failures: 0, ratio: 0 })
  })

  it('starts over when the scan was paused since the window began', () => {
    const breaker = new BreakerWindow(5 * MINUTE)
    breaker.record(SCAN, 0, 50, T0, null)
    breaker.record(SCAN, 0, 50, T0 + 1000, T0 + 500)
    expect(breaker.snapshot(SCAN, T0 + 1000).attempts).toBe(50)
    breaker.record(SCAN, 0, 0, T0 + 2000, T0 + 1500)
    expect(breaker.snapshot(SCAN, T0 + 2000).attempts).toBe(0)
  })

  it('clears and sweeps scans', () => {
    const breaker = new BreakerWindow(MINUTE)
    breaker.record(SCAN, 1, 1, T0)
    breaker.record('scan-b', 1, 1, T0)
    breaker.clear(SCAN)
    expect(breaker.scanIds()).toEqual(['scan-b'])
    breaker.sweep(T0 + 2 * MINUTE)
    expect(breaker.scanIds()).toEqual([])
  })
})
