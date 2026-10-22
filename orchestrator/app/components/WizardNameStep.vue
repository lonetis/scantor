<script setup lang="ts">
import type { FormSubmitEvent } from '@nuxt/ui'
import { z } from 'zod'
import { TASK_DESCRIPTION_MAX, taskName } from '#shared/schemas/tasks'

// Name and description of a new task (docs/ui.md §5.6): the slug rules of #shared/schemas/tasks are validated
// live; a taken name (409 alreadyExists) is shown under the field.
withDefaults(defineProps<{ submitting?: boolean; nameError?: string | null }>(), { submitting: false, nameError: null })
const name = defineModel<string>('name', { default: '' })
const description = defineModel<string>('description', { default: '' })
const emit = defineEmits<{ submit: [] }>()

const schema = z.object({ name: taskName(), description: z.string().trim().max(TASK_DESCRIPTION_MAX) })
const state = reactive({ name: name.value, description: description.value })
watch(() => state.name, (value) => {
  name.value = value
})
watch(() => state.description, (value) => {
  description.value = value
})

function submit(_event: FormSubmitEvent<z.output<typeof schema>>): void {
  emit('submit')
}
</script>

<template>
  <UForm :schema="schema" :state="state" class="max-w-lg space-y-3" @submit="submit">
    <UFormField label="Name" name="name" required hint="lowercase letters, digits, hyphens" :error="nameError ?? undefined">
      <UInput v-model="state.name" autocomplete="off" class="w-full font-mono" placeholder="echo" autofocus />
    </UFormField>
    <UFormField label="Description" name="description" hint="optional, ≤ 500 characters">
      <UTextarea v-model="state.description" :maxlength="500" :rows="2" autoresize class="w-full" />
    </UFormField>
    <UButton type="submit" label="Create task" icon="i-lucide-plus" :loading="submitting" />
  </UForm>
</template>
