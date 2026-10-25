<script setup lang="ts">
import { refDebounced } from '@vueuse/core'

// Users (docs/ui.md §5.16): search, create, edit, set password, ban/unban and delete (userPurge job with
// progress). The caller cannot demote, ban, delete or set the password of themselves.
definePageMeta({ admin: true })
useHead({ title: 'Users · scantor' })

const JOB_POLL_MS = 2000

const api = useApi()
const toast = useToast()
const { user: me } = useAuth()
const { confirm } = useConfirm()

const search = ref('')
const debouncedSearch = refDebounced(search, 300)
const users = useUsers(debouncedSearch)

const formOpen = ref(false)
const formMode = ref<'create' | 'edit' | 'password'>('create')
const formUser = shallowRef<User | null>(null)
const banOpen = ref(false)
const banTarget = shallowRef<User | null>(null)

/** userPurge jobs of users being deleted, by user id. */
const purgeJobs = ref<Record<string, Job | JobRef>>({})
const activePurges = computed(() => Object.entries(purgeJobs.value).filter(([, job]) => !(TERMINAL_JOB_STATES as readonly string[]).includes(job.state)))

function forgetPurge(userId: string): void {
  const { [userId]: _done, ...rest } = purgeJobs.value
  purgeJobs.value = rest
}

// A purge that ended without deleting the user unlocks the row again (the deletion can be retried) and shows the
// user as it is now.
const purgePoll = usePoll(async () => {
  for (const [userId, pending] of activePurges.value) {
    const job = await api<Job>(`/api/jobs/${pending.id}`, { background: true })
    purgeJobs.value = { ...purgeJobs.value, [userId]: job }
    if (job.state === 'succeeded') {
      users.remove(userId)
      forgetPurge(userId)
      toast.add({ title: 'User deleted', color: 'success', icon: 'i-lucide-check' })
    } else if (job.state === 'failed' || job.state === 'cancelled') {
      forgetPurge(userId)
      toast.add({
        title: job.state === 'failed' ? 'Deleting the user failed' : 'Deleting the user was cancelled',
        description: job.error?.message,
        color: 'error',
        icon: 'i-lucide-circle-alert',
      })
      users.reload(userId).catch((error: unknown) => console.error('[users] reloading the user failed', error))
    }
  }
}, { intervalMs: JOB_POLL_MS, enabled: () => activePurges.value.length > 0 })

function openForm(mode: 'create' | 'edit' | 'password', user: User | null = null): void {
  formMode.value = mode
  formUser.value = user
  formOpen.value = true
}

function openBan(user: User): void {
  banTarget.value = user
  banOpen.value = true
}

function onSaved(user: User | null): void {
  if (formMode.value === 'password' && formUser.value) {
    toast.add({ title: `Password of ${formUser.value.email} set`, color: 'success', icon: 'i-lucide-check' })
  } else if (formMode.value === 'create' && user) {
    toast.add({ title: `User ${user.email} created`, color: 'success', icon: 'i-lucide-check' })
  }
}

async function unban(user: User): Promise<void> {
  await users.unbanUser(user.id).catch((error: unknown) => console.error('[users] unban failed', error))
}

async function remove(user: User): Promise<void> {
  const confirmed = await confirm({
    title: `Delete ${user.email}`,
    description: 'The user is signed out at once; their tasks, scans, results, credentials and keys are deleted in the background. This cannot be undone.',
    confirmLabel: 'Delete user',
    typeToConfirm: user.email,
  })
  if (!confirmed) return
  try {
    const job = await users.deleteUser(user.id)
    purgeJobs.value = { ...purgeJobs.value, [user.id]: job }
  } catch (error) {
    console.error('[users] delete failed', error)
  }
}

async function refresh(): Promise<void> {
  await users.reset()
}
</script>

<template>
  <UDashboardPanel id="admin-users">
    <template #header>
      <UDashboardNavbar title="Users">
        <template #leading>
          <SidebarCollapseButton />
        </template>
        <template #right>
          <RefreshButton :loading="users.loading.value || purgePoll.running.value" @click="refresh" />
          <UButton label="New user" icon="i-lucide-user-plus" size="sm" @click="openForm('create')" />
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar>
        <UInput
          v-model="search"
          icon="i-lucide-search"
          placeholder="Search by name or email"
          aria-label="Search users"
          size="sm"
          class="w-full max-w-sm"
        />
      </UDashboardToolbar>
    </template>

    <template #body>
      <UAlert
        v-if="users.error.value"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        title="Users could not be loaded"
        :description="errorMessage(users.error.value)"
      />
      <UserTable
        :users="users.items.value"
        :loading="users.loading.value"
        :current-user-id="me?.id ?? null"
        :purge-jobs="purgeJobs"
        @edit="openForm('edit', $event)"
        @set-password="openForm('password', $event)"
        @ban="openBan"
        @unban="unban"
        @delete="remove"
      />
      <LoadMoreButton :has-more="users.hasMore.value" :loading="users.loading.value" @load="users.loadMore()" />

      <UserFormModal
        v-model:open="formOpen"
        :mode="formMode"
        :user="formUser"
        :is-self="formUser?.id === me?.id"
        :actions="users"
        @saved="onSaved"
      />
      <BanUserModal v-model:open="banOpen" :user="banTarget" :ban="users.banUser" />
    </template>
  </UDashboardPanel>
</template>
