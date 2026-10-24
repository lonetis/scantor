<script setup lang="ts">
// The build log of a revision (docs/ui.md §5.9): task-pipeline events grouped by phase with collapsible phase
// headers, error lines tinted, ANSI sequences stripped, and auto-scroll while following (toggle "Follow log").
const props = withDefaults(defineProps<{
  lines: readonly BuildLogLine[]
  complete: boolean
  maxHeightClass?: string
}>(), { maxHeightClass: 'max-h-[32rem]' })

const PHASE_ORDER = ['pack', 'static', 'build', 'describe', 'check', 'push', 'platform']
const container = useTemplateRef<HTMLElement>('container')
const { follow, onScroll, toggleFollow } = useFollowScroll(container, () => props.lines.length)
const collapsed = ref<Set<string>>(new Set())

interface PhaseGroup {
  phase: string
  lines: { key: number; text: string; error: boolean; warning: boolean }[]
  failed: boolean
}

function lineText(line: BuildLogLine): string {
  if (line.type === 'error' && line.error) {
    const where = line.error.file ? `${[line.error.file, line.error.line, line.error.column].filter((part) => part !== undefined).join(':')}: ` : ''
    return `error: ${where}${line.error.message}`
  }
  if (line.type === 'result') return line.result && (line.result as { ok?: boolean }).ok ? 'result: ok' : 'result: failed'
  return stripAnsi(line.text ?? '')
}

const groups = computed<PhaseGroup[]>(() => {
  const byPhase = new Map<string, PhaseGroup>()
  for (const line of props.lines) {
    let group = byPhase.get(line.phase)
    if (!group) {
      group = { phase: line.phase, lines: [], failed: false }
      byPhase.set(line.phase, group)
    }
    group.lines.push({ key: line.line, text: lineText(line), error: line.type === 'error', warning: line.level === 'warning' })
    if (line.type === 'error') group.failed = true
  }
  return [...byPhase.values()].sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase))
})

function toggle(phase: string): void {
  const next = new Set(collapsed.value)
  if (next.has(phase)) next.delete(phase)
  else next.add(phase)
  collapsed.value = next
}

</script>

<template>
  <div class="code-surface relative rounded-md" data-testid="build-log">
    <div class="absolute end-1 top-1 z-10 flex items-center gap-1 rounded bg-[var(--code-bg)]/80">
      <UIcon v-if="!complete" name="i-lucide-loader-circle" class="size-3.5 animate-spin text-[var(--code-dimmed)]" />
      <UTooltip text="Follow log">
        <UButton
          icon="i-lucide-arrow-down-to-line"
          size="xs"
          color="neutral"
          :variant="follow ? 'soft' : 'ghost'"
          aria-label="Follow log"
          :aria-pressed="follow"
          @click="toggleFollow"
        />
      </UTooltip>
    </div>
    <div ref="container" class="overflow-auto px-3 py-2 pe-16" :class="maxHeightClass" @scroll.passive="onScroll">
      <p v-if="groups.length === 0" class="text-[var(--code-dimmed)]">{{ complete ? 'No build log.' : 'Waiting for the build to start…' }}</p>
      <div v-for="group in groups" :key="group.phase" class="mb-1">
        <button
          type="button"
          class="flex w-full items-center gap-1 py-0.5 text-start text-[var(--code-dimmed)] hover:text-[var(--code-text)]"
          :aria-expanded="!collapsed.has(group.phase)"
          :aria-label="`${collapsed.has(group.phase) ? 'Expand' : 'Collapse'} phase ${group.phase}`"
          @click="toggle(group.phase)"
        >
          <UIcon :name="collapsed.has(group.phase) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" class="size-3.5" />
          <span class="font-semibold uppercase tracking-wider">{{ group.phase }}</span>
          <span class="text-[10px]">({{ group.lines.length }})</span>
          <UIcon v-if="group.failed" name="i-lucide-circle-x" class="size-3.5 text-[var(--code-error)]" />
        </button>
        <div v-if="!collapsed.has(group.phase)" class="ps-4">
          <div
            v-for="line in group.lines"
            :key="line.key"
            class="whitespace-pre-wrap break-all"
            :class="line.error ? 'bg-[var(--code-error-bg)] text-[var(--code-error)]' : line.warning ? 'bg-[var(--code-warning-bg)] text-[var(--code-warning)]' : ''"
          >{{ line.text || ' ' }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
