// Classifies JSON Schema (draft 2020-12) nodes into the form widgets of docs/ui.md §6.2, for the subset
// that describe accepts (docs/tasks.md §6.4). Everything outside the subset becomes a raw JSON field.

export type SchemaObject = Record<string, unknown>
export type JsonSchema = SchemaObject | boolean

export type WidgetKind =
  | 'object'
  | 'map'
  | 'string'
  | 'secret'
  | 'upload'
  | 'enum'
  | 'const'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'enumArray'
  | 'array'
  | 'objectArray'
  | 'union'
  | 'json'

export type PrimitiveType = 'string' | 'number' | 'integer' | 'boolean'

export interface EnumOption {
  value: unknown
  label: string
}

export interface UnionBranch {
  value: string | number | boolean
  label: string
  schema: SchemaObject
}

export interface ResolvedField {
  kind: WidgetKind
  /** The effective (non-null) schema with local `$ref`s resolved and the referring node's annotations merged. */
  schema: SchemaObject
  nullable: boolean
  title?: string
  description?: string
  hasDefault: boolean
  default?: unknown
  examples?: unknown[]
  deprecated: boolean
  readOnly: boolean
  writeOnly: boolean
  /** `enum`, titled `const` unions and enum arrays. */
  options: EnumOption[]
  /** Discriminated unions. */
  discriminator?: string
  branches?: UnionBranch[]
  /** Map values and primitive array items. */
  valueType?: PrimitiveType
  /** Array item schema (resolved). */
  itemSchema?: SchemaObject
  /** `$ref` chain followed down to this node; recursion falls back to JSON. */
  refStack: string[]
  /** Why the node renders as JSON. */
  fallbackReason?: string
}

export interface ResolveOptions {
  /** The document root, for local `$ref` resolution. */
  root: JsonSchema
  /** Object nesting depth of this node (the config root is 0). */
  depth?: number
  refStack?: string[]
}

/** Objects nested deeper than this render as JSON (docs/ui.md §6.2). */
export const MAX_FORM_DEPTH = 4

const UNSUPPORTED_KEYWORDS = [
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'dependentSchemas',
  'prefixItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
  '$dynamicRef',
] as const

const ANNOTATION_KEYS = ['title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'x-scantor'] as const

const PRIMITIVE_TYPES: readonly string[] = ['string', 'number', 'integer', 'boolean']

export function isSchemaObject(value: unknown): value is SchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

/** Looks up a local reference (`#/$defs/Name`, `#/definitions/Name`, any local pointer). */
export function lookupLocalRef(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (ref === '#') return root
  if (!ref.startsWith('#/')) return undefined
  let current: unknown = root
  for (const token of ref.slice(2).split('/').map(decodePointerToken)) {
    if (!isSchemaObject(current)) return undefined
    current = current[token]
  }
  return typeof current === 'boolean' || isSchemaObject(current) ? current : undefined
}

interface Dereferenced {
  schema: JsonSchema
  refStack: string[]
  recursive?: boolean
  unresolved?: string
}

/** Follows `$ref` chains; sibling keywords of a `$ref` override the target (2020-12 semantics for annotations). */
export function dereference(schema: JsonSchema, root: JsonSchema, refStack: readonly string[] = []): Dereferenced {
  let current: JsonSchema = schema
  const stack = [...refStack]
  while (isSchemaObject(current) && typeof current.$ref === 'string') {
    const ref = current.$ref
    if (stack.includes(ref)) return { schema: current, refStack: stack, recursive: true }
    const target = lookupLocalRef(root, ref)
    if (target === undefined) return { schema: current, refStack: stack, unresolved: ref }
    stack.push(ref)
    const { $ref: _ignored, ...siblings } = current
    current = typeof target === 'boolean' ? target : { ...target, ...siblings }
  }
  return { schema: current, refStack: stack }
}

function annotations(schema: SchemaObject): Pick<ResolvedField, 'title' | 'description' | 'hasDefault' | 'default' | 'examples' | 'deprecated' | 'readOnly' | 'writeOnly'> {
  return {
    title: typeof schema.title === 'string' ? schema.title : undefined,
    description: typeof schema.description === 'string' ? schema.description : undefined,
    hasDefault: Object.hasOwn(schema, 'default'),
    default: schema.default,
    examples: Array.isArray(schema.examples) ? schema.examples : undefined,
    deprecated: schema.deprecated === true,
    readOnly: schema.readOnly === true,
    writeOnly: schema.writeOnly === true,
  }
}

function pickAnnotations(schema: SchemaObject): SchemaObject {
  const result: SchemaObject = {}
  for (const key of ANNOTATION_KEYS) {
    if (Object.hasOwn(schema, key)) result[key] = schema[key]
  }
  return result
}

function jsonField(schema: SchemaObject, refStack: string[], reason: string, nullable = false): ResolvedField {
  return { kind: 'json', schema, nullable, ...annotations(schema), options: [], refStack, fallbackReason: reason }
}

function isNullSchema(value: unknown): boolean {
  return isSchemaObject(value) && value.type === 'null'
}

function enumLabel(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** `{const, title?, description?, type?}` members: a titled option list. */
function titledConstOptions(members: SchemaObject[]): EnumOption[] | null {
  const allowed = new Set(['const', 'title', 'description', 'type'])
  if (members.length === 0) return null
  const options: EnumOption[] = []
  for (const member of members) {
    if (!Object.hasOwn(member, 'const') || Object.keys(member).some((key) => !allowed.has(key))) return null
    options.push({ value: member.const, label: typeof member.title === 'string' ? member.title : enumLabel(member.const) })
  }
  return options
}

function constValueOf(schema: unknown): { found: boolean, value?: unknown } {
  if (!isSchemaObject(schema)) return { found: false }
  if (Object.hasOwn(schema, 'const')) return { found: true, value: schema.const }
  if (Array.isArray(schema.enum) && schema.enum.length === 1) return { found: true, value: schema.enum[0] }
  return { found: false }
}

function isObjectLike(schema: SchemaObject): boolean {
  return schema.type === 'object' || (schema.type === undefined && isSchemaObject(schema.properties))
}

/**
 * A `oneOf`/`anyOf` whose branches are objects sharing a property with distinct `const` values
 * (docs/tasks.md §6.4). The OpenAPI `discriminator.propertyName` annotation is preferred when present.
 */
export function detectDiscriminatedUnion(
  members: SchemaObject[],
  hint?: unknown,
): { discriminator: string, branches: UnionBranch[] } | null {
  if (members.length < 2 || !members.every(isObjectLike)) return null
  const firstProperties = members[0]!.properties
  if (!isSchemaObject(firstProperties)) return null
  const hinted = isSchemaObject(hint) && typeof hint.propertyName === 'string' ? [hint.propertyName] : []
  const candidates = [...hinted, ...Object.keys(firstProperties).filter((key) => !hinted.includes(key))]
  for (const candidate of candidates) {
    const branches: UnionBranch[] = []
    const seen = new Set<string>()
    for (const member of members) {
      const property = isSchemaObject(member.properties) ? member.properties[candidate] : undefined
      const { found, value } = constValueOf(property)
      if (!found || !['string', 'number', 'boolean'].includes(typeof value)) break
      const key = JSON.stringify(value)
      if (seen.has(key)) break
      seen.add(key)
      branches.push({
        value: value as string | number | boolean,
        label: typeof member.title === 'string' ? member.title : String(value),
        schema: member,
      })
    }
    if (branches.length === members.length) return { discriminator: candidate, branches }
  }
  return null
}

function primitiveTypeOf(schema: SchemaObject): PrimitiveType | null {
  return typeof schema.type === 'string' && PRIMITIVE_TYPES.includes(schema.type) ? (schema.type as PrimitiveType) : null
}

/** Classifies one schema node. */
export function resolveField(input: JsonSchema, options: ResolveOptions): ResolvedField {
  const depth = options.depth ?? 0
  const deref = dereference(input, options.root, options.refStack ?? [])
  const refStack = deref.refStack
  if (typeof deref.schema === 'boolean') return jsonField({}, refStack, deref.schema ? 'any value' : 'no value allowed')
  const schema = deref.schema
  if (deref.recursive) return jsonField(schema, refStack, 'recursive reference')
  if (deref.unresolved) return jsonField(schema, refStack, `unresolved reference ${deref.unresolved}`)

  const unsupported = UNSUPPORTED_KEYWORDS.find((keyword) => Object.hasOwn(schema, keyword))
  if (unsupported) return jsonField(schema, refStack, `unsupported keyword ${unsupported}`)

  // Nullable forms: `type: [T, "null"]` and `anyOf: [X, {type: "null"}]`.
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((type): type is string => typeof type === 'string')
    if (types.length === 2 && types.includes('null')) {
      const inner = resolveField({ ...schema, type: types.find((type) => type !== 'null') }, { ...options, refStack })
      return inner.nullable ? jsonField(schema, refStack, 'nested null union') : { ...inner, nullable: true }
    }
    return jsonField(schema, refStack, 'type union')
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length === 2 && schema.anyOf.some(isNullSchema)) {
    const member = schema.anyOf.find((candidate) => !isNullSchema(candidate))
    if (!isSchemaObject(member)) return jsonField(schema, refStack, 'invalid null union')
    const { anyOf: _ignored, ...outer } = schema
    const memberDeref = dereference(member, options.root, refStack)
    if (memberDeref.recursive || typeof memberDeref.schema === 'boolean') return jsonField(schema, refStack, 'recursive reference', true)
    const merged = { ...memberDeref.schema, ...pickAnnotations(outer), ...(isSchemaObject(outer.discriminator) ? { discriminator: outer.discriminator } : {}) }
    const inner = resolveField(merged, { ...options, refStack: memberDeref.refStack })
    return inner.nullable ? jsonField(schema, refStack, 'nested null union') : { ...inner, nullable: true }
  }

  const base = { schema, nullable: false, ...annotations(schema), options: [] as EnumOption[], refStack }

  if (Object.hasOwn(schema, 'const')) return { ...base, kind: 'const' }

  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((value) => value !== null)
    const nullable = values.length !== schema.enum.length
    if (values.length === 0) return jsonField(schema, refStack, 'empty enum')
    return { ...base, kind: 'enum', nullable, options: values.map((value) => ({ value, label: enumLabel(value) })) }
  }

  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const raw = schema[keyword]
    if (!Array.isArray(raw)) continue
    const members: SchemaObject[] = []
    for (const candidate of raw) {
      const resolved = dereference(candidate as JsonSchema, options.root, refStack)
      if (resolved.recursive || !isSchemaObject(resolved.schema)) return jsonField(schema, refStack, `unsupported ${keyword}`)
      members.push(resolved.schema)
    }
    const titled = titledConstOptions(members)
    if (titled) return { ...base, kind: 'enum', options: titled }
    const union = detectDiscriminatedUnion(members, schema.discriminator)
    if (union) {
      if (depth > MAX_FORM_DEPTH) return jsonField(schema, refStack, 'nested too deeply')
      return { ...base, kind: 'union', ...union }
    }
    return jsonField(schema, refStack, `unsupported ${keyword}`)
  }

  if (isObjectLike(schema)) {
    if (depth > MAX_FORM_DEPTH) return jsonField(schema, refStack, 'nested too deeply')
    if (isSchemaObject(schema.properties)) return { ...base, kind: 'object' }
    const additional = schema.additionalProperties
    if (isSchemaObject(additional)) {
      const value = dereference(additional, options.root, refStack)
      const valueType = isSchemaObject(value.schema) && !value.recursive ? primitiveTypeOf(value.schema) : null
      if (valueType && isSchemaObject(value.schema) && !Array.isArray(value.schema.enum)) return { ...base, kind: 'map', valueType }
      return jsonField(schema, refStack, 'map of non-primitive values')
    }
    if (additional === false) return { ...base, kind: 'object' }
    return jsonField(schema, refStack, 'open object')
  }

  switch (schema.type) {
    case 'string':
      if (schema['x-scantor'] === 'upload') return { ...base, kind: 'upload' }
      if (schema.writeOnly === true) return { ...base, kind: 'secret' }
      return { ...base, kind: 'string' }
    case 'number':
      return { ...base, kind: 'number' }
    case 'integer':
      return { ...base, kind: 'integer' }
    case 'boolean':
      return { ...base, kind: 'boolean' }
    case 'array':
      return resolveArray(schema, options, base)
    default:
      return jsonField(schema, refStack, schema.type === undefined ? 'no type' : `type ${String(schema.type)}`)
  }
}

function resolveArray(schema: SchemaObject, options: ResolveOptions, base: Omit<ResolvedField, 'kind'>): ResolvedField {
  const items = schema.items
  if (!isSchemaObject(items)) return jsonField(schema, base.refStack, 'array without item schema')
  const item = resolveField(items, { ...options, depth: (options.depth ?? 0) + 1, refStack: base.refStack })
  if (item.nullable) return jsonField(schema, base.refStack, 'nullable array items')
  if (item.kind === 'enum') return { ...base, kind: 'enumArray', options: item.options, itemSchema: item.schema }
  const valueType = primitiveTypeOf(item.schema)
  if (valueType && ['string', 'number', 'integer', 'boolean'].includes(item.kind)) {
    return { ...base, kind: 'array', valueType, itemSchema: item.schema }
  }
  if (item.kind === 'object') return { ...base, kind: 'objectArray', itemSchema: item.schema }
  return jsonField(schema, base.refStack, `array of ${item.kind === 'json' ? item.fallbackReason ?? 'unsupported items' : item.kind}`)
}

/** Ordered property list of an object schema with each property's `required` flag. */
export function objectProperties(schema: SchemaObject): { name: string, schema: JsonSchema, required: boolean }[] {
  const properties = isSchemaObject(schema.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [])
  return Object.entries(properties)
    .filter((entry): entry is [string, JsonSchema] => typeof entry[1] === 'boolean' || isSchemaObject(entry[1]))
    .map(([name, propertySchema]) => ({ name, schema: propertySchema, required: required.has(name) }))
}

/** True when the whole config schema can be edited as a form (its root is a renderable object). */
export function isFormRenderable(schema: JsonSchema | null | undefined): boolean {
  if (schema === null || schema === undefined) return false
  return resolveField(schema, { root: schema }).kind === 'object'
}

// ---------------------------------------------------------------------------------------------------------
// Read-only schema viewer rows (SchemaTable).

export interface SchemaRow {
  path: string
  depth: number
  type: string
  required: boolean
  hasDefault: boolean
  default?: unknown
  constraints: string[]
  description?: string
  badges: ('secret' | 'upload' | 'file' | 'deprecated' | 'readOnly')[]
}

const CONSTRAINT_KEYS = [
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'propertyNames',
] as const

const MAX_TABLE_DEPTH = 8

function describeType(schema: SchemaObject, root: JsonSchema, refStack: string[]): string {
  if (Object.hasOwn(schema, 'const')) return 'const'
  if (Array.isArray(schema.enum)) return 'enum'
  if (Array.isArray(schema.type)) return schema.type.join(' | ')
  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const members = schema[keyword]
    if (Array.isArray(members)) {
      const resolved = members.map((member) => dereference(member as JsonSchema, root, refStack).schema).filter(isSchemaObject)
      if (resolved.length === members.length && titledConstOptions(resolved)) return 'enum'
      const union = resolved.length === members.length ? detectDiscriminatedUnion(resolved, schema.discriminator) : null
      if (union) return `union by ${union.discriminator}`
      return members
        .map((member) => {
          const resolved = dereference(member as JsonSchema, root, refStack)
          return isSchemaObject(resolved.schema) && !resolved.recursive ? describeType(resolved.schema, root, resolved.refStack) : 'any'
        })
        .join(' | ')
    }
  }
  if (schema.type === 'array' && isSchemaObject(schema.items)) {
    const items = dereference(schema.items, root, refStack)
    return `array<${isSchemaObject(items.schema) && !items.recursive ? describeType(items.schema, root, items.refStack) : 'any'}>`
  }
  if (isObjectLike(schema) && !isSchemaObject(schema.properties) && isSchemaObject(schema.additionalProperties)) {
    const values = dereference(schema.additionalProperties, root, refStack)
    return `map<${isSchemaObject(values.schema) && !values.recursive ? describeType(values.schema, root, values.refStack) : 'any'}>`
  }
  if (typeof schema.type === 'string') return schema.type
  return isObjectLike(schema) ? 'object' : 'any'
}

/** `enum` values, or the values of a titled `const` union; null otherwise. */
function enumValues(schema: SchemaObject): unknown[] | null {
  if (Array.isArray(schema.enum)) return schema.enum
  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const members = schema[keyword]
    if (!Array.isArray(members) || !members.every(isSchemaObject)) continue
    const options = titledConstOptions(members)
    if (options) return options.map((option) => option.value)
  }
  return null
}

function constraintsOf(schema: SchemaObject): string[] {
  const result: string[] = []
  for (const key of CONSTRAINT_KEYS) {
    if (!Object.hasOwn(schema, key)) continue
    const value = schema[key]
    result.push(key === 'propertyNames' ? 'keys constrained' : `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
  }
  const values = enumValues(schema)
  if (values) result.push(`one of: ${values.slice(0, 10).map(enumLabel).join(', ')}${values.length > 10 ? ', …' : ''}`)
  if (Object.hasOwn(schema, 'const')) result.push(`= ${enumLabel(schema.const)}`)
  return result
}

/** The non-null member of a nullable `anyOf: [X, {type: "null"}]`, dereferenced; null for any other schema. */
function nullableMember(schema: SchemaObject, root: JsonSchema, refStack: string[]): Dereferenced | null {
  if (!Array.isArray(schema.anyOf) || schema.anyOf.length !== 2 || !schema.anyOf.some(isNullSchema)) return null
  const member = schema.anyOf.find((candidate) => !isNullSchema(candidate))
  return member === undefined ? null : dereference(member as JsonSchema, root, refStack)
}

/**
 * The badges of a property. A nullable property (`SecretStr | None` is `anyOf: [{…, writeOnly: true}, {type: "null"}]`)
 * carries its keywords on the non-null member, so the member counts unless the wrapper sets the keyword itself.
 */
function badgesOf(schema: SchemaObject, member: SchemaObject | null): SchemaRow['badges'] {
  const keyword = (key: string): unknown => (Object.hasOwn(schema, key) ? schema[key] : member?.[key])
  const badges: SchemaRow['badges'] = []
  if (keyword('writeOnly') === true) badges.push('secret')
  if (keyword('x-scantor') === 'upload') badges.push('upload')
  if (keyword('x-scantor') === 'file') badges.push('file')
  if (keyword('deprecated') === true) badges.push('deprecated')
  if (keyword('readOnly') === true) badges.push('readOnly')
  return badges
}

/** Flattens an object schema into one row per property path (`a.b`, `items[].c`). */
export function flattenSchema(schema: JsonSchema, root: JsonSchema = schema): SchemaRow[] {
  const rows: SchemaRow[] = []
  const visit = (node: JsonSchema, prefix: string, depth: number, refStack: string[]): void => {
    const deref = dereference(node, root, refStack)
    if (!isSchemaObject(deref.schema) || deref.recursive || depth > MAX_TABLE_DEPTH) return
    let current = deref.schema
    let stack = deref.refStack
    const nullable = nullableMember(current, root, stack)
    if (nullable) {
      if (!isSchemaObject(nullable.schema) || nullable.recursive) return
      current = nullable.schema
      stack = nullable.refStack
    }
    if (current.type === 'array' && isSchemaObject(current.items)) {
      visit(current.items, `${prefix}[]`, depth, stack)
      return
    }
    for (const property of objectProperties(current)) {
      const path = prefix ? `${prefix}.${property.name}` : property.name
      const resolved = dereference(property.schema, root, stack)
      const propertySchema = isSchemaObject(resolved.schema) ? resolved.schema : {}
      const member = resolved.recursive ? null : nullableMember(propertySchema, root, resolved.refStack)
      const memberSchema = member && !member.recursive && isSchemaObject(member.schema) ? member.schema : null
      const badges = badgesOf(propertySchema, memberSchema)
      rows.push({
        path,
        depth,
        type: resolved.recursive ? 'recursive' : describeType(propertySchema, root, resolved.refStack),
        required: property.required,
        hasDefault: Object.hasOwn(propertySchema, 'default'),
        default: propertySchema.default,
        constraints: constraintsOf(propertySchema),
        description: typeof propertySchema.description === 'string' ? propertySchema.description : (typeof propertySchema.title === 'string' ? propertySchema.title : undefined),
        badges,
      })
      if (!resolved.recursive && !badges.includes('file')) visit(property.schema, path, depth + 1, stack)
    }
  }
  visit(schema, '', 0, [])
  return rows
}
