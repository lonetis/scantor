<script setup lang="ts">
// Templates catalog (docs/ui.md §5.14): one card per schedule template with its schemas, examples and an estimate.
useHead({ title: 'Templates · scantor' })

const { templates, loading, error, load } = useTemplates()
</script>

<template>
  <UDashboardPanel id="templates">
    <template #header>
      <UDashboardNavbar title="Templates">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <RefreshButton :loading="loading" @click="load({ force: true })" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <p class="mb-4 max-w-3xl text-sm text-muted">
        Templates are reusable schedule implementations with predefined scan and analysis config types. A task uses one by passing
        the template's schedule; the authoring guide of your language shows how.
      </p>
      <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" title="Templates could not be loaded" :description="errorMessage(error)" />
      <USkeleton v-if="loading && !templates" class="h-64 w-full" />
      <div v-else class="grid gap-4 xl:grid-cols-2">
        <TemplateCard v-for="template in templates ?? []" :key="template.name" :template="template" />
      </div>
    </template>
  </UDashboardPanel>
</template>
