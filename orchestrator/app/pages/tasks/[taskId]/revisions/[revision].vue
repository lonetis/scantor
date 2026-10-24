<script setup lang="ts">
// Revision detail (docs/ui.md §5.9): header with ref, state, message and timings; actions "Start scan", "Download
// source" and "View files"; the errors of a failed build first; the live build log; the facts and, for ready
// revisions, the describe output. Polls every second while the revision is queued or building.
const route = useRoute()
const taskId = computed(() => String(route.params.taskId))
const revisionRef = computed(() => String(route.params.revision))
const detail = useRevision(taskId, revisionRef)
const revision = detail.revision
const active = computed(() => isRevisionActive(revision.value?.state))
const buildLog = useBuildLog(taskId, revisionRef, active)

useHead({ title: () => `${revision.value?.ref ?? 'Revision'} · scantor` })

const duration = computed(() => {
  const current = revision.value
  if (!current?.startedAt) return null
  return (current.finishedAt ? Date.parse(current.finishedAt) : Date.now()) - Date.parse(current.startedAt)
})
const settingsDefaults = computed(() => (revision.value?.settingsDefaults ?? null) as Record<string, unknown> | null)
const sourceUrl = computed(() => `/api/tasks/${encodeURIComponent(taskId.value)}/revisions/${encodeURIComponent(revisionRef.value)}/source?redirect=true`)
</script>

<template>
  <UDashboardPanel id="task-revision">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <SidebarCollapseButton />
        </template>
        <template #title>
          <div class="flex min-w-0 items-center gap-2">
            <UButton :to="`/tasks/${taskId}?tab=revisions`" icon="i-lucide-arrow-left" color="neutral" variant="ghost" size="xs" aria-label="Back to the task" />
            <span class="font-mono font-semibold">{{ revision?.ref ?? 'Revision' }}</span>
            <StatusBadge v-if="revision" kind="revision" :state="revision.state" />
            <UBadge v-if="revision?.privileged" label="privileged" color="warning" variant="outline" size="xs" icon="i-lucide-shield-alert" />
          </div>
        </template>
        <template #right>
          <RefreshButton :loading="detail.refreshing.value" @click="detail.refresh()" />
          <template v-if="revision">
            <UButton
              v-if="revision.state === 'ready'"
              :to="`/scans/new?revision=${encodeURIComponent(`${revision.taskId}@${revision.number}`)}`"
              label="Start scan"
              icon="i-lucide-play"
              size="sm"
            />
            <UButton :href="sourceUrl" external label="Download source" icon="i-lucide-download" size="sm" color="neutral" variant="outline" />
            <UButton :to="`/tasks/${taskId}?tab=files&revision=${revision.number}`" label="View files" icon="i-lucide-folder-tree" size="sm" color="neutral" variant="ghost" />
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
        :title="detail.error.value.code === 'notFound' ? 'Revision not found' : 'The revision could not be loaded'"
        :description="errorMessage(detail.error.value)"
      />
      <USkeleton v-if="!revision && !detail.error.value" class="h-48 w-full" />

      <div v-if="revision" class="space-y-6">
        <div class="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted">
          <span v-if="revision.message" class="text-sm text-default">{{ revision.message }}</span>
          <span>created <RelativeTime :value="revision.createdAt" /></span>
          <span v-if="revision.startedAt">started <RelativeTime :value="revision.startedAt" /></span>
          <span v-if="revision.finishedAt">finished <RelativeTime :value="revision.finishedAt" /></span>
          <span v-if="duration !== null">build <DurationText :ms="duration" /></span>
        </div>

        <BuildErrors v-if="revision.state === 'failed'" :errors="revision.errors" />

        <section class="space-y-2" aria-labelledby="revision-log-heading">
          <h2 id="revision-log-heading" class="section-label">Build log</h2>
          <UAlert v-if="buildLog.error.value" color="warning" variant="subtle" icon="i-lucide-triangle-alert" title="The build log could not be read" :description="errorMessage(buildLog.error.value)" />
          <BuildLog :lines="buildLog.lines.value" :complete="buildLog.complete.value" />
        </section>

        <section class="space-y-2" aria-labelledby="revision-facts-heading">
          <h2 id="revision-facts-heading" class="section-label">Facts</h2>
          <UCard :ui="{ body: 'p-4 sm:p-4' }">
            <RevisionFacts :revision="revision" />
          </UCard>
        </section>

        <section v-if="revision.description" class="space-y-2" aria-labelledby="revision-describe-heading">
          <h2 id="revision-describe-heading" class="section-label">Describe</h2>
          <DescribeView
            :description="revision.description"
            :settings-defaults="settingsDefaults"
            :manifest="revision.manifest ?? null"
          />
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
