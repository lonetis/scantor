<script setup lang="ts">
// Sessions (docs/ui.md §5.17): every signed-in browser with user agent, IP and creation time; the current one
// is marked. "Sign out other sessions" revokes each other session (better-auth revoke-session).

// The better-auth client revives ISO timestamps into Date objects.
interface SessionRow {
  id: string
  token: string
  userAgent?: string | null
  ipAddress?: string | null
  createdAt: string | Date
  expiresAt: string | Date
}

const { client, session } = useAuth()

const sessions = ref<SessionRow[]>([])
const loading = ref(false)
const working = ref(false)
const error = ref<string | null>(null)
const success = ref<string | null>(null)

function timeOf(value: string | Date): number {
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? 0 : time
}

const currentToken = computed(() => (session.value?.data?.session as { token?: string } | undefined)?.token ?? null)
const others = computed(() => sessions.value.filter((row) => row.token !== currentToken.value))
const sorted = computed(() =>
  [...sessions.value].sort((a, b) => Number(b.token === currentToken.value) - Number(a.token === currentToken.value) || timeOf(b.createdAt) - timeOf(a.createdAt)),
)

async function load(): Promise<void> {
  loading.value = true
  const result = await client.$fetch<SessionRow[]>('/list-sessions', { method: 'GET' })
  loading.value = false
  if (result.error) {
    // better-auth lists sessions only for a fresh session (signed in within the last 24 h).
    error.value = result.error.status === 403
      ? 'Sign out and in again to manage your sessions (this needs a sign-in from the last 24 hours).'
      : result.error.message || 'Sessions could not be loaded.'
    return
  }
  sessions.value = result.data ?? []
}

defineExpose({ load })
onMounted(() => {
  void load()
})

/** A short, readable device description from a user agent string. */
function deviceOf(userAgent: string | null | undefined): string {
  if (!userAgent) return 'Unknown device'
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : null
  // iOS user agents contain "like Mac OS X" and Android ones "Linux", so those are checked first.
  const system = /Windows/.test(userAgent) ? 'Windows' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Android/.test(userAgent) ? 'Android' : /Mac OS X|Macintosh/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : null
  return [browser, system].filter(Boolean).join(' on ') || userAgent.slice(0, 60)
}

async function revoke(rows: SessionRow[]): Promise<void> {
  working.value = true
  error.value = null
  success.value = null
  const results = await Promise.all(rows.map((row) => client.$fetch('/revoke-session', { method: 'POST', body: { token: row.token } })))
  working.value = false
  const failed = results.filter((result) => result.error)
  if (failed.length > 0) error.value = `${failed.length} of ${rows.length} sessions could not be signed out.`
  else success.value = rows.length === 1 ? 'Session signed out' : 'Other sessions signed out'
  await load()
}
</script>

<template>
  <section class="space-y-4 rounded-lg border border-default p-4" aria-labelledby="sessions-heading">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 id="sessions-heading" class="text-sm font-semibold text-highlighted">Sessions</h2>
      <UButton
        label="Sign out other sessions"
        icon="i-lucide-log-out"
        color="neutral"
        variant="outline"
        size="sm"
        :loading="working"
        :disabled="others.length === 0"
        @click="revoke(others)"
      />
    </div>

    <ul class="space-y-2" aria-label="Your sessions">
      <li
        v-for="row in sorted"
        :key="row.id"
        class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-default px-3 py-2 text-sm"
        :data-row-id="row.id"
      >
        <UIcon name="i-lucide-monitor-smartphone" class="size-4 text-muted" aria-hidden="true" />
        <span class="font-medium">{{ deviceOf(row.userAgent) }}</span>
        <UBadge v-if="row.token === currentToken" label="this browser" color="primary" variant="subtle" size="xs" />
        <span class="font-mono text-xs text-muted">{{ row.ipAddress || 'unknown IP' }}</span>
        <span class="text-xs text-muted">signed in <RelativeTime :value="row.createdAt" /></span>
        <UButton
          v-if="row.token !== currentToken"
          class="ms-auto"
          label="Sign out"
          size="xs"
          color="neutral"
          variant="ghost"
          :aria-label="`Sign out session ${deviceOf(row.userAgent)} from ${row.ipAddress || 'unknown IP'}`"
          :disabled="working"
          @click="revoke([row])"
        />
      </li>
      <li v-if="!loading && sessions.length === 0" class="text-xs text-dimmed">No sessions.</li>
    </ul>

    <p v-if="error" class="text-xs text-error" role="alert">{{ error }}</p>
    <p v-if="success" class="text-xs text-success" role="status">{{ success }}</p>
  </section>
</template>
