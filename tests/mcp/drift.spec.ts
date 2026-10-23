import { connectMcpWithKey } from '../helpers/mcp'
import { createTemporaryKey } from '../helpers/mcp-accounts'
import { cliCommands, cliMentions, guideFiles, includeBlocks, repoFile, skillFiles, toolMentions, unknownCommand } from '../helpers/mcp-docs'
import { withMcpTenants } from '../helpers/mcp-tenant'
import { expect, test as base, unique } from '../fixtures'

// Drift between the agent-facing documentation and the product (docs/mcp.md §6, §8; docs/testing.md §8.4): every MCP
// tool and every `scantor` command that skills/** and docs/guide/*.md mention exists, and every guide snippet that
// claims to include a file of the repository equals that file. Tools come from tools/list of an admin key (every
// level); commands from docs/guide/cli.md, which `just docs` generates from the cobra command tree.

const test = withMcpTenants(base)

/** The agent-facing documents; cli.md is the generated reference the commands are checked against. */
function documents(): { file: string; text: string }[] {
  return [...skillFiles(), ...guideFiles().filter((file) => file !== 'docs/guide/cli.md')]
    .filter((file) => file.endsWith('.md'))
    .map((file) => ({ file, text: repoFile(file) }))
}

test.describe('MCP documentation drift', () => {
  test('every MCP tool mentioned in the skills and guides exists', { tag: ['@MCP-017'] }, async ({ adminApi }) => {
    const key = await createTemporaryKey(adminApi, unique('mcp-drift'))
    try {
      const client = await connectMcpWithKey(key.key)
      try {
        const tools = new Set((await client.listTools()).tools.map((tool) => tool.name))
        const mentioned = new Map<string, Set<string>>()
        for (const { file, text } of documents()) {
          for (const name of toolMentions(text)) (mentioned.get(name) ?? mentioned.set(name, new Set()).get(name)!).add(file)
        }
        // The parser finds the tools the MCP guide and both skills name.
        expect([...mentioned.keys()]).toEqual(expect.arrayContaining(['get_authoring_guide', 'write_task_files', 'start_scan', 'query_analyses', 'list_nodes']))
        expect([...(mentioned.get('start_scan') ?? [])]).toEqual(expect.arrayContaining(['docs/guide/mcp.md', 'skills/scantor-scans/SKILL.md']))
        const unknown = [...mentioned].filter(([name]) => !tools.has(name)).map(([name, files]) => `${name} (${[...files].join(', ')})`)
        expect(unknown, 'tools mentioned but not served').toEqual([])
      } finally {
        await client.close()
      }
    } finally {
      await key.dispose()
    }
  })

  test('every scantor command mentioned in the skills and guides exists in the CLI reference', { tag: ['@MCP-017'] }, async () => {
    const commands = cliCommands()
    expect([...commands.keys()]).toEqual(expect.arrayContaining(['', 'push', 'scans start', 'scans worker logs', 'dev run', 'uploads create']))
    const mentions = documents().flatMap(({ file, text }) => cliMentions(file, text))
    expect(mentions.filter((mention) => mention.words.join(' ') === 'dev run').length, 'the parser finds the documented dev run calls').toBeGreaterThan(0)
    const unknown = mentions
      .map((mention) => ({ mention, reason: unknownCommand(mention, commands) }))
      .filter(({ reason }) => reason !== null)
      .map(({ mention, reason }) => `${mention.file}: ${mention.text} (${reason})`)
    expect(unknown, 'commands mentioned but not in docs/guide/cli.md').toEqual([])
  })

  test('every guide snippet that includes a repository file equals that file', { tag: ['@MCP-017'] }, async () => {
    const blocks = documents().flatMap(({ file, text }) => includeBlocks(file, text))
    // Each authoring guide includes at least one example task.
    expect([...new Set(blocks.map((block) => block.file))]).toEqual(
      expect.arrayContaining([
        'docs/guide/authoring-go.md',
        'docs/guide/authoring-javascript.md',
        'docs/guide/authoring-python.md',
        'docs/guide/authoring-typescript.md',
      ]),
    )
    for (const block of blocks) {
      expect(block.path, `${block.file}:${block.line}`).toMatch(/^tasks\//)
      const content = repoFile(block.path)
      expect(block.body, `${block.file}:${block.line} includes ${block.path}`).toBe(content.endsWith('\n') ? content : `${content}\n`)
    }
  })
})
