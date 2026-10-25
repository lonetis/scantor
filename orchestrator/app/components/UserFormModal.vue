<script lang="ts">
import { createReusableTemplate } from '@vueuse/core'
import { z } from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'
import { createUserBody, password, updateUserBody } from '#shared/schemas/users'
import type { CreateUserBody, UpdateUserBody } from '#shared/schemas/users'

export interface UserFormActions {
  createUser: (body: CreateUserBody) => Promise<User>
  updateUser: (userId: string, body: UpdateUserBody) => Promise<User>
  setPassword: (userId: string, password: string) => Promise<void>
}
</script>

<script setup lang="ts">
// Create a user, edit one, or set a user's password (docs/ui.md §5.16). The UI always asks for an initial
// password, because a user without one cannot sign in (docs/auth.md §6.3). Errors stay inline.
const props = defineProps<{
  mode: 'create' | 'edit' | 'password'
  user?: User | null
  isSelf?: boolean
  actions: UserFormActions
}>()

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [user: User | null] }>()

const ROLE_ITEMS = [
  { label: 'user', value: 'user' },
  { label: 'admin', value: 'admin' },
]

const createSchema = createUserBody.extend({ password: password() })
const passwordSchema = z
  .object({ password: password(), confirm: z.string() })
  .refine((value) => value.password === value.confirm, { message: 'The passwords do not match', path: ['confirm'] })

interface ProfileState {
  email: string
  name: string
  role: UserRole
  canRunPrivileged: boolean
  maxWorkers: number | undefined
}

const createState = reactive<ProfileState & { password: string }>({ email: '', name: '', password: '', role: 'user', canRunPrivileged: false, maxWorkers: undefined })
const editState = reactive<ProfileState>({ email: '', name: '', role: 'user', canRunPrivileged: false, maxWorkers: undefined })
const passwordState = reactive({ password: '', confirm: '' })
const profile = computed<ProfileState>(() => (props.mode === 'create' ? createState : editState))

const error = ref<string | null>(null)
const saving = ref(false)
const [DefineProfileFields, ReuseProfileFields] = createReusableTemplate()

watch(open, (value) => {
  if (!value) return
  error.value = null
  Object.assign(createState, { email: '', name: '', password: '', role: 'user', canRunPrivileged: false, maxWorkers: undefined })
  Object.assign(editState, {
    email: props.user?.email ?? '',
    name: props.user?.name ?? '',
    role: props.user?.role ?? 'user',
    canRunPrivileged: props.user?.canRunPrivileged ?? false,
    maxWorkers: props.user?.maxWorkers,
  })
  Object.assign(passwordState, { password: '', confirm: '' })
}, { immediate: true })

const title = computed(() => {
  if (props.mode === 'create') return 'New user'
  if (props.mode === 'password') return `Set password of ${props.user?.email ?? 'user'}`
  return `Edit ${props.user?.email ?? 'user'}`
})
// A user gets the instance default when created without a limit (docs/data-model.md §3); updateUser has no reset
// to it, so an emptied field keeps the stored limit.
const workerLimitHelp = computed(() => `Active workers across all scans of this user; 0 = unlimited. ${
  props.mode === 'create' ? 'Empty uses the instance default.' : 'Empty keeps the current limit.'
}`)
const submitLabel = computed(() => (props.mode === 'create' ? 'Create user' : props.mode === 'password' ? 'Set password' : 'Save user'))

async function run(action: () => Promise<User | null>): Promise<void> {
  saving.value = true
  error.value = null
  try {
    const user = await action()
    open.value = false
    emit('saved', user)
  } catch (cause) {
    const apiError = toApiError(cause)
    error.value = apiError.code === 'alreadyExists' ? 'A user with this email already exists.' : apiError.message
  } finally {
    saving.value = false
  }
}

async function submitCreate(event: FormSubmitEvent<z.output<typeof createSchema>>): Promise<void> {
  await run(() => props.actions.createUser(event.data))
}

async function submitEdit(event: FormSubmitEvent<z.output<typeof updateUserBody>>): Promise<void> {
  const user = props.user
  if (!user) return
  const body = event.data
  const changes: UpdateUserBody = {}
  if (body.name !== undefined && body.name !== user.name) changes.name = body.name
  if (body.email !== undefined && body.email !== user.email) changes.email = body.email
  if (body.role !== undefined && body.role !== user.role && !props.isSelf) changes.role = body.role
  if (body.canRunPrivileged !== undefined && body.canRunPrivileged !== user.canRunPrivileged) changes.canRunPrivileged = body.canRunPrivileged
  if (body.maxWorkers !== undefined && body.maxWorkers !== user.maxWorkers) changes.maxWorkers = body.maxWorkers
  if (Object.keys(changes).length === 0) {
    open.value = false
    return
  }
  await run(() => props.actions.updateUser(user.id, changes))
}

async function submitPassword(event: FormSubmitEvent<z.output<typeof passwordSchema>>): Promise<void> {
  const user = props.user
  if (!user) return
  await run(async () => {
    await props.actions.setPassword(user.id, event.data.password)
    return null
  })
}
</script>

<template>
  <DefineProfileFields>
    <UFormField label="Email" name="email" required>
      <UInput v-model="profile.email" type="email" autocomplete="off" class="w-full" />
    </UFormField>
    <UFormField label="Name" name="name" required>
      <UInput v-model="profile.name" autocomplete="off" class="w-full" />
    </UFormField>
    <UFormField v-if="mode === 'create'" label="Initial password" name="password" required hint="8–128 characters">
      <UInput v-model="createState.password" type="password" autocomplete="new-password" class="w-full" />
    </UFormField>
    <UFormField label="Role" name="role" :help="isSelf ? 'You cannot change your own role.' : undefined">
      <USelect v-model="profile.role" :items="ROLE_ITEMS" :disabled="isSelf" class="w-40" />
    </UFormField>
    <UFormField name="canRunPrivileged" help="Privileged tasks run Docker-in-Docker on nodes with DinD enabled.">
      <USwitch v-model="profile.canRunPrivileged" label="Can run privileged tasks" />
    </UFormField>
    <UFormField label="Worker limit" name="maxWorkers" :help="workerLimitHelp">
      <NumberInput
        :model-value="profile.maxWorkers ?? null"
        :min="0"
        :max="100000"
        class="w-40"
        :placeholder="mode === 'create' ? 'default' : undefined"
        @update:model-value="profile.maxWorkers = $event ?? undefined"
      />
    </UFormField>
    <p v-if="error" class="text-xs text-error" role="alert">{{ error }}</p>
  </DefineProfileFields>

  <UModal v-model:open="open" :title="title" :ui="{ content: 'sm:max-w-lg' }" :content="dialogContent">
    <template #close="{ ui }">
      <CloseButton :class="ui.close()" />
    </template>
    <template #body>
      <UForm v-if="mode === 'password'" id="user-form" :schema="passwordSchema" :state="passwordState" class="space-y-3" @submit="submitPassword">
        <UFormField label="New password" name="password" required hint="8–128 characters">
          <UInput v-model="passwordState.password" type="password" autocomplete="new-password" class="w-full" />
        </UFormField>
        <UFormField label="Confirm password" name="confirm" required>
          <UInput v-model="passwordState.confirm" type="password" autocomplete="new-password" class="w-full" />
        </UFormField>
        <p class="text-xs text-muted">Setting a password signs the user out everywhere.</p>
        <p v-if="error" class="text-xs text-error" role="alert">{{ error }}</p>
      </UForm>

      <UForm v-else-if="mode === 'create'" id="user-form" :schema="createSchema" :state="createState" class="space-y-3" @submit="submitCreate">
        <ReuseProfileFields />
      </UForm>

      <UForm v-else id="user-form" :schema="updateUserBody" :state="editState" class="space-y-3" @submit="submitEdit">
        <ReuseProfileFields />
      </UForm>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton type="submit" form="user-form" :label="submitLabel" :loading="saving" />
      </div>
    </template>
  </UModal>
</template>
