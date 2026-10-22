import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Nitro builds the OpenAPI document (and with it the MCP tool catalogue, docs/mcp.md §4.1) from the
// defineRouteMeta argument of every handler by static extraction: it transpiles the file with esbuild and keeps
// only object, array and literal nodes. Anything else is dropped without a warning: a negative number (a unary
// expression), an identifier or a call, and a template literal, which esbuild prints for a string that contains
// both ' and ". This test keeps every route meta inside what survives the extraction.

const root = fileURLToPath(new URL('../../server', import.meta.url))

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return routeFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

function routeMetaArgument(source: ts.SourceFile): ts.Expression | undefined {
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement)) continue
    const call = statement.expression
    if (ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === 'defineRouteMeta' && call.arguments.length === 1) {
      return call.arguments[0]
    }
  }
  return undefined
}

/** Paths and reasons of every value the static extraction would lose. */
function unextractableValues(node: ts.Expression, path = ''): string[] {
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.flatMap((property) => {
      if (!ts.isPropertyAssignment(property)) return [`${path}: ${ts.SyntaxKind[property.kind]} is dropped`]
      const name = property.name
      const key = ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : undefined
      if (key === undefined) return [`${path}: computed key ${ts.SyntaxKind[name.kind]} is dropped`]
      return unextractableValues(property.initializer, `${path}.${key}`)
    })
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap((element, index) => unextractableValues(element, `${path}[${index}]`))
  if (ts.isStringLiteral(node)) {
    return node.text.includes("'") && node.text.includes('"') ? [`${path}: a string with both ' and " becomes a template literal`] : []
  }
  if (ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) {
    return []
  }
  if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) return [`${path}: a template literal is dropped`]
  if (ts.isPrefixUnaryExpression(node)) return [`${path}: ${node.getText()} is a unary expression (negative numbers are dropped)`]
  return [`${path}: ${ts.SyntaxKind[node.kind]} is dropped`]
}

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile('route.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

describe('route meta', () => {
  it('flags values that Nitro’s static extraction drops', () => {
    const argument = routeMetaArgument(
      parse(`defineRouteMeta({ openAPI: { a: 'it\\'s "quoted"', b: [1, -1], c: LIMIT, d: \`x\`, e: { ok: true, n: null, s: 'fine' } } })`),
    )
    expect(argument && unextractableValues(argument)).toEqual([
      `.openAPI.a: a string with both ' and " becomes a template literal`,
      '.openAPI.b[1]: -1 is a unary expression (negative numbers are dropped)',
      '.openAPI.c: Identifier is dropped',
      '.openAPI.d: a template literal is dropped',
    ])
  })

  it('contains only values that survive the extraction in every handler', () => {
    const problems = routeFiles(root).flatMap((file) => {
      const argument = routeMetaArgument(parse(readFileSync(file, 'utf8')))
      return argument ? unextractableValues(argument).map((problem) => `${relative(root, file)} ${problem}`) : []
    })
    expect(problems).toEqual([])
  })
})
