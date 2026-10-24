<script setup lang="ts">
import type { NodeJoin } from '#shared/types/nodes'
import type { SecretSnippet } from './SecretRevealModal.vue'

// Join instructions of a remote node (docs/nodes.md §4, docs/ui.md §5.15): the `docker run` line and the compose file
// next to the host checklist. With `token` (createNode, rotateNodeToken) the token is shown exactly once through
// SecretRevealModal; without it (getNodeJoin) the snippets carry the placeholder ${SCANTOR_NODE_TOKEN}.
const props = withDefaults(defineProps<{
  nodeName: string
  join: NodeJoin | null
  token?: string | null
}>(), { token: null })

const open = defineModel<boolean>('open', { default: false })

const TOKEN_WARNING = 'This token is shown only now. A node sees everything about the scans placed on it; add only machines you trust like the master.'

const { info, loadInfo } = useInstance()
watch(open, (value) => {
  if (value) loadInfo().catch((error: unknown) => console.error('[nodes] loading instance info failed', error))
}, { immediate: true })

const snippets = computed<SecretSnippet[]>(() =>
  props.join
    ? [
        { title: 'docker run', code: props.join.dockerRun },
        { title: 'compose.yml', code: props.join.compose },
      ]
    : [],
)

const checklist = computed(() => [
  'Docker Engine 25 or newer on the node host.',
  `Outbound HTTPS from the node host to ${info.value?.publicUrl ?? 'the dashboard URL'}, ${info.value?.registryPublicHost ?? 'the registry host'}, the S3 endpoint and the AMQPS endpoint.`,
  'Optionally, outbound HTTPS to ghcr.io for base-image layers.',
  'For a private CA, the host Docker daemon must trust it for the registry host (/etc/docker/certs.d/<registry host>/ca.crt).',
  'For SCANTOR_NODE_DIND=sysbox, Sysbox must be installed on the host.',
])
</script>

<template>
  <SecretRevealModal
    v-if="token"
    v-model:open="open"
    :title="`Token of node ${nodeName}`"
    :secret="token"
    secret-label="Node token"
    :warning="TOKEN_WARNING"
    :snippets="snippets"
  >
    <div class="space-y-1">
      <p class="section-label">Checklist</p>
      <ol class="list-decimal space-y-0.5 ps-5 text-xs text-muted">
        <li v-for="item in checklist" :key="item">{{ item }}</li>
      </ol>
    </div>
  </SecretRevealModal>

  <UModal v-else v-model:open="open" :title="`Join command of ${nodeName}`" :ui="{ content: 'sm:max-w-2xl' }">
    <template #close="{ ui }">
      <CloseButton :class="ui.close()" />
    </template>
    <template #body>
      <div class="space-y-4">
        <p class="text-xs text-muted">
          Replace <code class="font-mono">${SCANTOR_NODE_TOKEN}</code> with the node's token. Tokens are shown only when a node is
          added or its token is rotated; rotate the token if it was lost.
        </p>
        <div v-for="snippet in snippets" :key="snippet.title" class="space-y-1">
          <p class="section-label">{{ snippet.title }}</p>
          <CodeBlock :code="snippet.code" :copy-label="`Copy ${snippet.title}`" :label="snippet.title" wrap />
        </div>
        <USkeleton v-if="!join" class="h-24 w-full" />
        <div class="space-y-1">
          <p class="section-label">Checklist</p>
          <ol class="list-decimal space-y-0.5 ps-5 text-xs text-muted">
            <li v-for="item in checklist" :key="item">{{ item }}</li>
          </ol>
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end">
        <UButton label="Close" color="neutral" variant="outline" @click="open = false" />
      </div>
    </template>
  </UModal>
</template>
