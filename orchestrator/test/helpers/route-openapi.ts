import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type { OpenApiDocument } from '../../server/utils/operations'

// The OpenAPI document of the API route files, built like Nitro's static extraction (docs/mcp.md §4.1): the literal
// argument of each handler's defineRouteMeta (test/api/route-meta.test.ts keeps it literal), its path from the file
// name (`[param]` → `{param}`, `index` → the directory), `$global` components merged into the document. Unit tests
// use it to check the real operations (MCP tool count, extension rules, bounds) without starting Nitro.

const API_ROOT = fileURLToPath(new URL('../../server/api', import.meta.url))
const METHOD_FILE = /^(.+)\.(get|put|post|delete|patch)\.ts$/

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return routeFiles(path)
    return METHOD_FILE.test(entry.name) ? [path] : []
  })
}

/** The value of a literal expression (object, array, string, number, boolean, null). */
function literalValue(node: ts.Expression): unknown {
  if (ts.isObjectLiteralExpression(node)) {
    const value: Record<string, unknown> = {}
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) throw new Error(`unsupported property ${ts.SyntaxKind[property.kind]}`)
      const name = property.name
      if (!ts.isIdentifier(name) && !ts.isStringLiteral(name) && !ts.isNumericLiteral(name)) throw new Error('computed key')
      value[name.text] = literalValue(property.initializer)
    }
    return value
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((element) => literalValue(element))
  if (ts.isStringLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  throw new Error(`unsupported expression ${ts.SyntaxKind[node.kind]}`)
}

function routeMeta(file: string): Record<string, unknown> | null {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement)) continue
    const call = statement.expression
    if (ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === 'defineRouteMeta' && call.arguments[0]) {
      return literalValue(call.arguments[0]) as Record<string, unknown>
    }
  }
  return null
}

/** `/api/nodes/{nodeId}/daemon-overrides` and `patch` for `nodes/[nodeId]/daemon-overrides.patch.ts`. */
function routeOf(file: string): { path: string; method: string } {
  const segments = relative(API_ROOT, file).split(sep)
  const match = METHOD_FILE.exec(segments.pop()!)!
  if (match[1] !== 'index') segments.push(match[1]!)
  return { path: `/api/${segments.map((segment) => segment.replace(/^\[(.+)\]$/, '{$1}')).join('/')}`.replace(/\/$/, ''), method: match[2]! }
}

export interface RouteOpenApiDocument extends OpenApiDocument {
  openapi: string
  info: { title: string; version: string }
  paths: Record<string, Record<string, Record<string, unknown>>>
  components: { schemas: Record<string, unknown> }
}

export function routeOpenApiDocument(): RouteOpenApiDocument {
  const document: RouteOpenApiDocument = { openapi: '3.1.0', info: { title: 'scantor API', version: 'test' }, paths: {}, components: { schemas: {} } }
  for (const file of routeFiles(API_ROOT)) {
    const openApi = routeMeta(file)?.openAPI as Record<string, unknown> | undefined
    if (!openApi) continue
    const { $global, ...operation } = openApi
    const schemas = ($global as { components?: { schemas?: Record<string, unknown> } } | undefined)?.components?.schemas
    if (schemas) Object.assign(document.components.schemas, schemas)
    const { path, method } = routeOf(file)
    document.paths[path] = { ...document.paths[path], [method]: operation }
  }
  return document
}

/** The operation `operationId` of the route document. */
export function routeOperation(document: RouteOpenApiDocument, operationId: string): Record<string, unknown> {
  for (const item of Object.values(document.paths)) {
    for (const operation of Object.values(item)) if (operation.operationId === operationId) return operation
  }
  throw new Error(`no operation ${operationId}`)
}
