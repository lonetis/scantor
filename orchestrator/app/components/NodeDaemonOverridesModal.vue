<script lang="ts">
import type { FormError } from '@nuxt/ui'
import { DAEMON_OVERRIDE_BOUNDS } from '#shared/schemas/nodes'
import type { DaemonOverrideKey, UpdateNodeDaemonOverridesBody } from '#shared/schemas/nodes'
import type { ScantorNode } from '#shared/types/nodes'
import { DAEMON_OVERRIDE_FIELDS } from '~/utils/daemon-config'
import type { DaemonOverrideField, DaemonOverrideForm } from '~/utils/daemon-config'

export interface NodeDaemonOverridesActions {
  updateNodeDaemonOverrides: (nodeId: string, body: UpdateNodeDaemonOverridesBody) => Promise<ScantorNode>
}

type GroupTitle = 'Workers' | 'Daemon' | 'Node resolver'

function groupOf(key: DaemonOverrideKey): GroupTitle {
  if (key.startsWith('dns.')) return 'Node resolver'
  return key === 'logLevel' ? 'Daemon' : 'Workers'
}

const GROUPS: { title: GroupTitle; description: string; fields: DaemonOverrideField[] }[] = (
  [
    { title: 'Workers', description: 'Container settings apply to workers created afterwards; running workers keep theirs.' },
    { title: 'Daemon', description: "The level of the daemon's own log; the node resolver keeps the environment's." },
    { title: 'Node resolver', description: 'A change replaces the node resolver; its cache starts empty.' },
  ] as const
).map((group) => ({ ...group, fields: DAEMON_OVERRIDE_FIELDS.filter((field) => groupOf(field.key) === group.title) }))

const HELP: Partial<Record<DaemonOverrideKey, string>> = {
  maxWorkers: "The node's capacity is the smaller of this and the admin worker limit; running workers are never stopped.",
  shmSizeBytes: 'Such as 256MiB or 1GiB.',
  workerLogMaxSizeBytes: 'Such as 20MiB.',
  imageRetentionMs: 'Such as 12h or 24h.',
  pullTimeoutMs: 'Such as 15m or 1h.',
  'dns.mode': "disabled: new workers use Docker's DNS.",
  'dns.upstreams':
    'IP, ip:port, [v6]:port or host (the host nameservers); one per line. Private and special-purpose servers only in SCANTOR_NODE_DNS_UPSTREAMS.',
  'dns.rootServers':
    'IP, ip:port or [v6]:port; one per line. Empty uses the IANA root servers. Private and special-purpose servers only in SCANTOR_NODE_DNS_ROOT_SERVERS.',
  'dns.localDomains': 'Resolved through the host nameservers; one per line.',
  'dns.cacheSizeBytes': 'Such as 256MiB or 1GiB.',
  'dns.upstreamQps': '0 = no limit.',
  'dns.authoritativeQps': 'In iterative mode; 0 = no limit.',
}

const BOUNDS = DAEMON_OVERRIDE_BOUNDS as Partial<Record<DaemonOverrideKey, { min: number; max: number }>>
</script>

<script setup lang="ts">
// "Edit overrides" of the node page (docs/ui.md §5.15, docs/nodes.md §6.12): every overridable setting of the daemon
// configuration, prefilled with its override or else its value. Saving sends only the changed settings as a merge
// patch, null for a removed override; settings outside the daemon's SCANTOR_NODE_OVERRIDES are disabled. Errors stay
// inline.
const props = defineProps<{
  node: ScantorNode | null
  actions: NodeDaemonOverridesActions
}>()

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [node: ScantorNode] }>()

const state = reactive({}) as DaemonOverrideForm
/** The form as it opened: only what differs from it is sent. */
let initial = {} as DaemonOverrideForm
const removed = reactive(new Set<DaemonOverrideKey>())
const allowed = shallowRef<ReadonlySet<DaemonOverrideKey>>(new Set())
const overridden = shallowRef<ReadonlySet<DaemonOverrideKey>>(new Set())
const error = ref<string | null>(null)
const saving = ref(false)

watch(
  open,
  (value) => {
    if (!value) return
    error.value = null
    removed.clear()
    const config = props.node?.daemonConfig
    if (!config) {
      allowed.value = new Set()
      overridden.value = new Set()
      return
    }
    initial = daemonOverrideForm(config, props.node?.info?.maxWorkers ?? null)
    Object.assign(state, initial)
    allowed.value = allowedOverrideKeys(config.values)
    overridden.value = new Set(DAEMON_OVERRIDE_FIELDS.filter((field) => configValueAt(config.overrides, field.key) !== undefined).map((field) => field.key))
  },
  { immediate: true },
)

const title = computed(() => `Daemon overrides of ${props.node?.name ?? 'node'}`)

function disabled(key: DaemonOverrideKey): boolean {
  return !allowed.value.has(key) || removed.has(key)
}

function helpOf(field: DaemonOverrideField): string | undefined {
  if (!allowed.value.has(field.key)) return 'Not allowed on this node (SCANTOR_NODE_OVERRIDES).'
  if (removed.has(field.key)) return 'The override is removed on save; the environment value or the default applies.'
  return HELP[field.key]
}

function removeLabel(field: DaemonOverrideField): string {
  return removed.has(field.key) ? `Keep override of ${field.label}` : `Remove override of ${field.label}`
}

function toggleRemoved(key: DaemonOverrideKey): void {
  if (removed.has(key)) removed.delete(key)
  else removed.add(key)
}

function numberOf(key: DaemonOverrideKey): number | null {
  const value = state[key]
  return typeof value === 'number' ? value : null
}

function textOf(key: DaemonOverrideKey): string {
  const value = state[key]
  return value === null || value === undefined ? '' : String(value)
}

function setValue(key: DaemonOverrideKey, value: unknown): void {
  state[key] = typeof value === 'number' || typeof value === 'string' ? value : null
}

function draft() {
  return daemonOverridesPatch(initial, state, removed)
}

const validate = settledValidator((): FormError[] => draft().errors.map((issue) => ({ name: issue.name || undefined, message: issue.message })))

function onFormError(event: { errors: { name?: string; message: string }[] }): void {
  // Errors of no field (none are expected: every key has a field) would block the save without a visible reason.
  const unplaced = event.errors.filter((issue) => !issue.name).map((issue) => issue.message)
  error.value = unplaced.length > 0 ? unplaced.join(' ') : null
}

async function submit(): Promise<void> {
  const node = props.node
  if (!node) return
  const { patch, errors } = draft()
  if (errors.length > 0) return
  if (Object.keys(patch).length === 0) {
    open.value = false
    return
  }
  saving.value = true
  error.value = null
  try {
    const saved = await props.actions.updateNodeDaemonOverrides(node.id, patch)
    open.value = false
    emit('saved', saved)
  } catch (cause) {
    error.value = daemonOverridesErrorText(toApiError(cause))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="title" :ui="{ content: 'sm:max-w-2xl' }" :content="dialogContent">
    <template #close="{ ui }">
      <CloseButton :class="ui.close()" />
    </template>
    <template #body>
      <UForm id="node-daemon-overrides-form" :state="state" :validate="validate" class="space-y-5" @submit="submit" @error="onFormError">
        <UAlert
          color="neutral"
          variant="subtle"
          icon="i-lucide-info"
          description="Overrides last until the daemon restarts. The admin worker limit is separate and persistent. Only changed settings are sent."
        />
        <div v-for="group in GROUPS" :key="group.title" role="group" class="space-y-3" :aria-label="group.title">
          <div>
            <p class="section-label">{{ group.title }}</p>
            <p class="text-xs text-muted">{{ group.description }}</p>
          </div>
          <UFormField v-for="field in group.fields" :key="field.key" :label="field.label" :name="field.key" :help="helpOf(field)">
            <template #hint>
              <span class="font-mono text-xs">{{ field.env }}</span>
            </template>
            <div class="flex items-start gap-2">
              <NumberInput
                v-if="field.input === 'count'"
                :model-value="numberOf(field.key)"
                :min="BOUNDS[field.key]?.min"
                :max="BOUNDS[field.key]?.max"
                :disabled="disabled(field.key)"
                class="w-56"
                @update:model-value="setValue(field.key, $event)"
              />
              <USelect
                v-else-if="field.input === 'select'"
                :model-value="textOf(field.key)"
                :items="[...(field.options ?? [])]"
                :disabled="disabled(field.key)"
                class="w-56"
                @update:model-value="setValue(field.key, $event)"
              />
              <UTextarea
                v-else-if="field.input === 'list'"
                :model-value="textOf(field.key)"
                :rows="2"
                autoresize
                :disabled="disabled(field.key)"
                class="w-full font-mono text-xs"
                spellcheck="false"
                @update:model-value="setValue(field.key, $event)"
              />
              <UInput
                v-else
                :model-value="textOf(field.key)"
                :disabled="disabled(field.key)"
                autocomplete="off"
                spellcheck="false"
                class="w-56 font-mono"
                @update:model-value="setValue(field.key, $event)"
              />
              <UTooltip v-if="overridden.has(field.key) && allowed.has(field.key)" :text="removeLabel(field)">
                <UButton
                  :icon="removed.has(field.key) ? 'i-lucide-undo-2' : 'i-lucide-x'"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :aria-label="removeLabel(field)"
                  @click="toggleRemoved(field.key)"
                />
              </UTooltip>
            </div>
          </UFormField>
        </div>
        <p v-if="error" class="text-xs text-error" role="alert">{{ error }}</p>
      </UForm>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton type="submit" form="node-daemon-overrides-form" label="Save overrides" :loading="saving" />
      </div>
    </template>
  </UModal>
</template>
