<script setup lang="ts">
// Read-only JSON tree rendered strictly as text (docs/ui.md §10, docs/security.md HDR-5): collapsible nodes,
// long strings truncated, masked secrets ("***") shown as a lock. Values are never linkified.

defineOptions({ name: 'JsonView' })

const props = withDefaults(defineProps<{
  value: unknown
  /** Nodes below this depth start collapsed. */
  collapsedDepth?: number
  maxStringLength?: number
  /** Show the copy button and frame (root only). */
  framed?: boolean
  copyable?: boolean
  /** Internal: key of this node within its parent. */
  propertyKey?: string | number | null
  /** Internal: dotted path for unique control names. */
  path?: string
  depth?: number
}>(), {
  collapsedDepth: 2,
  maxStringLength: 300,
  framed: true,
  copyable: true,
  propertyKey: null,
  path: '',
  depth: 0,
})

const SECRET_MASK = '***'

const isArray = computed(() => Array.isArray(props.value))
const isObject = computed(() => typeof props.value === 'object' && props.value !== null)
const entries = computed<[string | number, unknown][]>(() => {
  if (Array.isArray(props.value)) return props.value.map((item, index) => [index, item])
  if (isObject.value) return Object.entries(props.value as Record<string, unknown>)
  return []
})
const expanded = ref(props.depth < props.collapsedDepth)
const showFullString = ref(false)

const label = computed(() => props.path || 'value')
const summary = computed(() => {
  const count = entries.value.length
  return isArray.value ? `${count} ${count === 1 ? 'item' : 'items'}` : `${count} ${count === 1 ? 'key' : 'keys'}`
})
const stringValue = computed(() => (typeof props.value === 'string' ? props.value : ''))
const truncated = computed(() => stringValue.value.length > props.maxStringLength && !showFullString.value)
const displayedString = computed(() => (truncated.value ? `${stringValue.value.slice(0, props.maxStringLength)}…` : stringValue.value))
const serialized = computed(() => {
  try {
    return JSON.stringify(props.value, null, 2) ?? 'undefined'
  } catch (error) {
    return `/* cannot serialize: ${error instanceof Error ? error.message : String(error)} */`
  }
})

function childPath(key: string | number): string {
  return props.path ? `${props.path}.${key}` : String(key)
}
</script>

<template>
  <div
    v-if="depth === 0 && framed"
    class="code-surface group relative overflow-x-auto rounded-md px-3 py-2"
    data-slot="json-view"
  >
    <div v-if="copyable" class="absolute end-1 top-1 opacity-60 group-hover:opacity-100">
      <CopyButton :value="serialized" label="Copy JSON" />
    </div>
    <JsonView
      :value="value"
      :collapsed-depth="collapsedDepth"
      :max-string-length="maxStringLength"
      :framed="false"
      :copyable="false"
      :depth="0"
      path=""
    />
  </div>

  <div v-else class="font-mono text-xs leading-relaxed">
    <template v-if="isObject">
      <span class="inline-flex items-center gap-0.5">
        <UTooltip :text="`${expanded ? 'Collapse' : 'Expand'} ${label}`">
          <button
            type="button"
            class="-ms-1 inline-flex items-center rounded px-0.5 text-[var(--code-muted)] hover:bg-[var(--code-border)]/40"
            :aria-expanded="expanded"
            :aria-label="`${expanded ? 'Collapse' : 'Expand'} ${label}`"
            @click="expanded = !expanded"
          >
            <UIcon :name="expanded ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-3" />
          </button>
        </UTooltip>
        <span v-if="propertyKey !== null" class="text-[var(--code-key)]">{{ typeof propertyKey === 'number' ? propertyKey : `"${propertyKey}"` }}</span>
        <span v-if="propertyKey !== null" class="text-[var(--code-muted)]">:&nbsp;</span>
        <span class="text-[var(--code-muted)]">{{ isArray ? '[' : '{' }}</span>
        <template v-if="!expanded">
          <span class="text-[var(--code-dimmed)]">&nbsp;{{ summary }}&nbsp;</span>
          <span class="text-[var(--code-muted)]">{{ isArray ? ']' : '}' }}</span>
        </template>
      </span>
      <div v-if="expanded" class="border-s border-[var(--code-border)] ps-3">
        <JsonView
          v-for="[key, child] in entries"
          :key="key"
          :value="child"
          :property-key="key"
          :path="childPath(key)"
          :depth="depth + 1"
          :collapsed-depth="collapsedDepth"
          :max-string-length="maxStringLength"
          :framed="false"
          :copyable="false"
        />
        <span v-if="entries.length === 0" class="text-[var(--code-dimmed)]">empty</span>
      </div>
      <span v-if="expanded" class="text-[var(--code-muted)]">{{ isArray ? ']' : '}' }}</span>
    </template>

    <template v-else>
      <span v-if="propertyKey !== null" class="text-[var(--code-key)]">{{ typeof propertyKey === 'number' ? propertyKey : `"${propertyKey}"` }}</span>
      <span v-if="propertyKey !== null" class="text-[var(--code-muted)]">:&nbsp;</span>
      <span v-if="value === SECRET_MASK" class="inline-flex items-center gap-1 text-[var(--code-muted)]" title="Secret value, not shown">
        <UIcon name="i-lucide-lock" class="size-3" aria-hidden="true" />secret
      </span>
      <span v-else-if="typeof value === 'string'" class="whitespace-pre-wrap break-all text-[var(--code-string)]">"{{ displayedString }}"<button
        v-if="stringValue.length > maxStringLength"
        type="button"
        class="ms-1 rounded px-1 text-[10px] text-[var(--code-accent)] hover:underline"
        :aria-label="`${showFullString ? 'Shorten' : 'Show full value of'} ${label}`"
        @click="showFullString = !showFullString"
      >{{ showFullString ? 'less' : `+${stringValue.length - maxStringLength} chars` }}</button></span>
      <span v-else-if="typeof value === 'number'" class="text-[var(--code-number)]">{{ value }}</span>
      <span v-else-if="value === undefined" class="text-[var(--code-dimmed)]">undefined</span>
      <span v-else class="text-[var(--code-literal)]">{{ JSON.stringify(value) }}</span>
    </template>
  </div>
</template>
