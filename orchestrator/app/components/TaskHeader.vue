<script setup lang="ts">
// The title block of the task page (docs/ui.md §5.7): name, language, source (git: url@ref:path and short commit),
// privileged, "Unpublished changes" and the latest revision with its state.
defineProps<{ task: Task }>()
</script>

<template>
  <div class="flex min-w-0 flex-wrap items-center gap-2">
    <UButton to="/tasks" icon="i-lucide-arrow-left" color="neutral" variant="ghost" size="xs" aria-label="Back to tasks" />
    <span class="truncate font-mono font-semibold">{{ task.name }}</span>
    <UBadge :label="task.language" color="neutral" variant="soft" size="xs" />
    <UTooltip v-if="task.source.git" :text="`${task.source.git.url}@${task.source.git.ref}:${task.source.git.path}`">
      <UBadge color="neutral" variant="outline" size="xs" icon="i-lucide-git-branch" :label="`git · ${task.source.git.commit.slice(0, 8)}`" />
    </UTooltip>
    <UBadge v-else :label="task.source.kind" color="neutral" variant="outline" size="xs" />
    <UBadge v-if="task.privileged" label="privileged" color="warning" variant="outline" size="xs" icon="i-lucide-shield-alert" />
    <UTooltip v-if="task.workspace.dirty" text="The workspace differs from the latest revision">
      <UBadge label="Unpublished changes" color="warning" variant="subtle" size="xs" icon="i-lucide-circle-dot" data-testid="unpublished-badge" />
    </UTooltip>
    <NuxtLink
      v-if="task.latestRevision"
      :to="`/tasks/${task.id}/revisions/${task.latestRevision.number}`"
      class="flex items-center gap-1 text-xs hover:underline"
    >
      <span class="font-mono">{{ task.name }}@{{ task.latestRevision.number }}</span>
      <StatusBadge kind="revision" :state="task.latestRevision.state" />
    </NuxtLink>
  </div>
</template>
