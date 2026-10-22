import { describe, expect, it } from 'vitest'
import { ERROR_CODES, errorTitleFor, isErrorCode } from '#shared/utils/error-codes'
import { readRepoFile } from '../helpers/repo'

// The shared error-code table equals docs/api.md §1.7 (code and HTTP status).

function documentedCodes(): Record<string, number> {
  const section = readRepoFile('docs/api.md').split('### 1.7 Errors')[1]!.split('### 1.8')[0]!
  const codes: Record<string, number> = {}
  for (const match of section.matchAll(/^\| `([A-Za-z]+)` \| (\d{3}) \|/gm)) codes[match[1]!] = Number(match[2])
  return codes
}

describe('ERROR_CODES', () => {
  it('matches the table of docs/api.md §1.7', () => {
    const table = Object.fromEntries(Object.entries(ERROR_CODES).map(([code, { status }]) => [code, status]))
    expect(table).toEqual(documentedCodes())
  })

  it('gives every code a UI title', () => {
    for (const { title } of Object.values(ERROR_CODES)) expect(title.length).toBeGreaterThan(0)
    expect(errorTitleFor('notFound')).toBe('Not found')
    expect(errorTitleFor('somethingElse')).toBe('Request failed')
    expect(isErrorCode('banned')).toBe(true)
    expect(isErrorCode('toString')).toBe(false)
  })
})
