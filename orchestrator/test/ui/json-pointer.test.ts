import { describe, expect, it } from 'vitest'
import {
  dotPathAncestors,
  formatPointer,
  mapIssuesToFields,
  parsePointer,
  pointerToDotPath,
  removeIn,
  setIn,
} from '../../app/utils/json-pointer'

describe('JSON pointers', () => {
  it('parses and formats RFC 6901 pointers with escapes', () => {
    expect(parsePointer('')).toEqual([])
    expect(parsePointer('/headers/0')).toEqual(['headers', '0'])
    expect(parsePointer('/a~1b/c~0d')).toEqual(['a/b', 'c~d'])
    expect(formatPointer(['a/b', 'c~d', 3])).toBe('/a~1b/c~0d/3')
    expect(() => parsePointer('headers')).toThrow()
  })

  it('converts pointers to dot paths, optionally prefixed', () => {
    expect(pointerToDotPath('/headers/0')).toBe('headers.0')
    expect(pointerToDotPath('/headers/0', 'taskConfig')).toBe('taskConfig.headers.0')
    expect(pointerToDotPath('', 'taskConfig')).toBe('taskConfig')
  })

  it('lists ancestors from the closest', () => {
    expect(dotPathAncestors('a.b.c')).toEqual(['a.b.c', 'a.b', 'a'])
    expect(dotPathAncestors('')).toEqual([])
  })
})

describe('mapIssuesToFields', () => {
  const rendered = new Set(['headers', 'headers.0', 'retries', 'auth', 'auth.token'])

  it('maps issues of its own form onto exact fields', () => {
    const result = mapIssuesToFields([{ path: '/taskConfig/headers/0', message: 'too long' }], 'taskConfig', rendered)
    expect(result).toEqual({ fieldErrors: [{ name: 'headers.0', message: 'too long' }], formErrors: [] })
  })

  it('falls back to the nearest rendered ancestor', () => {
    const result = mapIssuesToFields([{ path: '/taskConfig/auth/extra/deep', message: 'bad' }], 'taskConfig', rendered)
    expect(result.fieldErrors).toEqual([{ name: 'auth', message: 'bad' }])
  })

  it('reports unmatched and root issues at form level', () => {
    const result = mapIssuesToFields(
      [
        { path: '/taskConfig/unknown', message: 'unknown property' },
        { path: '/taskConfig', message: 'must be object' },
      ],
      'taskConfig',
      rendered,
    )
    expect(result.fieldErrors).toEqual([])
    expect(result.formErrors).toEqual(['unknown: unknown property', 'must be object'])
  })

  it('ignores issues of other forms and malformed pointers', () => {
    const result = mapIssuesToFields(
      [
        { path: '/scanConfig/headers/0', message: 'other form' },
        { path: 'not-a-pointer', message: 'broken' },
      ],
      'taskConfig',
      rendered,
    )
    expect(result).toEqual({ fieldErrors: [], formErrors: [] })
  })

  it('treats the whole body as the form when no name is given', () => {
    expect(mapIssuesToFields([{ path: '/retries', message: 'too big' }], undefined, rendered).fieldErrors).toEqual([{ name: 'retries', message: 'too big' }])
  })
})

describe('immutable path updates', () => {
  it('sets values without mutating and creates containers', () => {
    const source = { a: { b: 1 } }
    const next = setIn(source, ['a', 'c'], 2)
    expect(next).toEqual({ a: { b: 1, c: 2 } })
    expect(source).toEqual({ a: { b: 1 } })
    expect(setIn({}, ['list', 0, 'x'], true)).toEqual({ list: [{ x: true }] })
  })

  it('removes keys and array elements without mutating', () => {
    const source = { a: { b: 1, c: 2 }, list: [1, 2, 3] }
    expect(removeIn(source, ['a', 'b'])).toEqual({ a: { c: 2 }, list: [1, 2, 3] })
    expect(removeIn(source, ['list', 1])).toEqual({ a: { b: 1, c: 2 }, list: [1, 3] })
    expect(removeIn(source, ['missing'])).toBe(source)
    expect(source).toEqual({ a: { b: 1, c: 2 }, list: [1, 2, 3] })
  })
})
