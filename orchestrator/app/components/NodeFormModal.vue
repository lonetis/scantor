<script lang="ts">
import type { FormSubmitEvent } from '@nuxt/ui'
import { nodeFormSchema } from '#shared/schemas/nodes'
import type { CreateNodeBody, NodeForm, UpdateNodeBody } from '#shared/schemas/nodes'
import type { NodeWithToken, ScantorNode } from '#shared/types/nodes'
import { NODE_LABEL_KEY_PATTERN, NODE_LABELS_MAX } from '#shared/utils/slug'

export interface NodeFormActions {
  createNode: (body: CreateNodeBody) => Promise<NodeWithToken>
  updateNode: (nodeId: string, body: UpdateNodeBody) => Promise<ScantorNode>
}

</script>

<script setup lang="ts">
// Add a remote node or edit one (docs/ui.md §5.15): name (slug), pool (default "shared"), labels (≤ 32) and an
// optional worker limit; editing also offers the cordon switch. The built-in node keeps its name. Errors stay
// inline; a created node is handed to the caller, which shows its token once.
const props = defineProps<{
  mode: 'create' | 'edit'
  node?: ScantorNode | null
  actions: NodeFormActions
}>()

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ created: [result: NodeWithToken], saved: [node: ScantorNode] }>()

const state = reactive<NodeForm>({ name: '', pool: 'shared', labels: {}, maxWorkers: null, cordoned: false })
const error = ref<string | null>(null)
const saving = ref(false)

watch(open, (value) => {
  if (!value) return
  error.value = null
  const node = props.mode === 'edit' ? props.node : null
  Object.assign(state, {
    name: node?.name ?? '',
    pool: node?.pool ?? 'shared',
    labels: { ...(node?.labels ?? {}) },
    maxWorkers: node?.maxWorkers ?? null,
    cordoned: node?.cordoned ?? false,
  })
}, { immediate: true })

const builtIn = computed(() => props.mode === 'edit' && props.node?.builtIn === true)
const schema = computed(() => nodeFormSchema(builtIn.value))
const title = computed(() => (props.mode === 'create' ? 'Add node' : `Edit ${props.node?.name ?? 'node'}`))

function stringRecord(value: Record<string, string | number | boolean>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]))
}

function messageOf(cause: unknown): string {
  const apiError = toApiError(cause)
  if (apiError.code === 'alreadyExists') return 'A node with this name already exists.'
  return apiError.message
}

async function submit(event: FormSubmitEvent<NodeForm>): Promise<void> {
  saving.value = true
  error.value = null
  try {
    const form = event.data
    if (props.mode === 'create') {
      const created = await props.actions.createNode({ name: form.name, pool: form.pool, labels: form.labels, maxWorkers: form.maxWorkers })
      open.value = false
      emit('created', created)
      return
    }
    const node = props.node
    if (!node) return
    const changes = nodeChanges(node, form)
    if (Object.keys(changes).length === 0) {
      open.value = false
      return
    }
    const saved = await props.actions.updateNode(node.id, changes)
    open.value = false
    emit('saved', saved)
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="title" :ui="{ content: 'sm:max-w-lg' }">
    <template #close="{ ui }">
      <CloseButton :class="ui.close()" />
    </template>
    <template #body>
      <UForm id="node-form" :schema="schema" :state="state" class="space-y-3" @submit="submit">
        <UFormField label="Name" name="name" required hint="lowercase letters, digits, hyphens" :help="builtIn ? 'The built-in node keeps its name.' : undefined">
          <UInput v-model="state.name" autocomplete="off" class="w-full font-mono" :disabled="builtIn" placeholder="scan-eu-1" />
        </UFormField>
        <UFormField label="Pool" name="pool" help="Scans select nodes with settings.nodeSelector.pool.">
          <UInput v-model="state.pool" autocomplete="off" class="w-full font-mono" />
        </UFormField>
        <UFormField label="Labels" name="labels" :help="`Matched by nodeSelector.labels; at most ${NODE_LABELS_MAX}.`">
          <KeyValueEditor
            :model-value="state.labels"
            :key-pattern="NODE_LABEL_KEY_PATTERN"
            key-hint="lowercase letters, digits, &quot;.&quot;, &quot;_&quot; or &quot;-&quot;"
            :max-entries="NODE_LABELS_MAX"
            entry-name="label"
            @update:model-value="state.labels = stringRecord($event)"
          />
        </UFormField>
        <UFormField label="Worker limit" name="maxWorkers" help="Caps the node below its reported capacity. Empty = no limit.">
          <NumberInput
            :model-value="state.maxWorkers"
            :min="0"
            :max="100000"
            class="w-40"
            placeholder="no limit"
            @update:model-value="state.maxWorkers = $event ?? null"
          />
        </UFormField>
        <UFormField v-if="mode === 'edit'" name="cordoned" help="A cordoned node gets no new workers; running workers stay.">
          <USwitch v-model="state.cordoned" label="Cordoned" />
        </UFormField>
        <UAlert
          v-if="mode === 'create'"
          color="warning"
          variant="subtle"
          icon="i-lucide-shield-alert"
          description="A node sees everything about the scans placed on it, including secrets in their configs. Add only machines you trust like the master."
        />
        <p v-if="error" class="text-xs text-error" role="alert">{{ error }}</p>
      </UForm>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton type="submit" form="node-form" :label="mode === 'create' ? 'Create node' : 'Save node'" :loading="saving" />
      </div>
    </template>
  </UModal>
</template>
