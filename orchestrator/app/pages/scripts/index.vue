<script setup lang="ts">
import { refDebounced } from '@vueuse/core'

// Scripts list: search, an admin-only "Only mine" switch, the table and "Load more". Polls every 30 s while visible.
useHead({ title: 'Scripts · scantor' })

const { user, isAdmin } = useAuth()

const search = ref('')
const debouncedSearch = refDebounced(search, SCRIPT_SEARCH_DEBOUNCE_MS)
const onlyMine = ref(false)

const filters = computed<ScriptFilters>(() => ({
  q: debouncedSearch.value.slice(0, SCRIPT_SEARCH_MAX_LENGTH),
  userId: isAdmin.value && onlyMine.value ? (user.value?.id ?? null) : null,
}))
const scripts = useScripts(filters)

const hasFilters = computed(() => Boolean(debouncedSearch.value.trim()) || onlyMine.value)
</script>

<template>
  <UDashboardPanel id="scripts">
    <template #header>
      <UDashboardNavbar title="Scripts">
        <template #leading>
          <SidebarCollapseButton />
        </template>
        <template #right>
          <RefreshButton :loading="scripts.loading.value || scripts.refreshing.value" @click="scripts.refresh()" />
          <UButton to="/scripts/new" label="New script" icon="i-lucide-plus" size="sm" />
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar>
        <div class="flex w-full flex-wrap items-center gap-2">
          <UInput v-model="search" icon="i-lucide-search" placeholder="Search scripts" aria-label="Search scripts" size="sm" class="w-full max-w-xs" />
          <USwitch v-if="isAdmin" v-model="onlyMine" label="Only mine" size="sm" />
        </div>
      </UDashboardToolbar>
    </template>

    <template #body>
      <UAlert
        v-if="scripts.error.value"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        title="Scripts could not be loaded"
        :description="errorMessage(scripts.error.value)"
      />
      <EmptyState
        v-if="scripts.loaded.value && scripts.items.value.length === 0 && !hasFilters"
        icon="i-lucide-file-code-2"
        title="No scripts yet"
        description="A script reads the results and files of your scans on the master and returns a summary or output files."
        action-label="Create your first script"
        action-to="/scripts/new"
        action-icon="i-lucide-plus"
      />
      <template v-else>
        <ScriptTable :scripts="scripts.items.value" :loading="scripts.loading.value && !scripts.loaded.value" :show-owner="isAdmin" />
        <LoadMoreButton :has-more="scripts.hasMore.value" :loading="scripts.loading.value" @load="scripts.loadMore()" />
      </template>
    </template>
  </UDashboardPanel>
</template>
