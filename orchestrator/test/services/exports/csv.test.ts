import { describe, expect, it } from 'vitest'
import { csvCellText, csvRow, escapeCsvCell } from '../../../server/services/exports/csv'
import { createRowFormatter } from '../../../server/services/exports/rows'

// CSV export rows (docs/api.md §4.15, security.md DL-2): formula escaping, JSON-encoded nested values, RFC 4180
// quoting, default columns and masking.

describe('escapeCsvCell', () => {
  it('prefixes every formula trigger with an apostrophe', () => {
    expect(escapeCsvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`)
    expect(escapeCsvCell('+1+1')).toBe("'+1+1")
    expect(escapeCsvCell('-2+3')).toBe("'-2+3")
    expect(escapeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(escapeCsvCell('\tcmd')).toBe("'\tcmd")
    expect(escapeCsvCell('\r=1')).toBe(`"'\r=1"`)
  })

  it('leaves other cells unchanged unless they need quoting', () => {
    expect(escapeCsvCell('')).toBe('')
    expect(escapeCsvCell('plain text')).toBe('plain text')
    expect(escapeCsvCell(' =not first')).toBe(' =not first')
    expect(escapeCsvCell('a,b')).toBe('"a,b"')
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""')
    expect(escapeCsvCell('line\nbreak')).toBe('"line\nbreak"')
  })
})

describe('csvCellText', () => {
  it('renders scalars as text and nested values as JSON', () => {
    expect(csvCellText(null)).toBe('')
    expect(csvCellText(undefined)).toBe('')
    expect(csvCellText(42)).toBe('42')
    expect(csvCellText(-3)).toBe('-3')
    expect(csvCellText(true)).toBe('true')
    expect(csvCellText(new Date('2026-10-21T10:00:00.000Z'))).toBe('2026-10-21T10:00:00.000Z')
    expect(csvCellText({ a: [1, '=x'] })).toBe('{"a":[1,"=x"]}')
  })
})

describe('csvRow', () => {
  it('joins escaped cells and ends with CRLF', () => {
    expect(csvRow(['id', 7, null, { k: 'v' }, '=1+1'])).toBe(`id,7,,"{""k"":""v""}",'=1+1\r\n`)
  })

  it('escapes negative numbers as text too (a cell starting with "-")', () => {
    expect(csvRow([-1])).toBe("'-1\r\n")
  })
})

describe('createRowFormatter (csv)', () => {
  const scan = {
    _id: '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f',
    userId: '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11',
    secretPaths: { taskConfig: [], scanConfig: [], analysisConfig: ['/apiKey'], result: [] },
  }
  const doc = {
    _id: `${scan._id}-3`,
    seq: 3,
    status: 'failed',
    attempt: 2,
    round: 1,
    error: { type: 'taskError', message: '=cmd|calc' },
    timings: { durationMs: 1200 },
    config: { origin: 'https://example.org', apiKey: 'secret-value' },
    files: [{ id: 'f', name: 'x.txt', key: 'files/internal' }],
  }

  it('writes the default columns with masked, escaped values', () => {
    const formatter = createRowFormatter('csv', null, scan)
    expect(formatter.header()).toBe('id,seq,status,attempt,round,error.type,error.message,timings.durationMs,config,result\r\n')
    const row = formatter.row(doc)
    expect(row).toContain(`${scan._id}-3,3,failed,2,1,taskError,'=cmd|calc,1200,`)
    expect(row).toContain('""apiKey"":""***""')
    expect(row).not.toContain('secret-value')
  })

  it('uses the requested fields as columns and never exposes file keys', () => {
    const formatter = createRowFormatter('csv', ['seq', 'files'], scan)
    expect(formatter.header()).toBe('seq,files\r\n')
    const row = formatter.row(doc)
    expect(row).not.toContain('files/internal')
    expect(row.startsWith('3,')).toBe(true)
  })
})

describe('createRowFormatter (jsonl)', () => {
  it('writes one masked representation per line', () => {
    const scan = {
      _id: '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f',
      userId: '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11',
      secretPaths: { taskConfig: [], scanConfig: [], analysisConfig: [], result: ['/token'] },
    }
    const formatter = createRowFormatter('jsonl', ['id', 'result'], scan)
    expect(formatter.header()).toBeNull()
    const line = formatter.row({ _id: `${scan._id}-0`, seq: 0, result: { token: 't', title: 'T' } })
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toEqual({ id: `${scan._id}-0`, result: { token: '***', title: 'T' } })
  })
})
