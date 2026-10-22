<script setup lang="ts">
// Single-file drop zone with a "Choose file" fallback (task upload, list uploads). Validates extension and
// size client-side; the server enforces its own caps.
const props = withDefaults(defineProps<{
  /** File name suffixes, for example ['.tar.gz', '.tgz']; empty accepts any file. */
  extensions?: string[]
  maxBytes?: number | null
  label?: string
  hint?: string
  disabled?: boolean
}>(), { extensions: () => [], maxBytes: null, label: 'Drop a file here', hint: undefined, disabled: false })

const model = defineModel<File | null>({ default: null })

const input = useTemplateRef<HTMLInputElement>('input')
const dragging = ref(false)
const problem = ref<string | null>(null)
const accept = computed(() => (props.extensions.length > 0 ? props.extensions.join(',') : undefined))

watch(model, (file) => {
  if (!file && input.value) input.value.value = ''
})

function check(file: File): string | null {
  const name = file.name.toLowerCase()
  if (props.extensions.length > 0 && !props.extensions.some((extension) => name.endsWith(extension.toLowerCase()))) {
    return `Expected a ${props.extensions.join(' or ')} file`
  }
  if (props.maxBytes !== null && file.size > props.maxBytes) return `The file is larger than ${formatBytes(props.maxBytes)}`
  return null
}

function choose(file: File | undefined): void {
  if (!file) return
  problem.value = check(file)
  model.value = problem.value ? null : file
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  if (props.disabled) return
  choose(event.dataTransfer?.files?.[0])
}

function onChange(event: Event): void {
  choose((event.target as HTMLInputElement).files?.[0])
}

function openPicker(): void {
  if (!props.disabled) input.value?.click()
}
</script>

<template>
  <div class="space-y-1">
    <div
      class="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors"
      :class="[
        dragging ? 'border-primary bg-primary/5' : 'border-default',
        disabled ? 'opacity-60' : '',
      ]"
      data-testid="file-drop-zone"
      @dragover.prevent="dragging = !disabled"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <UIcon name="i-lucide-cloud-upload" class="size-8 text-dimmed" aria-hidden="true" />
      <template v-if="model">
        <p class="text-sm font-medium text-highlighted">{{ model.name }}</p>
        <p class="text-xs text-muted"><BytesText :bytes="model.size" /></p>
        <UButton label="Remove file" icon="i-lucide-x" color="neutral" variant="ghost" size="xs" :disabled="disabled" @click="model = null" />
      </template>
      <template v-else>
        <p class="text-sm text-muted">{{ label }}</p>
        <UButton label="Choose file" icon="i-lucide-file-up" color="neutral" variant="outline" size="sm" :disabled="disabled" @click="openPicker" />
      </template>
      <input ref="input" type="file" class="hidden" :accept="accept" :disabled="disabled" @change="onChange">
    </div>
    <p v-if="problem" class="text-xs text-error">{{ problem }}</p>
    <p v-else-if="hint" class="text-xs text-dimmed">{{ hint }}</p>
  </div>
</template>
