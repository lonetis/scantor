<script setup lang="ts">
// MCP access (docs/ui.md §5.18, docs/mcp.md §3.8): the endpoint, the OAuth setup command and a generic client
// snippet; without OAuth (plain-http public URL) only the API-key form.
const { info } = useInstance()

const mcpUrl = computed(() => info.value?.mcpUrl ?? null)
const oauth = computed(() => info.value?.features.mcpOAuth ?? false)
const oauthCommand = computed(() => `claude mcp add --transport http scantor ${mcpUrl.value}`)
const apiKeyCommand = computed(() => `claude mcp add --transport http scantor ${mcpUrl.value} --header "Authorization: Bearer $SCANTOR_TOKEN"`)
const clientSnippet = computed(() => JSON.stringify({ mcpServers: { scantor: { type: 'http', url: mcpUrl.value } } }, null, 2))
</script>

<template>
  <section class="space-y-4 rounded-lg border border-default p-4" aria-labelledby="mcp-heading">
    <div>
      <h2 id="mcp-heading" class="text-sm font-semibold text-highlighted">MCP</h2>
      <p class="text-xs text-muted">Connect LLM agents to scantor through the Model Context Protocol.</p>
    </div>

    <p v-if="!info" class="text-xs text-dimmed">Loading…</p>
    <UAlert
      v-else-if="!mcpUrl"
      color="neutral"
      variant="subtle"
      icon="i-lucide-info"
      description="MCP is disabled on this instance."
    />
    <template v-else>
      <div class="space-y-1">
        <p class="section-label">Endpoint</p>
        <div class="flex items-center gap-1">
          <code class="code-surface block min-w-0 flex-1 overflow-x-auto rounded-md px-3 py-1.5 whitespace-nowrap" data-testid="mcp-url">{{ mcpUrl }}</code>
          <CopyButton :value="mcpUrl" label="Copy MCP URL" size="sm" />
        </div>
      </div>

      <template v-if="oauth">
        <div class="space-y-1">
          <p class="section-label">Claude Code (OAuth)</p>
          <CodeBlock :code="oauthCommand" copy-label="Copy OAuth MCP command" label="Claude Code OAuth command" wrap />
        </div>
        <div class="space-y-1">
          <p class="section-label">Other MCP clients</p>
          <CodeBlock :code="clientSnippet" copy-label="Copy MCP client configuration" label="MCP client configuration" />
        </div>
        <p class="text-xs text-muted">You choose the access level (read only, read and write, or admin) on the consent screen when the client connects.</p>
      </template>

      <div class="space-y-1">
        <p class="section-label">With an API key</p>
        <CodeBlock :code="apiKeyCommand" copy-label="Copy API key MCP command" label="MCP command with an API key" wrap />
        <p v-if="!oauth" class="text-xs text-muted">OAuth for MCP clients needs an https public URL; use an API key instead.</p>
      </div>
    </template>
  </section>
</template>
