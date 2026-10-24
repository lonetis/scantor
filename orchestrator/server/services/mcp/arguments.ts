import type { JsonSchemaType, StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { ValidationIssue } from '#shared/types/common'

// Tool arguments (docs/mcp.md §4.3, §4.7, §4.8). The MCP SDK validates `tools/call` arguments against a tool's input
// schema before the tool runs and answers a violation with a plain-text "Input validation error". That would reject
// `wait: 120` before the bridge can clamp it, and it would bypass the structured error shape. So the SDK gets a schema
// that advertises the generated JSON Schema but accepts every argument object, and the bridge validates against the
// same JSON Schema after clamping `wait`, answering a violation with 400 `validationFailed` and `details.issues`.

export type ToolArguments = Record<string, unknown>
export type ArgumentsCheck = (args: ToolArguments) => ValidationIssue[]

/** The input schema registered with the SDK: lists `schema` in `tools/list`, defers validation to the bridge. */
export function advertisedInputSchema(schema: JsonSchemaType): StandardSchemaWithJSON<ToolArguments, ToolArguments> {
  return {
    '~standard': {
      version: 1,
      vendor: 'scantor',
      jsonSchema: { input: () => schema, output: () => schema },
      validate: (value: unknown) => ({ value: value as ToolArguments }),
    },
  }
}

let ajv: Ajv2020 | null = null

/** The same settings as the SDK's default validator (draft 2020-12, formats asserted, all errors). */
function useAjv(): Ajv2020 {
  if (ajv) return ajv
  ajv = new Ajv2020({ strict: false, validateFormats: true, validateSchema: false, allErrors: true, logger: false })
  addFormats(ajv)
  return ajv
}

function dotPath(instancePath: string, key?: string): string {
  const segments = instancePath
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
  if (key !== undefined) segments.push(key)
  return segments.join('.')
}

/** One ajv error as a `details.issues` entry with a dot path, like the REST API's zod issues (docs/api.md §1.5). */
export function argumentIssue(error: ErrorObject): ValidationIssue {
  const params = error.params as Record<string, unknown>
  if (error.keyword === 'required' && typeof params.missingProperty === 'string') {
    return { path: dotPath(error.instancePath, params.missingProperty), message: 'is required' }
  }
  if (error.keyword === 'additionalProperties' && typeof params.additionalProperty === 'string') {
    return { path: dotPath(error.instancePath, params.additionalProperty), message: 'unknown field' }
  }
  return { path: dotPath(error.instancePath), message: error.message ?? `failed ${error.keyword}` }
}

/** Compiles the check of a tool's input schema; an empty list means the arguments are valid. */
export function compileArgumentsCheck(schema: JsonSchemaType): ArgumentsCheck {
  const validate = useAjv().compile(schema)
  return (args) => (validate(args) ? [] : (validate.errors ?? []).map(argumentIssue))
}

/** Clamps a numeric `wait` argument to `max` (docs/mcp.md §4.8); every other value is left to validation. */
export function clampWait(args: ToolArguments, max: number): ToolArguments {
  return typeof args.wait === 'number' && args.wait > max ? { ...args, wait: max } : args
}
