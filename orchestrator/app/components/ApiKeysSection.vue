<script setup lang="ts">
import type { FormSubmitEvent, TableColumn } from '@nuxt/ui'
import type { z } from 'zod'
import { API_KEY_DEFAULT_EXPIRES_IN_DAYS, createApiKeyBody } from '#shared/schemas/account'
import type { SecretSnippet } from '~/components/SecretRevealModal.vue'

// API keys for the CLI, scripts and MCP clients (docs/ui.md §5.18, docs/auth.md §8.2). A new key is shown once
// with ready-to-paste snippets; editor keys are listed read-only.
const { keys, defaultKeys, editorKeys, loading, error, load, createKey, deleteKey } = useApiKeys()
const { info, isReleaseVersion } = useInstance()

defineExpose({ load })
onMounted(() => {
  void load()
})

const table = useTemplateRef('table')
useTableRowIds(table, (key: ApiKey) => key.id)

const createOpen = ref(false)
const createState = reactive<{ name: string, expiresInDays: number }>({ name: '', expiresInDays: API_KEY_DEFAULT_EXPIRES_IN_DAYS })
const createError = ref<string | null>(null)
const creating = ref(false)
const revealed = ref<{ key: string, name: string } | null>(null)
const revealOpen = ref(false)
const deleteArmedId = ref<string | null>(null)

const publicUrl = computed(() => info.value?.publicUrl ?? window.location.origin)

// Release assets (docs/development.md §14), linked only for release versions: dev builds have no release.
const RELEASE_REPOSITORY = 'https://github.com/lonetis/scantor'
const RELEASE_BINARIES = [
  { asset: 'scantor-darwin-arm64', platform: 'macOS, Apple silicon' },
  { asset: 'scantor-darwin-amd64', platform: 'macOS, Intel' },
  { asset: 'scantor-linux-amd64', platform: 'Linux, x86-64' },
  { asset: 'scantor-linux-arm64', platform: 'Linux, ARM64' },
] as const
const releaseVersion = computed(() => (isReleaseVersion.value && info.value ? info.value.version : null))
const releasePageUrl = computed(() => (releaseVersion.value ? `${RELEASE_REPOSITORY}/releases/tag/v${releaseVersion.value}` : null))

function releaseAssetUrl(asset: string): string {
  return `${RELEASE_REPOSITORY}/releases/download/v${releaseVersion.value}/${asset}`
}

function snippetsFor(key: string): SecretSnippet[] {
  const snippets: SecretSnippet[] = [
    { title: 'Environment', code: `export SCANTOR_URL=${publicUrl.value}\nexport SCANTOR_TOKEN=${key}` },
  ]
  if (info.value?.cliImage) {
    snippets.push({
      title: 'Docker alias',
      code: `alias scantor='docker run --rm -i -v "$PWD:$PWD" -w "$PWD" -v /var/run/docker.sock:/var/run/docker.sock -e SCANTOR_URL -e SCANTOR_TOKEN --add-host host.docker.internal:host-gateway ${info.value.cliImage}'`,
    })
  }
  if (info.value?.mcpUrl) {
    snippets.push({
      title: 'MCP with this key',
      code: `claude mcp add --transport http scantor ${info.value.mcpUrl} --header "Authorization: Bearer ${key}"`,
    })
  }
  return snippets
}

function openCreate(): void {
  createState.name = ''
  createState.expiresInDays = API_KEY_DEFAULT_EXPIRES_IN_DAYS
  createError.value = null
  createOpen.value = true
}

async function submitCreate(event: FormSubmitEvent<z.output<typeof createApiKeyBody>>): Promise<void> {
  creating.value = true
  createError.value = null
  try {
    const created = await createKey(event.data)
    createOpen.value = false
    revealed.value = { key: created.key, name: created.apiKey.name ?? event.data.name }
    revealOpen.value = true
  } catch (cause) {
    createError.value = errorMessage(cause)
  } finally {
    creating.value = false
  }
}

async function onDelete(key: ApiKey): Promise<void> {
  if (deleteArmedId.value !== key.id) {
    deleteArmedId.value = key.id
    return
  }
  deleteArmedId.value = null
  await deleteKey(key.id).catch((cause: unknown) => console.error('[api-keys] delete failed', cause))
}

function keyName(key: ApiKey): string {
  return key.name || key.start || shortId(key.id)
}

const columns: TableColumn<ApiKey>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'start', header: 'Prefix' },
  { accessorKey: 'createdAt', header: 'Created' },
  { accessorKey: 'expiresAt', header: 'Expires' },
  { accessorKey: 'lastRequest', header: 'Last used' },
  { accessorKey: 'enabled', header: 'Enabled' },
  { id: 'actions', header: '', meta: { class: { td: 'text-end' } } },
]
</script>

<template>
  <section class="space-y-4 rounded-lg border border-default p-4" aria-labelledby="api-keys-heading">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 id="api-keys-heading" class="text-sm font-semibold text-highlighted">API keys</h2>
        <p class="text-xs text-muted">For the scantor CLI, scripts and MCP clients. Send a key as <code class="font-mono">Authorization: Bearer</code>.</p>
      </div>
      <UButton label="Create key" icon="i-lucide-plus" size="sm" @click="openCreate" />
    </div>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :description="error.message" />

    <UTable
      ref="table"
      :data="defaultKeys"
      :columns="columns"
      :loading="loading"
      aria-label="API keys"
      empty="No API keys yet."
      class="rounded-md border border-default"
      :ui="{ td: 'py-2 text-sm', th: 'py-2 text-xs' }"
    >
      <template #name-cell="{ row }">
        <span class="font-medium">{{ row.original.name || '–' }}</span>
      </template>
      <template #start-cell="{ row }">
        <code class="font-mono text-xs text-muted">{{ row.original.start ? `${row.original.start}…` : '–' }}</code>
      </template>
      <template #createdAt-cell="{ row }"><RelativeTime :value="row.original.createdAt" /></template>
      <template #expiresAt-cell="{ row }">
        <RelativeTime v-if="row.original.expiresAt" :value="row.original.expiresAt" />
        <span v-else class="text-dimmed">never</span>
      </template>
      <template #lastRequest-cell="{ row }">
        <RelativeTime v-if="row.original.lastRequest" :value="row.original.lastRequest" />
        <span v-else class="text-dimmed">never</span>
      </template>
      <template #enabled-cell="{ row }">
        <UBadge :label="row.original.enabled ? 'enabled' : 'disabled'" :color="row.original.enabled ? 'success' : 'neutral'" variant="subtle" size="xs" />
      </template>
      <template #actions-cell="{ row }">
        <div class="flex justify-end gap-1">
          <UButton
            v-if="deleteArmedId === row.original.id"
            label="Cancel"
            size="xs"
            color="neutral"
            variant="ghost"
            :aria-label="`Keep key ${keyName(row.original)}`"
            @click="deleteArmedId = null"
          />
          <UButton
            :label="deleteArmedId === row.original.id ? 'Confirm delete' : 'Delete'"
            size="xs"
            color="error"
            :variant="deleteArmedId === row.original.id ? 'solid' : 'ghost'"
            :aria-label="`${deleteArmedId === row.original.id ? 'Confirm delete' : 'Delete'} key ${keyName(row.original)}`"
            @click="onDelete(row.original)"
          />
        </div>
      </template>
    </UTable>

    <div v-if="editorKeys.length > 0" class="space-y-1">
      <p class="section-label">Managed by the editor</p>
      <ul class="space-y-1">
        <li v-for="key in editorKeys" :key="key.id" class="flex flex-wrap items-center gap-3 rounded-md border border-default px-3 py-2 text-xs" :data-row-id="key.id">
          <code class="font-mono text-muted">{{ key.start ? `${key.start}…` : key.id }}</code>
          <span class="text-muted">created <RelativeTime :value="key.createdAt" /></span>
          <span v-if="key.expiresAt" class="text-muted">expires <RelativeTime :value="key.expiresAt" /></span>
          <span class="text-dimmed">rotated automatically by the editor; stop the editor to revoke it</span>
        </li>
      </ul>
    </div>

    <div class="space-y-1 text-xs text-muted">
      <p>
        Run the CLI with the Docker shim <code class="font-mono">scantor.sh</code> or a native binary<template v-if="releasePageUrl">
          of release <a :href="releasePageUrl" class="text-primary hover:underline" rel="noopener noreferrer" target="_blank">v{{ releaseVersion }}</a></template>.
        <template v-if="keys.length === 0 && !loading"> Create a key to get started.</template>
      </p>
      <ul v-if="releaseVersion" class="flex flex-wrap gap-x-4 gap-y-1" aria-label="CLI downloads">
        <li>
          <a :href="releaseAssetUrl('scantor.sh')" class="font-mono text-primary hover:underline" rel="noopener noreferrer">scantor.sh</a>
          <span class="text-dimmed"> (Docker shim)</span>
        </li>
        <li v-for="binary in RELEASE_BINARIES" :key="binary.asset">
          <a :href="releaseAssetUrl(binary.asset)" class="font-mono text-primary hover:underline" rel="noopener noreferrer">{{ binary.asset }}</a>
          <span class="text-dimmed"> ({{ binary.platform }})</span>
        </li>
        <li>
          <a :href="releaseAssetUrl('SHA256SUMS')" class="font-mono text-primary hover:underline" rel="noopener noreferrer">SHA256SUMS</a>
        </li>
      </ul>
    </div>

    <UModal v-model:open="createOpen" title="Create API key" description="The key is shown once after creation." :ui="{ content: 'sm:max-w-md' }">
      <template #body>
        <UForm id="create-api-key-form" :schema="createApiKeyBody" :state="createState" class="space-y-3" @submit="submitCreate">
          <UFormField label="Name" name="name" required hint="1–32 characters">
            <UInput v-model="createState.name" maxlength="32" placeholder="laptop CLI" class="w-full" autofocus />
          </UFormField>
          <UFormField label="Expires in (days)" name="expiresInDays" required hint="1–365">
            <UInputNumber v-model="createState.expiresInDays" :min="1" :max="365" class="w-40" />
          </UFormField>
          <p v-if="createError" class="text-xs text-error" role="alert">{{ createError }}</p>
        </UForm>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton label="Cancel" color="neutral" variant="ghost" @click="createOpen = false" />
          <UButton type="submit" form="create-api-key-form" label="Create API key" :loading="creating" />
        </div>
      </template>
    </UModal>

    <SecretRevealModal
      v-if="revealed"
      v-model:open="revealOpen"
      :title="`API key ${revealed.name}`"
      :secret="revealed.key"
      secret-label="API key"
      warning="This key is shown only now. Anyone with it can act as you; store it in a password manager or your shell profile."
      :snippets="snippetsFor(revealed.key)"
      @close="revealed = null"
    />
  </section>
</template>
