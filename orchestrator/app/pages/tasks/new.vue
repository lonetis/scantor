<script setup lang="ts">
import type { StepperItem } from '@nuxt/ui'
import type { WizardSource } from '~/components/WizardSourceStep.vue'
import { CUSTOM_TEMPLATE } from '#shared/schemas/tasks'

// New-task wizard (docs/ui.md §5.6): source → (scaffold: language → template → name) | git | upload. A created task
// opens its page with a banner offering "Open in editor", "Start test run" and "Publish".
useHead({ title: 'New task · scantor' })

const toast = useToast()
const actions = useTaskActions()
const { languages, loadScaffolds, scaffoldTemplates } = useLanguages()
const { templates } = useTemplates()

const step = ref(0)
const source = ref<WizardSource | null>(null)
const language = ref<string | null>(null)
const template = ref<string | null>(null)
const name = ref('')
const description = ref('')
const creating = ref(false)
const nameError = ref<string | null>(null)
const createError = ref<string | null>(null)

loadScaffolds().catch((cause: unknown) => console.error('[tasks] loading scaffolds failed', cause))

const items = computed<StepperItem[]>(() => {
  const first: StepperItem = { title: 'Source', icon: 'i-lucide-signpost', value: 0 }
  if (source.value === 'git') return [first, { title: 'Git repository', icon: 'i-lucide-git-branch', value: 1 }]
  if (source.value === 'upload') return [first, { title: 'Upload folder', icon: 'i-lucide-upload', value: 1 }]
  return [
    first,
    { title: 'Language', icon: 'i-lucide-languages', value: 1 },
    { title: 'Template', icon: 'i-lucide-layout-template', value: 2 },
    { title: 'Name', icon: 'i-lucide-tag', value: 3 },
  ]
})

const templateChoices = computed(() => {
  if (!language.value) return []
  const supported = scaffoldTemplates(language.value)
  return (templates.value ?? []).filter((item) => supported.length === 0 || supported.includes(item.name))
})
const allowCustom = computed(() => !language.value || scaffoldTemplates(language.value).length === 0 || scaffoldTemplates(language.value).includes(CUSTOM_TEMPLATE))

function next(): void {
  step.value = Math.min(step.value + 1, items.value.length - 1)
}

async function create(): Promise<void> {
  if (!language.value || !template.value) return
  creating.value = true
  nameError.value = null
  createError.value = null
  try {
    const task = await actions.createTask({ name: name.value.trim(), language: language.value, template: template.value, description: description.value.trim() || undefined })
    await navigateTo({ path: `/tasks/${task.id}`, query: { created: '1' } })
  } catch (cause) {
    const apiError = toApiError(cause)
    if (apiError.code === 'alreadyExists') nameError.value = 'A task with this name already exists.'
    else createError.value = apiError.message
  } finally {
    creating.value = false
  }
}

async function imported(tasks: Task[]): Promise<void> {
  if (tasks.length === 1) {
    await navigateTo({ path: `/tasks/${tasks[0]!.id}`, query: { created: '1' } })
    return
  }
  toast.add({ title: `Imported ${tasks.length} tasks`, description: tasks.map((task) => task.name).join(', '), color: 'success', icon: 'i-lucide-check' })
  await navigateTo('/tasks')
}

async function uploaded(result: UploadTaskResult): Promise<void> {
  if (result.revision) await navigateTo(`/tasks/${result.task.id}/revisions/${result.revision.number}`)
  else await navigateTo(`/tasks/${result.task.id}`)
}

watch(source, () => {
  language.value = null
  template.value = null
})
</script>

<template>
  <UDashboardPanel id="tasks-new">
    <template #header>
      <UDashboardNavbar title="New task">
        <template #leading>
          <SidebarCollapseButton />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-5xl space-y-6">
        <UStepper v-model="step" :items="items" size="sm" :linear="false" />

        <WizardSourceStep v-if="step === 0" v-model="source" @next="next" />

        <template v-else-if="source === 'scaffold'">
          <WizardLanguageStep v-if="step === 1" v-model="language" :languages="languages ?? []" @next="next" />
          <WizardTemplateStep v-else-if="step === 2" v-model="template" :templates="templateChoices" :allow-custom="allowCustom" @next="next" />
          <div v-else-if="step === 3" class="space-y-3">
            <p class="text-sm text-muted">
              <span class="font-mono">{{ language }}</span> ·
              <span class="font-mono">{{ template === 'custom' ? 'custom schedule' : template }}</span>
            </p>
            <WizardNameStep v-model:name="name" v-model:description="description" :submitting="creating" :name-error="nameError" @submit="create" />
            <UAlert v-if="createError" color="error" variant="subtle" icon="i-lucide-circle-alert" title="The task could not be created" :description="createError" />
          </div>
        </template>

        <WizardGitStep v-else-if="source === 'git'" @imported="imported" />
        <WizardUploadStep v-else-if="source === 'upload'" @uploaded="uploaded" />

        <div v-if="step > 0" class="flex gap-2">
          <UButton label="Back" icon="i-lucide-arrow-left" color="neutral" variant="ghost" size="sm" @click="step--" />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
