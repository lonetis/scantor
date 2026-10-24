import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { ApiError } from '../helpers/api-client'
import { loadSeed, runFile, seedFile } from '../helpers/authz-seed'
import { deleteUser } from '../helpers/users'
import { test as teardown } from '../fixtures'

// The `authz-teardown` project (docs/testing.md §8.5): deletes tenants A and B (their purge removes every resource
// they own) and the admin's matrix API key, then this run's seed and storage-state files. Runs after the `authz`
// project, also when it failed.

teardown.use({ storageState: { cookies: [], origins: [] } })

teardown('delete the tenants of the authorization matrix', async ({ adminApi }, testInfo) => {
  teardown.skip(!existsSync(seedFile(testInfo)), 'the seed did not run')
  const seed = loadSeed(testInfo)
  await deleteUser(adminApi, seed.a.id)
  await deleteUser(adminApi, seed.b.id)
  const key = await adminApi.call('deleteApiKey', { path: { keyId: seed.admin.keyId } })
  if (![200, 204, 404].includes(key.status)) throw new ApiError('deleteApiKey', key)
  for (const file of [seedFile(testInfo), runFile(testInfo, 'a'), runFile(testInfo, 'b')]) await rm(file, { force: true })
})
