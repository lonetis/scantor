<script setup lang="ts">
// One analysis of a test run (docs/ui.md §5.8): status, timings, config, result or error, attempts, log tail and
// files (presigned downloads through getTestRunFileDownload). Configs and results are masked ("***").
const props = defineProps<{ testRunId: string; analysis: TestRunAnalysis | null }>()
const open = defineModel<boolean>('open', { default: false })

const actions = useTestRunActions()
const downloading = ref<string | null>(null)

async function download(file: FileRef): Promise<void> {
  downloading.value = file.id
  try {
    const target = await actions.fileDownload(props.testRunId, file.id)
    window.open(target.url, '_blank', 'noopener')
  } catch (cause) {
    console.error('[test-runs] file download failed', cause)
  } finally {
    downloading.value = null
  }
}
</script>

<template>
  <USlideover v-model:open="open" :title="analysis ? `Analysis ${analysis.seq}` : 'Analysis'" :ui="{ content: 'sm:max-w-2xl' }">
    <template #body>
      <div v-if="analysis" class="space-y-4" data-testid="analysis-slideover">
        <div class="flex flex-wrap items-center gap-2">
          <StatusBadge kind="analysis" :state="analysis.status" />
          <span class="text-xs text-muted">attempt {{ analysis.attempt }}</span>
          <DurationText :ms="analysis.timings?.durationMs" />
        </div>
        <div v-if="analysis.error" class="space-y-1">
          <p class="section-label">Error</p>
          <UAlert color="error" variant="subtle" :title="`${analysis.error.type}: ${analysis.error.message}`" />
          <CodeBlock v-if="analysis.error.stack" :code="analysis.error.stack" label="Stack" />
        </div>
        <div v-if="analysis.config" class="space-y-1">
          <p class="section-label">Analysis config</p>
          <JsonView :value="analysis.config" />
        </div>
        <div v-if="analysis.result" class="space-y-1">
          <p class="section-label">Result</p>
          <JsonView :value="analysis.result" :collapsed-depth="3" />
        </div>
        <div v-if="analysis.files.length > 0" class="space-y-1">
          <p class="section-label">Files</p>
          <div class="flex flex-wrap gap-2">
            <UButton
              v-for="file in analysis.files"
              :key="file.id"
              :label="file.name"
              :aria-label="`Download ${file.name}`"
              icon="i-lucide-file-down"
              size="xs"
              color="neutral"
              variant="outline"
              :loading="downloading === file.id"
              @click="download(file)"
            >
              <template #trailing>
                <span class="text-[10px] text-muted">{{ formatBytes(file.size) }}</span>
              </template>
            </UButton>
          </div>
        </div>
        <div v-if="analysis.attempts.length > 0" class="space-y-1">
          <p class="section-label">Earlier attempts</p>
          <ul class="divide-y divide-default rounded-md border border-default text-sm">
            <li v-for="attempt in analysis.attempts" :key="attempt.attempt" class="px-3 py-2">
              <div class="flex items-center gap-2 text-xs">
                <span class="font-mono">#{{ attempt.attempt }}</span>
                <DurationText :ms="attempt.durationMs" />
                <span v-if="attempt.error" class="text-error">{{ attempt.error.type }}: {{ attempt.error.message }}</span>
              </div>
            </li>
          </ul>
        </div>
        <div class="space-y-1">
          <p class="section-label">Log tail</p>
          <LogView :text="analysis.logTail ?? ''" empty-text="No output." />
        </div>
      </div>
    </template>
  </USlideover>
</template>
