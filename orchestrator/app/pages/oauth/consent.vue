<script setup lang="ts">
import type { AccessLevel } from '~/utils/consent'

// OAuth consent for MCP clients (docs/ui.md §5.3, docs/mcp.md §3.3). Shows who asks (with the redirect origin,
// which defeats look-alike names) and lets the user pick the access level. Requires a session; without one the
// user signs in first with the signed OAuth query kept.
definePageMeta({ layout: 'auth', auth: false })
useHead({ title: 'Authorize application · scantor' })

interface PublicClient {
  client_id: string
  client_name?: string | null
  client_uri?: string | null
}

const route = useRoute()
const { client, waitForSession, isAdmin } = useAuth()

const sessionEmail = ref<string | null>(null)
const appClient = ref<PublicClient | null>(null)
const error = ref<string | null>(null)
const submitting = ref<'approve' | 'deny' | null>(null)
const level = ref<AccessLevel | undefined>(undefined)

const clientId = computed(() => (typeof route.query.client_id === 'string' ? route.query.client_id : ''))
const requestedScopes = computed(() => parseScopes(route.query.scope))
const redirectOrigin = computed(() => urlOrigin(route.query.redirect_uri))
/** CIMD clients are identified by an https metadata URL; everything else registered itself (DCR). */
const metadataHost = computed(() => {
  const url = safeHttpUrl(clientId.value)
  return url && url.startsWith('https://') ? new URL(url).host : null
})
const unverified = computed(() => metadataHost.value === null)
const clientName = computed(() => appClient.value?.client_name || metadataHost.value || 'An application')
const clientHomepage = computed(() => safeHttpUrl(appClient.value?.client_uri))
const levels = computed(() => consentLevels(requestedScopes.value, isAdmin.value))
const levelItems = computed(() => levels.value.map((option) => ({
  value: option.value,
  label: option.label,
  description: option.description,
  disabled: option.disabled,
})))

onMounted(async () => {
  const user = await waitForSession()
  if (!user) {
    await navigateTo({ path: '/login', query: route.query })
    return
  }
  sessionEmail.value = user.email
  level.value = defaultConsentLevel(levels.value) ?? undefined

  if (!isOAuthAuthorizationPage() || !clientId.value) {
    error.value = 'This page is only reachable from an application authorization request.'
    return
  }
  const result = await client.$fetch<PublicClient>('/oauth2/public-client', { method: 'GET', query: { client_id: clientId.value } })
  if (result.error) {
    error.value = result.error.message || 'Unknown application'
    return
  }
  appClient.value = result.data
})

async function respond(accept: boolean): Promise<void> {
  error.value = null
  if (accept && !level.value) {
    error.value = 'Choose an access level.'
    return
  }
  submitting.value = accept ? 'approve' : 'deny'
  try {
    const body = accept && level.value
      ? { accept: true, scope: approvedScope(requestedScopes.value, level.value) }
      : { accept: false }
    const result = await client.$fetch('/oauth2/consent', { method: 'POST', body })
    if (result.error) {
      error.value = result.error.message || 'Authorization failed'
      return
    }
    if (!followOAuthRedirect(result.data)) error.value = 'Authorization finished without a redirect.'
  } finally {
    submitting.value = null
  }
}
</script>

<template>
  <div class="rounded-xl border border-default bg-default p-6 shadow-sm" data-testid="oauth-consent">
    <h1 class="flex flex-wrap items-center gap-2 text-lg font-semibold text-highlighted">
      <span>Authorize <span data-testid="oauth-client-name">{{ clientName }}</span></span>
      <UBadge v-if="appClient && unverified" label="unverified" color="warning" variant="subtle" size="sm" />
    </h1>
    <p v-if="metadataHost" class="mt-1 text-xs text-muted">Identified by its metadata document on <span class="font-mono">{{ metadataHost }}</span></p>
    <a
      v-if="clientHomepage"
      :href="clientHomepage"
      target="_blank"
      rel="noopener noreferrer"
      class="mt-1 block truncate text-xs text-primary hover:underline"
    >{{ clientHomepage }}</a>

    <p v-if="redirectOrigin" class="mt-4 rounded-md border border-default bg-elevated px-3 py-2 text-sm">
      After approval you will return to
      <span class="font-mono font-semibold text-highlighted" data-testid="oauth-redirect-origin">{{ redirectOrigin }}</span>
    </p>

    <p v-if="sessionEmail" class="mt-3 text-sm text-muted">
      Signed in as <span class="font-medium text-highlighted" data-testid="oauth-account">{{ sessionEmail }}</span>
    </p>

    <UFormField label="Access level" name="accessLevel" class="mt-5">
      <URadioGroup
        v-model="level"
        :items="levelItems"
        :disabled="!appClient"
        aria-label="Access level"
        data-testid="oauth-access-level"
      />
    </UFormField>

    <p class="mt-4 text-xs text-muted">
      Only approve applications you trust. You can revoke access at any time under CLI &amp; MCP access.
    </p>

    <UAlert v-if="error" class="mt-4" color="error" variant="subtle" icon="i-lucide-circle-alert" :description="error" role="alert" data-testid="oauth-consent-error" />

    <div class="mt-6 flex gap-3">
      <UButton
        label="Deny"
        block
        color="neutral"
        variant="outline"
        :loading="submitting === 'deny'"
        :disabled="submitting !== null || !appClient"
        @click="respond(false)"
      />
      <UButton
        label="Approve"
        block
        :loading="submitting === 'approve'"
        :disabled="submitting !== null || !appClient || !level"
        @click="respond(true)"
      />
    </div>
  </div>
</template>
