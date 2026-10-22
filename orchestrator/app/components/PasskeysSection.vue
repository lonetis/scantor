<script setup lang="ts">
// Passkeys (docs/ui.md §5.17): list, rename, remove (two-step; never the last credential) and add.
// Hidden when the instance has passkeys disabled.

// The better-auth client revives ISO timestamps into Date objects.
interface PasskeyRow {
  id: string
  name?: string | null
  createdAt: string | Date
  deviceType?: string
  backedUp?: boolean
}

const { client } = useAuth()
const { account, load: loadAccount } = useCurrentUser()

const passkeys = ref<PasskeyRow[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const success = ref<string | null>(null)
const newName = ref('')
const adding = ref(false)
const renamingId = ref<string | null>(null)
const renameValue = ref('')
const removeArmedId = ref<string | null>(null)

const isLastCredential = computed(() => passkeys.value.length <= 1 && account.value?.credentials.hasPassword === false)

function failureMessage(failure: { status?: number, message?: string, code?: string } | null | undefined, fallback: string): string {
  if (!failure) return fallback
  if (failure.status === 409) return 'This is your last way to sign in; add a password or another passkey first.'
  if (failure.status === 429) return 'Too many attempts, try again in a minute'
  return failure.message || fallback
}

async function load(): Promise<void> {
  loading.value = true
  const result = await client.$fetch<PasskeyRow[]>('/passkey/list-user-passkeys', { method: 'GET' })
  loading.value = false
  if (result.error) {
    error.value = failureMessage(result.error, 'Passkeys could not be loaded.')
    return
  }
  passkeys.value = result.data ?? []
}

defineExpose({ load })
onMounted(() => {
  void load()
})

function displayName(passkey: PasskeyRow): string {
  return passkey.name?.trim() || 'Unnamed passkey'
}

async function addPasskey(): Promise<void> {
  adding.value = true
  error.value = null
  success.value = null
  const result = await client.passkey.addPasskey({ name: newName.value.trim() || undefined })
  adding.value = false
  if (result?.error) {
    error.value = failureMessage(result.error, 'The passkey could not be added.')
    return
  }
  newName.value = ''
  success.value = 'Passkey added'
  await Promise.allSettled([load(), loadAccount(true)])
}

function startRename(passkey: PasskeyRow): void {
  renamingId.value = passkey.id
  renameValue.value = passkey.name ?? ''
}

async function saveRename(passkey: PasskeyRow): Promise<void> {
  const name = renameValue.value.trim()
  if (!name) return
  const result = await client.$fetch('/passkey/update-passkey', { method: 'POST', body: { id: passkey.id, name } })
  if (result.error) {
    error.value = failureMessage(result.error, 'The passkey could not be renamed.')
    return
  }
  renamingId.value = null
  await load()
}

async function removePasskey(passkey: PasskeyRow): Promise<void> {
  if (removeArmedId.value !== passkey.id) {
    removeArmedId.value = passkey.id
    return
  }
  removeArmedId.value = null
  error.value = null
  success.value = null
  const result = await client.$fetch('/passkey/delete-passkey', { method: 'POST', body: { id: passkey.id } })
  if (result.error) {
    error.value = failureMessage(result.error, 'The passkey could not be removed.')
    return
  }
  success.value = 'Passkey removed'
  await Promise.allSettled([load(), loadAccount(true)])
}
</script>

<template>
  <section class="space-y-4 rounded-lg border border-default p-4" aria-labelledby="passkeys-heading">
    <h2 id="passkeys-heading" class="text-sm font-semibold text-highlighted">Passkeys</h2>

    <ul class="space-y-2" aria-label="Your passkeys">
      <li
        v-for="passkey in passkeys"
        :key="passkey.id"
        class="flex flex-wrap items-center gap-2 rounded-md border border-default px-3 py-2"
        :data-row-id="passkey.id"
      >
        <UIcon name="i-lucide-key-round" class="size-4 text-muted" aria-hidden="true" />
        <template v-if="renamingId === passkey.id">
          <UInput v-model="renameValue" size="sm" class="w-56" :aria-label="`New name for ${displayName(passkey)}`" @keydown.enter.prevent="saveRename(passkey)" />
          <UButton label="Save" size="xs" :aria-label="`Save name of ${displayName(passkey)}`" @click="saveRename(passkey)" />
          <UButton label="Cancel" size="xs" color="neutral" variant="ghost" :aria-label="`Cancel renaming ${displayName(passkey)}`" @click="renamingId = null" />
        </template>
        <template v-else>
          <span class="text-sm font-medium">{{ displayName(passkey) }}</span>
          <span class="text-xs text-muted">added <RelativeTime :value="passkey.createdAt" /></span>
          <UBadge v-if="passkey.deviceType" :label="passkey.deviceType === 'multiDevice' ? 'synced' : 'device-bound'" color="neutral" variant="subtle" size="xs" />
        </template>
        <div class="ms-auto flex items-center gap-1">
          <UButton
            v-if="renamingId !== passkey.id"
            label="Rename"
            size="xs"
            color="neutral"
            variant="ghost"
            :aria-label="`Rename passkey ${displayName(passkey)}`"
            @click="startRename(passkey)"
          />
          <UButton
            :label="removeArmedId === passkey.id ? 'Confirm remove' : 'Remove'"
            size="xs"
            color="error"
            :variant="removeArmedId === passkey.id ? 'solid' : 'ghost'"
            :aria-label="`${removeArmedId === passkey.id ? 'Confirm remove' : 'Remove'} passkey ${displayName(passkey)}`"
            :disabled="isLastCredential"
            :title="isLastCredential ? 'Your last way to sign in cannot be removed' : undefined"
            @click="removePasskey(passkey)"
          />
          <UButton
            v-if="removeArmedId === passkey.id"
            label="Cancel"
            size="xs"
            color="neutral"
            variant="ghost"
            :aria-label="`Keep passkey ${displayName(passkey)}`"
            @click="removeArmedId = null"
          />
        </div>
      </li>
      <li v-if="!loading && passkeys.length === 0" class="text-xs text-dimmed">No passkeys yet.</li>
    </ul>

    <form class="flex flex-wrap items-end gap-2" @submit.prevent="addPasskey">
      <UFormField label="New passkey name" name="passkeyName" class="w-64">
        <UInput v-model="newName" placeholder="e.g. MacBook Touch ID" maxlength="64" class="w-full" />
      </UFormField>
      <UButton type="submit" label="Add passkey" icon="i-lucide-plus" size="sm" :loading="adding" />
    </form>

    <p v-if="error" class="text-xs text-error" role="alert">{{ error }}</p>
    <p v-if="success" class="text-xs text-success" role="status">{{ success }}</p>
  </section>
</template>
