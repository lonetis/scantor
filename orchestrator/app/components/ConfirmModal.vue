<script setup lang="ts">
// Confirmation dialog for destructive operations (docs/ui.md §5, §11): the confirm button names the action;
// optionally the user must type a name first. Emits `close` with the decision (works with useOverlay).
const props = withDefaults(defineProps<{
  title: string
  description?: string
  confirmLabel: string
  confirmColor?: 'error' | 'warning' | 'primary' | 'neutral'
  typeToConfirm?: string
}>(), { description: undefined, confirmColor: 'error', typeToConfirm: undefined })

const emit = defineEmits<{ close: [confirmed: boolean] }>()

const typed = ref('')
const canConfirm = computed(() => !props.typeToConfirm || typed.value.trim() === props.typeToConfirm)

function submit(): void {
  if (canConfirm.value) emit('close', true)
}
</script>

<template>
  <UModal :title="title" :description="description" :ui="{ content: 'sm:max-w-md' }" :content="dialogContent">
    <template #close="{ ui }">
      <CloseButton :class="ui.close()" @click="emit('close', false)" />
    </template>
    <template #body>
      <form id="confirm-modal-form" class="space-y-3" @submit.prevent="submit">
        <slot />
        <UFormField v-if="typeToConfirm" :label="`Type ${typeToConfirm} to confirm`" name="confirmation">
          <UInput v-model="typed" class="w-full font-mono" autocomplete="off" :placeholder="typeToConfirm" autofocus />
        </UFormField>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="emit('close', false)" />
        <UButton type="submit" form="confirm-modal-form" :label="confirmLabel" :color="confirmColor" :disabled="!canConfirm" />
      </div>
    </template>
  </UModal>
</template>
