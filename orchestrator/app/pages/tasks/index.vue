<script setup lang="ts">
import { refDebounced } from '@vueuse/core'

// Tasks list (docs/ui.md §5.5): search, language filter, an admin-only "Only mine" switch, the table and "Load
// more". Polls every 30 s while visible.
useHead({ title: 'Tasks · scantor' })

const { user, isAdmin } = useAuth()
const { languages } = useLanguages()

const search = ref('')
const debouncedSearch = refDebounced(search, 300)
const language = ref<string>('all')
const onlyMine = ref(false)

const filters = computed<TaskFilters>(() => ({
  q: debouncedSearch.value,
  language: language.value === 'all' ? null : language.value,
  userId: isAdmin.value && onlyMine.value ? (user.value?.id ?? null) : null,
}))
const tasks = useTasks(filters)

const languageItems = computed(() => [
  { label: 'All languages', value: 'all' },
  ...(languages.value ?? []).map((item) => ({ label: item.title, value: item.language })),
])
const hasFilters = computed(() => Boolean(debouncedSearch.value.trim()) || language.value !== 'all' || onlyMine.value)
</script>

<template>
  <UDashboardPanel id="tasks">
    <template #header>
      <UDashboardNavbar title="Tasks">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <RefreshButton :loading="tasks.loading.value || tasks.refreshing.value" @click="tasks.refresh()" />
          <UButton to="/tasks/new" label="New task" icon="i-lucide-plus" size="sm" />
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar>
        <div class="flex w-full flex-wrap items-center gap-2">
          <UInput v-model="search" icon="i-lucide-search" placeholder="Search tasks" aria-label="Search tasks" size="sm" class="w-full max-w-xs" />
          <USelect v-model="language" :items="languageItems" size="sm" class="w-44" aria-label="Language" />
          <USwitch v-if="isAdmin" v-model="onlyMine" label="Only mine" size="sm" />
        </div>
      </UDashboardToolbar>
    </template>

    <template #body>
      <UAlert
        v-if="tasks.error.value"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        title="Tasks could not be loaded"
        :description="errorMessage(tasks.error.value)"
      />
      <EmptyState
        v-if="tasks.loaded.value && tasks.items.value.length === 0 && !hasFilters"
        icon="i-lucide-package"
        title="No tasks yet"
        description="A task is a folder with a manifest, a Dockerfile and your code."
        action-label="Create your first task"
        action-to="/tasks/new"
        action-icon="i-lucide-plus"
      />
      <template v-else>
        <TaskTable :tasks="tasks.items.value" :loading="tasks.loading.value && !tasks.loaded.value" :show-owner="isAdmin" />
        <LoadMoreButton :has-more="tasks.hasMore.value" :loading="tasks.loading.value" @load="tasks.loadMore()" />
      </template>
    </template>
  </UDashboardPanel>
</template>
