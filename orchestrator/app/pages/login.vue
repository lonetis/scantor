<script setup lang="ts">
import { z } from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'

// Sign-in (docs/ui.md §5.1): email + password, passkeys (button and conditional-UI autofill), and the resume
// of an MCP OAuth authorization when the URL carries a signed query.
definePageMeta({ layout: 'auth', auth: false })
useHead({ title: 'Sign in · scantor' })

const route = useRoute()
const { client } = useAuth()
const { loadSetupStatus } = useInstance()

const schema = z.object({
  email: z.email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
})
const state = reactive({ email: '', password: '' })
const error = ref<string | null>(route.query.banned === '1' ? 'Your account is banned' : null)
const loading = ref(false)
const passkeyLoading = ref(false)
const passkeysEnabled = ref(false)
const oauthFlow = ref(false)

const redirectTarget = computed(() => safeRedirectPath(route.query.redirect))

interface AuthFailure {
  status?: number
  code?: string
  message?: string
}

function failureMessage(failure: AuthFailure, fallback: string): string {
  if (failure.status === 429) return 'Too many attempts, try again in a minute'
  if (failure.code === 'BANNED_USER' || /banned/i.test(failure.message ?? '')) return 'Your account is banned'
  if (failure.status === 401 || failure.code === 'INVALID_EMAIL_OR_PASSWORD') return 'Invalid email or password'
  return failure.message || fallback
}

function afterSignIn(data: unknown): void {
  if (followOAuthRedirect(data)) return
  hardNavigate(redirectTarget.value)
}

async function startConditionalPasskey(): Promise<void> {
  // Conditional UI races test-driven passkey ceremonies, so it is skipped under webdriver.
  if (navigator.webdriver) return
  const credential = window.PublicKeyCredential as (typeof PublicKeyCredential & { isConditionalMediationAvailable?: () => Promise<boolean> }) | undefined
  if (!credential?.isConditionalMediationAvailable || !(await credential.isConditionalMediationAvailable())) return
  const result = await client.signIn.passkey({ autoFill: true })
  if (result?.data && !result.error) afterSignIn(result.data)
}

onMounted(async () => {
  oauthFlow.value = isOAuthAuthorizationPage()
  try {
    const status = await loadSetupStatus(true)
    if (status.needsSetup) {
      await navigateTo('/setup')
      return
    }
    passkeysEnabled.value = status.passkeysEnabled
  } catch (cause) {
    console.error('[login] loading the setup status failed', cause)
  }

  const session = await client.getSession()
  if (session.data?.user && !oauthFlow.value) {
    hardNavigate(redirectTarget.value)
    return
  }

  if (passkeysEnabled.value) {
    startConditionalPasskey().catch((cause: unknown) => console.warn('[login] passkey autofill is unavailable', cause))
  }
})

async function onSubmit(event: FormSubmitEvent<z.output<typeof schema>>): Promise<void> {
  error.value = null
  loading.value = true
  try {
    const result = await client.signIn.email({ email: event.data.email, password: event.data.password })
    if (result.error) {
      error.value = failureMessage(result.error, 'Sign-in failed')
      return
    }
    afterSignIn(result.data)
  } finally {
    loading.value = false
  }
}

async function signInWithPasskey(): Promise<void> {
  error.value = null
  passkeyLoading.value = true
  try {
    const result = await client.signIn.passkey()
    if (result?.error) {
      error.value = failureMessage(result.error, 'Passkey sign-in failed')
      return
    }
    afterSignIn(result?.data)
  } finally {
    passkeyLoading.value = false
  }
}
</script>

<template>
  <div class="rounded-xl border border-default bg-default p-6 shadow-sm">
    <h1 class="mb-1 text-lg font-semibold text-highlighted">Sign in</h1>
    <p v-if="oauthFlow" class="mb-4 text-sm text-muted" data-testid="oauth-login-notice">
      Sign in to authorize an application to access your scantor account.
    </p>
    <p v-else class="mb-4 text-sm text-muted">Distributed scanning platform</p>

    <UForm :schema="schema" :state="state" class="space-y-4" @submit="onSubmit">
      <UFormField label="Email" name="email" required>
        <UInput
          v-model="state.email"
          type="email"
          autocomplete="username webauthn"
          placeholder="you@example.com"
          autofocus
          class="w-full"
        />
      </UFormField>
      <UFormField label="Password" name="password" required>
        <UInput
          v-model="state.password"
          type="password"
          autocomplete="current-password webauthn"
          class="w-full"
        />
      </UFormField>

      <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :description="error" role="alert" data-testid="login-error" />

      <UButton type="submit" label="Sign in" block :loading="loading" />
    </UForm>

    <template v-if="passkeysEnabled">
      <div class="my-4 flex items-center gap-3 text-xs uppercase tracking-wide text-dimmed">
        <div class="h-px flex-1 bg-(--ui-border)" />
        <span>or</span>
        <div class="h-px flex-1 bg-(--ui-border)" />
      </div>
      <UButton
        label="Sign in with passkey"
        icon="i-lucide-key-round"
        color="neutral"
        variant="outline"
        block
        :loading="passkeyLoading"
        @click="signInWithPasskey"
      />
    </template>
  </div>
</template>
