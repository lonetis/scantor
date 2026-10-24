import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallToolResult, Client } from '@modelcontextprotocol/client'

// Tool-call helpers of the mcp writer's specs (docs/mcp.md §4): raw results with their note block, the structured
// error of a failed call, the `untrusted_data` envelope, long-polls through the `wait` tools, and generated task
// folders for tests that need a task the fixtures do not have.

export interface ToolCall<T = Record<string, unknown>> {
  result: CallToolResult
  /** the text of every content block */
  texts: string[]
  /** the first block parsed as JSON (null when it is not JSON, for example after a hard cut) */
  json: T | null
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Calls a tool and returns its result, also when it is an error. */
export async function callTool<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolCall<T>> {
  const result = (await client.callTool({ name, arguments: args }, { timeout: 120_000 })) as CallToolResult
  const texts = result.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text)
  return { result, texts, json: parseJson(texts[0]) as T | null }
}

/** Calls a tool that must succeed and returns its JSON (the first content block). */
export async function callOk<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const call = await callTool<T>(client, name, args)
  if (call.result.isError) throw new Error(`${name} failed: ${call.texts.join('\n')}`)
  if (call.json === null) throw new Error(`${name} returned no JSON: ${call.texts.join('\n').slice(0, 2000)}`)
  return call.json
}

export interface ToolError {
  httpStatus: number
  code: string
  message: string
  details?: Record<string, unknown>
  retryAfterSeconds?: number
}

/** Calls a tool that must fail and returns the structured error of its single text block. */
export async function callToolError(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolError> {
  const call = await callTool<{ error?: ToolError }>(client, name, args)
  if (!call.result.isError) throw new Error(`${name} unexpectedly succeeded: ${call.texts.join('\n').slice(0, 2000)}`)
  if (call.texts.length !== 1 || !call.json?.error) throw new Error(`${name} failed without a structured error: ${call.texts.join('\n')}`)
  return call.json.error
}

/** The value inside an `{untrusted_data: …}` envelope; throws when the value is not wrapped. */
export function unwrap<T = unknown>(value: unknown, what: string): T {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'untrusted_data') {
    throw new Error(`${what} is not wrapped as untrusted_data: ${JSON.stringify(value)?.slice(0, 500)}`)
  }
  return (value as { untrusted_data: T }).untrusted_data
}

/**
 * Calls a tool that must succeed, retrying a structured 503 every 5 s until `timeoutMs`: the busy shared stack
 * refuses new scans with 503 `brokerAlarm` while RabbitMQ is out of memory, until it recovers.
 */
export async function callOkPatiently<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const call = await callTool<T & { error?: ToolError }>(client, name, args)
    const unavailable = call.result.isError && call.json?.error?.httpStatus === 503
    if (!unavailable || Date.now() >= deadline) {
      if (call.result.isError) throw new Error(`${name} failed: ${call.texts.join('\n')}`)
      if (call.json === null) throw new Error(`${name} returned no JSON: ${call.texts.join('\n').slice(0, 2000)}`)
      return call.json
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
}

type Waited = Record<string, unknown> & { _wait?: string; state?: string }

/** Calls a `wait` tool with wait 50 until `done` holds for its result; each round takes at most 50 s. */
export async function pollTool<T extends Waited>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await callOk<T>(client, name, { ...args, wait: 50 })
    if (done(value)) return value
    if (Date.now() >= deadline) throw new Error(`${name} did not settle within ${timeoutMs / 1000} s: ${JSON.stringify(value).slice(0, 2000)}`)
    // A settled answer that is not done yet (for example a scan that is paused) is polled again after a moment.
    if (value._wait === 'settled') await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/** Writes a task folder to a new temporary directory; remove it with helpers/tasks.ts `removeDir`. */
export async function writeTaskDir(prefix: string, files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`))
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content)
  return dir
}

/** A Python task of the `list` template whose result carries `sizeBytes` characters per analysis. */
export function largeResultTaskFiles(name: string): Record<string, string> {
  return {
    'scantor.yaml': `scantor: 1\nname: ${name}\nlanguage: python\ndescription: "Test task: results of a configurable size."\n`,
    Dockerfile: 'ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nCOPY . .\n',
    '.dockerignore': '__pycache__/\n.scantor/\n',
    'main.py': [
      '"""Results of a configurable size, one analysis per list item."""',
      '',
      'from pydantic import BaseModel, Field',
      '',
      'import scantor',
      'from scantor import templates',
      '',
      '',
      'class TaskConfig(scantor.Config):',
      '    size_bytes: int = Field(default=1024, ge=1, le=900000)',
      '',
      '',
      'class Result(BaseModel):',
      '    item: str',
      '    text: str',
      '',
      '',
      'def run(ctx: scantor.Context, analysis_config: templates.list.AnalysisConfig, task_config: TaskConfig) -> Result:',
      '    return Result(item=analysis_config.item, text="x" * task_config.size_bytes)',
      '',
      '',
      'task = scantor.Task(task_config=TaskConfig, result=Result, schedule=templates.list.schedule, run=run)',
      '',
    ].join('\n'),
  }
}
