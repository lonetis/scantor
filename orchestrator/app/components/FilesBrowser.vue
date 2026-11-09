<script setup lang="ts">
import type { TreeItem } from '@nuxt/ui'

// Read-only file browser of a folder (a task's workspace or revision, a script; docs/ui.md §5.7 tab `files`): the tree,
// a viewer for UTF-8 files and size notices for binary or truncated content. The owner passes how to list and read the
// folder; `folderKey` changes whenever another folder (or another source of it) is shown. The UI never edits files;
// "Open in editor" does.
const props = defineProps<{
  /** identity of the shown folder and source; the listing is read again when it changes */
  folderKey: string
  list: () => Promise<TaskFileList>
  read: (path: string) => Promise<TaskFileContent>
  /** accessible name of the tree */
  treeLabel: string
  /** the editor link of the folder, or null without the editor */
  editorTo: string | null
}>()

interface FileNode extends TreeItem {
  path: string
  type: TaskFileEntry['type']
  children?: FileNode[]
}

const listing = shallowRef<TaskFileList | null>(null)
const listError = ref<string | null>(null)
const loadingList = ref(false)
const selected = ref<FileNode | undefined>(undefined)
const content = shallowRef<TaskFileContent | null>(null)
const contentError = ref<string | null>(null)
const loadingContent = ref(false)

const ICONS: Record<TaskFileEntry['type'], string> = { file: 'i-lucide-file', dir: 'i-lucide-folder', symlink: 'i-lucide-link' }

/** Nested tree items from the flat, path-sorted listing. */
function buildTree(entries: readonly TaskFileEntry[]): FileNode[] {
  const roots: FileNode[] = []
  const byPath = new Map<string, FileNode>()
  for (const entry of entries) {
    const slash = entry.path.lastIndexOf('/')
    const node: FileNode = {
      label: slash >= 0 ? entry.path.slice(slash + 1) : entry.path,
      path: entry.path,
      type: entry.type,
      icon: ICONS[entry.type],
      ...(entry.type === 'dir' ? { children: [] } : {}),
    }
    byPath.set(entry.path, node)
    const parent = slash >= 0 ? byPath.get(entry.path.slice(0, slash)) : undefined
    if (parent?.children) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

const tree = computed(() => buildTree(listing.value?.entries ?? []))

// Reads count up, so an answer is applied only while it belongs to the latest listing or file read: a slow read of a
// file selected before (or of the source shown before) never replaces the current one.
let listingGeneration = 0
let contentGeneration = 0

async function loadListing(): Promise<void> {
  const generation = ++listingGeneration
  contentGeneration++
  loadingList.value = true
  loadingContent.value = false
  listError.value = null
  selected.value = undefined
  content.value = null
  try {
    const result = await props.list()
    if (generation === listingGeneration) listing.value = result
  } catch (cause) {
    if (generation !== listingGeneration) return
    listing.value = null
    listError.value = errorMessage(cause)
  } finally {
    if (generation === listingGeneration) loadingList.value = false
  }
}

async function open(node: FileNode | undefined): Promise<void> {
  if (!node || node.type !== 'file') return
  const generation = ++contentGeneration
  loadingContent.value = true
  contentError.value = null
  try {
    const result = await props.read(node.path)
    if (generation === contentGeneration) content.value = result
  } catch (cause) {
    if (generation !== contentGeneration) return
    content.value = null
    contentError.value = errorMessage(cause)
  } finally {
    if (generation === contentGeneration) loadingContent.value = false
  }
}

watch(selected, (node) => void open(node))
watch(() => props.folderKey, () => void loadListing(), { immediate: true })
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <slot name="source" />
        <RefreshButton :loading="loadingList" label="Reload files" @click="loadListing" />
      </div>
      <UButton
        v-if="editorTo"
        :to="editorTo"
        label="Open in editor"
        icon="i-lucide-code"
        size="xs"
        variant="outline"
      />
    </div>
    <UAlert v-if="listError" color="error" variant="subtle" icon="i-lucide-circle-alert" title="Files could not be listed" :description="listError" />
    <UAlert
      v-if="listing?.truncated"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="Only the first 5000 entries are shown"
    />
    <div class="grid min-h-96 gap-3 lg:grid-cols-[minmax(14rem,20rem)_1fr]">
      <div class="overflow-auto rounded-md border border-default p-1">
        <USkeleton v-if="loadingList && !listing" class="h-40 w-full" />
        <UTree v-else-if="tree.length > 0" v-model="selected" :items="tree" :get-key="(item: FileNode) => item.path" size="sm" :aria-label="treeLabel" />
        <p v-else-if="listing" class="p-2 text-xs text-dimmed">The folder is empty.</p>
      </div>
      <div class="min-w-0">
        <p v-if="!selected" class="text-xs text-dimmed">Select a file to view it.</p>
        <USkeleton v-else-if="loadingContent" class="h-40 w-full" />
        <UAlert v-else-if="contentError" color="error" variant="subtle" icon="i-lucide-circle-alert" title="The file could not be read" :description="contentError" />
        <template v-else-if="content">
          <div class="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span class="font-mono">{{ content.path }}</span>
            <BytesText :bytes="content.size" />
            <IdChip :id="content.sha256" copy-label="Copy file hash" />
          </div>
          <UAlert v-if="content.truncated" color="warning" variant="subtle" icon="i-lucide-triangle-alert" title="Only the first MiB is shown" class="mb-2" />
          <CodeBlock v-if="content.encoding === 'utf8'" :code="content.content" line-numbers :label="content.path" />
          <p v-else class="rounded-md border border-default p-4 text-sm text-muted">Binary file, {{ formatBytes(content.size) }}</p>
        </template>
      </div>
    </div>
  </div>
</template>
