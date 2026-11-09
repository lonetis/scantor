<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'

// Script run detail: state, progress, duration, actions (cancel, run again, resume, download source), build errors, the
// error with its stack, the result, the output files (downloaded by navigation to their presigned URLs), the scans and
// settings the run used, and the log (`getScriptRunLogs?afterLine=`, every 2 s until it is complete). Polls the run
// every 2 s while it is active.
const route = useRoute()
const toast = useToast()
const { confirm } = useConfirm()
const actions = useScriptRunActions()

const scriptId = computed(() => String(route.params.scriptId))
const runId = computed(() => String(route.params.runId))
const detail = useScriptRun(runId)
const run = detail.run
const active = detail.active
const log = useScriptRunLog(runId, {
  ready: () => run.value !== null,
  totalLines: () => run.value?.log.lines ?? null,
})
/** The run's script: its config schema for "Run again" and "Resume". */
const script = useApiFetch<Script>(() => (run.value ? scriptPath(run.value.scriptId) : null), { toast: false })

useHead({ title: () => `${run.value ? `${run.value.scriptName} run ${shortId(run.value.id)}` : 'Script run'} · scantor` })

// The duration of an active run follows the clock.
const now = ref(Date.now())
const clock = useIntervalFn(() => (now.value = Date.now()), 1000, { immediate: false })
watch(active, (isActive) => (isActive ? clock.resume() : clock.pause()), { immediate: true })
const durationMs = computed(() => scriptRunDurationMs(run.value, now.value))
const percent = computed(() => scriptRunProgressPercent(run.value?.progress))
const resumable = computed(() => canResumeScriptRun(run.value))
const progressSummary = computed(() => {
  const progress = run.value?.progress
  if (!progress) return 'no progress reported'
  return progress.total === null ? `${formatCount(progress.done)} done` : `${formatCount(progress.done)} of ${formatCount(progress.total)}`
})
const hasResult = computed(() => run.value !== null && run.value.result !== null && run.value.result !== undefined)

const restartOpen = ref(false)
const restartResume = ref(false)
const cancelling = ref(false)

function openRestart(resume: boolean): void {
  restartResume.value = resume
  restartOpen.value = true
}

async function onRestarted(next: ScriptRun): Promise<void> {
  await navigateTo(`/scripts/${next.scriptId}/runs/${next.id}`)
}

async function refresh(): Promise<void> {
  await Promise.all([detail.refresh(), log.refresh()])
}

async function cancel(): Promise<void> {
  const current = run.value
  if (!current) return
  const confirmed = await confirm({
    title: 'Cancel script run',
    description: 'The run stops. Output files it already stored and its checkpoint are kept, so it can be resumed.',
    confirmLabel: 'Cancel script run',
  })
  if (!confirmed) return
  cancelling.value = true
  try {
    detail.set(await actions.cancelRun(current.id))
  } catch (cause) {
    const apiError = toApiError(cause)
    toast.add({ title: errorTitle(apiError.code), description: apiError.message, color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    cancelling.value = false
  }
}

function formatTimeout(ms: number | null): string {
  return ms === null ? 'default' : formatDuration(ms)
}
</script>

<template>
  <UDashboardPanel id="script-run">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <SidebarCollapseButton />
        </template>
        <template #title>
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <UButton :to="`/scripts/${scriptId}?tab=runs`" icon="i-lucide-arrow-left" color="neutral" variant="ghost" size="xs" aria-label="Back to the script" />
            <span class="truncate font-mono font-semibold">{{ run?.scriptName ?? 'Script run' }}</span>
            <IdChip v-if="run" :id="run.id" copy-label="Copy script run id" />
            <StatusBadge v-if="run" kind="scriptRun" :state="run.state" />
          </div>
        </template>
        <template #right>
          <RefreshButton :loading="detail.refreshing.value" @click="refresh()" />
          <template v-if="run">
            <UButton
              v-if="active"
              label="Cancel script run"
              aria-label="Cancel script run"
              icon="i-lucide-square"
              size="sm"
              color="error"
              variant="outline"
              :loading="cancelling"
              :ui="{ label: 'hidden lg:inline' }"
              @click="cancel"
            />
            <UButton
              v-if="resumable"
              label="Resume"
              aria-label="Resume"
              icon="i-lucide-step-forward"
              size="sm"
              :ui="{ label: 'hidden lg:inline' }"
              @click="openRestart(true)"
            />
            <UButton
              label="Run again"
              aria-label="Run again"
              icon="i-lucide-rotate-ccw"
              size="sm"
              color="neutral"
              variant="outline"
              :ui="{ label: 'hidden lg:inline' }"
              @click="openRestart(false)"
            />
            <UButton
              :href="actions.sourceDownloadUrl(run.id)"
              external
              label="Download source"
              aria-label="Download source"
              icon="i-lucide-download"
              size="sm"
              color="neutral"
              variant="ghost"
              :ui="{ label: 'hidden xl:inline' }"
            />
          </template>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UAlert
        v-if="detail.error.value"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="detail.error.value.code === 'notFound' ? 'Script run not found' : 'The script run could not be loaded'"
        :description="errorMessage(detail.error.value)"
      />
      <USkeleton v-if="!run && !detail.error.value" class="h-48 w-full" />

      <div v-if="run" class="space-y-6">
        <div class="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted">
          <span>created <RelativeTime :value="run.createdAt" /></span>
          <span v-if="run.startedAt">started <RelativeTime :value="run.startedAt" /></span>
          <span v-if="run.finishedAt">finished <RelativeTime :value="run.finishedAt" /></span>
          <span v-if="durationMs !== null">ran <DurationText :ms="durationMs" /></span>
          <UBadge v-if="run.input.settings.limit !== null" :label="`sample of ${formatCount(run.input.settings.limit)} analyses per stream`" color="neutral" variant="outline" size="xs" />
          <UBadge v-if="run.image?.cached" label="image cached" color="neutral" variant="soft" size="xs" />
          <span v-if="run.restartedFrom">
            {{ run.restartedFrom.resume ? 'resumed from' : 'restarted from' }}
            <NuxtLink :to="`/scripts/${run.scriptId}/runs/${run.restartedFrom.id}`" class="font-mono hover:underline">{{ shortId(run.restartedFrom.id) }}</NuxtLink>
          </span>
          <span v-if="run.exitCode !== null">exit code <span class="font-mono">{{ run.exitCode }}</span></span>
        </div>

        <section v-if="run.progress || active" class="space-y-1.5" data-testid="script-run-progress" aria-labelledby="script-run-progress-heading">
          <h2 id="script-run-progress-heading" class="section-label">Progress</h2>
          <UProgress
            :model-value="percent ?? (active ? null : 0)"
            size="sm"
            :get-value-label="() => `Progress of script run ${shortId(run?.id)}`"
            :get-value-text="() => progressSummary"
          />
          <p class="text-xs text-muted tabular-nums">
            <template v-if="run.progress">
              {{ formatCount(run.progress.done) }}<template v-if="run.progress.total !== null"> / {{ formatCount(run.progress.total) }} ({{ formatPercent(percent) }})</template>
              <span v-if="run.progress.message" class="ms-2">{{ stripEscapes(run.progress.message) }}</span>
              <span class="ms-2 text-dimmed">updated <RelativeTime :value="run.progress.updatedAt" /></span>
            </template>
            <template v-else>{{ run.state === 'running' ? 'No progress reported yet.' : `The run is ${run.state}.` }}</template>
          </p>
        </section>

        <BuildErrors :errors="run.errors" />

        <section v-if="run.error" class="space-y-1.5" data-testid="script-run-error" aria-labelledby="script-run-error-heading">
          <h2 id="script-run-error-heading" class="section-label">Error</h2>
          <div class="space-y-2 rounded-md border border-error/40 p-3">
            <div class="flex flex-wrap items-start gap-2">
              <UBadge :label="run.error.type" color="error" variant="subtle" size="xs" class="font-mono" />
              <span class="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm">{{ stripEscapes(run.error.message) }}</span>
            </div>
            <UCollapsible v-if="run.error.stack">
              <UButton label="Stack trace" icon="i-lucide-chevron-down" color="neutral" variant="ghost" size="xs" />
              <template #content>
                <CodeBlock :code="stripAnsi(run.error.stack)" label="Stack trace" copy-label="Copy stack trace" class="mt-2" />
              </template>
            </UCollapsible>
          </div>
        </section>

        <section v-if="hasResult" class="space-y-1.5" data-testid="script-run-result" aria-labelledby="script-run-result-heading">
          <h2 id="script-run-result-heading" class="section-label">Result</h2>
          <JsonView :value="run.result" />
        </section>

        <section class="space-y-1.5" data-testid="script-run-outputs" aria-labelledby="script-run-outputs-heading">
          <h2 id="script-run-outputs-heading" class="section-label">Output files</h2>
          <ul v-if="run.outputs.length > 0" class="divide-y divide-default rounded-md border border-default text-sm">
            <li v-for="output in run.outputs" :key="output.id" class="flex flex-wrap items-center gap-2 px-3 py-2">
              <UIcon name="i-lucide-file" class="size-4 text-muted" aria-hidden="true" />
              <span class="min-w-0 truncate font-mono text-xs">{{ stripEscapes(output.name) }}</span>
              <BytesText :bytes="output.size" class="text-xs text-muted" />
              <span class="text-xs text-dimmed">{{ output.contentType }}</span>
              <IdChip :id="output.sha256" :copy-label="`Copy SHA-256 of ${stripEscapes(output.name)}`" />
              <UButton
                :href="actions.outputDownloadUrl(run.id, output.id)"
                external
                :label="`Download ${stripEscapes(output.name)}`"
                icon="i-lucide-download"
                size="xs"
                color="neutral"
                variant="outline"
                class="ms-auto"
              />
            </li>
          </ul>
          <p v-else class="text-xs text-dimmed">{{ active ? 'No output files stored yet.' : 'The run stored no output files.' }}</p>
        </section>

        <div class="grid gap-4 lg:grid-cols-2">
          <UCard :ui="{ body: 'p-4 sm:p-4' }">
            <p class="section-label mb-2">Inputs</p>
            <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt class="text-xs text-muted">Scans</dt>
              <dd class="flex flex-wrap gap-x-2">
                <NuxtLink v-for="scan in run.scans" :key="scan.id" :to="`/scans/${scan.id}`" class="hover:underline">{{ scan.name || `Scan ${shortId(scan.id)}` }}</NuxtLink>
              </dd>
              <dt class="text-xs text-muted">Secrets</dt>
              <dd>
                <span v-if="run.secrets.length > 0" class="font-mono text-xs">{{ run.secrets.join(', ') }}</span>
                <span v-else class="text-xs text-dimmed">none</span>
              </dd>
              <dt class="text-xs text-muted">Timeout</dt>
              <dd>{{ formatTimeout(run.input.settings.timeoutMs) }}</dd>
              <dt class="text-xs text-muted">Resources</dt>
              <dd>
                {{ run.input.settings.resources.cpus ?? 'default' }} CPUs ·
                {{ run.input.settings.resources.memoryMiB === null ? 'default memory' : formatBytes(run.input.settings.resources.memoryMiB * 1_048_576) }}
              </dd>
              <dt class="text-xs text-muted">Sample limit</dt>
              <dd>{{ run.input.settings.limit === null ? 'all analyses' : formatCount(run.input.settings.limit) }}</dd>
            </dl>
            <p class="section-label mb-1 mt-3">Config</p>
            <JsonView :value="run.input.config" />
          </UCard>
          <UCard :ui="{ body: 'p-4 sm:p-4' }">
            <p class="section-label mb-2">Code and state</p>
            <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt class="text-xs text-muted">Pack hash</dt>
              <dd><IdChip :id="run.source.packSha256" copy-label="Copy pack hash of the run's code" /></dd>
              <dt class="text-xs text-muted">Files</dt>
              <dd class="tabular-nums">{{ formatCount(run.source.fileCount) }} · <BytesText :bytes="run.source.packBytes" /> packed</dd>
              <template v-if="run.image">
                <dt class="text-xs text-muted">Image</dt>
                <dd class="truncate font-mono text-xs" :title="run.image.ref">{{ run.image.ref }}</dd>
              </template>
              <dt class="text-xs text-muted">Checkpoint</dt>
              <dd>
                <template v-if="run.checkpoint">
                  <BytesText :bytes="run.checkpoint.bytes" /> saved <RelativeTime :value="run.checkpoint.savedAt" />
                </template>
                <span v-else class="text-xs text-dimmed">none</span>
              </dd>
              <dt class="text-xs text-muted">Kept until</dt>
              <dd>
                <RelativeTime v-if="run.expiresAt" :value="run.expiresAt" />
                <span v-else class="text-xs text-dimmed">{{ active ? 'set when the run ends' : 'kept until the script is deleted' }}</span>
              </dd>
            </dl>
          </UCard>
        </div>

        <section class="space-y-2" aria-labelledby="script-run-log-heading">
          <h2 id="script-run-log-heading" class="section-label">Log</h2>
          <UAlert
            v-if="run.log.droppedLines > 0"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="`${plural(run.log.droppedLines, 'log line was', 'log lines were')} dropped`"
            description="The run logged faster than the rate limit, or the log outgrew its size limit (its beginning and end are kept)."
            data-testid="script-run-dropped-lines"
          />
          <UAlert
            v-if="log.truncated.value"
            color="neutral"
            variant="subtle"
            icon="i-lucide-info"
            :title="`Only the last ${formatCount(SCRIPT_RUN_LOG_MAX_LINES)} lines are shown`"
            :description="`scantor scripts runs logs ${run.id} prints the whole log.`"
          />
          <UAlert v-if="log.error.value" color="warning" variant="subtle" icon="i-lucide-triangle-alert" title="The log could not be read" :description="errorMessage(log.error.value)" />
          <LogView
            :lines="log.text.value"
            :error-pattern="SCRIPT_RUN_LOG_ERROR_PATTERN"
            max-height-class="max-h-[32rem]"
            testid="script-run-log"
            :empty-text="active ? 'No output yet.' : 'The run logged nothing.'"
          />
        </section>
      </div>

      <ScriptRunRestartModal
        v-if="run"
        v-model:open="restartOpen"
        :run="run"
        :script="script.data.value ?? null"
        :resume="restartResume"
        @restarted="onRestarted"
      />
    </template>
  </UDashboardPanel>
</template>
