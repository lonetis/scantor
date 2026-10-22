import { describe, expect, it } from 'vitest'
import {
  MAX_FORM_DEPTH,
  detectDiscriminatedUnion,
  flattenSchema,
  isFormRenderable,
  objectProperties,
  resolveField,
} from '../../app/utils/schema-subset'
import type { JsonSchema, SchemaObject } from '../../app/utils/schema-subset'

function kindOf(schema: JsonSchema, root: JsonSchema = schema, depth = 1): string {
  return resolveField(schema, { root, depth }).kind
}

describe('resolveField: widgets of docs/ui.md §6.2', () => {
  it.each<[string, SchemaObject, string]>([
    ['object with properties', { type: 'object', properties: { a: { type: 'string' } } }, 'object'],
    ['map of primitives', { type: 'object', additionalProperties: { type: 'integer' } }, 'map'],
    ['open map', { type: 'object', additionalProperties: true }, 'json'],
    ['string', { type: 'string', maxLength: 10 }, 'string'],
    ['secret string', { type: 'string', writeOnly: true }, 'secret'],
    ['upload string', { type: 'string', 'x-scantor': 'upload' }, 'upload'],
    ['enum', { enum: ['a', 'b'] }, 'enum'],
    ['titled const union', { oneOf: [{ const: 'a', title: 'Alpha' }, { const: 'b', title: 'Beta' }] }, 'enum'],
    ['const', { const: 'fixed' }, 'const'],
    ['integer', { type: 'integer', minimum: 0 }, 'integer'],
    ['number', { type: 'number' }, 'number'],
    ['boolean', { type: 'boolean' }, 'boolean'],
    ['array of enum', { type: 'array', items: { enum: ['x', 'y'] } }, 'enumArray'],
    ['array of primitives', { type: 'array', items: { type: 'string' } }, 'array'],
    ['array of objects', { type: 'array', items: { type: 'object', properties: { a: { type: 'number' } } } }, 'objectArray'],
  ])('%s → %s', (_name, schema, kind) => {
    expect(kindOf(schema)).toBe(kind)
  })

  it('collects enum options with titles', () => {
    const field = resolveField({ anyOf: [{ const: 1, title: 'One' }, { const: 2 }] }, { root: {} })
    expect(field.options).toEqual([{ value: 1, label: 'One' }, { value: 2, label: '2' }])
  })

  it('detects nullable types in both spellings', () => {
    const typeArray = resolveField({ type: ['string', 'null'], title: 'Name' }, { root: {} })
    expect(typeArray).toMatchObject({ kind: 'string', nullable: true, title: 'Name' })
    const anyOf = resolveField({ anyOf: [{ type: 'integer' }, { type: 'null' }], default: null, title: 'Limit' }, { root: {} })
    expect(anyOf).toMatchObject({ kind: 'integer', nullable: true, hasDefault: true, default: null, title: 'Limit' })
    const nullableUpload = resolveField({ anyOf: [{ type: 'string', 'x-scantor': 'upload' }, { type: 'null' }] }, { root: {} })
    expect(nullableUpload).toMatchObject({ kind: 'upload', nullable: true })
  })

  it('resolves local $refs and merges sibling annotations', () => {
    const root: SchemaObject = {
      type: 'object',
      properties: { auth: { $ref: '#/$defs/Auth', description: 'Credentials' } },
      $defs: { Auth: { type: 'object', title: 'Auth', properties: { token: { type: 'string', writeOnly: true } } } },
    }
    const field = resolveField((root.properties as SchemaObject).auth as SchemaObject, { root, depth: 1 })
    expect(field).toMatchObject({ kind: 'object', title: 'Auth', description: 'Credentials', refStack: ['#/$defs/Auth'] })
  })

  it('falls back to JSON for recursive references', () => {
    const root: SchemaObject = {
      $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } },
    }
    const node = resolveField({ $ref: '#/$defs/Node' }, { root, depth: 1 })
    expect(node.kind).toBe('object')
    const child = resolveField({ $ref: '#/$defs/Node' }, { root, depth: 2, refStack: node.refStack })
    expect(child).toMatchObject({ kind: 'json', fallbackReason: 'recursive reference' })
  })

  it.each<[string, SchemaObject]>([
    ['allOf', { allOf: [{ type: 'string' }] }],
    ['not', { not: { type: 'string' } }],
    ['if/then/else', { if: { type: 'string' }, then: { minLength: 1 } }],
    ['patternProperties', { type: 'object', patternProperties: { '^x': { type: 'string' } } }],
    ['prefixItems', { type: 'array', prefixItems: [{ type: 'string' }] }],
    ['dependentSchemas', { type: 'object', properties: {}, dependentSchemas: { a: {} } }],
    ['mixed union', { oneOf: [{ type: 'string' }, { type: 'integer' }] }],
    ['type union', { type: ['string', 'integer'] }],
    ['map of objects', { type: 'object', additionalProperties: { type: 'object', properties: {} } }],
    ['array without items', { type: 'array' }],
    ['unresolved ref', { $ref: '#/$defs/Missing' }],
    ['no type', { description: 'anything' }],
  ])('renders %s as JSON', (_name, schema) => {
    expect(kindOf(schema)).toBe('json')
  })

  it('falls back to JSON beyond the maximum depth', () => {
    const object: SchemaObject = { type: 'object', properties: { a: { type: 'string' } } }
    expect(kindOf(object, object, MAX_FORM_DEPTH)).toBe('object')
    expect(kindOf(object, object, MAX_FORM_DEPTH + 1)).toBe('json')
  })

  it('reads annotations', () => {
    const field = resolveField({ type: 'string', title: 'Greeting', description: 'Said first', default: 'Hello', examples: ['Hi'], deprecated: true, readOnly: true }, { root: {} })
    expect(field).toMatchObject({ title: 'Greeting', description: 'Said first', hasDefault: true, default: 'Hello', examples: ['Hi'], deprecated: true, readOnly: true })
  })
})

describe('discriminated unions', () => {
  const branches: SchemaObject[] = [
    { type: 'object', title: 'Basic', properties: { kind: { const: 'basic' }, user: { type: 'string' } } },
    { type: 'object', title: 'Token', properties: { kind: { const: 'token' }, token: { type: 'string', writeOnly: true } } },
  ]

  it('finds the shared const property', () => {
    expect(detectDiscriminatedUnion(branches)).toMatchObject({
      discriminator: 'kind',
      branches: [{ value: 'basic', label: 'Basic' }, { value: 'token', label: 'Token' }],
    })
  })

  it('renders oneOf and anyOf object unions as union widgets', () => {
    expect(resolveField({ oneOf: branches }, { root: {} })).toMatchObject({ kind: 'union', discriminator: 'kind' })
    expect(resolveField({ anyOf: branches, discriminator: { propertyName: 'kind' } }, { root: {} }).kind).toBe('union')
  })

  it('resolves branches given as $refs', () => {
    const root: SchemaObject = { $defs: { A: branches[0]!, B: branches[1]! } }
    expect(resolveField({ oneOf: [{ $ref: '#/$defs/A' }, { $ref: '#/$defs/B' }] }, { root }).kind).toBe('union')
  })

  it('rejects duplicate or missing discriminator values', () => {
    expect(detectDiscriminatedUnion([branches[0]!, branches[0]!])).toBeNull()
    expect(detectDiscriminatedUnion([branches[0]!, { type: 'object', properties: { user: { type: 'string' } } }])).toBeNull()
  })
})

describe('objectProperties and isFormRenderable', () => {
  it('lists properties in order with required flags', () => {
    expect(objectProperties({ properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['b'] }).map((property) => [property.name, property.required]))
      .toEqual([['a', false], ['b', true]])
  })

  it('accepts object roots only', () => {
    expect(isFormRenderable({ type: 'object', properties: {}, additionalProperties: false })).toBe(true)
    expect(isFormRenderable({ type: 'object', additionalProperties: true })).toBe(false)
    expect(isFormRenderable(null)).toBe(false)
  })
})

describe('flattenSchema', () => {
  it('lists every property path with type, constraints and badges', () => {
    const schema: SchemaObject = {
      type: 'object',
      required: ['domain'],
      properties: {
        domain: { type: 'string', format: 'hostname', maxLength: 253, description: 'Target' },
        apiKey: { type: 'string', writeOnly: true },
        list: { anyOf: [{ type: 'string', 'x-scantor': 'upload' }, { type: 'null' }], default: null },
        headers: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
        mode: { enum: ['fast', 'slow'], default: 'fast' },
      },
    }
    const rows = flattenSchema(schema)
    expect(rows.map((row) => row.path)).toEqual(['domain', 'apiKey', 'list', 'headers', 'headers[].name', 'mode'])
    expect(rows[0]).toMatchObject({ type: 'string', required: true, constraints: ['maxLength: 253', 'format: hostname'], description: 'Target' })
    expect(rows[1]!.badges).toEqual(['secret'])
    expect(rows[2]).toMatchObject({ type: 'string | null', hasDefault: true, default: null })
    expect(rows[3]!.type).toBe('array<object>')
    expect(rows[5]).toMatchObject({ type: 'enum', constraints: ['one of: fast, slow'] })
  })

  it('marks file references and does not expand them', () => {
    const schema: SchemaObject = {
      type: 'object',
      properties: { shot: { $ref: '#/$defs/FileRef' } },
      $defs: { FileRef: { type: 'object', 'x-scantor': 'file', properties: { id: { type: 'string' } } } },
    }
    const rows = flattenSchema(schema)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ path: 'shot', badges: ['file'] })
  })

  it('stops at recursive references', () => {
    const schema: SchemaObject = {
      type: 'object',
      properties: { tree: { $ref: '#/$defs/Node' } },
      $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } },
    }
    expect(flattenSchema(schema).map((row) => row.path)).toEqual(['tree', 'tree.child'])
  })
})

describe('flattenSchema type labels for unions', () => {
  it('labels titled const unions as enums and object unions by their discriminator', () => {
    const rows = flattenSchema({
      type: 'object',
      properties: {
        level: { oneOf: [{ const: 1, title: 'Low' }, { const: 2, title: 'High' }] },
        auth: { oneOf: [
          { type: 'object', properties: { kind: { const: 'basic' } } },
          { type: 'object', properties: { kind: { const: 'token' } } },
        ] },
      },
    })
    expect(rows[0]).toMatchObject({ type: 'enum', constraints: ['one of: 1, 2'] })
    expect(rows[1]!.type).toBe('union by kind')
  })
})
