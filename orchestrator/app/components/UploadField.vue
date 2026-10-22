<script setup lang="ts">
import type { ResolvedField } from '~/utils/schema-subset'

// `"x-scantor": "upload"` fields hold an upload id (docs/tasks.md §6.6): pick an existing upload or upload a
// newline-separated list file (createUpload). "None" clears the field (null for a nullable field).
const props = defineProps<{
  field: ResolvedField
  modelValue: unknown
  label: string
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string | null | undefined] }>()

const NONE = '__none__'
const UPLOAD_LIST_LIMIT = 200

const api = useApi()
const uploads = shallowRef<Upload[]>([])
const loading = ref(false)
const uploading = ref(false)
const problem = ref<string | null>(null)
const fileInput = useTemplateRef<HTMLInputElement>('fileInput')

async function loadUploads(): Promise<void> {
  loading.value = true
  try {
    const page = await api<Page<Upload>>('/api/uploads', { query: { limit: UPLOAD_LIST_LIMIT }, toast: false })
    uploads.value = page.items
    problem.value = null
  } catch (error) {
    problem.value = `Uploads could not be loaded: ${errorMessage(error)}`
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadUploads()
})

function describe(upload: Upload): string {
  return `${upload.name} · ${plural(upload.lines, 'line')} · ${formatBytes(upload.bytes)}`
}

const items = computed(() => [
  { label: 'None', value: NONE },
  ...uploads.value.map((upload) => ({ label: describe(upload), value: upload.id })),
])

const selectedId = computed(() => (typeof props.modelValue === 'string' ? props.modelValue : NONE))
const selected = computed(() => uploads.value.find((upload) => upload.id === props.modelValue) ?? null)

function onSelect(value: unknown): void {
  if (value === NONE || typeof value !== 'string') emit('update:modelValue', props.field.nullable ? null : undefined)
  else emit('update:modelValue', value)
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  uploading.value = true
  problem.value = null
  try {
    const upload = await api<Upload>('/api/uploads', {
      method: 'POST',
      query: { name: file.name.slice(0, 200), kind: 'list' },
      body: file,
      headers: { 'content-type': 'text/plain' },
      toast: false,
    })
    uploads.value = [upload, ...uploads.value.filter((existing) => existing.id !== upload.id)]
    emit('update:modelValue', upload.id)
  } catch (error) {
    problem.value = `Upload failed: ${errorMessage(error)}`
  } finally {
    uploading.value = false
  }
}
</script>

<template>
  <div class="space-y-1.5">
    <div class="flex flex-wrap items-center gap-2">
      <USelect
        :model-value="selectedId"
        :items="items"
        :loading="loading"
        :disabled="disabled"
        :aria-label="label"
        class="w-full max-w-md"
        @update:model-value="onSelect"
      />
      <UButton
        :label="uploading ? 'Uploading…' : 'Upload a list'"
        icon="i-lucide-upload"
        color="neutral"
        variant="outline"
        size="sm"
        :loading="uploading"
        :disabled="disabled"
        :aria-label="`Upload a list for ${label}`"
        @click="fileInput?.click()"
      />
      <input ref="fileInput" type="file" class="hidden" accept=".txt,.csv,.lst,text/plain" @change="onFile">
    </div>
    <p v-if="selected" class="text-xs text-muted">
      {{ plural(selected.lines, 'line') }} · <BytesText :bytes="selected.bytes" /> · <IdChip :id="selected.id" :copyable="false" />
    </p>
    <p v-else-if="typeof modelValue === 'string' && !loading" class="text-xs text-dimmed">
      Upload <code class="font-mono">{{ shortId(modelValue) }}</code> (not in your recent uploads)
    </p>
    <p class="text-xs text-dimmed">One entry per line (text file).</p>
    <p v-if="problem" class="text-xs text-error">{{ problem }}</p>
  </div>
</template>
