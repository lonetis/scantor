<script setup lang="ts">
import type { FileRef } from '#shared/types/common'
import type { FileDownload } from '#shared/types/exports'

// One file of an analysis (docs/ui.md §5.13.3): name, size, content type and SHA-256 as text, a download button
// (getFileDownload → presigned URL, forced attachment) and, with `preview`, an image preview for the types the API
// serves inline (png, jpeg, gif, webp). File names come from task code: rendered as text, never as a link.
const props = withDefaults(defineProps<{
  file: FileRef
  /** `<scanId>-<seq>` of the analysis the file belongs to. */
  analysisId: string
  /** Show an image preview when the API serves the file inline. */
  preview?: boolean
  /** Compact form for table cells. */
  compact?: boolean
}>(), { preview: false, compact: false })

const analyses = useAnalyses(() => props.analysisId.slice(0, 36))
const downloading = ref(false)
const previewInfo = shallowRef<FileDownload | null>(null)
const previewFailed = ref(false)
const isImage = computed(() => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(props.file.contentType.split(';')[0]!.trim().toLowerCase()))

async function download(): Promise<void> {
  downloading.value = true
  try {
    const info = await analyses.fileDownload(props.analysisId, props.file.id)
    navigateToDownload(info.url)
  } catch (error) {
    console.error('[files] creating the download link failed', error)
  } finally {
    downloading.value = false
  }
}

async function loadPreview(): Promise<void> {
  if (!props.preview || !isImage.value) return
  try {
    const info = await analyses.fileDownload(props.analysisId, props.file.id)
    if (info.inline) previewInfo.value = info
  } catch (error) {
    previewFailed.value = true
    console.error('[files] creating the preview link failed', error)
  }
}

watch(() => [props.analysisId, props.file.id, props.preview], () => {
  previewInfo.value = null
  previewFailed.value = false
  void loadPreview()
}, { immediate: true })
</script>

<template>
  <div class="inline-flex max-w-full flex-col gap-1" :data-file-id="file.id">
    <div class="inline-flex max-w-full items-center gap-1.5 rounded-md border border-default bg-elevated/50 px-2 py-0.5 text-xs">
      <UIcon :name="isImage ? 'i-lucide-file-image' : 'i-lucide-file'" class="size-3.5 shrink-0 text-muted" aria-hidden="true" />
      <UTooltip :text="`SHA-256 ${file.sha256}`">
        <span class="truncate font-mono" :class="compact ? 'max-w-32' : 'max-w-64'">{{ file.name }}</span>
      </UTooltip>
      <BytesText :bytes="file.size" class="text-muted" />
      <span v-if="!compact" class="truncate text-dimmed">{{ file.contentType }}</span>
      <UTooltip :text="`Download ${file.name}`">
        <UButton
          icon="i-lucide-download"
          color="neutral"
          variant="ghost"
          size="xs"
          :loading="downloading"
          :aria-label="`Download ${file.name}`"
          @click.stop="download"
        />
      </UTooltip>
    </div>
    <img
      v-if="previewInfo"
      :src="previewInfo.url"
      :alt="`Preview of ${file.name}`"
      class="max-h-64 max-w-full rounded-md border border-default object-contain"
      referrerpolicy="no-referrer"
      loading="lazy"
    >
    <p v-else-if="previewFailed" class="text-xs text-dimmed">Preview unavailable.</p>
  </div>
</template>
