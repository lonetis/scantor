<script setup lang="ts">
// Editor (docs/ui.md §5.10): the caller's code-server, embedded from the separate editor origin. Every iframe load
// and every new tab uses a fresh one-time session URL (createEditorSession; valid 60 s, single use). `?task=<name>`
// opens that task's folder. Visiting the page opens the editor, unless its last start failed (then the error and
// "Retry" are shown) or the user stopped it here.
useHead({ title: 'Editor · scantor' })

type Phase = 'loading' | 'starting' | 'ready' | 'stopped' | 'failed' | 'busy' | 'taskMissing'

const route = useRoute()
const toast = useToast()
const { confirm } = useConfirm()
const { status, state, live, stopping, pollIntervalMs, load, openSession, stop } = useEditor()

const phase = ref<Phase>('loading')
const frameUrl = ref<string | null>(null)
/** `startedAt` of the editor the iframe was signed in to; a restart elsewhere invalidates its cookie */
const frameStartedAt = ref<string | null>(null)
const failure = ref<string | null>(null)
const opening = ref(false)

const task = computed(() => (typeof route.query.task === 'string' && route.query.task !== '' ? route.query.task : null))
const idleText = computed(() => idleTimeoutText(status.value?.idleTimeoutMs))

function fail(error: unknown): void {
  const apiError = toApiError(error)
  if (apiError.code === 'tooManyRequests') {
    phase.value = 'busy'
    return
  }
  // `?task=` names no task of the caller: retrying cannot help, opening the workspace root can.
  if (apiError.code === 'notFound' && task.value) {
    phase.value = 'taskMissing'
    return
  }
  failure.value = apiError.message
  phase.value = 'failed'
}

/** Starts the editor if needed; mounts the iframe once it runs (a starting editor is picked up by the poll). */
async function open(): Promise<void> {
  if (opening.value) return
  opening.value = true
  failure.value = null
  try {
    const session = await openSession(task.value)
    if (session.editor.state === 'running') {
      frameUrl.value = session.url
      frameStartedAt.value = session.editor.startedAt
      phase.value = 'ready'
    } else {
      frameUrl.value = null
      phase.value = 'starting'
    }
  } catch (error) {
    fail(error)
  } finally {
    opening.value = false
  }
}

async function poll(): Promise<void> {
  const current = await load({ background: true })
  if (phase.value === 'starting' && current.state === 'running') {
    await open()
  } else if (phase.value === 'starting' && current.state === 'stopped') {
    failure.value = current.error ?? 'The editor stopped while it was starting.'
    phase.value = 'failed'
  } else if (phase.value === 'ready' && (current.state === 'stopped' || current.state === 'stopping')) {
    frameUrl.value = null
    phase.value = 'stopped'
  } else if (phase.value === 'ready' && current.state === 'running' && current.startedAt !== frameStartedAt.value) {
    // Restarted elsewhere (another tab, the account page): sign the frame in to the new editor.
    await open()
  } else if (phase.value === 'ready' && current.state === 'starting') {
    frameUrl.value = null
    phase.value = 'starting'
  }
}

usePoll(poll, { intervalMs: pollIntervalMs, enabled: () => phase.value === 'starting' || phase.value === 'ready', immediate: false })

onMounted(async () => {
  try {
    const current = await load()
    if (current.state === 'stopped' && current.error) {
      failure.value = current.error
      phase.value = 'failed'
      return
    }
    await open()
  } catch (error) {
    fail(error)
  }
})

async function openWorkspace(): Promise<void> {
  await navigateTo({ path: '/editor' }, { replace: true })
  await open()
}

async function openInNewTab(): Promise<void> {
  try {
    const session = await openSession(task.value)
    window.open(session.url, '_blank', 'noopener')
    if (phase.value !== 'ready' && session.editor.state === 'starting') phase.value = 'starting'
  } catch (error) {
    fail(error)
  }
}

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
    frameUrl.value = null
    phase.value = 'stopped'
    toast.add({ title: 'Editor stopped', color: 'success', icon: 'i-lucide-check' })
  } catch (error) {
    // The central fetch wrapper already showed the error.
    console.error('[editor] stopping failed', error)
  }
}
</script>

<template>
  <UDashboardPanel id="editor" :ui="{ body: 'p-0 sm:p-0 gap-0 sm:gap-0 overflow-hidden' }">
    <template #header>
      <UDashboardNavbar title="Editor">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #trailing>
          <StatusBadge v-if="state" kind="editor" :state="state" />
          <span v-if="idleText" class="hidden text-xs text-muted sm:inline">{{ idleText }}</span>
        </template>
        <template #right>
          <UButton
            label="Open in new tab"
            icon="i-lucide-external-link"
            color="neutral"
            variant="ghost"
            size="sm"
            :disabled="phase === 'loading' || opening"
            @click="openInNewTab"
          />
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
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <iframe
        v-if="phase === 'ready' && frameUrl"
        :key="frameUrl"
        :src="frameUrl"
        title="Editor"
        allow="clipboard-read; clipboard-write"
        class="size-full min-h-0 flex-1 border-0 bg-default"
      />

      <div v-else class="flex flex-1 items-center justify-center p-6">
        <div v-if="phase === 'loading' || phase === 'starting'" class="flex flex-col items-center gap-3 text-center" role="status">
          <UIcon name="i-lucide-loader-circle" class="size-8 text-dimmed motion-safe:animate-spin" aria-hidden="true" />
          <p class="text-sm text-muted">{{ phase === 'starting' ? 'Editor is starting…' : 'Loading the editor…' }}</p>
          <p v-if="phase === 'starting'" class="max-w-sm text-xs text-dimmed">The first start can take a minute while the editor image is prepared.</p>
        </div>

        <UAlert
          v-else-if="phase === 'busy'"
          class="max-w-lg"
          color="warning"
          variant="subtle"
          icon="i-lucide-users"
          title="Too many editors are running; try again later"
          description="Every editor slot of this instance is in use. Editors stop by themselves when they are idle."
          :actions="[{ label: 'Retry', color: 'neutral', variant: 'outline', loading: opening, onClick: () => { void open() } }]"
        />

        <UAlert
          v-else-if="phase === 'taskMissing'"
          class="max-w-lg"
          color="warning"
          variant="subtle"
          icon="i-lucide-folder-x"
          :title="`Task “${task}” was not found`"
          description="None of your tasks has this name. Open the editor on your whole workspace instead."
          :actions="[{ label: 'Open workspace', color: 'neutral', variant: 'outline', loading: opening, onClick: () => { void openWorkspace() } }]"
        />

        <UAlert
          v-else-if="phase === 'failed'"
          class="max-w-lg"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          title="The editor could not start"
          :description="failure ?? undefined"
          :actions="[{ label: 'Retry', color: 'neutral', variant: 'outline', loading: opening, onClick: () => { void open() } }]"
        />

        <EmptyState
          v-else
          icon="i-lucide-code"
          title="The editor is stopped"
          description="Open it to edit your tasks in the browser. Your workspace files are kept while it is stopped."
          action-label="Open editor"
          action-icon="i-lucide-play"
          @action="open"
        />
      </div>
    </template>
  </UDashboardPanel>
</template>
