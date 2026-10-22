<script setup lang="ts">
import { z } from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'
import { updateAccountBody } from '#shared/schemas/account'

// Profile (docs/ui.md §5.17): name via updateAccount, email via better-auth changeEmail; role and limits are
// read-only.
const { account, load, set } = useCurrentUser()
const { client } = useAuth()
const api = useApi()

const nameState = reactive({ name: '' })
const nameError = ref<string | null>(null)
const nameSaved = ref(false)

const emailSchema = z.object({ newEmail: z.email('Enter a valid email address').max(254) })
const emailState = reactive({ newEmail: '' })
const emailError = ref<string | null>(null)
const emailSaved = ref(false)

watch(account, (value) => {
  if (!value) return
  nameState.name = value.name
  emailState.newEmail = value.email
}, { immediate: true })

async function saveName(event: FormSubmitEvent<z.output<typeof updateAccountBody>>): Promise<void> {
  nameError.value = null
  nameSaved.value = false
  try {
    set(await api<Account>('/api/account', { method: 'PATCH', body: event.data, toast: false }))
    nameSaved.value = true
  } catch (error) {
    nameError.value = errorMessage(error)
  }
}

async function saveEmail(event: FormSubmitEvent<z.output<typeof emailSchema>>): Promise<void> {
  emailError.value = null
  emailSaved.value = false
  const result = await client.changeEmail({ newEmail: event.data.newEmail })
  if (result.error) {
    emailError.value = result.error.message || 'The email address could not be changed.'
    return
  }
  emailSaved.value = true
  await load(true).catch((error: unknown) => console.error('[account] reloading the account failed', error))
}
</script>

<template>
  <section class="space-y-4 rounded-lg border border-default p-4" aria-labelledby="profile-heading">
    <h2 id="profile-heading" class="text-sm font-semibold text-highlighted">Profile</h2>

    <div v-if="account" class="grid gap-6 lg:grid-cols-2">
      <UForm :schema="updateAccountBody" :state="nameState" class="space-y-2" @submit="saveName">
        <UFormField label="Name" name="name" required>
          <UInput v-model="nameState.name" autocomplete="name" class="w-full" />
        </UFormField>
        <div class="flex items-center gap-2">
          <UButton type="submit" label="Save name" size="sm" />
          <span v-if="nameSaved" class="text-xs text-success" role="status">Saved</span>
        </div>
        <p v-if="nameError" class="text-xs text-error" role="alert">{{ nameError }}</p>
      </UForm>

      <UForm :schema="emailSchema" :state="emailState" class="space-y-2" @submit="saveEmail">
        <UFormField label="Email" name="newEmail" required>
          <UInput v-model="emailState.newEmail" type="email" autocomplete="email" class="w-full" />
        </UFormField>
        <div class="flex items-center gap-2">
          <UButton type="submit" label="Change email" size="sm" color="neutral" variant="outline" :disabled="emailState.newEmail === account.email" />
          <span v-if="emailSaved" class="text-xs text-success" role="status">Email changed</span>
        </div>
        <p v-if="emailError" class="text-xs text-error" role="alert">{{ emailError }}</p>
      </UForm>
    </div>

    <dl v-if="account" class="facts-grid text-sm">
      <dt>Role</dt>
      <dd><UBadge :label="account.role" :color="account.role === 'admin' ? 'warning' : 'neutral'" variant="subtle" size="xs" /></dd>
      <dt>Privileged tasks</dt>
      <dd>{{ account.canRunPrivileged ? 'allowed' : 'not allowed' }}</dd>
      <dt>Worker limit</dt>
      <dd>{{ account.maxWorkers === 0 ? 'unlimited' : formatCount(account.maxWorkers) }}</dd>
      <dt>Member since</dt>
      <dd><RelativeTime :value="account.createdAt" /></dd>
    </dl>
    <p v-else class="text-xs text-dimmed">Loading…</p>
  </section>
</template>
