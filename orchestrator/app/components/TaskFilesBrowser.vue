<script setup lang="ts">
// Read-only file browser of a task (docs/ui.md §5.7 tab `files`): `FilesBrowser` on the workspace or on a revision's
// snapshot, chosen with the source switch.
const props = defineProps<{
  task: Task
  /** revision number to show instead of the workspace (null = workspace) */
  revision: string | null
  revisions: RevisionSummary[]
  editorEnabled: boolean
}>()
const emit = defineEmits<{ 'update:revision': [value: string | null] }>()

const actions = useTaskActions()

const sourceItems = computed(() => [
  { label: 'Workspace', value: 'workspace' },
  ...props.revisions.map((revision) => ({ label: `Revision ${revision.number}`, value: String(revision.number) })),
])
const source = computed({
  get: () => props.revision ?? 'workspace',
  set: (value: string) => emit('update:revision', value === 'workspace' ? null : value),
})

const folderKey = computed(() => `${props.task.id}@${props.revision ?? 'workspace'}`)
const list = () => actions.listFiles(props.task.id, { path: '', recursive: true, revision: props.revision })
const read = (path: string) => actions.readFile(props.task.id, path, props.revision)
const editorTo = computed(() => (props.editorEnabled ? `/editor?task=${encodeURIComponent(props.task.name)}` : null))
</script>

<template>
  <FilesBrowser :folder-key="folderKey" :list="list" :read="read" tree-label="Task files" :editor-to="editorTo">
    <template #source>
      <span class="text-xs text-muted">Source</span>
      <USelect v-model="source" :items="sourceItems" size="xs" class="w-40" aria-label="File source" />
    </template>
  </FilesBrowser>
</template>
