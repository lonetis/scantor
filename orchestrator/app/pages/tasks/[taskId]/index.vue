<script setup lang="ts">
// Task detail (docs/ui.md §5.7, §5.8): header, actions (editor, publish, start scan, git pull, download, delete) and
// the tabs overview, files, revisions and test (`?tab=`). Polls the task every 10 s, every 2 s while its latest
// revision builds.
const route = useRoute()
const router = useRouter()
const toast = useToast()
const { confirm } = useConfirm()
const { features, loadInfo } = useInstance()
const actions = useTaskActions()

loadInfo().catch((cause: unknown) => console.error('[tasks] loading instance info failed', cause))

const taskId = computed(() => String(route.params.taskId))
const detail = useTask(taskId)
const task = detail.task

useHead({ title: () => `${task.value?.name ?? 'Task'} · scantor` })

type Tab = 'overview' | 'files' | 'revisions' | 'test'
const TABS: { label: string; value: Tab; icon: string }[] = [
  { label: 'Overview', value: 'overview', icon: 'i-lucide-info' },
  { label: 'Files', value: 'files', icon: 'i-lucide-folder-tree' },
  { label: 'Revisions', value: 'revisions', icon: 'i-lucide-history' },
  { label: 'Test', value: 'test', icon: 'i-lucide-flask-conical' },
]
const tab = computed<Tab>({
  get: () => (TABS.some((item) => item.value === route.query.tab) ? (route.query.tab as Tab) : 'overview'),
  set: (value) => void router.replace({ query: { ...route.query, tab: value === 'overview' ? undefined : value } }),
})
const fileRevision = computed<string | null>({
  get: () => (typeof route.query.revision === 'string' ? route.query.revision : null),
  set: (value) => void router.replace({ query: { ...route.query, revision: value ?? undefined } }),
})
const created = computed(() => route.query.created === '1')

const revisionState = ref<RevisionState | 'all'>('all')
const revisions = useRevisions(taskId, () => (revisionState.value === 'all' ? null : revisionState.value))
const revisionStateItems = [{ label: 'All states', value: 'all' }, ...REVISION_STATES.map((state) => ({ label: state, value: state }))]
const recentScans = useApiFetch<Page<ScanSummary>>(() => (task.value ? '/api/scans' : null), { query: () => ({ task: taskId.value, limit: 10 }), toast: false })
const recentTestRuns = useApiFetch<Page<TestRun>>(() => (task.value ? `/api/tasks/${taskId.value}/test-runs` : null), { query: { limit: 5 }, toast: false })

/** The latest revision (with its schemas when it is ready), for the test-run forms and the overview. */
const latestRevision = useApiFetch<Revision>(
  () => (task.value?.latestReadyRevision ? `/api/tasks/${taskId.value}/revisions/${task.value.latestReadyRevision.id}` : null),
  { toast: false },
)

const publishOpen = ref(false)
const pulling = ref(false)
const deleting = ref(false)

async function onPublished(revision: Revision): Promise<void> {
  await navigateTo(`/tasks/${taskId.value}/revisions/${revision.number}`)
}

async function pull(force = false): Promise<void> {
  if (!task.value) return
  pulling.value = true
  try {
    const result = await actions.pullGitTask(task.value.id, force)
    detail.task.value = result.task
    toast.add({
      title: result.changed ? `Pulled ${result.commit.slice(0, 8)}` : 'Already up to date',
      color: 'success',
      icon: 'i-lucide-git-pull-request-arrow',
    })
  } catch (cause) {
    const apiError = toApiError(cause)
    if (apiError.code === 'gitDiverged' && !force) {
      const overwrite = await confirm({
        title: 'Overwrite the workspace?',
        description: `Local changes or a non-fast-forward remote. Overwrite the workspace? (The server reports: ${apiError.message}.)`,
        confirmLabel: 'Overwrite workspace',
        confirmColor: 'warning',
      })
      if (overwrite) await pull(true)
      return
    }
    toast.add({ title: errorTitle(apiError.code), description: apiError.message, color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    pulling.value = false
  }
}

async function remove(): Promise<void> {
  if (!task.value) return
  const name = task.value.name
  const confirmed = await confirm({
    title: `Delete ${name}`,
    description: 'The workspace folder, every revision with its images and the test runs are deleted. Scans that already finished keep their results.',
    confirmLabel: 'Delete task',
    typeToConfirm: name,
  })
  if (!confirmed) return
  deleting.value = true
  try {
    await actions.deleteTask(task.value.id)
    toast.add({ title: `Task ${name} is being deleted`, color: 'success', icon: 'i-lucide-trash-2' })
    await navigateTo('/tasks')
  } catch (cause) {
    const apiError = toApiError(cause)
    toast.add({
      title: apiError.code === 'taskInUse' ? 'A scan still uses this task' : errorTitle(apiError.code),
      description: apiError.message,
      color: 'error',
      icon: 'i-lucide-circle-alert',
      actions: apiError.code === 'taskInUse'
        ? [{ label: 'Show active scans', color: 'neutral', variant: 'outline', onClick: () => void navigateTo(`/scans?task=${taskId.value}`) }]
        : undefined,
    })
  } finally {
    deleting.value = false
  }
}

function dismissCreated(): void {
  void router.replace({ query: { ...route.query, created: undefined } })
}
</script>

<template>
  <UDashboardPanel id="task">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #title>
          <TaskHeader v-if="task" :task="task" />
          <span v-else class="font-semibold">Task</span>
        </template>
        <template #right>
          <RefreshButton :loading="detail.refreshing.value" @click="detail.refresh()" />
          <template v-if="task">
            <UButton
              v-if="features.editor"
              :to="`/editor?task=${encodeURIComponent(task.name)}`"
              label="Open in editor"
              aria-label="Open in editor"
              icon="i-lucide-code"
              size="sm"
              color="neutral"
              variant="outline"
              :ui="{ label: 'hidden lg:inline' }"
            />
            <UButton label="Publish revision" aria-label="Publish revision" icon="i-lucide-rocket" size="sm" :ui="{ label: 'hidden lg:inline' }" @click="publishOpen = true" />
            <UButton
              v-if="task.latestReadyRevision"
              :to="`/scans/new?revision=${encodeURIComponent(`${task.id}@latest`)}`"
              label="Start scan"
              aria-label="Start scan"
              icon="i-lucide-play"
              size="sm"
              color="neutral"
              variant="outline"
              :ui="{ label: 'hidden lg:inline' }"
            />
            <UButton
              v-if="task.source.kind === 'git'"
              label="Pull from git"
              aria-label="Pull from git"
              icon="i-lucide-git-pull-request-arrow"
              size="sm"
              color="neutral"
              variant="outline"
              :loading="pulling"
              :ui="{ label: 'hidden lg:inline' }"
              @click="pull()"
            />
            <UButton
              :href="actions.workspaceArchiveUrl(task.id)"
              download
              external
              label="Download workspace"
              aria-label="Download workspace"
              icon="i-lucide-download"
              size="sm"
              color="neutral"
              variant="ghost"
              :ui="{ label: 'hidden xl:inline' }"
            />
            <UButton
              label="Delete task"
              aria-label="Delete task"
              icon="i-lucide-trash-2"
              size="sm"
              color="error"
              variant="ghost"
              :loading="deleting"
              :ui="{ label: 'hidden xl:inline' }"
              @click="remove"
            />
          </template>
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar>
        <UTabs v-model="tab" :items="TABS" :content="false" size="sm" variant="link" />
      </UDashboardToolbar>
    </template>

    <template #body>
      <UAlert
        v-if="detail.error.value"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="detail.error.value.code === 'notFound' ? 'Task not found' : 'The task could not be loaded'"
        :description="errorMessage(detail.error.value)"
      />
      <USkeleton v-if="!task && !detail.error.value" class="h-48 w-full" />

      <template v-if="task">
        <UAlert
          v-if="created"
          color="success"
          variant="subtle"
          icon="i-lucide-party-popper"
          :title="`Task ${task.name} is ready`"
          description="Edit it in the editor, try it with a test run, then publish a revision."
          close
          class="mb-4"
          @update:open="dismissCreated"
        >
          <template #actions>
            <UButton v-if="features.editor" :to="`/editor?task=${encodeURIComponent(task.name)}`" label="Open the editor" size="xs" variant="outline" />
            <UButton label="Try a test run" size="xs" variant="outline" @click="tab = 'test'" />
            <UButton label="Publish now" size="xs" variant="outline" @click="publishOpen = true" />
          </template>
        </UAlert>

        <div v-if="tab === 'overview'" class="space-y-6">
          <p v-if="task.description" class="text-sm">{{ task.description }}</p>
          <div class="grid gap-4 lg:grid-cols-3">
            <TaskWorkspaceCard :task="task" @checked="detail.refresh()" />
            <UCard :ui="{ body: 'p-4 sm:p-4' }">
              <p class="section-label mb-2">Revisions</p>
              <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                <dt class="text-xs text-muted">Latest</dt>
                <dd>
                  <NuxtLink v-if="task.latestRevision" :to="`/tasks/${task.id}/revisions/${task.latestRevision.number}`" class="flex items-center gap-1 hover:underline">
                    <span class="font-mono text-xs">@{{ task.latestRevision.number }}</span>
                    <StatusBadge kind="revision" :state="task.latestRevision.state" />
                  </NuxtLink>
                  <span v-else class="text-xs text-dimmed">none</span>
                </dd>
                <dt class="text-xs text-muted">Latest ready</dt>
                <dd>
                  <NuxtLink v-if="task.latestReadyRevision" :to="`/tasks/${task.id}/revisions/${task.latestReadyRevision.number}`" class="font-mono text-xs hover:underline">
                    {{ task.name }}@{{ task.latestReadyRevision.number }}
                  </NuxtLink>
                  <span v-else class="text-xs text-dimmed">none</span>
                </dd>
                <dt class="text-xs text-muted">Published</dt>
                <dd class="tabular-nums">{{ task.revisionCount }}</dd>
              </dl>
            </UCard>
            <UCard :ui="{ body: 'p-4 sm:p-4' }">
              <p class="section-label mb-2">Source</p>
              <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                <dt class="text-xs text-muted">Kind</dt>
                <dd>{{ task.source.kind }}</dd>
                <template v-if="task.source.template">
                  <dt class="text-xs text-muted">Template</dt>
                  <dd class="font-mono text-xs">{{ task.source.template }}</dd>
                </template>
                <template v-if="task.source.git">
                  <dt class="text-xs text-muted">Repository</dt>
                  <dd class="truncate font-mono text-xs" :title="task.source.git.url">{{ task.source.git.url }}</dd>
                  <dt class="text-xs text-muted">Ref / path</dt>
                  <dd class="font-mono text-xs">{{ task.source.git.ref }} · {{ task.source.git.path }}</dd>
                  <dt class="text-xs text-muted">Commit</dt>
                  <dd><IdChip :id="task.source.git.commit" copy-label="Copy commit" /></dd>
                  <dt class="text-xs text-muted">Pulled</dt>
                  <dd><RelativeTime :value="task.source.git.pulledAt" /></dd>
                </template>
              </dl>
            </UCard>
          </div>
          <section class="space-y-2" aria-labelledby="task-scans-heading">
            <h2 id="task-scans-heading" class="section-label">Recent scans</h2>
            <ScanTable
              :scans="recentScans.data.value?.items ?? []"
              :loading="recentScans.pending.value"
              compact
              label="Recent scans"
              empty="No scans of this task yet."
            />
          </section>
          <section class="space-y-2" aria-labelledby="task-test-runs-heading">
            <div class="flex items-center justify-between">
              <h2 id="task-test-runs-heading" class="section-label">Recent test runs</h2>
              <UButton label="Open test runs" size="xs" color="neutral" variant="ghost" @click="tab = 'test'" />
            </div>
            <ul v-if="(recentTestRuns.data.value?.items ?? []).length > 0" class="divide-y divide-default rounded-md border border-default text-sm">
              <li v-for="testRun in recentTestRuns.data.value?.items ?? []" :key="testRun.id" class="flex flex-wrap items-center gap-2 px-3 py-2">
                <StatusBadge kind="testRun" :state="testRun.state" />
                <span class="text-xs tabular-nums">{{ testRun.summary.succeeded }} / {{ testRun.summary.analyses }} succeeded</span>
                <RelativeTime :value="testRun.createdAt" class="ms-auto" />
              </li>
            </ul>
            <p v-else class="text-xs text-dimmed">No test runs yet.</p>
          </section>
        </div>

        <TaskFilesBrowser
          v-else-if="tab === 'files'"
          v-model:revision="fileRevision"
          :task="task"
          :revisions="revisions.items.value"
          :editor-enabled="features.editor"
        />

        <div v-else-if="tab === 'revisions'" class="space-y-3">
          <USelect v-model="revisionState" :items="revisionStateItems" size="sm" class="w-40" aria-label="Revision state" />
          <RevisionTable :task-id="task.id" :revisions="revisions.items.value" :loading="revisions.loading.value && !revisions.loaded.value" />
          <LoadMoreButton :has-more="revisions.hasMore.value" :loading="revisions.loading.value" @load="revisions.loadMore()" />
        </div>

        <TestRunPanel
          v-else-if="tab === 'test'"
          :task="task"
          :revision-description="latestRevision.data.value?.description ?? null"
          :manifest-timeout-ms="latestRevision.data.value?.settingsDefaults?.timeoutMs ?? null"
        />

        <PublishModal v-model:open="publishOpen" :task="task" @published="onPublished" />
      </template>
    </template>
  </UDashboardPanel>
</template>
