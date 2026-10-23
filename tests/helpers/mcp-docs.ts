import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { env } from './env'

// Reading the agent-facing documentation of the repository checkout for the mcp writer's guide and drift specs
// (docs/mcp.md §6, docs/testing.md §8.4): the user guides of docs/guide/, the skills under skills/, the MCP
// instructions section, the CLI command tree of the generated docs/guide/cli.md, MCP tool names and `scantor`
// commands mentioned in prose and code, and the `scantor:include` snippet blocks.

export const INSTRUCTIONS_START = '<!-- scantor:mcp-instructions:start -->'
export const INSTRUCTIONS_END = '<!-- scantor:mcp-instructions:end -->'
/** Guides served by name (docs/mcp.md §6). */
export const GUIDE_NAMES = ['templates', 'manifest', 'errors-and-retries', 'cli', 'mcp', 'remote-nodes'] as const

/** A file of the repository checkout (/src in the runner). */
export function repoFile(path: string): string {
  return readFileSync(join(env.paths.repo, path), 'utf8')
}

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? walk(path) : [path]
    })
}

/** Repository-relative paths of docs/guide/*.md. */
export function guideFiles(): string[] {
  return readdirSync(join(env.paths.repo, 'docs/guide'))
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => `docs/guide/${name}`)
}

/** Repository-relative paths of every file under skills/. */
export function skillFiles(): string[] {
  return walk(join(env.paths.repo, 'skills')).map((path) => relative(env.paths.repo, path))
}

/** The language ids of schemas/languages.json (one authoring guide each). */
export function languages(): string[] {
  const table = JSON.parse(repoFile('schemas/languages.json')) as { languages: Record<string, unknown> }
  return Object.keys(table.languages)
}

/** The marked instructions section of docs/guide/mcp.md, trimmed. */
export function instructionsSection(): string {
  const markdown = repoFile('docs/guide/mcp.md')
  const start = markdown.indexOf(INSTRUCTIONS_START)
  const end = markdown.indexOf(INSTRUCTIONS_END)
  if (start < 0 || end <= start) throw new Error('docs/guide/mcp.md has no instructions section')
  return markdown.slice(start + INSTRUCTIONS_START.length, end).trim()
}

/** Verbs that start the snake_case name of a tool or of a plausible future one (`<verb>_<object>`). */
const TOOL_VERBS = [
  'list',
  'get',
  'create',
  'read',
  'write',
  'update',
  'delete',
  'remove',
  'add',
  'set',
  'publish',
  'test',
  'start',
  'stop',
  'pause',
  'resume',
  'scale',
  'cancel',
  'retry',
  'restart',
  'run',
  'query',
  'aggregate',
  'export',
  'import',
  'upload',
  'download',
  'pull',
  'push',
  'rotate',
  'revoke',
  'validate',
  'estimate',
]

/**
 * MCP tool names mentioned in markdown: a snake_case `<verb>_<object>` identifier that is not a member access
 * (`ctx.get_x`) and stands right before a closing backtick or a `{` of arguments, as in `` `get_scan` `` and
 * `start_scan {"revision": …}`. Python code such as `retry_after = …` or `.get_secret_value()` is not a mention.
 */
export function toolMentions(markdown: string): string[] {
  const found = new Set<string>()
  for (const match of markdown.matchAll(/(?<![\w.$-])([a-z]+(?:_[a-z]+)+)(?=`|\s*\{)/g)) {
    const name = match[1]!
    if (TOOL_VERBS.includes(name.split('_')[0]!)) found.add(name)
  }
  return [...found].sort()
}

export interface CliCommand {
  /** the words after `scantor`, for example `scans worker logs` */
  path: string
  /** false for a pure command group (no synopsis: it only lists its subcommands) */
  runnable: boolean
}

/** The command tree of the generated CLI reference (`## scantor …` sections; a synopsis marks a runnable command). */
export function cliCommands(): Map<string, CliCommand> {
  const commands = new Map<string, CliCommand>()
  let current: CliCommand | undefined
  for (const line of repoFile('docs/guide/cli.md').split('\n')) {
    const heading = /^## scantor(?: (.+))?$/.exec(line)
    if (heading) {
      current = { path: heading[1]?.trim() ?? '', runnable: false }
      commands.set(current.path, current)
    } else if (current && line.trim() === '### Synopsis') {
      current.runnable = true
    }
  }
  return commands
}

/** A `scantor …` invocation found in markdown: the words after `scantor` up to the first flag or placeholder. */
export interface CliMention {
  file: string
  words: string[]
  text: string
}

const COMMAND_WORD = /^[a-z][a-z0-9-]*$/

function invocation(file: string, rest: string, text: string): CliMention {
  const words: string[] = []
  for (const token of rest.trim().split(/\s+/)) {
    if (!COMMAND_WORD.test(token)) break
    words.push(token)
  }
  return { file, words, text: text.trim() }
}

/**
 * `scantor` invocations in markdown: inline code spans that start with `scantor `, and lines of fenced code blocks
 * where `scantor ` stands at a command position (line start after an optional `$ ` prompt, or after `&&`, `||`, `|`,
 * `;` or `$(`). Prose ("scantor runs …"), `import scantor`, `scantor.yaml` and `alias scantor=` are not invocations.
 */
export function cliMentions(file: string, markdown: string): CliMention[] {
  const mentions: CliMention[] = []
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]!
      else if (line.trim().startsWith(fence)) fence = null
      continue
    }
    if (fence !== null) {
      for (const match of line.matchAll(/(?:^\s*(?:\$\s+)?|&&\s*|\|\|\s*|\|\s*|;\s*|\$\(\s*)scantor ([^\n|;&)]*)/g)) {
        mentions.push(invocation(file, match[1]!, line))
      }
      continue
    }
    for (const match of line.matchAll(/`scantor ([^`]*)`/g)) mentions.push(invocation(file, match[1]!, match[0]))
  }
  return mentions
}

/** Why a mention names no existing command, or null when it does. */
export function unknownCommand(mention: CliMention, commands: Map<string, CliCommand>): string | null {
  const path: string[] = []
  for (const word of mention.words) {
    if (!commands.has([...path, word].join(' '))) break
    path.push(word)
  }
  if (mention.words.length === 0) return null
  if (path.length === 0) return `no command "scantor ${mention.words[0]}"`
  const command = commands.get(path.join(' '))!
  const next = mention.words[path.length]
  if (next !== undefined && !command.runnable) return `no subcommand "${next}" of "scantor ${command.path}"`
  return null
}

/** A `<!-- scantor:include <path> -->` block: the included path and the body of its fenced code block. */
export interface IncludeBlock {
  file: string
  line: number
  path: string
  body: string
}

/** The include blocks of a guide; throws on a block without its end marker or fence. */
export function includeBlocks(file: string, markdown: string): IncludeBlock[] {
  const lines = markdown.split('\n')
  const blocks: IncludeBlock[] = []
  for (let i = 0; i < lines.length; i++) {
    const start = /^<!-- scantor:include (\S+) -->$/.exec(lines[i]!)
    if (!start) continue
    const end = lines.indexOf('<!-- scantor:include:end -->', i + 1)
    if (end < 0) throw new Error(`${file}:${i + 1}: include of ${start[1]} has no end marker`)
    const fence = /^(`{3,})/.exec(lines[i + 1] ?? '')?.[1]
    if (!fence || lines[end - 1] !== fence) throw new Error(`${file}:${i + 1}: include of ${start[1]} is not one fenced code block`)
    blocks.push({ file, line: i + 1, path: start[1]!, body: `${lines.slice(i + 2, end - 1).join('\n')}\n` })
    i = end
  }
  return blocks
}
