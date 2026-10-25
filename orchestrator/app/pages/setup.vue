<script setup lang="ts">
import { z } from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'
import { createSetupAdminBody, createSetupPasskeyTokenBody } from '#shared/schemas/setup'

// First admin (docs/ui.md §5.2, docs/auth.md §7): the setup token from the orchestrator log authorizes either a
// password admin or a passkey-first admin. The token leaves the address bar at once and lives in
// sessionStorage only until setup succeeds.
definePageMeta({ layout: 'auth', auth: false })
useHead({ title: 'Setup · scantor' })

const TOKEN_STORAGE_KEY = 'scantor-setup-token'
// The container name is fixed in the dev and the prod compose file, so the command needs neither compose file.
const SETUP_LOG_COMMAND = 'docker logs scantor-orchestrator 2>&1 | grep /setup'
const TOKEN_INVALID_MESSAGE = 'The setup token is missing or wrong. Restarting the orchestrator prints a new one.'

const route = useRoute()
const api = useApi()
const { client } = useAuth()
const { loadSetupStatus } = useInstance()

const token = ref<string | null>(null)
const pastedToken = ref('')
const passkeysEnabled = ref(false)
const mode = ref<'password' | 'passkey'>('password')
const error = ref<string | null>(null)
const loading = ref(false)
const checking = ref(true)

const passwordSchema = createSetupAdminBody
  .extend({ confirm: z.string() })
  .refine((value) => value.password === value.confirm, { message: 'The passwords do not match', path: ['confirm'] })
const passwordState = reactive({ name: '', email: '', password: '', confirm: '' })
const passkeyState = reactive({ name: '', email: '' })

function readStoredToken(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY)
  } catch (cause) {
    console.warn('[setup] sessionStorage is unavailable', cause)
    return null
  }
}

function storeToken(value: string | null): void {
  try {
    if (value) window.sessionStorage.setItem(TOKEN_STORAGE_KEY, value)
    else window.sessionStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch (cause) {
    console.warn('[setup] sessionStorage is unavailable', cause)
  }
}

function applyToken(value: string): void {
  const trimmed = value.trim()
  if (!trimmed) return
  token.value = trimmed
  storeToken(trimmed)
  error.value = null
}

function forgetToken(): void {
  token.value = null
  storeToken(null)
}

async function finishSetup(): Promise<void> {
  storeToken(null)
  hardNavigate('/')
}

function handleSetupError(cause: unknown): void {
  const apiError = toApiError(cause)
  if (apiError.code === 'setupCompleted') {
    storeToken(null)
    void navigateTo('/login')
    return
  }
  if (apiError.code === 'setupTokenInvalid') {
    error.value = TOKEN_INVALID_MESSAGE
    return
  }
  error.value = apiError.message
}

onMounted(async () => {
  // Remove the token from the address bar (and so from history) before anything else.
  const queryToken = typeof route.query.token === 'string' ? route.query.token : null
  if (queryToken) {
    storeToken(queryToken)
    window.history.replaceState(window.history.state, '', '/setup')
  }
  token.value = queryToken ?? readStoredToken()

  try {
    const status = await loadSetupStatus(true)
    if (!status.needsSetup) {
      storeToken(null)
      await navigateTo('/login')
      return
    }
    passkeysEnabled.value = status.passkeysEnabled
  } catch (cause) {
    error.value = `The setup status could not be loaded: ${errorMessage(cause)}`
  } finally {
    checking.value = false
  }
})

async function submitPassword(event: FormSubmitEvent<z.output<typeof passwordSchema>>): Promise<void> {
  if (!token.value) return
  error.value = null
  loading.value = true
  try {
    const { email, name, password } = event.data
    await api('/api/setup/admin', {
      method: 'POST',
      body: { email, name, password },
      headers: { 'X-Scantor-Setup-Token': token.value },
      toast: false,
    })
    const result = await client.signIn.email({ email, password })
    if (result.error) {
      // The admin exists; only the automatic sign-in failed.
      storeToken(null)
      hardNavigate('/login')
      return
    }
    await finishSetup()
  } catch (cause) {
    handleSetupError(cause)
  } finally {
    loading.value = false
  }
}

async function submitPasskey(event: FormSubmitEvent<z.output<typeof createSetupPasskeyTokenBody>>): Promise<void> {
  if (!token.value) return
  error.value = null
  loading.value = true
  try {
    const passkeyToken = await api<SetupPasskeyToken>('/api/setup/admin-passkey-token', {
      method: 'POST',
      body: event.data,
      headers: { 'X-Scantor-Setup-Token': token.value },
      toast: false,
    })
    // The registration creates the admin and signs this browser in (docs/auth.md §7.3).
    const result = await client.passkey.addPasskey({ name: 'Primary passkey', context: passkeyToken.token, createSession: true })
    if (result?.error) {
      error.value = result.error.message || 'The passkey could not be registered.'
      return
    }
    await finishSetup()
  } catch (cause) {
    handleSetupError(cause)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="rounded-xl border border-default bg-default p-6 shadow-sm">
    <h1 class="text-lg font-semibold text-highlighted">Create the first admin</h1>
    <p class="mb-4 text-sm text-muted">No account exists yet. The first account is an admin.</p>

    <p v-if="checking" class="text-sm text-dimmed">Checking setup status…</p>

    <div v-else-if="!token" class="space-y-3">
      <p class="text-sm">Open the setup link printed in the orchestrator log:</p>
      <CodeBlock :code="SETUP_LOG_COMMAND" copy-label="Copy log command" label="Command to find the setup link" />
      <form class="space-y-2" @submit.prevent="applyToken(pastedToken)">
        <UFormField label="Or paste the setup token" name="setupToken">
          <UInput v-model="pastedToken" placeholder="sst_…" autocomplete="off" class="w-full font-mono" />
        </UFormField>
        <UButton type="submit" label="Use token" size="sm" :disabled="!pastedToken.trim()" />
      </form>
      <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :description="error" role="alert" data-testid="setup-error" />
    </div>

    <div v-else class="space-y-4">
      <div v-if="passkeysEnabled" role="radiogroup" aria-label="Sign-in method" class="flex rounded-md bg-elevated p-0.5 text-sm">
        <button
          v-for="option in (['password', 'passkey'] as const)"
          :key="option"
          type="button"
          role="radio"
          :aria-checked="mode === option"
          class="flex-1 rounded px-3 py-1.5 transition-colors"
          :class="mode === option ? 'bg-default font-medium text-highlighted shadow-sm' : 'text-muted hover:text-highlighted'"
          @click="mode = option"
        >
          {{ option === 'password' ? 'Password' : 'Passkey' }}
        </button>
      </div>

      <UForm v-if="mode === 'password'" :schema="passwordSchema" :state="passwordState" class="space-y-3" @submit="submitPassword">
        <UFormField label="Name" name="name" required>
          <UInput v-model="passwordState.name" autocomplete="name" autofocus class="w-full" />
        </UFormField>
        <UFormField label="Email" name="email" required>
          <UInput v-model="passwordState.email" type="email" autocomplete="username" class="w-full" />
        </UFormField>
        <UFormField label="Password" name="password" required hint="8–128 characters">
          <UInput v-model="passwordState.password" type="password" autocomplete="new-password" class="w-full" />
        </UFormField>
        <UFormField label="Confirm password" name="confirm" required>
          <UInput v-model="passwordState.confirm" type="password" autocomplete="new-password" class="w-full" />
        </UFormField>
        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :description="error" role="alert" data-testid="setup-error" />
        <UButton type="submit" label="Create admin and sign in" block :loading="loading" />
      </UForm>

      <UForm v-else :schema="createSetupPasskeyTokenBody" :state="passkeyState" class="space-y-3" @submit="submitPasskey">
        <UFormField label="Name" name="name" required>
          <UInput v-model="passkeyState.name" autocomplete="name" autofocus class="w-full" />
        </UFormField>
        <UFormField label="Email" name="email" required>
          <UInput v-model="passkeyState.email" type="email" autocomplete="username" class="w-full" />
        </UFormField>
        <p class="text-sm text-muted">Your browser asks you to create a passkey on this device. The account has no password.</p>
        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :description="error" role="alert" data-testid="setup-error" />
        <UButton type="submit" label="Create admin with passkey" icon="i-lucide-key-round" block :loading="loading" />
      </UForm>

      <UButton
        label="Use a different setup token"
        color="neutral"
        variant="link"
        size="xs"
        @click="forgetToken"
      />
    </div>
  </div>
</template>
