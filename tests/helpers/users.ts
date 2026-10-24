import { randomBytes } from 'node:crypto'
import { request, type APIRequestContext, type Page } from '@playwright/test'
import type { User } from '#shared/types/users'
import { ApiError, ok, type ApiClient, type ApiResponse } from './api-client'
import { env } from './env'
import { reserve } from './limiter'
import { unique } from './unique'

// Users and sessions for tests (docs/testing.md §7.7, §7.8). Every sign-in, whether through the API, the login form
// or a deliberately wrong password, first reserves a slot of the shared limiter; every request context carries the
// public origin as Origin (better-auth and the CSRF middleware require it).

export interface TestUser {
  id: string
  email: string
  name: string
  password: string
  role: User['role']
}

export interface CreateUserOptions {
  /** what the user is for; part of the unique email */
  prefix?: string
  role?: User['role']
  canRunPrivileged?: boolean
  maxWorkers?: number
}

/** A request context on the public origin (Origin header, the test CA trusted through NODE_EXTRA_CA_CERTS). */
export function newApiContext(options: { storageState?: string; headers?: Record<string, string> } = {}): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: env.publicUrl,
    // Long-polls (`wait` up to 120 s, getScan?wait=50) and slow jobs outlive Playwright's 30 s default.
    timeout: 150_000,
    extraHTTPHeaders: { Origin: env.publicUrl, ...options.headers },
    storageState: options.storageState,
  })
}

/** Creates a user as admin with a unique `@scantor.test` email and a random password. */
export async function createUser(adminApi: ApiClient, options: CreateUserOptions = {}): Promise<TestUser> {
  const name = unique(options.prefix ?? 'user')
  const email = `${name}@scantor.test`
  const password = randomBytes(18).toString('base64url')
  const user = ok(
    await adminApi.createUser({
      email,
      name,
      password,
      role: options.role ?? 'user',
      canRunPrivileged: options.canRunPrivileged,
      maxWorkers: options.maxWorkers,
    }),
    'createUser',
  )
  return { id: user.id, email, name, password, role: user.role }
}

/** Deletes a user (202 with a userPurge job). A user that is already gone (404) counts as deleted. */
export async function deleteUser(adminApi: ApiClient, userId: string): Promise<void> {
  const response = await adminApi.deleteUser(userId)
  if (response.status !== 202 && response.status !== 404) throw new ApiError('deleteUser', response)
}

/** `POST /api/auth/sign-in/email` through the limiter; returns the response (also for failing sign-ins). */
export async function signIn(context: APIRequestContext, email: string, password: string): Promise<ApiResponse> {
  await reserve('/sign-in/email')
  const response = await context.post('/api/auth/sign-in/email', { data: { email, password } })
  const raw = await response.body()
  const headers = response.headers()
  const body: unknown = (headers['content-type'] ?? '').includes('json') && raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {}
  return { status: response.status(), headers, body, raw }
}

/** A request context signed in as the user (one limiter slot). Save it with `context.storageState({path})`. */
export async function signedInContext(email: string, password: string): Promise<APIRequestContext> {
  const context = await newApiContext()
  try {
    const response = await signIn(context, email, password)
    if (response.status !== 200) throw new ApiError(`sign-in of ${email}`, response)
    return context
  } catch (error) {
    await context.dispose()
    throw error
  }
}

/** Signs in through the login form (one limiter slot) and waits until the app left /login. */
export async function browserSignIn(page: Page, user: { email: string; password: string }, redirect?: string): Promise<void> {
  await page.goto(redirect ? `/login?redirect=${encodeURIComponent(redirect)}` : '/login')
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await reserve('/sign-in/email')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL((url) => url.pathname !== '/login', { timeout: 15_000 })
}
