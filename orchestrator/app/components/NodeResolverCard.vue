<script setup lang="ts">
import type { NodeResolverReport } from '#shared/types/nodes'

// The "Node resolver" card of the node page (docs/ui.md §5.15, docs/nodes.md §6.11), a region named by its heading: the
// state of the DNS server every worker of the node resolves names through, its mode and address, the reason when it
// cannot serve, its upstream check and IPv6 use ("unknown" while the report cannot know them) and its statistics
// since it started.
const props = defineProps<{
  resolver: NodeResolverReport | null | undefined
}>()

const error = computed(() => resolverErrorText(props.resolver?.error, props.resolver?.detail))
const health = computed(() => (props.resolver ? resolverHealthText(props.resolver) : null))
const stats = computed(() => resolverStatRows(props.resolver?.stats))
</script>

<template>
  <UCard as="section" aria-labelledby="node-resolver-heading" :ui="{ body: 'p-4 sm:p-4' }" data-testid="node-resolver">
    <div class="mb-2 flex items-center justify-between gap-2">
      <h2 id="node-resolver-heading" class="section-label">Node resolver</h2>
      <StatusBadge v-if="resolver" kind="resolver" :state="resolver.state" />
    </div>
    <p v-if="!resolver" class="text-sm text-muted">Not reported by the node's daemon.</p>
    <template v-else>
      <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt class="text-xs text-muted">Mode</dt>
        <dd>{{ resolver.mode }}<span v-if="resolver.kept" class="text-muted"> · kept for existing workers</span></dd>
        <dt class="text-xs text-muted">Address</dt>
        <dd class="font-mono text-xs">{{ resolver.address || '–' }}</dd>
        <template v-if="error">
          <dt class="text-xs text-muted">Error</dt>
          <dd class="text-error">{{ error }}</dd>
        </template>
        <dt class="text-xs text-muted">Upstream check</dt>
        <dd :class="health?.upstream === 'unknown' ? 'text-muted' : ''">{{ health?.upstream }}</dd>
        <dt class="text-xs text-muted">IPv6</dt>
        <dd :class="health?.ipv6 === 'unknown' ? 'text-muted' : ''">{{ health?.ipv6 }}</dd>
        <dt class="text-xs text-muted">State since</dt>
        <dd><RelativeTime :value="resolver.since" /></dd>
        <template v-if="resolver.spec">
          <dt class="text-xs text-muted">Spec</dt>
          <dd class="font-mono text-xs" :title="resolver.spec">{{ shortId(resolver.spec, 12) }}</dd>
        </template>
      </dl>
      <dl v-if="stats.length > 0" class="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 border-t border-default pt-3 text-sm">
        <template v-for="row in stats" :key="row.label">
          <dt class="text-xs text-muted">{{ row.label }}</dt>
          <dd class="tabular-nums" :class="row.warn ? 'text-warning' : ''" :title="row.title">{{ row.value }}</dd>
        </template>
      </dl>
    </template>
  </UCard>
</template>
