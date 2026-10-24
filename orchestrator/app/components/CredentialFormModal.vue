<script setup lang="ts">
import type { FormSubmitEvent } from '@nuxt/ui'
import { z } from 'zod'
import { CREDENTIAL_NAME_MAX, CREDENTIAL_TOKEN_MAX, CREDENTIAL_USERNAME_MAX, credentialHost } from '#shared/schemas/tasks'
import type { CreateCredentialBody, UpdateCredentialBody } from '#shared/schemas/tasks'
import type { GitCredential } from '#shared/types/credentials'

// Create or edit a git credential (docs/ui.md §5.19): kind gitToken, name, host[:port], username (default
// x-access-token) and the token as a password input; when editing, an empty token keeps the stored one. Tokens are
// never shown again.
const props = defineProps<{
  credential: GitCredential | null
  actions: {
    createCredential: (body: CreateCredentialBody) => Promise<GitCredential>
    updateCredential: (credentialId: string, body: UpdateCredentialBody) => Promise<GitCredential>
  }
}>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [credential: GitCredential] }>()

const editing = computed(() => props.credential !== null)
const schema = computed(() =>
  z.object({
    name: z.string().trim().min(1).max(CREDENTIAL_NAME_MAX),
    host: credentialHost(),
    username: z.string().trim().min(1).max(CREDENTIAL_USERNAME_MAX),
    token: editing.value ? z.string().max(CREDENTIAL_TOKEN_MAX) : z.string().min(1, 'required').max(CREDENTIAL_TOKEN_MAX),
  }),
)
const state = reactive({ name: '', host: '', username: 'x-access-token', token: '' })
const saving = ref(false)
const error = ref<string | null>(null)
const showToken = ref(false)

watch(open, (value) => {
  if (!value) return
  error.value = null
  showToken.value = false
  Object.assign(state, {
    name: props.credential?.name ?? '',
    host: props.credential?.host ?? '',
    username: props.credential?.username ?? 'x-access-token',
    token: '',
  })
}, { immediate: true })

async function submit(event: FormSubmitEvent<{ name: string; host: string; username: string; token: string }>): Promise<void> {
  saving.value = true
  error.value = null
  try {
    const form = event.data
    let saved: GitCredential
    if (props.credential) {
      const changes: UpdateCredentialBody = {}
      if (form.name !== props.credential.name) changes.name = form.name
      if (form.host !== props.credential.host) changes.host = form.host
      if (form.username !== props.credential.username) changes.username = form.username
      if (form.token) changes.token = form.token
      if (Object.keys(changes).length === 0) {
        open.value = false
        return
      }
      saved = await props.actions.updateCredential(props.credential.id, changes)
    } else {
      saved = await props.actions.createCredential({ kind: 'gitToken', name: form.name, host: form.host, username: form.username, token: form.token })
    }
    open.value = false
    emit('saved', saved)
  } catch (cause) {
    const apiError = toApiError(cause)
    error.value = apiError.code === 'alreadyExists' ? 'A credential with this name already exists.' : apiError.message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="editing ? `Edit ${credential?.name}` : 'New credential'" :ui="{ content: 'sm:max-w-lg' }" :content="dialogContent">
    <template #close="{ ui }">
      <CloseButton :class="ui.close()" />
    </template>
    <template #body>
      <UForm id="credential-form" :schema="schema" :state="state" class="space-y-3" @submit="submit">
        <UFormField label="Name" name="name" required>
          <UInput v-model="state.name" autocomplete="off" class="w-full" placeholder="github" />
        </UFormField>
        <UFormField label="Host" name="host" required help="host[:port] without scheme; the token is sent only to exactly this host.">
          <UInput v-model="state.host" autocomplete="off" class="w-full font-mono" placeholder="github.com" />
        </UFormField>
        <UFormField label="Username" name="username" help="Sent with the token as Basic auth; x-access-token works for GitHub and most forges.">
          <UInput v-model="state.username" autocomplete="off" class="w-full font-mono" />
        </UFormField>
        <UFormField label="Token" name="token" :required="!editing" :help="editing ? 'Leave empty to keep the stored token.' : 'Shown never again after saving.'">
          <UInput v-model="state.token" :type="showToken ? 'text' : 'password'" autocomplete="new-password" class="w-full font-mono">
            <template #trailing>
              <UTooltip text="Show value of token">
                <UButton
                  :icon="showToken ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                  size="xs"
                  color="neutral"
                  variant="link"
                  aria-label="Show value of token"
                  :aria-pressed="showToken"
                  @click="showToken = !showToken"
                />
              </UTooltip>
            </template>
          </UInput>
        </UFormField>
        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" title="The credential could not be saved" :description="error" />
      </UForm>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton type="submit" form="credential-form" :label="editing ? 'Save credential' : 'Create credential'" :loading="saving" />
      </div>
    </template>
  </UModal>
</template>
