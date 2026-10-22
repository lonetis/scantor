<script setup lang="ts">
// The workspace of a task (docs/ui.md §5.7 overview): files, size, pack hash, last check and "Check now"
// (getTaskWorkspace computes the hash fresh with a workspace helper).
const props = defineProps<{ task: Task }>()
const emit = defineEmits<{ checked: [status: TaskWorkspaceStatus] }>()

const actions = useTaskActions()
const checking = ref(false)
const fresh = shallowRef<TaskWorkspaceStatus | null>(null)
const error = ref<string | null>(null)

const view = computed(() => {
  const status = fresh.value
  if (status && status.checkedAt >= (props.task.workspace.checkedAt ?? '')) {
    return { packSha256: status.packSha256, fileCount: status.fileCount, bytes: status.bytes, dirty: status.dirty, checkedAt: status.checkedAt }
  }
  return props.task.workspace
})

async function check(): Promise<void> {
  checking.value = true
  error.value = null
  try {
    fresh.value = await actions.getWorkspace(props.task.id)
    emit('checked', fresh.value)
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    checking.value = false
  }
}
</script>

<template>
  <UCard :ui="{ body: 'p-4 sm:p-4' }">
    <div class="mb-2 flex items-center justify-between gap-2">
      <p class="section-label">Workspace</p>
      <UButton label="Check now" icon="i-lucide-scan-search" size="xs" color="neutral" variant="outline" :loading="checking" @click="check" />
    </div>
    <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      <dt class="text-xs text-muted">Files</dt>
      <dd class="tabular-nums">{{ formatCount(view.fileCount) }}</dd>
      <dt class="text-xs text-muted">Size</dt>
      <dd><BytesText :bytes="view.bytes" /></dd>
      <dt class="text-xs text-muted">Pack hash</dt>
      <dd>
        <IdChip v-if="view.packSha256" :id="view.packSha256" copy-label="Copy workspace pack hash" />
        <span v-else class="text-xs text-dimmed">unknown</span>
      </dd>
      <dt class="text-xs text-muted">Status</dt>
      <dd>
        <UBadge v-if="view.dirty" label="Unpublished changes" color="warning" variant="subtle" size="xs" />
        <UBadge v-else label="Published" color="success" variant="subtle" size="xs" />
      </dd>
      <dt class="text-xs text-muted">Checked</dt>
      <dd><RelativeTime :value="view.checkedAt" /></dd>
    </dl>
    <p v-if="error" class="mt-2 text-xs text-error">{{ error }}</p>
  </UCard>
</template>
