<script setup lang="ts">
import type { TimelineItem } from '@nuxt/ui'

// The scan timeline (docs/ui.md §5.13.6): time, level, type and message of each event, its data on expand.
const props = withDefaults(defineProps<{ events: ScantorEvent[] }>(), {})

const expanded = ref(new Set<string>())

function toggle(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

const LEVEL_ICON: Record<string, string> = {
  info: 'i-lucide-info',
  warning: 'i-lucide-triangle-alert',
  error: 'i-lucide-circle-x',
}
const LEVEL_INDICATOR: Record<string, string> = {
  info: 'bg-info/15 text-info',
  warning: 'bg-warning/15 text-warning',
  error: 'bg-error/15 text-error',
}

interface EventItem extends TimelineItem {
  event: ScantorEvent
}

const items = computed<EventItem[]>(() =>
  props.events.map((event) => ({
    value: event.id,
    icon: LEVEL_ICON[event.level] ?? 'i-lucide-info',
    title: event.type,
    event,
    ui: { indicator: LEVEL_INDICATOR[event.level] ?? '' },
  })),
)
</script>

<template>
  <UTimeline :items="items" color="neutral" size="xs" aria-label="Scan events" :ui="{ wrapper: 'pb-3', title: 'font-mono text-xs' }">
    <template #date="{ item }">
      <RelativeTime :value="item.event.at" />
    </template>
    <template #description="{ item }">
      <div class="space-y-1" :data-row-id="item.event.id">
        <p class="text-sm text-default">{{ stripEscapes(item.event.message) }}</p>
        <UButton
          v-if="item.event.data"
          :label="expanded.has(item.event.id) ? 'Hide data' : 'Show data'"
          :aria-label="`${expanded.has(item.event.id) ? 'Hide' : 'Show'} data of event ${item.event.type} ${shortId(item.event.id)}`"
          :aria-expanded="expanded.has(item.event.id)"
          color="neutral"
          variant="link"
          size="xs"
          class="px-0"
          @click="toggle(item.event.id)"
        />
        <JsonView v-if="item.event.data && expanded.has(item.event.id)" :value="item.event.data" :path="`event.${shortId(item.event.id)}`" :collapsed-depth="2" />
      </div>
    </template>
  </UTimeline>
</template>
