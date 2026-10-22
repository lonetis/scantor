<script setup lang="ts">
// Publish the workspace of a task (docs/ui.md §5.7): an optional message, the fresh workspace status and a notice
// when the content is already published (publishing then returns the existing revision, docs/api.md §4.10).
const props = defineProps<{ task: Task }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ published: [revision: Revision] }>()

const actions = useTaskActions()
const message = ref('')
const status = shallowRef<TaskWorkspaceStatus | null>(null)
const statusError = ref<string | null>(null)
const checking = ref(false)
const publishing = ref(false)
const error = ref<string | null>(null)

const returnsExisting = computed(() => {
  const latest = props.task.latestRevision
  return status.value !== null && !status.value.dirty && latest !== null && latest.state !== 'failed'
})

watch(open, async (value) => {
  if (!value) return
  message.value = ''
  error.value = null
  status.value = null
  statusError.value = null
  checking.value = true
  try {
    status.value = await actions.getWorkspace(props.task.id)
  } catch (cause) {
    statusError.value = errorMessage(cause)
  } finally {
    checking.value = false
  }
})

async function publish(): Promise<void> {
  publishing.value = true
  error.value = null
  try {
    const revision = await actions.publishRevision(props.task.id, message.value)
    open.value = false
    emit('published', revision)
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    publishing.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="`Publish ${task.name}`" description="Snapshot the workspace and build a new revision." :ui="{ content: 'sm:max-w-lg' }">
    <template #body>
      <form id="publish-form" class="space-y-3" @submit.prevent="publish">
        <div class="rounded-md border border-default p-3 text-sm">
          <USkeleton v-if="checking" class="h-10 w-full" />
          <p v-else-if="statusError" class="text-xs text-error">{{ statusError }}</p>
          <dl v-else-if="status" class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt class="text-xs text-muted">Workspace</dt>
            <dd class="flex items-center gap-2 text-xs">
              <span class="tabular-nums">{{ formatCount(status.fileCount) }} files · {{ formatBytes(status.bytes) }}</span>
              <IdChip :id="status.packSha256" copy-label="Copy workspace pack hash" />
            </dd>
            <dt class="text-xs text-muted">Status</dt>
            <dd>
              <UBadge v-if="status.dirty" label="Unpublished changes" color="warning" variant="subtle" size="xs" />
              <UBadge v-else label="Already published" color="success" variant="subtle" size="xs" />
            </dd>
          </dl>
        </div>
        <UAlert
          v-if="returnsExisting && task.latestRevision"
          color="info"
          variant="subtle"
          icon="i-lucide-info"
          :title="`The workspace equals ${task.name}@${task.latestRevision.number}`"
          description="Publishing returns the existing revision instead of building again."
        />
        <UFormField label="Message" name="message" hint="optional">
          <UTextarea v-model="message" :maxlength="500" :rows="2" autoresize class="w-full" placeholder="What changed?" />
        </UFormField>
        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" title="Publishing failed" :description="error" />
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton type="submit" form="publish-form" label="Publish revision" icon="i-lucide-rocket" :loading="publishing" />
      </div>
    </template>
  </UModal>
</template>
