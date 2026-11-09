<script setup lang="ts">
// Script detail: header, actions (editor, run, download, delete) and the tabs overview, files and runs (`?tab=`). The
// runs tab holds the run form (prefilled by `?scan=<scanId>` from the scan page's "Run script") and the run history.
// Polls the script every 10 s, every 3 s while its latest run is active.
const route = useRoute()
const router = useRouter()
const toast = useToast()
const { confirm } = useConfirm()
const { isAdmin } = useAuth()
const { features, loadInfo } = useInstance()
const actions = useScriptActions()

loadInfo().catch((cause: unknown) => console.error('[scripts] loading instance info failed', cause))

const scriptId = computed(() => String(route.params.scriptId))
const detail = useScript(scriptId)
const script = detail.script

useHead({ title: () => `${script.value?.name ?? 'Script'} · scantor` })

type Tab = 'overview' | 'files' | 'runs'
const TABS: { label: string; value: Tab; icon: string }[] = [
  { label: 'Overview', value: 'overview', icon: 'i-lucide-info' },
  { label: 'Files', value: 'files', icon: 'i-lucide-folder-tree' },
  { label: 'Runs', value: 'runs', icon: 'i-lucide-history' },
]
const tab = computed<Tab>({
  get: () => (TABS.some((item) => item.value === route.query.tab) ? (route.query.tab as Tab) : 'overview'),
  set: (value) => void router.replace({ query: { ...route.query, tab: value === 'overview' ? undefined : value } }),
})
const created = computed(() => route.query.created === '1')
/** `?scan=<id>[,<id>…]`: scans the run form preselects. */
const initialScans = computed(() => {
  const value = route.query.scan
  const values = (Array.isArray(value) ? value : [value]).filter((entry): entry is string => typeof entry === 'string')
  return [...new Set(values.flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter((entry) => entry !== ''))]
})

const runs = useScriptRuns(scriptId, { enabled: () => tab.value === 'runs' && script.value !== null })
// A run that starts or settles (seen on the polled script) re-reads the history.
watch(() => (script.value?.latestRun ? `${script.value.latestRun.id}:${script.value.latestRun.state}` : null), (version, previous) => {
  if (previous === undefined || version === previous || !runs.loaded.value) return
  runs.refresh({ background: true }).catch((cause: unknown) => console.error('[scripts] reloading the runs failed', cause))
})

async function refresh(): Promise<void> {
  const reloadRuns = runs.loaded.value ? runs.refresh().catch((cause: unknown) => console.error('[scripts] reloading the runs failed', cause)) : Promise.resolve()
  await Promise.all([detail.refresh(), reloadRuns])
}

const editorTo = computed(() => (features.value.editor && script.value ? `/editor?script=${encodeURIComponent(script.value.name)}` : null))
const filesKey = computed(() => script.value?.id ?? '')
const listFiles = () => actions.listFiles(scriptId.value, { path: '', recursive: true })
const readFile = (path: string) => actions.readFile(scriptId.value, path)
const deleting = ref(false)

async function onStarted(run: ScriptRun): Promise<void> {
  await navigateTo(`/scripts/${run.scriptId}/runs/${run.id}`)
}

async function remove(): Promise<void> {
  if (!script.value) return
  const name = script.value.name
  const confirmed = await confirm({
    title: `Delete ${name}`,
    description: 'Active runs are cancelled. The script folder, every run with its log, result and output files, and the built images are deleted.',
    confirmLabel: 'Delete script',
    typeToConfirm: name,
  })
  if (!confirmed) return
  deleting.value = true
  try {
    await actions.deleteScript(script.value.id)
    toast.add({ title: `Script ${name} is being deleted`, color: 'success', icon: 'i-lucide-trash-2' })
    await navigateTo('/scripts')
  } catch (cause) {
    const apiError = toApiError(cause)
    toast.add({ title: errorTitle(apiError.code), description: apiError.message, color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    deleting.value = false
  }
}

function dismissCreated(): void {
  void router.replace({ query: { ...route.query, created: undefined } })
}

const describe = computed(() => script.value?.describe ?? null)
const describeCurrent = computed(() => describe.value !== null && describe.value.packSha256 === script.value?.workspace.packSha256)
</script>

<template>
  <UDashboardPanel id="script">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <SidebarCollapseButton />
        </template>
        <template #title>
          <div v-if="script" class="flex min-w-0 flex-wrap items-center gap-2">
            <UButton to="/scripts" icon="i-lucide-arrow-left" color="neutral" variant="ghost" size="xs" aria-label="Back to the scripts" />
            <span class="truncate font-mono font-semibold">{{ script.name }}</span>
            <UBadge :label="script.language" color="neutral" variant="soft" size="xs" />
            <StatusBadge v-if="script.latestRun" kind="scriptRun" :state="script.latestRun.state" />
          </div>
          <span v-else class="font-semibold">Script</span>
        </template>
        <template #right>
          <RefreshButton :loading="detail.refreshing.value || runs.refreshing.value" @click="refresh()" />
          <template v-if="script">
            <UButton
              v-if="editorTo"
              :to="editorTo"
              label="Open in editor"
              aria-label="Open in editor"
              icon="i-lucide-code"
              size="sm"
              color="neutral"
              variant="outline"
              :ui="{ label: 'hidden lg:inline' }"
            />
            <UButton
              label="Run script"
              aria-label="Run script"
              icon="i-lucide-play"
              size="sm"
              :ui="{ label: 'hidden lg:inline' }"
              @click="tab = 'runs'"
            />
            <UButton
              :href="actions.workspaceArchiveUrl(script.id)"
              download
              external
              label="Download script"
              aria-label="Download script"
              icon="i-lucide-download"
              size="sm"
              color="neutral"
              variant="ghost"
              :ui="{ label: 'hidden xl:inline' }"
            />
            <UButton
              label="Delete script"
              aria-label="Delete script"
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
        <UTabs v-model="tab" :items="TABS" :content="false" size="sm" variant="link" aria-label="Script tabs" />
      </UDashboardToolbar>
    </template>

    <template #body>
      <UAlert
        v-if="detail.error.value"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="detail.error.value.code === 'notFound' ? 'Script not found' : 'The script could not be loaded'"
        :description="errorMessage(detail.error.value)"
      />
      <USkeleton v-if="!script && !detail.error.value" class="h-48 w-full" />

      <template v-if="script">
        <UAlert
          v-if="created"
          color="success"
          variant="subtle"
          icon="i-lucide-party-popper"
          :title="`Script ${script.name} is ready`"
          description="It starts as a working example. Edit it in the editor, then try it on a scan."
          close
          class="mb-4"
          @update:open="dismissCreated"
        >
          <template #actions>
            <UButton v-if="editorTo" :to="editorTo" label="Open the editor" size="xs" variant="outline" />
            <UButton label="Try it on a scan" size="xs" variant="outline" @click="tab = 'runs'" />
          </template>
        </UAlert>

        <div v-if="tab === 'overview'" class="space-y-6">
          <p v-if="script.description" class="text-sm">{{ script.description }}</p>
          <div class="grid gap-4 lg:grid-cols-3">
            <UCard :ui="{ body: 'p-4 sm:p-4' }">
              <p class="section-label mb-2">Folder</p>
              <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                <dt class="text-xs text-muted">Files</dt>
                <dd class="tabular-nums">{{ formatCount(script.workspace.fileCount) }}</dd>
                <dt class="text-xs text-muted">Size</dt>
                <dd><BytesText :bytes="script.workspace.bytes" /></dd>
                <dt class="text-xs text-muted">Pack hash</dt>
                <dd>
                  <IdChip v-if="script.workspace.packSha256" :id="script.workspace.packSha256" copy-label="Copy pack hash" />
                  <span v-else class="text-xs text-dimmed">unknown</span>
                </dd>
                <dt class="text-xs text-muted">Checked</dt>
                <dd>
                  <RelativeTime v-if="script.workspace.checkedAt" :value="script.workspace.checkedAt" />
                  <span v-else class="text-xs text-dimmed">never</span>
                </dd>
              </dl>
            </UCard>
            <UCard :ui="{ body: 'p-4 sm:p-4' }">
              <p class="section-label mb-2">Latest run</p>
              <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                <dt class="text-xs text-muted">State</dt>
                <dd>
                  <NuxtLink v-if="script.latestRun" :to="`/scripts/${script.id}/runs/${script.latestRun.id}`" class="hover:underline">
                    <StatusBadge kind="scriptRun" :state="script.latestRun.state" />
                  </NuxtLink>
                  <span v-else class="text-xs text-dimmed">none</span>
                </dd>
                <template v-if="script.latestRun">
                  <dt class="text-xs text-muted">Started</dt>
                  <dd><RelativeTime :value="script.latestRun.createdAt" /></dd>
                  <dt class="text-xs text-muted">Finished</dt>
                  <dd>
                    <RelativeTime v-if="script.latestRun.finishedAt" :value="script.latestRun.finishedAt" />
                    <span v-else class="text-xs text-dimmed">not yet</span>
                  </dd>
                </template>
              </dl>
            </UCard>
            <UCard :ui="{ body: 'p-4 sm:p-4' }">
              <p class="section-label mb-2">Source</p>
              <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                <dt class="text-xs text-muted">Kind</dt>
                <dd>{{ script.source.kind }}</dd>
                <dt class="text-xs text-muted">Created</dt>
                <dd><RelativeTime :value="script.createdAt" /></dd>
                <template v-if="isAdmin">
                  <dt class="text-xs text-muted">Owner</dt>
                  <dd><IdChip :id="script.userId" copy-label="Copy owner id" /></dd>
                </template>
              </dl>
            </UCard>
          </div>

          <section class="space-y-2" aria-labelledby="script-recent-runs-heading">
            <div class="flex items-center justify-between">
              <h2 id="script-recent-runs-heading" class="section-label">Recent runs</h2>
              <UButton label="Open runs" size="xs" color="neutral" variant="ghost" @click="tab = 'runs'" />
            </div>
            <ul v-if="(script.recentRuns ?? []).length > 0" class="divide-y divide-default rounded-md border border-default text-sm">
              <li v-for="run in script.recentRuns ?? []" :key="run.id">
                <NuxtLink :to="`/scripts/${script.id}/runs/${run.id}`" class="flex flex-wrap items-center gap-2 px-3 py-2 hover:bg-elevated">
                  <StatusBadge kind="scriptRun" :state="run.state" />
                  <span v-if="run.progress" class="text-xs tabular-nums text-muted">
                    {{ formatCount(run.progress.done) }}<template v-if="run.progress.total !== null"> / {{ formatCount(run.progress.total) }}</template>
                  </span>
                  <span v-if="run.progress?.message" class="min-w-0 flex-1 truncate text-xs text-muted">{{ stripEscapes(run.progress.message) }}</span>
                  <RelativeTime :value="run.createdAt" class="ms-auto" />
                </NuxtLink>
              </li>
            </ul>
            <p v-else class="text-xs text-dimmed">No runs yet.</p>
          </section>

          <section class="space-y-2" aria-labelledby="script-describe-heading">
            <h2 id="script-describe-heading" class="section-label">Schemas</h2>
            <template v-if="describe">
              <p class="text-xs text-muted">
                Reported by the code <IdChip :id="describe.packSha256" copy-label="Copy pack hash of the described code" />
                <RelativeTime :value="describe.at" />.
                <span v-if="!describeCurrent">The folder changed since then; the run form uses JSON until a run of the current code reports again.</span>
              </p>
              <div class="grid gap-4 lg:grid-cols-2">
                <div class="space-y-1">
                  <p class="text-xs font-medium">Config</p>
                  <SchemaTable v-if="describe.configSchema" :schema="describe.configSchema" label="Config schema" />
                  <p v-else class="text-xs text-dimmed">The script takes no config.</p>
                </div>
                <div class="space-y-1">
                  <p class="text-xs font-medium">Result</p>
                  <SchemaTable v-if="describe.resultSchema" :schema="describe.resultSchema" label="Result schema" />
                  <p v-else class="text-xs text-dimmed">The script declares no result model.</p>
                </div>
              </div>
            </template>
            <p v-else class="text-xs text-dimmed">The schemas appear after the first run: the code reports its config and result models when it starts.</p>
          </section>
        </div>

        <FilesBrowser
          v-else-if="tab === 'files'"
          :folder-key="filesKey"
          :list="listFiles"
          :read="readFile"
          tree-label="Script files"
          :editor-to="editorTo"
        />

        <div v-else-if="tab === 'runs'" class="grid gap-4 xl:grid-cols-[minmax(22rem,30rem)_1fr]">
          <UCard :ui="{ body: 'p-4 sm:p-4' }">
            <ScriptRunForm :script="script" :initial-scans="initialScans" @started="onStarted" />
          </UCard>
          <section class="min-w-0 space-y-2" aria-labelledby="script-runs-heading">
            <h2 id="script-runs-heading" class="section-label">History</h2>
            <UAlert v-if="runs.error.value" color="error" variant="subtle" icon="i-lucide-circle-alert" title="Runs could not be loaded" :description="errorMessage(runs.error.value)" />
            <ScriptRunsTable :runs="runs.items.value" :loading="runs.loading.value && !runs.loaded.value" label="Script run history" />
            <LoadMoreButton :has-more="runs.hasMore.value" :loading="runs.loading.value" @load="runs.loadMore()" />
          </section>
        </div>
      </template>
    </template>
  </UDashboardPanel>
</template>
