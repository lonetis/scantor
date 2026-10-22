<script setup lang="ts">
import type { GitCredential } from '#shared/types/credentials'

// Git credentials (docs/ui.md §5.19): HTTPS tokens for git import and pull, sent only to their exact host; tokens
// are write-only.
useHead({ title: 'Git credentials · scantor' })

const toast = useToast()
const store = useCredentials()
const formOpen = ref(false)
const editing = shallowRef<GitCredential | null>(null)

function openForm(credential: GitCredential | null): void {
  editing.value = credential
  formOpen.value = true
}

function onSaved(credential: GitCredential): void {
  toast.add({ title: `Credential ${credential.name} saved`, color: 'success', icon: 'i-lucide-check' })
}

async function remove(credential: GitCredential): Promise<void> {
  try {
    await store.deleteCredential(credential.id)
    toast.add({ title: `Credential ${credential.name} deleted`, color: 'success', icon: 'i-lucide-trash-2' })
  } catch (cause) {
    console.error('[credentials] delete failed', cause)
  }
}
</script>

<template>
  <UDashboardPanel id="account-credentials">
    <template #header>
      <UDashboardNavbar title="Git credentials">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <RefreshButton :loading="store.loading.value" @click="store.load()" />
          <UButton label="New credential" icon="i-lucide-plus" size="sm" @click="openForm(null)" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <p class="mb-4 max-w-3xl text-sm text-muted">
        Credentials let you import and pull tasks from private git repositories. A token is sent as Basic auth only to the exact
        host it was saved for and is never shown again after saving.
      </p>
      <UAlert
        v-if="store.error.value"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        title="Credentials could not be loaded"
        :description="errorMessage(store.error.value)"
      />
      <CredentialsTable :credentials="store.credentials.value" :loading="store.loading.value && !store.loaded.value" @edit="openForm" @delete="remove" />
      <CredentialFormModal v-model:open="formOpen" :credential="editing" :actions="store" @saved="onSaved" />
    </template>
  </UDashboardPanel>
</template>
