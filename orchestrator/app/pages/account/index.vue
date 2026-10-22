<script setup lang="ts">
// Account (docs/ui.md §5.17): every section loads and fails on its own, so one failure never blanks the page.
useHead({ title: 'Account · scantor' })

const { account, load: loadAccount } = useCurrentUser()
const { features, loadInfo } = useInstance()
const loadError = ref<string | null>(null)

async function load(): Promise<void> {
  const [accountResult] = await Promise.allSettled([loadAccount(true), loadInfo()])
  loadError.value = accountResult.status === 'rejected' ? errorMessage(accountResult.reason) : null
}

onMounted(() => {
  void load()
})
</script>

<template>
  <UDashboardPanel id="account">
    <template #header>
      <UDashboardNavbar title="Account">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton label="CLI & MCP access" icon="i-lucide-terminal" color="neutral" variant="ghost" size="sm" to="/account/access" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-4xl space-y-6">
        <UAlert
          v-if="loadError && !account"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          title="Your account could not be loaded"
          :description="loadError"
          :actions="[{ label: 'Retry', color: 'neutral', variant: 'outline', onClick: () => { void load() } }]"
        />
        <ProfileSection />
        <PasswordSection />
        <PasskeysSection v-if="features.passkeys" />
        <SessionsSection />
        <EditorSection v-if="features.editor" />
      </div>
    </template>
  </UDashboardPanel>
</template>
