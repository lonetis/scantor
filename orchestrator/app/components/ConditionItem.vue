<script setup lang="ts">
// One scan condition with its type-specific details (docs/ui.md §5.13.1; docs/data-model.md §4.5.4).
const props = defineProps<{ condition: Condition, scanId: string, canResume?: boolean }>()
defineEmits<{ resume: [] }>()

const TITLES: Record<string, string> = {
  workersPending: 'Workers cannot be placed',
  crashLoop: 'Worker crash loop',
  imagePullFailed: 'Image pull failed',
  workerErrors: 'Worker errors',
  schedulerRestarting: 'Scheduler restarting',
  schedulingFailed: 'Scheduling failed',
  topologyFailed: 'Broker setup failed',
  brokerAlarm: 'Message broker alarm',
  breakerTripped: 'Paused: failure rate',
  stalled: 'Stalled',
  clockSkew: 'Clock skew',
}

const PENDING_REASONS: Record<string, string> = {
  noNodes: 'No online node matches',
  archMismatch: 'No node with the revision\'s platform',
  selectorMismatch: 'No node matches the node selector',
  insufficientCapacity: 'Not enough free capacity',
  userMaxWorkers: 'Your worker limit is reached',
  dindUnavailable: 'No node allows Docker-in-Docker',
  diskLow: 'Nodes are low on disk space',
  pullLimit: 'Waiting for other image pulls',
}

// Literal class names, so Tailwind generates them (status colors come from utils/status.ts).
const TEXT_COLOR: Record<StatusColor, string> = {
  primary: 'text-primary',
  secondary: 'text-secondary',
  success: 'text-success',
  info: 'text-info',
  warning: 'text-warning',
  error: 'text-error',
  neutral: 'text-muted',
}

// Node pages are admin-only: other users see the node's short id as text.
const { isAdmin } = useAuth()

const meta = computed(() => statusMeta('conditionSeverity', props.condition.severity))
const details = computed(() => (props.condition.details ?? {}) as Record<string, unknown>)
const title = computed(() => TITLES[props.condition.type] ?? props.condition.type)

/** A detail as plain text: task output can carry ANSI sequences (docs/security.md HDR-5). */
function text(value: unknown): string {
  return stripEscapes(typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value))
}
function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

const pendingReasons = computed(() => Object.entries(record(details.value.reasons) ?? {}).map(([reason, count]) => ({ reason, label: PENDING_REASONS[reason] ?? reason, count: num(count) ?? 0 })))
const error = computed(() => record(details.value.error))
const alarms = computed(() => (Array.isArray(details.value.alarms) ? details.value.alarms.map(text) : []))
</script>

<template>
  <li class="space-y-2 px-3 py-2" :data-testid="`condition-${condition.type}`">
    <div class="flex flex-wrap items-center gap-2">
      <UIcon :name="meta.icon" class="size-4" :class="TEXT_COLOR[meta.color]" aria-hidden="true" />
      <span class="text-sm font-medium text-highlighted">{{ title }}</span>
      <StatusBadge kind="conditionSeverity" :state="condition.severity" />
      <span class="font-mono text-xs text-dimmed">{{ condition.reason }}</span>
      <span class="ms-auto text-xs text-dimmed">since <RelativeTime :value="condition.since" /></span>
    </div>
    <p class="text-sm text-muted">{{ stripEscapes(condition.message) }}</p>

    <template v-if="condition.type === 'workersPending'">
      <p class="text-xs text-muted">{{ plural(num(details.count) ?? 0, 'worker') }} pending</p>
      <table class="text-xs" aria-label="Pending reasons">
        <tbody>
          <tr v-for="entry in pendingReasons" :key="entry.reason" :data-row-id="entry.reason">
            <td class="pe-3 text-muted">{{ entry.label }}</td>
            <td class="font-mono tabular-nums">{{ entry.count }}</td>
          </tr>
        </tbody>
      </table>
    </template>

    <template v-else-if="condition.type === 'crashLoop'">
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt class="text-muted">Worker</dt>
        <dd><IdChip v-if="text(details.workerId)" :id="text(details.workerId)" /></dd>
        <dt class="text-muted">Node</dt>
        <dd>
          <NuxtLink v-if="text(details.nodeId) && isAdmin" :to="`/admin/nodes/${text(details.nodeId)}`" class="font-mono hover:underline">{{ shortId(text(details.nodeId)) }}</NuxtLink>
          <span v-else-if="text(details.nodeId)" class="font-mono">{{ shortId(text(details.nodeId)) }}</span>
        </dd>
        <dt class="text-muted">Exit code</dt>
        <dd class="font-mono">
          {{ text(details.exitCode) }}
          <UBadge v-if="details.oomKilled === true" label="OOM killed" color="error" variant="subtle" size="xs" class="ms-1" />
        </dd>
        <dt class="text-muted">Restarts</dt>
        <dd class="font-mono">{{ text(details.restarts) }}</dd>
      </dl>
      <LogView v-if="text(details.logTail)" :text="text(details.logTail)" max-height-class="max-h-48" :testid="`condition-${condition.type}-log`" />
    </template>

    <dl v-else-if="condition.type === 'imagePullFailed'" class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      <dt class="text-muted">Node</dt>
      <dd class="font-mono">{{ shortId(text(details.nodeId)) }}</dd>
      <dt class="text-muted">Message</dt>
      <dd class="break-all">{{ text(details.message) }}</dd>
    </dl>

    <template v-else-if="condition.type === 'workerErrors' || condition.type === 'schedulerRestarting' || condition.type === 'schedulingFailed'">
      <p v-if="num(details.restarts) !== null" class="text-xs text-muted">{{ plural(num(details.restarts)!, 'restart') }}</p>
      <p v-if="text(details.workerId)" class="text-xs text-muted">Worker <IdChip :id="text(details.workerId)" /></p>
      <div v-if="error" class="flex flex-wrap items-center gap-2 text-xs">
        <UBadge :label="text(error.type)" color="error" variant="subtle" size="xs" />
        <span class="font-mono text-dimmed">{{ text(error.phase) }}</span>
        <span class="break-all">{{ text(error.message) }}</span>
      </div>
    </template>

    <template v-else-if="condition.type === 'brokerAlarm'">
      <p class="text-xs text-muted">Alarms: <span class="font-mono">{{ alarms.join(', ') }}</span></p>
    </template>

    <template v-else-if="condition.type === 'breakerTripped'">
      <p class="text-xs text-muted tabular-nums">
        {{ formatPercent(((num(details.ratio) ?? 0) * 100)) }} of {{ formatCount(num(details.attempts)) }} attempts failed within
        {{ formatDuration(num(details.windowMs)) }}
      </p>
      <UButton v-if="canResume" label="Resume scan" icon="i-lucide-play" size="xs" color="primary" variant="subtle" @click="$emit('resume')" />
    </template>

    <p v-else-if="condition.type === 'stalled'" class="text-xs text-muted">{{ plural(num(details.lost) ?? 0, 'analysis', 'analyses') }} recorded as lost</p>

    <p v-else-if="condition.type === 'clockSkew'" class="text-xs text-muted">
      Node <span class="font-mono">{{ shortId(text(details.nodeId)) }}</span> is off by <span class="font-mono">{{ text(details.offsetMs) }} ms</span>
    </p>

    <p v-else-if="condition.type === 'topologyFailed'" class="break-all text-xs text-muted">{{ text(details.message) }}</p>
  </li>
</template>
