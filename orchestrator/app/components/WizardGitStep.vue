<script setup lang="ts">
import type { FormSubmitEvent } from '@nuxt/ui'
import { z } from 'zod'
import { gitUrl } from '#shared/schemas/tasks'

// Import from git (docs/ui.md §5.6): url (https), ref, path and an optional credential for the URL's host. Several
// manifests in the repository add a selection of candidates; a second call imports the selected paths.
const emit = defineEmits<{ imported: [tasks: Task[]] }>()

const actions = useTaskActions()
const { credentials } = useCredentials()

const schema = z.object({
  url: gitUrl(),
  ref: z.string().trim().min(1).max(255),
  path: z.string().trim().min(1).max(1024),
  credentialId: z.string(),
})
const state = reactive({ url: '', ref: 'HEAD', path: '.', credentialId: 'none' })
const importing = ref(false)
const error = ref<string | null>(null)
const manifestErrors = ref<BuildError[]>([])
const candidates = ref<GitImportCandidate[] | null>(null)
const selected = ref<string[]>([])

const credentialItems = computed(() => [
  { label: 'None', value: 'none' },
  ...credentials.value.map((credential) => ({ label: `${credential.name} (${credential.host})`, value: credential.id })),
])

async function run(select?: string[]): Promise<void> {
  importing.value = true
  error.value = null
  manifestErrors.value = []
  try {
    const result = await actions.importGitTask({
      url: state.url.trim(),
      ref: state.ref.trim(),
      path: state.path.trim(),
      ...(state.credentialId !== 'none' ? { credentialId: state.credentialId } : {}),
      ...(select ? { select } : {}),
    })
    if (result.imported.length > 0) {
      emit('imported', result.imported)
      return
    }
    candidates.value = result.candidates
    selected.value = []
  } catch (cause) {
    const apiError = toApiError(cause)
    if (apiError.code === 'gitFailed' && typeof apiError.details?.message === 'string') error.value = apiError.details.message
    else error.value = apiError.message
    if (apiError.code === 'manifestInvalid' && Array.isArray(apiError.details?.errors)) manifestErrors.value = apiError.details.errors as BuildError[]
  } finally {
    importing.value = false
  }
}

function submit(_event: FormSubmitEvent<z.output<typeof schema>>): void {
  candidates.value = null
  void run()
}

function toggle(path: string, checked: boolean | 'indeterminate'): void {
  selected.value = checked === true ? [...selected.value, path] : selected.value.filter((item) => item !== path)
}
</script>

<template>
  <div class="max-w-2xl space-y-4">
    <UForm :schema="schema" :state="state" class="space-y-3" @submit="submit">
      <UFormField label="Repository URL" name="url" required hint="https only">
        <UInput v-model="state.url" type="url" autocomplete="off" class="w-full font-mono" placeholder="https://github.com/acme/tasks.git" />
      </UFormField>
      <div class="grid gap-3 sm:grid-cols-2">
        <UFormField label="Ref" name="ref" hint="branch, tag, commit or HEAD">
          <UInput v-model="state.ref" autocomplete="off" class="w-full font-mono" />
        </UFormField>
        <UFormField label="Path" name="path" hint="folder to search">
          <UInput v-model="state.path" autocomplete="off" class="w-full font-mono" />
        </UFormField>
      </div>
      <UFormField label="Credential" name="credentialId">
        <div class="flex items-center gap-2">
          <USelect v-model="state.credentialId" :items="credentialItems" class="w-72" aria-label="Git credential" />
          <ULink to="/account/credentials" target="_blank" class="text-xs text-primary hover:underline">Add a credential</ULink>
        </div>
      </UFormField>
      <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" title="The import failed" :description="error" />
      <BuildErrors :errors="manifestErrors" title="Manifest errors" />
      <UButton type="submit" label="Import" icon="i-lucide-git-branch" :loading="importing && !candidates" />
    </UForm>

    <section v-if="candidates" class="space-y-2" aria-labelledby="git-candidates-heading">
      <h3 id="git-candidates-heading" class="section-label">Select tasks</h3>
      <p class="text-xs text-muted">The repository contains several task folders. Choose the ones to import.</p>
      <ul class="divide-y divide-default rounded-md border border-default">
        <li v-for="candidate in candidates" :key="candidate.path" class="flex items-center gap-3 px-3 py-2 text-sm">
          <UCheckbox
            :model-value="selected.includes(candidate.path)"
            :disabled="candidate.exists"
            :aria-label="`Import ${candidate.name} from ${candidate.path}`"
            @update:model-value="toggle(candidate.path, $event)"
          />
          <span class="font-mono font-medium">{{ candidate.name }}</span>
          <UBadge :label="candidate.language" color="neutral" variant="soft" size="xs" />
          <span class="truncate font-mono text-xs text-muted">{{ candidate.path }}</span>
          <UBadge v-if="candidate.exists" label="already exists" color="warning" variant="subtle" size="xs" class="ms-auto" />
        </li>
      </ul>
      <UButton
        label="Import selected"
        icon="i-lucide-download"
        :disabled="selected.length === 0"
        :loading="importing"
        @click="run(selected)"
      />
    </section>
  </div>
</template>
