<script setup lang="ts">
import { z } from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'
import { password } from '#shared/schemas/users'

// Password (docs/ui.md §5.17): change it (better-auth changePassword), set one when the account has only
// passkeys (setAccountPassword), or remove it while a passkey exists (removeAccountPassword, two-step).
const { account, load } = useCurrentUser()
const { client } = useAuth()
const api = useApi()

const changeSchema = z
  .object({ currentPassword: z.string().min(1, 'Enter your current password'), newPassword: password(), confirm: z.string(), revokeOtherSessions: z.boolean() })
  .refine((value) => value.newPassword === value.confirm, { message: 'The passwords do not match', path: ['confirm'] })
const setSchema = z
  .object({ newPassword: password(), confirm: z.string() })
  .refine((value) => value.newPassword === value.confirm, { message: 'The passwords do not match', path: ['confirm'] })

const changeState = reactive({ currentPassword: '', newPassword: '', confirm: '', revokeOtherSessions: true })
const setState = reactive({ newPassword: '', confirm: '' })
const error = ref<string | null>(null)
const success = ref<string | null>(null)
const removeArmed = ref(false)
const removing = ref(false)

const hasPassword = computed(() => account.value?.credentials.hasPassword ?? false)
const canRemove = computed(() => hasPassword.value && (account.value?.credentials.passkeyCount ?? 0) > 0)

function reset(): void {
  Object.assign(changeState, { currentPassword: '', newPassword: '', confirm: '' })
  Object.assign(setState, { newPassword: '', confirm: '' })
}

async function changePassword(event: FormSubmitEvent<z.output<typeof changeSchema>>): Promise<void> {
  error.value = null
  success.value = null
  const result = await client.changePassword({
    currentPassword: event.data.currentPassword,
    newPassword: event.data.newPassword,
    revokeOtherSessions: event.data.revokeOtherSessions,
  })
  if (result.error) {
    error.value = result.error.status === 429 ? 'Too many attempts, try again in a minute' : result.error.message || 'The password could not be changed.'
    return
  }
  reset()
  success.value = 'Password changed'
}

async function setPassword(event: FormSubmitEvent<z.output<typeof setSchema>>): Promise<void> {
  error.value = null
  success.value = null
  try {
    await api('/api/account/password', { method: 'POST', body: { newPassword: event.data.newPassword }, toast: false })
    reset()
    success.value = 'Password set'
    await load(true)
  } catch (cause) {
    error.value = errorMessage(cause)
  }
}

async function removePassword(): Promise<void> {
  if (!removeArmed.value) {
    removeArmed.value = true
    return
  }
  removing.value = true
  error.value = null
  success.value = null
  try {
    await api('/api/account/password', { method: 'DELETE', toast: false })
    success.value = 'Password removed; sign in with a passkey from now on'
    await load(true)
  } catch (cause) {
    const apiError = toApiError(cause)
    error.value = apiError.code === 'lastCredential' ? 'Add a passkey before removing your password.' : apiError.message
  } finally {
    removing.value = false
    removeArmed.value = false
  }
}
</script>

<template>
  <section class="space-y-4 rounded-lg border border-default p-4" aria-labelledby="password-heading">
    <h2 id="password-heading" class="text-sm font-semibold text-highlighted">Password</h2>

    <template v-if="account">
      <UForm v-if="hasPassword" :schema="changeSchema" :state="changeState" class="grid max-w-xl gap-3" @submit="changePassword">
        <UFormField label="Current password" name="currentPassword" required>
          <UInput v-model="changeState.currentPassword" type="password" autocomplete="current-password" class="w-full" />
        </UFormField>
        <UFormField label="New password" name="newPassword" required hint="8–128 characters">
          <UInput v-model="changeState.newPassword" type="password" autocomplete="new-password" class="w-full" />
        </UFormField>
        <UFormField label="Confirm new password" name="confirm" required>
          <UInput v-model="changeState.confirm" type="password" autocomplete="new-password" class="w-full" />
        </UFormField>
        <UFormField name="revokeOtherSessions">
          <UCheckbox v-model="changeState.revokeOtherSessions" label="Sign out my other sessions" />
        </UFormField>
        <div><UButton type="submit" label="Change password" size="sm" /></div>
      </UForm>

      <UForm v-else :schema="setSchema" :state="setState" class="grid max-w-xl gap-3" @submit="setPassword">
        <p class="text-xs text-muted">Your account has no password; you sign in with a passkey. You can add a password as a second way to sign in.</p>
        <UFormField label="New password" name="newPassword" required hint="8–128 characters">
          <UInput v-model="setState.newPassword" type="password" autocomplete="new-password" class="w-full" />
        </UFormField>
        <UFormField label="Confirm new password" name="confirm" required>
          <UInput v-model="setState.confirm" type="password" autocomplete="new-password" class="w-full" />
        </UFormField>
        <div><UButton type="submit" label="Set password" size="sm" /></div>
      </UForm>

      <div v-if="canRemove" class="flex items-center gap-2 border-t border-default pt-3">
        <UButton
          :label="removeArmed ? 'Confirm: remove password' : 'Remove password'"
          :color="removeArmed ? 'error' : 'neutral'"
          :variant="removeArmed ? 'solid' : 'outline'"
          size="sm"
          :loading="removing"
          @click="removePassword"
        />
        <UButton v-if="removeArmed" label="Keep password" color="neutral" variant="ghost" size="sm" @click="removeArmed = false" />
        <span class="text-xs text-dimmed">You keep signing in with your passkeys.</span>
      </div>

      <p v-if="error" class="text-xs text-error" role="alert">{{ error }}</p>
      <p v-if="success" class="text-xs text-success" role="status">{{ success }}</p>
    </template>
    <p v-else class="text-xs text-dimmed">Loading…</p>
  </section>
</template>
