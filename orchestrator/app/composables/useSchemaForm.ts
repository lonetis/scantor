import { type OutputUnit, type Schema, Validator } from '@cfworker/json-schema'
import { computed, type MaybeRefOrGetter, nextTick, toValue } from 'vue'
import { type FieldError, parsePointer, segmentsToDotPath } from '../utils/json-pointer'
import { isFormRenderable, type JsonSchema } from '../utils/schema-subset'

// Browser-side validation of JSON-Schema forms (docs/ui.md §6.1) with @cfworker/json-schema: an interpreter that
// generates no code, so it runs under the production CSP without 'unsafe-eval'. Draft 2020-12, every error is
// reported, defaults are never filled and `discriminator` is ignored. The server's ajv stays authoritative; the
// browser validates for fast feedback only.

const MAX_CACHED_VALIDATORS = 64

/** Validators per schema text (most recently used last); `null` marks a schema the browser cannot use. */
const validators = new Map<string, Validator | null>()
let unavailableWarningShown = false

function warnUnavailable(error: unknown): void {
  if (unavailableWarningShown) return
  unavailableWarningShown = true
  console.warn('[schema-form] browser-side validation is unavailable for a schema; the server validates on submit', error)
}

function validatorFor(schema: JsonSchema): Validator | null {
  const key = JSON.stringify(schema)
  if (validators.has(key)) {
    const cached = validators.get(key) ?? null
    validators.delete(key)
    validators.set(key, cached)
    return cached
  }
  let validator: Validator | null = null
  try {
    validator = new Validator(schema as Schema | boolean, '2020-12', false)
  } catch (error) {
    warnUnavailable(error)
  }
  validators.set(key, validator)
  if (validators.size > MAX_CACHED_VALIDATORS) validators.delete(validators.keys().next().value!)
  return validator
}

/** Keywords whose error only says "a subschema failed"; the subschema's own errors follow it. */
const WRAPPERS = new Set([
  'properties',
  'patternProperties',
  'items',
  'prefixItems',
  'additionalItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'allOf',
  '$ref',
  '$recursiveRef',
  'dependentSchemas',
  'dependencies',
  'if',
  'contains',
  'propertyNames',
])

/** `#/headers/0` → `["headers", "0"]` (cfworker URI-encodes pointer tokens). */
function locationSegments(location: string): string[] {
  const pointer = location.startsWith('#') ? location.slice(1) : location
  return parsePointer(pointer).map((segment) => decodeURIComponent(segment))
}

function quoted(message: string, pattern: RegExp): string | null {
  return pattern.exec(message)?.[1] ?? null
}

function isDirectChild(location: string, parent: string): boolean {
  return location.startsWith(`${parent}/`) && !location.slice(parent.length + 1).includes('/')
}

const UNKNOWN_PROPERTY = 'unknownProperty'

/**
 * Folds `additionalProperties: false` failures into one unit per unknown key. cfworker reports them as an
 * `additionalProperties` unit followed by a `false` unit whose keywordLocation is not nested under it, and it also
 * reports declared properties that failed their own schema as additional; those are dropped here.
 */
function foldAdditionalProperties(units: readonly OutputUnit[]): OutputUnit[] {
  const folded: OutputUnit[] = []
  for (let index = 0; index < units.length; index++) {
    const unit = units[index]!
    if (unit.keyword !== 'additionalProperties') {
      folded.push(unit)
      continue
    }
    const key = quoted(unit.error, /^Property "(.*)" does not match/)
    const next = units[index + 1]
    if (key === null || next?.keyword !== 'false' || next.instanceLocation !== `${unit.instanceLocation}/${encodePointerToken(key)}`) continue
    index++
    const propertiesLocation = `${unit.keywordLocation.slice(0, -'additionalProperties'.length)}properties`
    const declared = units.some(
      (other) =>
        other.keyword === 'properties' &&
        other.instanceLocation === unit.instanceLocation &&
        other.keywordLocation === propertiesLocation &&
        quoted(other.error, /^Property "(.*)" does not match schema/) === key,
    )
    if (!declared) folded.push({ keyword: UNKNOWN_PROPERTY, keywordLocation: unit.keywordLocation, instanceLocation: unit.instanceLocation, error: key })
  }
  return folded
}

/**
 * The errors to show. For a failed `oneOf`/`anyOf` whose branches are told apart by a constant (a discriminated
 * union, docs/tasks.md §6.4), only the errors of the branch the value selected are kept; otherwise the summary.
 */
function selectUnits(units: readonly OutputUnit[]): OutputUnit[] {
  const selected: OutputUnit[] = []
  for (let index = 0; index < units.length; index++) {
    const unit = units[index]!
    if (unit.keyword !== 'oneOf' && unit.keyword !== 'anyOf') {
      selected.push(unit)
      continue
    }
    const prefix = `${unit.keywordLocation}/`
    let end = index + 1
    while (end < units.length && units[end]!.keywordLocation.startsWith(prefix)) end++
    const branches = new Map<string, OutputUnit[]>()
    for (const nested of units.slice(index + 1, end)) {
      const branch = nested.keywordLocation.slice(prefix.length).split('/')[0]!
      branches.set(branch, [...(branches.get(branch) ?? []), nested])
    }
    const matching = [...branches.values()].filter(
      (errors) => !errors.some((error) => (error.keyword === 'const' || error.keyword === 'enum') && isDirectChild(error.instanceLocation, unit.instanceLocation)),
    )
    if (matching.length === 1) selected.push(...selectUnits(matching[0]!))
    else selected.push(unit)
    index = end - 1
  }
  return selected
}

/** cfworker output units → form errors with dot paths relative to the validated value. */
export function outputUnitsToFieldErrors(units: readonly OutputUnit[]): FieldError[] {
  const errors: FieldError[] = []
  for (const unit of selectUnits(foldAdditionalProperties(units))) {
    if (WRAPPERS.has(unit.keyword)) continue
    const base = locationSegments(unit.instanceLocation)
    if (unit.keyword === 'required') {
      const key = quoted(unit.error, /required property "(.*)"/)
      errors.push({ name: segmentsToDotPath(key === null ? base : [...base, key]), message: 'is required' })
    } else if (unit.keyword === UNKNOWN_PROPERTY) {
      errors.push({ name: segmentsToDotPath(base), message: `unknown property "${unit.error}"` })
    } else {
      errors.push({ name: segmentsToDotPath(base), message: unit.keyword === 'false' ? 'is not allowed' : unit.error })
    }
  }
  const seen = new Set<string>()
  return errors.filter((error) => {
    const key = `${error.name}\n${error.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function encodePointerToken(token: string): string {
  return encodeURI(token.replace(/~/g, '~0').replace(/\//g, '~1'))
}

/** Validates a value against a schema and returns form errors with dot paths relative to the value. */
export function validateAgainstSchema(schema: JsonSchema, value: unknown): FieldError[] {
  const validator = validatorFor(schema)
  if (!validator) return []
  try {
    const result = validator.validate(value)
    return result.valid ? [] : outputUnitsToFieldErrors(result.errors)
  } catch (error) {
    // For example a $ref the validator cannot resolve: the server still validates on submit.
    warnUnavailable(error)
    return []
  }
}

/**
 * A UForm `validate` that runs once the edit has settled. The UForm validates on "change" and "blur" in the tick of
 * the edit, before the parent has passed the edited value back as `modelValue`; validated then, a required number
 * field (which commits its text on blur) was still empty and showed "is required" until the next validation.
 */
export function settledValidator<E>(validate: () => E[]): () => Promise<E[]> {
  return async () => {
    await nextTick()
    return validate()
  }
}

export function useSchemaForm(schema: MaybeRefOrGetter<JsonSchema | null | undefined>) {
  const resolved = computed(() => toValue(schema) ?? null)
  const renderable = computed(() => isFormRenderable(resolved.value))
  const available = computed(() => resolved.value !== null && validatorFor(resolved.value) !== null)

  function validate(value: unknown): FieldError[] {
    return resolved.value === null ? [] : validateAgainstSchema(resolved.value, value)
  }

  return { renderable, available, validate }
}
