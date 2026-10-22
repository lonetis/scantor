import { describe, expect, it } from 'vitest'
import { outputUnitsToFieldErrors, validateAgainstSchema } from '../../app/composables/useSchemaForm'

// Browser-side JSON-Schema validation (docs/ui.md §6.1): @cfworker/json-schema output mapped onto form fields with
// dot paths; no defaults filled; discriminated unions report the selected branch only.

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 5 },
    count: { type: 'integer', minimum: 1, default: 3 },
    headers: { type: 'array', items: { type: 'string' } },
    labels: { type: 'object', additionalProperties: { type: 'string' } },
    'a/b': { type: 'string' },
    contact: { type: 'string', format: 'email' },
    secret: { type: 'string', format: 'password' },
    target: {
      oneOf: [
        { type: 'object', properties: { kind: { const: 'url' }, url: { type: 'string' } }, required: ['kind', 'url'], additionalProperties: false },
        { type: 'object', properties: { kind: { const: 'host' }, host: { type: 'string' } }, required: ['kind', 'host'], additionalProperties: false },
      ],
      discriminator: { propertyName: 'kind' },
    },
    nested: { $ref: '#/$defs/Nested' },
  },
  required: ['name'],
  additionalProperties: false,
  $defs: { Nested: { type: 'object', properties: { on: { type: 'boolean' } }, additionalProperties: false } },
}

describe('validateAgainstSchema', () => {
  it('accepts valid values and never fills defaults', () => {
    const value = { name: 'abc' }
    expect(validateAgainstSchema(schema, value)).toEqual([])
    expect(value).toEqual({ name: 'abc' })
  })

  it('maps errors onto dot paths', () => {
    const errors = validateAgainstSchema(schema, { count: 0, headers: ['a', 2], labels: { x: 1 }, 'a/b': 3, limt: 1, nested: { off: true } })
    expect(errors).toEqual(
      expect.arrayContaining([
        { name: 'name', message: 'is required' },
        { name: 'count', message: expect.stringContaining('1') },
        { name: 'headers.1', message: expect.stringContaining('string') },
        { name: 'labels.x', message: expect.stringContaining('string') },
        { name: 'a/b', message: expect.stringContaining('string') },
        { name: '', message: 'unknown property "limt"' },
        { name: 'nested', message: 'unknown property "off"' },
      ]),
    )
    expect(errors.some((error) => error.message.includes('does not match schema'))).toBe(false)
  })

  it('asserts formats it knows and ignores annotations such as password', () => {
    expect(validateAgainstSchema(schema, { name: 'a', contact: 'nope', secret: 'x' })).toEqual([{ name: 'contact', message: expect.stringContaining('email') }])
  })

  it('reports only the selected branch of a discriminated union', () => {
    expect(validateAgainstSchema(schema, { name: 'a', target: { kind: 'host' } })).toEqual([{ name: 'target.host', message: 'is required' }])
    expect(validateAgainstSchema(schema, { name: 'a', target: { kind: 'host', host: 'h', port: 1 } })).toEqual([{ name: 'target', message: 'unknown property "port"' }])
    expect(validateAgainstSchema(schema, { name: 'a', target: { kind: 'other' } })).toEqual([{ name: 'target', message: expect.stringContaining('one subschema') }])
  })

  it('does not throw on schemas it cannot use', () => {
    expect(validateAgainstSchema({ type: 'object', properties: { a: { $ref: '#/$defs/missing' } } }, { a: 1 })).toEqual([])
  })
})

describe('outputUnitsToFieldErrors', () => {
  it('drops wrapper errors and duplicates', () => {
    expect(
      outputUnitsToFieldErrors([
        { keyword: 'properties', keywordLocation: '#/properties', instanceLocation: '#', error: 'Property "x" does not match schema.' },
        { keyword: 'type', keywordLocation: '#/properties/x/type', instanceLocation: '#/x', error: 'Instance type "number" is invalid. Expected "string".' },
        { keyword: 'type', keywordLocation: '#/properties/x/type', instanceLocation: '#/x', error: 'Instance type "number" is invalid. Expected "string".' },
      ]),
    ).toEqual([{ name: 'x', message: 'Instance type "number" is invalid. Expected "string".' }])
  })
})
