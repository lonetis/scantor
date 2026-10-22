<script setup lang="ts">
// Revision selection of the new-scan form (docs/ui.md §5.12 step 1): task → "latest" or a ready revision →
// getRevision, then the revision's language, schedule, privileged flag and whether the caller may run it.
const props = defineProps<{
  /** a revision reference to preselect (`?revision=<task>@<N>`, `<task>@latest` or `<task>`) */
  initialRef?: string | null
}>()
const emit = defineEmits<{ change: [revision: Revision | null] }>()

const LATEST = 'latest'
const LIST_LIMIT = 200

const api = useApi()
const { account, load: loadAccount } = useCurrentUser()

const tasks = shallowRef<Task[]>([])
const revisions = shallowRef<RevisionSummary[]>([])
const revision = shallowRef<Revision | null>(null)
const taskId = ref<string | undefined>(undefined)
const revisionChoice = ref<string>(LATEST)
const loadingTasks = ref(false)
const loadingRevision = ref(false)
const problem = ref<string | null>(null)

const taskItems = computed(() => tasks.value.map((task) => ({ label: task.name, value: task.id, description: task.language })))
const revisionItems = computed(() => [
  { label: 'latest ready revision', value: LATEST },
  ...revisions.value.map((summary) => ({ label: `@${summary.number}`, value: String(summary.number) })),
])

function parseRef(ref: string): { task: string, revision: string } {
  const at = ref.lastIndexOf('@')
  return at > 0 ? { task: ref.slice(0, at), revision: ref.slice(at + 1) || LATEST } : { task: ref, revision: LATEST }
}

async function loadTasks(): Promise<void> {
  loadingTasks.value = true
  try {
    tasks.value = (await api<Page<Task>>('/api/tasks', { query: { limit: LIST_LIMIT } })).items
  } finally {
    loadingTasks.value = false
  }
}

async function loadRevisions(id: string): Promise<void> {
  revisions.value = (await api<Page<RevisionSummary>>(`/api/tasks/${encodeURIComponent(id)}/revisions`, { query: { state: 'ready', limit: LIST_LIMIT } })).items
}

async function loadRevision(): Promise<void> {
  const id = taskId.value
  revision.value = null
  problem.value = null
  emit('change', null)
  if (!id) return
  loadingRevision.value = true
  try {
    const loaded = await api<Revision>(`/api/tasks/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionChoice.value)}`, { toast: false })
    if (id !== taskId.value) return
    if (loaded.state !== 'ready' || !loaded.description) {
      problem.value = `Revision @${loaded.number} is ${loaded.state}; only ready revisions can be scanned.`
      return
    }
    revision.value = loaded
    emit('change', loaded)
  } catch (cause) {
    const error = toApiError(cause)
    problem.value = error.code === 'notFound' ? 'This task has no ready revision yet. Publish one first.' : error.message
  } finally {
    loadingRevision.value = false
  }
}

watch(taskId, async (id) => {
  revisions.value = []
  if (id) await loadRevisions(id).catch(() => {})
  await loadRevision()
})
watch(revisionChoice, () => void loadRevision())

onMounted(async () => {
  void loadAccount().catch(() => {})
  await loadTasks().catch(() => {})
  if (!props.initialRef) return
  const parsed = parseRef(props.initialRef)
  const task = tasks.value.find((candidate) => candidate.name === parsed.task || candidate.id === parsed.task)
  if (!task) {
    problem.value = `Task ${parsed.task} was not found among your tasks.`
    return
  }
  revisionChoice.value = /^\d+$/.test(parsed.revision) ? parsed.revision : LATEST
  taskId.value = task.id
})

const blocked = computed(() => revision.value?.privileged === true && account.value !== null && !account.value.canRunPrivileged)
defineExpose({ blocked })
</script>

<template>
  <div class="space-y-3">
    <div class="grid gap-3 sm:grid-cols-2">
      <UFormField label="Task" name="revision" required>
        <USelectMenu
          v-model="taskId"
          :items="taskItems"
          value-key="value"
          :loading="loadingTasks"
          placeholder="Select a task"
          :search-input="{ placeholder: 'Search tasks…' }"
          class="w-full"
          aria-label="Task"
        />
      </UFormField>
      <UFormField label="Revision">
        <USelect v-model="revisionChoice" :items="revisionItems" :disabled="!taskId" class="w-full" aria-label="Revision" />
      </UFormField>
    </div>

    <UAlert v-if="problem" color="warning" variant="subtle" icon="i-lucide-triangle-alert" :description="problem" />
    <div v-else-if="loadingRevision" class="text-sm text-muted">Loading the revision…</div>
    <div v-else-if="revision" class="flex flex-wrap items-center gap-2 text-sm">
      <NuxtLink :to="`/tasks/${revision.taskId}/revisions/${revision.number}`" class="font-mono font-medium hover:underline">{{ revision.ref }}</NuxtLink>
      <UBadge :label="revision.language ?? 'unknown'" color="neutral" variant="subtle" size="xs" />
      <UBadge
        :label="revision.description?.schedule.kind === 'template' ? `template: ${revision.description.schedule.template}` : 'custom schedule'"
        color="neutral"
        variant="subtle"
        size="xs"
      />
      <UBadge v-if="revision.privileged" label="privileged" color="warning" variant="subtle" size="xs" icon="i-lucide-shield-alert" />
      <span class="text-xs text-dimmed">published <RelativeTime :value="revision.createdAt" /></span>
    </div>
    <UAlert
      v-if="blocked"
      color="error"
      variant="subtle"
      icon="i-lucide-shield-alert"
      title="Privileged revision"
      description="This revision runs Docker-in-Docker. Starting it needs the canRunPrivileged permission, which an admin grants."
    />
  </div>
</template>
