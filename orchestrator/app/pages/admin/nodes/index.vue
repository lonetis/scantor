<script setup lang="ts">
import { refDebounced } from '@vueuse/core'
import type { NodeJoin, NodeWithToken, ScantorNode } from '#shared/types/nodes'

// Nodes (docs/ui.md §5.15): every compute node with capacity and warnings, filtered by state and pool; add a node
// (its token and join commands are shown once), edit and cordon, show the join command, rotate or revoke the token,
// delete. Polls every 10 s while visible.
definePageMeta({ admin: true })
useHead({ title: 'Nodes · scantor' })

const toast = useToast()
const { confirm } = useConfirm()

const ANY = 'any'
const stateFilter = ref<string>(ANY)
const poolFilter = ref('')
const debouncedPool = refDebounced(poolFilter, 300)
const nodes = useNodes(() => ({
  state: stateFilter.value === ANY ? null : (stateFilter.value as NodeState),
  pool: debouncedPool.value,
}))

const STATE_ITEMS = [{ label: 'Any state', value: ANY }, ...NODE_STATES.map((state) => ({ label: state, value: state }))]

const formOpen = ref(false)
const formMode = ref<'create' | 'edit'>('create')
const formNode = shallowRef<ScantorNode | null>(null)

const joinOpen = ref(false)
const joinNodeName = ref('')
const join = shallowRef<NodeJoin | null>(null)
const joinToken = ref<string | null>(null)

function openForm(mode: 'create' | 'edit', node: ScantorNode | null = null): void {
  formMode.value = mode
  formNode.value = node
  formOpen.value = true
}

function revealToken(result: NodeWithToken): void {
  joinNodeName.value = result.node.name
  join.value = result.join
  joinToken.value = result.token
  joinOpen.value = true
}

function onCreated(result: NodeWithToken): void {
  revealToken(result)
}

function onSaved(node: ScantorNode): void {
  toast.add({ title: `Node ${node.name} saved`, color: 'success', icon: 'i-lucide-check' })
}

async function showJoin(node: ScantorNode): Promise<void> {
  joinNodeName.value = node.name
  joinToken.value = null
  join.value = null
  joinOpen.value = true
  try {
    join.value = await nodes.getNodeJoin(node.id)
  } catch (error) {
    joinOpen.value = false
    console.error('[nodes] loading the join command failed', error)
  }
}

async function rotate(node: ScantorNode): Promise<void> {
  const confirmed = await confirm({
    title: `Rotate the token of ${node.name}`,
    description: 'The current token stops working at once. Restart the node daemon with the new token; its workers are rescheduled if it stays away longer than the offline window.',
    confirmLabel: 'Rotate token',
    confirmColor: 'warning',
  })
  if (!confirmed) return
  try {
    revealToken(await nodes.rotateNodeToken(node.id))
  } catch (error) {
    console.error('[nodes] rotating the token failed', error)
  }
}

async function revoke(node: ScantorNode): Promise<void> {
  const confirmed = await confirm({
    title: `Revoke the token of ${node.name}`,
    description: 'The node can no longer connect or pull images. Its workers are rescheduled on other nodes. Rotate the token to let it join again.',
    confirmLabel: 'Revoke token',
  })
  if (!confirmed) return
  try {
    await nodes.revokeNodeToken(node.id)
    toast.add({ title: `Token of ${node.name} revoked`, color: 'success', icon: 'i-lucide-check' })
  } catch (error) {
    console.error('[nodes] revoking the token failed', error)
  }
}

async function remove(node: ScantorNode): Promise<void> {
  const confirmed = await confirm({
    title: `Delete node ${node.name}`,
    description: 'The node record is removed and its token revoked. Its workers are rescheduled on other nodes; the daemon removes its containers on its own.',
    confirmLabel: 'Delete node',
    typeToConfirm: node.name,
  })
  if (!confirmed) return
  try {
    await nodes.deleteNode(node.id)
    toast.add({ title: `Node ${node.name} deleted`, color: 'success', icon: 'i-lucide-check' })
  } catch (error) {
    console.error('[nodes] deleting the node failed', error)
  }
}
</script>

<template>
  <UDashboardPanel id="admin-nodes">
    <template #header>
      <UDashboardNavbar title="Nodes">
        <template #leading>
          <SidebarCollapseButton />
        </template>
        <template #right>
          <RefreshButton :loading="nodes.refreshing.value" @click="nodes.refresh()" />
          <UButton label="Add node" icon="i-lucide-plus" size="sm" @click="openForm('create')" />
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar>
        <div class="flex flex-wrap items-center gap-2">
          <USelect v-model="stateFilter" :items="STATE_ITEMS" aria-label="Filter by state" size="sm" class="w-36" />
          <UInput v-model="poolFilter" icon="i-lucide-filter" placeholder="Pool" aria-label="Filter by pool" size="sm" class="w-40 font-mono" />
        </div>
      </UDashboardToolbar>
    </template>

    <template #body>
      <UAlert
        v-if="nodes.error.value"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        title="Nodes could not be loaded"
        :description="errorMessage(nodes.error.value)"
      />
      <EmptyState
        v-if="nodes.loaded.value && nodes.nodes.value.length === 0 && stateFilter === ANY && !poolFilter"
        icon="i-lucide-server"
        title="No nodes yet"
        description="The built-in node appears after the orchestrator has started."
      />
      <NodeTable
        v-else
        :nodes="nodes.nodes.value"
        :loading="!nodes.loaded.value"
        @edit="openForm('edit', $event)"
        @join="showJoin"
        @rotate="rotate"
        @revoke="revoke"
        @delete="remove"
      />

      <NodeFormModal v-model:open="formOpen" :mode="formMode" :node="formNode" :actions="nodes" @created="onCreated" @saved="onSaved" />
      <NodeJoinModal v-model:open="joinOpen" :node-name="joinNodeName" :join="join" :token="joinToken" />
    </template>
  </UDashboardPanel>
</template>
