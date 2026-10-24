<script setup lang="ts">
import type { FormSubmitEvent } from '@nuxt/ui'
import type { z } from 'zod'
import { banUserBody } from '#shared/schemas/users'
import type { BanUserBody } from '#shared/schemas/users'

// Ban a user (docs/ui.md §5.16, docs/auth.md §5.7): sessions, API keys and OAuth grants are revoked at once.
// "Also cancel all their scans" is checked by default; unchecked, their running scans continue until they end.
const props = defineProps<{
  user: User | null
  ban: (userId: string, body: BanUserBody) => Promise<User>
}>()

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ banned: [user: User] }>()

const state = reactive<{ reason?: string, cancelScans: boolean }>({ reason: undefined, cancelScans: true })
const error = ref<string | null>(null)
const saving = ref(false)

watch(open, (value) => {
  if (!value) return
  state.reason = undefined
  state.cancelScans = true
  error.value = null
})

async function submit(event: FormSubmitEvent<z.output<typeof banUserBody>>): Promise<void> {
  if (!props.user) return
  saving.value = true
  error.value = null
  try {
    const user = await props.ban(props.user.id, event.data)
    open.value = false
    emit('banned', user)
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="`Ban ${user?.email ?? 'user'}`" description="Signs the user out everywhere and revokes their API keys and app authorizations." :ui="{ content: 'sm:max-w-md' }">
    <template #close="{ ui }">
      <CloseButton :class="ui.close()" />
    </template>
    <template #body>
      <UForm id="ban-user-form" :schema="banUserBody" :state="state" class="space-y-3" @submit="submit">
        <UFormField label="Reason" name="reason" hint="optional, shown to admins">
          <UTextarea
            :model-value="state.reason ?? ''"
            :rows="2"
            maxlength="500"
            class="w-full"
            @update:model-value="state.reason = String($event ?? '').trim() === '' ? undefined : String($event)"
          />
        </UFormField>
        <UFormField name="cancelScans" help="Unchecked, their running scans continue until they end.">
          <UCheckbox v-model="state.cancelScans" label="Also cancel all their scans" />
        </UFormField>
        <p v-if="error" class="text-xs text-error" role="alert">{{ error }}</p>
      </UForm>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton type="submit" form="ban-user-form" label="Ban user" color="error" :loading="saving" />
      </div>
    </template>
  </UModal>
</template>
