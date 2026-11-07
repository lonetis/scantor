<script setup lang="ts">
import { z } from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'
import type { NotificationSettings, NotificationTestResult } from '#shared/types/notifications'
import { ntfyToken, ntfyTopic } from '#shared/schemas/notifications'
import { NOTIFICATION_TRIGGER_INFO, NOTIFICATION_TRIGGERS, type NotificationTrigger } from '#shared/utils/notifications'

// Notifications (docs/ui.md §5.17): ntfy push notifications on the instance's server (getNotificationSettings,
// updateNotificationSettings, testNotification). The token is write-only: an empty field keeps the stored one.
const api = useApi()
const { account } = useCurrentUser()

const settings = ref<NotificationSettings | null>(null)
const loadError = ref<string | null>(null)
const saveError = ref<string | null>(null)
const saved = ref(false)
const testing = ref(false)
const testResult = ref<NotificationTestResult | null>(null)
const testError = ref<string | null>(null)

const schema = z
  .object({
    enabled: z.boolean(),
    topic: z.union([z.literal(''), ntfyTopic()]),
    token: z.union([z.literal(''), ntfyToken()]),
    removeToken: z.boolean(),
    triggers: z.array(z.enum(NOTIFICATION_TRIGGERS)),
  })
  .refine((value) => !value.enabled || value.topic.trim() !== '', { message: 'Enter a topic to turn notifications on', path: ['topic'] })

const state = reactive({ enabled: false, topic: '', token: '', removeToken: false, triggers: [] as NotificationTrigger[] })

const isAdmin = computed(() => account.value?.role === 'admin')
const triggerItems = computed(() =>
  NOTIFICATION_TRIGGERS.filter((trigger) => isAdmin.value || !NOTIFICATION_TRIGGER_INFO[trigger].adminOnly).map((trigger) => ({
    value: trigger,
    label: NOTIFICATION_TRIGGER_INFO[trigger].title,
    description: NOTIFICATION_TRIGGER_INFO[trigger].description,
  })),
)
const ntfy = computed(() => settings.value?.ntfy ?? null)
const subscribeUrl = computed(() => (ntfy.value?.server && ntfy.value.topic ? `${ntfy.value.server}/${ntfy.value.topic}` : null))
const failedDelivery = computed(() => (ntfy.value?.lastDelivery && !ntfy.value.lastDelivery.ok ? ntfy.value.lastDelivery : null))

function apply(next: NotificationSettings): void {
  settings.value = next
  Object.assign(state, { enabled: next.ntfy.enabled, topic: next.ntfy.topic ?? '', token: '', removeToken: false, triggers: [...next.ntfy.triggers] })
}

async function load(): Promise<void> {
  try {
    apply(await api<NotificationSettings>('/api/account/notifications', { toast: false }))
    loadError.value = null
  } catch (error) {
    loadError.value = errorMessage(error, 'The notification settings could not be loaded.')
  }
}

onMounted(() => {
  void load()
})

/** A random topic: on a public server, a topic name is its only protection. */
function generateTopic(): void {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  state.topic = `scantor-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')}`
}

async function save(event: FormSubmitEvent<z.output<typeof schema>>): Promise<void> {
  saveError.value = null
  saved.value = false
  const body: { ntfy: { enabled: boolean; topic: string | null; triggers: NotificationTrigger[]; token?: string | null } } = {
    ntfy: { enabled: event.data.enabled, topic: event.data.topic.trim() || null, triggers: event.data.triggers },
  }
  if (event.data.token) body.ntfy.token = event.data.token
  else if (event.data.removeToken) body.ntfy.token = null
  try {
    apply(await api<NotificationSettings>('/api/account/notifications', { method: 'PATCH', body, toast: false }))
    saved.value = true
  } catch (error) {
    saveError.value = errorMessage(error)
  }
}

async function sendTest(): Promise<void> {
  testing.value = true
  testResult.value = null
  testError.value = null
  try {
    testResult.value = await api<NotificationTestResult>('/api/account/notifications/test', { method: 'POST', toast: false })
  } catch (error) {
    testError.value = errorMessage(error)
  } finally {
    testing.value = false
    await load()
  }
}
</script>

<template>
  <section class="space-y-4 rounded-lg border border-default p-4" aria-labelledby="notifications-heading">
    <h2 id="notifications-heading" class="text-sm font-semibold text-highlighted">Notifications</h2>

    <p v-if="loadError" class="text-xs text-error" role="alert">{{ loadError }}</p>
    <p v-else-if="!settings" class="text-xs text-dimmed">Loading…</p>
    <p v-else-if="!settings.available" class="text-xs text-muted">Push notifications are disabled on this instance.</p>

    <template v-else>
      <p class="text-xs text-muted">
        Push notifications through
        <ULink :to="settings.ntfy.server ?? undefined" target="_blank" rel="noopener noreferrer" class="font-mono">{{ settings.ntfy.server }}</ULink
        >: subscribe to your topic in the ntfy app or web app. Anyone who knows the name of a topic on a public server can read it, so choose a hard-to-guess
        topic or protect it with an access token.
      </p>

      <UForm :schema="schema" :state="state" class="grid max-w-xl gap-3" @submit="save">
        <UFormField name="enabled">
          <USwitch v-model="state.enabled" label="Send push notifications" />
        </UFormField>
        <UFormField label="ntfy topic" name="topic" hint="1–64 letters, digits, - or _">
          <div class="flex gap-2">
            <UInput v-model="state.topic" autocomplete="off" spellcheck="false" class="w-full font-mono" />
            <UButton label="Generate" icon="i-lucide-dices" color="neutral" variant="outline" @click="generateTopic" />
          </div>
        </UFormField>
        <UFormField
          label="Access token"
          name="token"
          :help="settings.ntfy.tokenSet ? 'A token is stored. Enter a new one to replace it.' : 'Optional: for topics that need a token on the ntfy server.'"
        >
          <UInput v-model="state.token" type="password" autocomplete="off" :placeholder="settings.ntfy.tokenSet ? '••••••••' : ''" class="w-full" />
        </UFormField>
        <UFormField v-if="settings.ntfy.tokenSet" name="removeToken">
          <UCheckbox v-model="state.removeToken" label="Remove the stored token" :disabled="state.token !== ''" />
        </UFormField>
        <UFormField label="Notify me about" name="triggers">
          <UCheckboxGroup v-model="state.triggers" :items="triggerItems" />
        </UFormField>
        <div class="flex flex-wrap items-center gap-2">
          <UButton type="submit" label="Save notifications" size="sm" />
          <UButton
            label="Send test notification"
            icon="i-lucide-bell-ring"
            color="neutral"
            variant="outline"
            size="sm"
            :loading="testing"
            :disabled="!settings.ntfy.topic"
            @click="sendTest"
          />
          <span v-if="saved" class="text-xs text-success" role="status">Saved</span>
          <span v-if="testResult?.delivered" class="text-xs text-success" role="status">Test notification sent</span>
        </div>
        <p v-if="saveError" class="text-xs text-error" role="alert">{{ saveError }}</p>
        <p v-if="testError" class="text-xs text-error" role="alert">{{ testError }}</p>
      </UForm>

      <p v-if="subscribeUrl" class="text-xs text-muted">
        Subscribe to <span class="font-mono" data-testid="ntfy-subscribe-url">{{ subscribeUrl }}</span>
      </p>
      <UAlert
        v-if="failedDelivery"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        title="The last notification could not be delivered"
        :description="failedDelivery.message ?? undefined"
      />
    </template>
  </section>
</template>
