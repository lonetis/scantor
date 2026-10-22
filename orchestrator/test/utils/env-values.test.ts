import { describe, expect, it } from 'vitest'
import { parseBoolean, parseByteSize, parseDuration, parseInteger, parseList } from '../../server/utils/env-values'

describe('parseDuration (Go duration syntax)', () => {
  it.each([
    ['0', 0],
    ['500ms', 500],
    ['30s', 30_000],
    ['15m', 900_000],
    ['24h', 86_400_000],
    ['1h30m', 5_400_000],
    ['1.5h', 5_400_000],
    ['2m3.5s', 123_500],
    ['100us', 0.1],
    ['100µs', 0.1],
    ['10ns', 0.00001],
    [' 168h ', 604_800_000],
  ])('%s → %d ms', (input, expected) => {
    expect(parseDuration(input)).toBeCloseTo(expected, 9)
  })

  it.each(['', '7d', '10', '-5s', '5 s', 's', '1h foo', '1e3s', 'NaNs'])('rejects %j', (input) => {
    expect(() => parseDuration(input)).toThrow()
  })
})

describe('parseByteSize', () => {
  it.each([
    ['0', 0],
    ['1048576', 1_048_576],
    ['512KiB', 512 * 1024],
    ['64MiB', 64 * 1024 ** 2],
    ['5GiB', 5 * 1024 ** 3],
    ['2TiB', 2 * 1024 ** 4],
  ])('%s → %d', (input, expected) => {
    expect(parseByteSize(input)).toBe(expected)
  })

  it.each(['', '1.5GiB', '10GB', '10 GiB', '-1', '1KB', 'MiB', '9999999999999999TiB'])('rejects %j', (input) => {
    expect(() => parseByteSize(input)).toThrow()
  })
})

describe('parseBoolean', () => {
  it('accepts exactly true and false', () => {
    expect(parseBoolean('true')).toBe(true)
    expect(parseBoolean('false')).toBe(false)
    expect(parseBoolean(' true ')).toBe(true)
  })

  it.each(['1', '0', 'yes', 'TRUE', 'False', ''])('rejects %j', (input) => {
    expect(() => parseBoolean(input)).toThrow()
  })
})

describe('parseList', () => {
  it('trims entries and drops empty ones', () => {
    expect(parseList(' a, b ,,c ,')).toEqual(['a', 'b', 'c'])
    expect(parseList('')).toEqual([])
    expect(parseList(' , ')).toEqual([])
  })
})

describe('parseInteger', () => {
  it('parses decimal integers', () => {
    expect(parseInteger('42')).toBe(42)
    expect(parseInteger('-3')).toBe(-3)
  })

  it.each(['4.2', '1e3', '0x10', '', 'abc'])('rejects %j', (input) => {
    expect(() => parseInteger(input)).toThrow()
  })
})
