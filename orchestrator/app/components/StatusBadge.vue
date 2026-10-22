<script setup lang="ts">
import type { StatusKind } from '~/utils/status'

// A state badge: color, icon and the state text itself (color is never the only signal, docs/ui.md §11).
const props = withDefaults(defineProps<{
  kind: StatusKind
  state: string | null | undefined
  /** Extra text after the state, for example a state reason. */
  detail?: string | null
  size?: 'xs' | 'sm' | 'md'
}>(), { detail: null, size: 'xs' })

const meta = computed(() => statusMeta(props.kind, props.state))
</script>

<template>
  <UBadge :color="meta.color" variant="subtle" :size="size" class="gap-1 font-medium" :data-state="meta.label">
    <span v-if="meta.pulse" class="size-1.5 shrink-0 rounded-full bg-current motion-safe:animate-pulse" aria-hidden="true" />
    <UIcon v-else :name="meta.icon" class="size-3 shrink-0" aria-hidden="true" />
    <span>{{ meta.label }}</span>
    <span v-if="detail" class="font-normal opacity-80">· {{ detail }}</span>
  </UBadge>
</template>
