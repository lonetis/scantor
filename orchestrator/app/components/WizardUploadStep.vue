<script setup lang="ts">
// Upload a task folder (docs/ui.md §5.6): a .tar.gz (the CLI's `scantor push` is the main path), "Publish a revision"
// (default on), "Replace unpublished changes" (force) and an optional message. 409 workspaceDirty offers
// "Replace anyway"; manifest and path errors are shown inline.
const emit = defineEmits<{ uploaded: [result: UploadTaskResult] }>()

const actions = useTaskActions()

const file = ref<File | null>(null)
const publish = ref(true)
const force = ref(false)
const message = ref('')
const uploading = ref(false)
const error = ref<string | null>(null)
const dirty = ref(false)
const manifestErrors = ref<BuildError[]>([])

async function upload(options: { force?: boolean } = {}): Promise<void> {
  if (!file.value) return
  uploading.value = true
  error.value = null
  dirty.value = false
  manifestErrors.value = []
  try {
    const result = await actions.uploadTask(file.value, { publish: publish.value, force: options.force ?? force.value, message: message.value })
    emit('uploaded', result)
  } catch (cause) {
    const apiError = toApiError(cause)
    error.value = apiError.code === 'invalidPath' && typeof apiError.details?.path === 'string' ? `${apiError.message} (${apiError.details.path})` : apiError.message
    dirty.value = apiError.code === 'workspaceDirty'
    if (apiError.code === 'manifestInvalid' && Array.isArray(apiError.details?.errors)) manifestErrors.value = apiError.details.errors as BuildError[]
  } finally {
    uploading.value = false
  }
}
</script>

<template>
  <form class="max-w-2xl space-y-4" @submit.prevent="upload()">
    <p class="text-sm text-muted">
      The CLI uploads with <span class="font-mono">scantor push</span>. To upload by hand, pack the folder first:
    </p>
    <CodeBlock code="tar czf task.tgz -C <dir> ." />
    <FileDropZone
      v-model="file"
      :extensions="['.tar.gz', '.tgz']"
      label="Task folder (.tar.gz)"
      hint="A tar.gz with scantor.yaml at its root (or in one top-level folder)."
    />
    <div class="flex flex-wrap gap-4">
      <UCheckbox v-model="publish" label="Publish a revision" />
      <UCheckbox v-model="force" label="Replace unpublished changes" />
    </div>
    <UFormField label="Message" name="message" hint="optional revision message">
      <UInput v-model="message" :maxlength="500" class="w-full" />
    </UFormField>
    <UAlert v-if="error" :color="dirty ? 'warning' : 'error'" variant="subtle" icon="i-lucide-circle-alert" :title="dirty ? 'The workspace has unpublished changes' : 'The upload failed'" :description="error">
      <template v-if="dirty" #actions>
        <UButton label="Replace anyway" color="warning" size="xs" :loading="uploading" @click="upload({ force: true })" />
      </template>
    </UAlert>
    <BuildErrors :errors="manifestErrors" title="Manifest errors" />
    <UButton type="submit" label="Upload" icon="i-lucide-upload" :disabled="!file" :loading="uploading" />
  </form>
</template>
