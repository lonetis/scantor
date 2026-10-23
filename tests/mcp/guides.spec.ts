import { ProtocolError, type Client } from '@modelcontextprotocol/client'
import { connectMcpWithKey } from '../helpers/mcp'
import { createTemporaryKey, type TemporaryKey } from '../helpers/mcp-accounts'
import { GUIDE_NAMES, instructionsSection, languages, repoFile, toolMentions } from '../helpers/mcp-docs'
import { withMcpTenants } from '../helpers/mcp-tenant'
import { callTool } from '../helpers/mcp-tools'
import { expect, test as base, unique } from '../fixtures'

// The agent-facing documentation served over MCP (docs/mcp.md §6): the server instructions (the marked section of
// docs/guide/mcp.md, at most 8 KiB), the guide resources and the get_authoring_guide tool. The served text is
// compared with the repository checkout the stack was built from.

const test = withMcpTenants(base)

const MARKDOWN = 'text/markdown'

/** The text of a resource, which must be one markdown content block. */
async function readMarkdown(client: Client, uri: string): Promise<string> {
  const { contents } = await client.readResource({ uri })
  expect(contents, uri).toHaveLength(1)
  const [content] = contents as { uri: string; mimeType?: string; text?: string }[]
  expect(content!.uri, uri).toBe(uri)
  expect(content!.mimeType, uri).toBe(MARKDOWN)
  expect(typeof content!.text, uri).toBe('string')
  return content!.text!
}

test.describe('MCP instructions and guides', () => {
  test(
    'the instructions are the marked section of the MCP guide, at most 8 KiB, and name only existing tools',
    { tag: ['@MCP-016'] },
    async ({ adminApi, mcpKey }) => {
      const instructions = mcpKey.getInstructions()
      expect(instructions, 'initialize carries instructions').toBeTruthy()
      expect(Buffer.byteLength(instructions!, 'utf8')).toBeLessThanOrEqual(8 * 1024)
      expect(instructions).toBe(instructionsSection())

      // The instructions name tools of every level, list_nodes included: compare with an admin key's catalogue.
      const adminKey: TemporaryKey = await createTemporaryKey(adminApi, unique('mcp-guides'))
      try {
        const client = await connectMcpWithKey(adminKey.key)
        try {
          const tools = (await client.listTools()).tools.map((tool) => tool.name)
          const named = toolMentions(instructions!)
          expect(named).toEqual(expect.arrayContaining(['create_task', 'test_task', 'publish_revision', 'start_scan', 'get_scan', 'export_scan']))
          expect(
            named.filter((name) => !tools.includes(name)),
            'tools named by the instructions that do not exist',
          ).toEqual([])
        } finally {
          await client.close()
        }
      } finally {
        await adminKey.dispose()
      }
    },
  )

  test(
    'the guide resources list and serve the instructions, every authoring guide and every named guide as markdown',
    { tag: ['@MCP-016'] },
    async ({ mcpKey }) => {
      const { resources } = await mcpKey.listResources()
      const expected = [
        'scantor://guide',
        ...languages().map((language) => `scantor://guide/authoring/${language}`),
        ...GUIDE_NAMES.map((name) => `scantor://guide/${name}`),
      ]
      expect(resources.map((resource) => resource.uri).sort()).toEqual([...expected].sort())
      for (const resource of resources) expect(resource.mimeType, resource.uri).toBe(MARKDOWN)

      const { resourceTemplates } = await mcpKey.listResourceTemplates()
      expect(resourceTemplates.map((template) => template.uriTemplate).sort()).toEqual(['scantor://guide/authoring/{language}', 'scantor://guide/{name}'])

      expect(await readMarkdown(mcpKey, 'scantor://guide')).toBe(mcpKey.getInstructions())
      for (const language of languages()) {
        expect(await readMarkdown(mcpKey, `scantor://guide/authoring/${language}`), language).toBe(repoFile(`docs/guide/authoring-${language}.md`))
      }
      for (const name of GUIDE_NAMES) {
        expect(await readMarkdown(mcpKey, `scantor://guide/${name}`), name).toBe(repoFile(`docs/guide/${name}.md`))
      }

      // A guide that does not exist is a protocol error, not an empty document.
      const missing = await mcpKey.readResource({ uri: 'scantor://guide/authoring/cobol' }).then(
        (result) => new Error(`read returned ${JSON.stringify(result).slice(0, 300)}`),
        (error: unknown) => error,
      )
      expect(missing).toBeInstanceOf(ProtocolError)
    },
  )

  test('get_authoring_guide returns the authoring guide of every language', { tag: ['@MCP-016'] }, async ({ mcpKey }) => {
    for (const language of languages()) {
      const call = await callTool(mcpKey, 'get_authoring_guide', { language })
      expect(call.result.isError, `${language}: ${call.texts.join('\n').slice(0, 300)}`).toBeFalsy()
      expect(call.texts, language).toHaveLength(1)
      expect(call.texts[0], language).toBe(repoFile(`docs/guide/authoring-${language}.md`))
    }
  })
})
