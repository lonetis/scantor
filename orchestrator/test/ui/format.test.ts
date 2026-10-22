import { describe, expect, it } from 'vitest'
import {
  formatAbsoluteTime,
  formatBytes,
  formatCount,
  formatDuration,
  formatEta,
  formatPercent,
  formatRate,
  formatRelativeTime,
  plural,
  shortId,
  splitCodeSpans,
} from '../../app/utils/format'

const NOW = Date.parse('2026-10-21T12:00:00.000Z')

describe('formatRelativeTime', () => {
  it.each([
    ['2026-10-21T11:59:50.000Z', 'just now'],
    ['2026-10-21T11:57:00.000Z', '3 min ago'],
    ['2026-10-21T10:00:00.000Z', '2 h ago'],
    ['2026-10-20T12:00:00.000Z', '1 day ago'],
    ['2026-10-17T12:00:00.000Z', '4 days ago'],
    ['2026-10-21T12:03:00.000Z', 'in 3 min'],
    ['2026-08-01T12:00:00.000Z', '2026-08-01'],
  ])('%s → %s', (value, expected) => {
    expect(formatRelativeTime(value, NOW)).toBe(expected)
  })

  it('accepts dates and epoch milliseconds', () => {
    expect(formatRelativeTime(new Date(NOW - 120_000), NOW)).toBe('2 min ago')
    expect(formatRelativeTime(NOW - 7_200_000, NOW)).toBe('2 h ago')
  })

  it('renders missing or invalid values as a dash', () => {
    expect(formatRelativeTime(null, NOW)).toBe('–')
    expect(formatRelativeTime('not a date', NOW)).toBe('–')
  })
})

describe('formatAbsoluteTime', () => {
  it('returns ISO 8601 UTC with milliseconds', () => {
    expect(formatAbsoluteTime(NOW)).toBe('2026-10-21T12:00:00.000Z')
    expect(formatAbsoluteTime(undefined)).toBe('')
  })
})

describe('formatDuration', () => {
  it.each([
    [850, '850 ms'],
    [0, '0 ms'],
    [4250, '4.2s'],
    [23_400, '23s'],
    [83_000, '1m 23s'],
    [63_000, '1m 03s'],
    [3_720_000, '1h 02m'],
    [183_600_000, '2d 03h'],
  ])('%d ms → %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })

  it('renders unknown durations as a dash', () => {
    expect(formatDuration(null)).toBe('–')
    expect(formatDuration(Number.NaN)).toBe('–')
  })
})

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [14_336, '14 KiB'],
    [1536, '1.5 KiB'],
    [1.5 * 1024 ** 3, '1.5 GiB'],
    [187_654_321, '179 MiB'],
    [5 * 1024 ** 4, '5 TiB'],
  ])('%d → %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })
})

describe('counts, percentages, rates and ETAs', () => {
  it('formats counts with grouping', () => {
    expect(formatCount(100_000)).toBe('100,000')
    expect(formatCount(undefined)).toBe('–')
  })

  it('formats percentages with one decimal', () => {
    expect(formatPercent(39.913)).toBe('39.9 %')
    expect(formatPercent(100)).toBe('100.0 %')
    expect(formatPercent(null)).toBe('–')
  })

  it('formats rates per minute', () => {
    expect(formatRate(8100)).toBe('8,100 / min')
  })

  it('formats ETAs and hides unknown ones', () => {
    expect(formatEta(444)).toBe('≈ 7 min')
    expect(formatEta(20)).toBe('≈ 1 min')
    expect(formatEta(7500)).toBe('≈ 2h 05m')
    expect(formatEta(null)).toBe('')
  })

  it('pluralises', () => {
    expect(plural(1, 'analysis', 'analyses')).toBe('1 analysis')
    expect(plural(2500, 'analysis', 'analyses')).toBe('2,500 analyses')
    expect(plural(3, 'line')).toBe('3 lines')
  })
})

describe('shortId', () => {
  it('shortens ids and digests to 8 characters', () => {
    expect(shortId('7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c')).toBe('7f3b2c1a')
    expect(shortId('sha256:4e5f6a7b8c9d')).toBe('4e5f6a7b')
    expect(shortId(null)).toBe('')
  })
})

describe('splitCodeSpans', () => {
  it('marks Markdown code spans and keeps the rest as text', () => {
    expect(splitCodeSpans('per subnet of length `prefix`, at most `maxAnalyses`.')).toEqual([
      { text: 'per subnet of length ', code: false },
      { text: 'prefix', code: true },
      { text: ', at most ', code: false },
      { text: 'maxAnalyses', code: true },
      { text: '.', code: false },
    ])
  })

  it('leaves unpaired backticks and plain text alone', () => {
    expect(splitCodeSpans('no code')).toEqual([{ text: 'no code', code: false }])
    expect(splitCodeSpans('`a` and `b')).toEqual([
      { text: 'a', code: true },
      { text: ' and `b', code: false },
    ])
    expect(splitCodeSpans('``')).toEqual([])
    expect(splitCodeSpans('')).toEqual([])
  })
})
