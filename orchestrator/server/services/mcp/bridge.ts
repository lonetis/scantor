import type { CallToolResult } from '@modelcontextprotocol/server'
import { buildHttpRequest } from 'mcp-from-openapi'
import { INTERNAL_AUTH_HEADER, mintInternalCapability } from '../../utils/internal-auth'
import type { UserPrincipal } from '../../utils/principal'
import { clampWait } from './arguments'
import { type CatalogueTool, MCP_MAX_WAIT_SECONDS } from './tools'
import { capJson, capText } from './truncate'
import { wrapUntrusted } from './untrusted'

// Tool execution (docs/mcp.md §4.3–§4.7): every call goes through the real REST route over loopback HTTP (the
// private loopback listener of server/utils/loopback.ts) with a single-use internal capability bound to method, path
// and operation, so validation, ownership, masking and limits are identical to the REST API. The client's OAuth
// token is never forwarded.

export const MAX_BRIDGE_BODY_BYTES = 16 * 1024 * 1024

export interface ToolError {
  httpStatus: number
  code: string
  message: string
  details?: unknown
  retryAfterSeconds?: number
}

export function errorResult(error: ToolError): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error }, null, 2) }] }
}

function textResult(value: { text: string; note?: string }): CallToolResult {
  return {
    content: [{ type: 'text', text: value.text }, ...(value.note ? [{ type: 'text' as const, text: value.note }] : [])],
  }
}

async function readBodyCapped(response: Response, limit: number): Promise<Buffer | null> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return Buffer.concat(chunks)
    size += value.length
    if (size > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
}

/** Parses JSON; null when the text is not JSON (error bodies of non-scantor handlers). */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function mediaType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
}

/** Maps a REST response onto a tool result (docs/mcp.md §4.4). */
export async function toToolResult(response: Response, operationId: string): Promise<CallToolResult> {
  const body = await readBodyCapped(response, MAX_BRIDGE_BODY_BYTES)
  if (!body) {
    return errorResult({
      httpStatus: 413,
      code: 'payloadTooLarge',
      message: 'the response exceeds 16 MiB; narrow the request with limit, fields/projection, filter or afterSeq',
    })
  }
  const type = mediaType(response)
  if (response.status >= 300 && response.status < 400) {
    return textResult(capJson({ redirect: response.headers.get('location') }))
  }
  if (!response.ok) {
    const envelope = (parseJson(body.toString('utf8')) ?? {}) as { error?: { code?: string; message?: string; details?: unknown } }
    const retryAfter = Number(response.headers.get('retry-after'))
    return errorResult({
      httpStatus: response.status,
      code: envelope.error?.code ?? 'internal',
      message: envelope.error?.message ?? (body.toString('utf8').slice(0, 500) || response.statusText),
      ...(envelope.error?.details === undefined ? {} : { details: envelope.error.details }),
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
    })
  }
  if (body.length === 0) return textResult(capJson({ ok: true, status: response.status }))
  if (!type || type === 'application/json' || type.endsWith('+json')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      return textResult(capText(body.toString('utf8')))
    }
    let wrapped = wrapUntrusted(operationId, parsed)
    const wait = response.headers.get('scantor-wait')
    if (wait && wrapped !== null && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
      wrapped = { ...(wrapped as Record<string, unknown>), _wait: wait }
    }
    return textResult(capJson(wrapped))
  }
  return textResult(capText(body.toString('utf8')))
}

/**
 * Executes one tool call as `principal` (whose `mcp.level` the REST middleware re-checks) against the loopback
 * listener at `loopbackOrigin`.
 */
export async function callApiTool(
  tool: CatalogueTool,
  input: Record<string, unknown>,
  principal: UserPrincipal,
  requestId: string,
  loopbackOrigin: string,
): Promise<CallToolResult> {
  const args = clampWait(input, MCP_MAX_WAIT_SECONDS)
  const issues = tool.checkArguments(args)
  if (issues.length > 0) {
    return errorResult({
      httpStatus: 400,
      code: 'validationFailed',
      message: `invalid arguments for ${tool.name}: ${issues.map((issue) => (issue.path ? `${issue.path} ${issue.message}` : issue.message)).join('; ')}`,
      details: { issues },
    })
  }
  let request: ReturnType<typeof buildHttpRequest>
  try {
    request = buildHttpRequest(tool.tool, args, { baseUrl: loopbackOrigin })
  } catch (error) {
    return errorResult({ httpStatus: 400, code: 'validationFailed', message: `invalid arguments: ${(error as Error).message}` })
  }
  const url = new URL(request.url)
  const capability = mintInternalCapability({
    principal: { ...principal, mcp: { clientId: principal.mcp?.clientId ?? null, level: principal.mcp?.level ?? 'read', operationId: tool.operationId } },
    method: request.method,
    pathname: url.pathname,
    operationId: tool.operationId,
  })
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers, [INTERNAL_AUTH_HEADER]: capability, 'x-request-id': requestId },
      body: request.body as BodyInit | undefined,
      redirect: 'manual',
    })
    return await toToolResult(response, tool.operationId)
  } catch (error) {
    return errorResult({ httpStatus: 503, code: 'unavailable', message: `the REST API is unreachable: ${(error as Error).message}` })
  }
}
