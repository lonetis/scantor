<script setup lang="ts">
import { useNow } from '@vueuse/core'

// The bundle of a revision (docs/ui.md §5.9): the disclosure warning, then "Create bundle" while the revision has none;
// the state and elapsed time while the bundle job runs (useBundle polls every 2 s); when ready the platform, size,
// expiry, "Download bundle" (a fresh presigned link; disabled without the downloads feature) and the recipient's
// copyable commands; when failed the error and "Try again" (rebuild). Mount it with `v-if` and `v-model:open`, so it
// reads the bundle when it opens.
const props = defineProps<{
  revision: Pick<Revision, 'taskId' | 'number' | 'ref'>
}>()

const open = defineModel<boolean>('open', { default: true })

const detail = useBundle(
  () => props.revision.taskId,
  () => String(props.revision.number),
)
const bundle = detail.bundle
const now = useNow({ interval: 1000 })
const { features, publicUrl } = useInstance()

const active = computed(() => isBundleActive(bundle.value?.state))
const elapsed = computed(() => (bundle.value ? bundleElapsedMs(bundle.value, now.value.getTime()) : null))
const commands = computed(() => (bundle.value ? bundleCommandLines(bundle.value) : []))
const platform = computed(() => (bundle.value ? bundlePlatformLabel(bundle.value.platform) : ''))
/** The footer's action: create while there is no bundle, try again after a failure, download when ready. */
const action = computed<'create' | 'retry' | 'download' | null>(() => {
  if (!detail.loaded.value) return null
  if (!bundle.value) return 'create'
  if (bundle.value.state === 'failed') return 'retry'
  return bundle.value.state === 'ready' ? 'download' : null
})

const createError = shallowRef<ApiError | null>(null)
const downloading = ref(false)

async function create(rebuild: boolean): Promise<void> {
  createError.value = null
  try {
    await detail.create(rebuild)
  } catch (cause) {
    createError.value = toApiError(cause)
  }
}

async function download(): Promise<void> {
  downloading.value = true
  try {
    await detail.download()
  } catch (cause) {
    // The API wrapper already showed the error as a toast.
    console.error('[bundles] reading the download link failed', cause)
  } finally {
    downloading.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="`Bundle of ${revision.ref}`"
    description="Run this revision on any machine with only Docker, without the platform."
    :ui="{ content: 'sm:max-w-2xl' }"
    :content="dialogContent"
  >
    <template #close="{ ui }">
      <CloseButton :class="ui.close()" />
    </template>
    <template #body>
      <div class="space-y-4">
        <UAlert
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="Share bundles only with people you trust"
          :description="BUNDLE_WARNING"
        />

        <UAlert
          v-if="detail.error.value && !bundle"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          title="The bundle could not be loaded"
          :description="errorMessage(detail.error.value)"
        />
        <USkeleton v-else-if="!detail.loaded.value" class="h-16 w-full" />
        <p v-else-if="!bundle" class="text-sm text-muted">
          This revision has no bundle yet. Creating one builds it on the master, which takes a few minutes for large task images. A bundle is kept for a limited
          time; it can be created again later.
        </p>

        <template v-if="bundle">
          <!-- Only the state is a live region: the elapsed time changes every second and is not announced. -->
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            <span role="status"><StatusBadge kind="bundle" :state="bundle.state" /></span>
            <span v-if="active">building for <DurationText :ms="elapsed" /></span>
            <span v-else-if="bundle.state === 'ready'">ready after <DurationText :ms="elapsed" /></span>
            <span>requested <RelativeTime :value="bundle.createdAt" /></span>
          </div>

          <UAlert
            v-if="bundle.state === 'failed'"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-x"
            title="The bundle failed"
            :description="bundle.error ? `${bundle.error.message} (${bundle.error.code})` : 'The bundle could not be built.'"
          />

          <template v-if="bundle.state === 'ready'">
            <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt class="text-xs text-muted">Platform</dt>
              <dd class="font-mono text-xs">{{ platform }}</dd>
              <dt class="text-xs text-muted">Size</dt>
              <dd><BytesText :bytes="bundle.bytes" /></dd>
              <dt class="text-xs text-muted">Expires</dt>
              <dd><RelativeTime :value="bundle.expiresAt" /></dd>
              <template v-if="bundle.download">
                <dt class="text-xs text-muted">File</dt>
                <dd class="min-w-0 truncate font-mono text-xs" :title="bundle.download.fileName">{{ bundle.download.fileName }}</dd>
              </template>
              <template v-if="bundle.sha256">
                <dt class="text-xs text-muted">SHA-256</dt>
                <dd><IdChip :id="bundle.sha256" copy-label="Copy bundle SHA-256" /></dd>
              </template>
              <template v-if="bundle.scantorVersion">
                <dt class="text-xs text-muted">Runtime</dt>
                <dd class="text-xs">scantor {{ bundle.scantorVersion }}</dd>
              </template>
            </dl>
            <p class="text-xs text-muted">
              The bundle runs natively on {{ platform }}; other platforms need emulation (Docker Desktop on Apple Silicon runs amd64 images). The recipient
              needs Docker only:
            </p>
            <div v-for="command in commands" :key="command.key" class="space-y-1">
              <p class="section-label">{{ command.title }}</p>
              <CodeBlock :code="command.code" :copy-label="`Copy ${command.key} command`" :label="`${command.title} command`" wrap />
            </div>
          </template>
        </template>

        <UAlert
          v-if="createError"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="errorTitle(createError.code)"
          :description="createError.message"
        />
      </div>
    </template>
    <template v-if="action" #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton v-if="action === 'create'" label="Create bundle" icon="i-lucide-package" :loading="detail.creating.value" @click="create(false)" />
        <UButton v-else-if="action === 'retry'" label="Try again" icon="i-lucide-rotate-ccw" :loading="detail.creating.value" @click="create(true)" />
        <UTooltip v-else :text="downloadsUnavailableText(publicUrl)" :disabled="features.downloads">
          <span>
            <UButton label="Download bundle" icon="i-lucide-download" :loading="downloading" :disabled="!features.downloads" @click="download" />
          </span>
        </UTooltip>
      </div>
    </template>
  </UModal>
</template>
