<script setup lang="ts">
// The latest output of a worker container (docs/ui.md §5.13.5): requests a fresh tail from the node
// (getWorkerLogs?wait=20&tailBytes=65536) and shows it as text.
const props = defineProps<{ scanId: string, worker: ScanWorker | null }>()
const open = defineModel<boolean>('open', { default: false })

const WAIT_SECONDS = 20
const TAIL_BYTES = 65_536

const api = useApi()
const logs = shallowRef<WorkerLogs | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

async function load(): Promise<void> {
  const worker = props.worker
  if (!worker) return
  loading.value = true
  error.value = null
  try {
    logs.value = await api<WorkerLogs>(`/api/scans/${encodeURIComponent(props.scanId)}/workers/${encodeURIComponent(worker.id)}/logs`, {
      query: { wait: WAIT_SECONDS, tailBytes: TAIL_BYTES },
      toast: false,
    })
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    loading.value = false
  }
}

watch([open, () => props.worker?.id], ([isOpen]) => {
  if (!isOpen) return
  logs.value = null
  void load()
}, { immediate: true })

const title = computed(() => (props.worker ? `Logs of ${props.worker.role} ${shortId(props.worker.id)}` : 'Worker logs'))
</script>

<template>
  <UModal v-model:open="open" :title="title" :ui="{ content: 'sm:max-w-4xl' }" :content="dialogContent">
    <template #close="{ ui }">
      <CloseButton :class="ui.close()" />
    </template>
    <template #body>
      <div class="space-y-2">
        <div class="flex flex-wrap items-center gap-3 text-xs text-muted">
          <span v-if="logs?.collectedAt">Collected <RelativeTime :value="logs.collectedAt" /></span>
          <span v-else-if="loading">Requesting the latest output from the node…</span>
          <UBadge v-if="logs?.pending" label="waiting for the node" color="warning" variant="subtle" size="xs" />
          <UBadge v-if="logs?.truncated" label="truncated" color="neutral" variant="subtle" size="xs" />
          <UButton label="Refresh" icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="xs" class="ms-auto" :loading="loading" @click="load" />
        </div>
        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :description="error" />
        <LogView :text="logs?.text ?? ''" max-height-class="max-h-[60vh]" testid="worker-logs" empty-text="No output collected yet." />
      </div>
    </template>
  </UModal>
</template>
