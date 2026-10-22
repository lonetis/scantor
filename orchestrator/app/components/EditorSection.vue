<script setup lang="ts">
// Editor (docs/ui.md §5.17): the state of the caller's browser editor, with "Open editor" and "Stop editor".
const { status, state, live, stopping, pollIntervalMs, load, stop } = useEditor()
const { confirm } = useConfirm()
const toast = useToast()
const loadError = ref<string | null>(null)

async function refresh(): Promise<void> {
  try {
    await load({ background: true })
    loadError.value = null
  } catch (error) {
    loadError.value = errorMessage(error, 'The editor state could not be loaded.')
    throw error
  }
}

usePoll(refresh, { intervalMs: pollIntervalMs })

const idleText = computed(() => idleTimeoutText(status.value?.idleTimeoutMs))

async function stopEditor(): Promise<void> {
  const confirmed = await confirm({
    title: 'Stop editor',
    description: 'Open editor tabs disconnect and the editor\'s API key is deleted. The files in your workspace stay.',
    confirmLabel: 'Stop editor',
    confirmColor: 'warning',
  })
  if (!confirmed) return
  try {
    await stop()
    toast.add({ title: 'Editor stopped', color: 'success', icon: 'i-lucide-check' })
  } catch (error) {
    // The central fetch wrapper already showed the error.
    console.error('[editor] stopping failed', error)
  }
}
</script>

<template>
  <section class="space-y-4 rounded-lg border border-default p-4" aria-labelledby="editor-heading">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <h2 id="editor-heading" class="text-sm font-semibold text-highlighted">Editor</h2>
        <StatusBadge v-if="state" kind="editor" :state="state" />
      </div>
      <div class="flex gap-2">
        <UButton label="Open editor" icon="i-lucide-code" color="neutral" variant="outline" size="sm" to="/editor" />
        <UButton
          label="Stop editor"
          icon="i-lucide-square"
          color="warning"
          variant="outline"
          size="sm"
          :loading="stopping"
          :disabled="!live"
          @click="stopEditor"
        />
      </div>
    </div>

    <p class="text-xs text-muted">
      A code-server in your browser on your own workspace, with the scantor CLI preinstalled.
      <template v-if="idleText">It {{ idleText }}.</template>
    </p>

    <dl v-if="status" class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
      <dt class="text-muted">Started</dt>
      <dd><RelativeTime :value="status.startedAt" /></dd>
      <dt class="text-muted">Last activity</dt>
      <dd><RelativeTime :value="status.lastActivityAt" /></dd>
    </dl>

    <UAlert
      v-if="status?.error && state === 'stopped'"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="The last start failed"
      :description="status.error"
    />
    <p v-if="loadError" class="text-xs text-error" role="alert">{{ loadError }}</p>
  </section>
</template>
