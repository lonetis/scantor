<script setup lang="ts">
// "Run script" of the scan page: searches the scripts of the scan's owner (a script run reads only scans of the
// script's owner) and opens the chosen script's runs tab with this scan preselected.
const props = defineProps<{ scan: Pick<Scan, 'id' | 'userId' | 'name'> }>()
const open = defineModel<boolean>('open', { default: false })

const owner = computed(() => (open.value ? props.scan.userId : null))
const choices = useScriptChoices(owner)

function targetOf(script: Script): string {
  return `/scripts/${script.id}?tab=runs&scan=${encodeURIComponent(props.scan.id)}`
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="Run script"
    :description="`Choose a script to evaluate ${scan.name || `scan ${shortId(scan.id)}`}.`"
    :ui="{ content: 'sm:max-w-lg' }"
    :content="dialogContent"
  >
    <template #close="{ ui }">
      <CloseButton :class="ui.close()" />
    </template>
    <template #body>
      <div class="space-y-3">
        <UInput v-model="choices.search.value" icon="i-lucide-search" placeholder="Search scripts" aria-label="Search scripts" class="w-full" autofocus />
        <UAlert v-if="choices.error.value" color="error" variant="subtle" icon="i-lucide-circle-alert" title="Scripts could not be loaded" :description="choices.error.value.message" />
        <ul v-if="choices.scripts.value.length > 0" class="max-h-80 divide-y divide-default overflow-auto rounded-md border border-default" aria-label="Scripts">
          <li v-for="script in choices.scripts.value" :key="script.id">
            <NuxtLink :to="targetOf(script)" class="flex flex-col gap-0.5 px-3 py-2 hover:bg-elevated" @click="open = false">
              <span class="font-mono text-sm font-medium">{{ script.name }}</span>
              <span v-if="script.description" class="truncate text-xs text-muted">{{ script.description }}</span>
            </NuxtLink>
          </li>
        </ul>
        <p v-else-if="choices.loading.value" class="text-sm text-muted">Searching…</p>
        <EmptyState
          v-else-if="choices.loaded.value"
          icon="i-lucide-file-code-2"
          :title="choices.search.value.trim() ? 'No script matches' : 'No scripts yet'"
          description="A script reads the results and files of your scans and computes a summary or output files."
          action-label="New script"
          action-to="/scripts/new"
          action-icon="i-lucide-plus"
        />
      </div>
    </template>
  </UModal>
</template>
