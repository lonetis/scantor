<script setup lang="ts">
import type { FormSubmitEvent } from '@nuxt/ui'
import { z } from 'zod'
import { SCRIPT_DESCRIPTION_MAX, scriptName } from '#shared/schemas/scripts'

// New script: a name (the task name rules) and an optional description. The script is created from the Python
// scaffold, then its page opens with a banner offering the editor and the run form. A taken name (409 alreadyExists)
// is shown under the field.
useHead({ title: 'New script · scantor' })

const CLI_SNIPPET = 'scantor scripts init my-script --name my-script\nscantor scripts push my-script'

const actions = useScriptActions()

const schema = z.object({ name: scriptName(), description: z.string().trim().max(SCRIPT_DESCRIPTION_MAX) })
const state = reactive({ name: '', description: '' })
const creating = ref(false)
const nameError = ref<string | null>(null)
const createError = ref<string | null>(null)

async function create(_event: FormSubmitEvent<z.output<typeof schema>>): Promise<void> {
  creating.value = true
  nameError.value = null
  createError.value = null
  try {
    const script = await actions.createScript({ name: state.name.trim(), description: state.description.trim() || undefined })
    await navigateTo({ path: `/scripts/${script.id}`, query: { created: '1' } })
  } catch (cause) {
    const apiError = toApiError(cause)
    if (apiError.code === 'alreadyExists') nameError.value = 'A script with this name already exists.'
    else createError.value = apiError.message
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <UDashboardPanel id="script-new">
    <template #header>
      <UDashboardNavbar title="New script">
        <template #leading>
          <SidebarCollapseButton />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="max-w-2xl space-y-6">
        <p class="text-sm text-muted">
          A script is a Python folder that reads the results and files of your scans on the master. It starts from a
          working example; edit it in the editor, then run it on one or more scans.
        </p>
        <UForm :schema="schema" :state="state" class="max-w-lg space-y-3" @submit="create">
          <UFormField label="Name" name="name" required hint="lowercase letters, digits, hyphens" :error="nameError ?? undefined">
            <UInput v-model="state.name" autocomplete="off" class="w-full font-mono" placeholder="csp-report" autofocus />
          </UFormField>
          <UFormField label="Description" name="description" :hint="`optional, ≤ ${SCRIPT_DESCRIPTION_MAX} characters`">
            <UTextarea v-model="state.description" :maxlength="SCRIPT_DESCRIPTION_MAX" :rows="2" autoresize class="w-full" />
          </UFormField>
          <UAlert v-if="createError" color="error" variant="subtle" icon="i-lucide-circle-alert" title="The script could not be created" :description="createError" />
          <UButton type="submit" label="Create script" icon="i-lucide-plus" :loading="creating" />
        </UForm>
        <div class="space-y-1">
          <p class="section-label">From your machine</p>
          <p class="text-xs text-muted">Scaffold a script locally and upload it with the CLI:</p>
          <CodeBlock :code="CLI_SNIPPET" label="Upload a script with the CLI" />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
