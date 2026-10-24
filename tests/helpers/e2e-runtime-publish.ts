import type { Revision } from '#shared/types/revisions'
import { ok, type ApiClient, type ApiResponse } from './api-client'
import { packTask, type UploadedTask } from './tasks'

// Publishing for the e2e runtime specs: upload a task folder under a name, publish and wait for the build like
// helpers/tasks.ts uploadAndPublish, but its waits (getRevision?wait) step aside when the owner's concurrent waits
// are used up (429, SCANTOR_MAX_CONCURRENT_WAITS), because every worker of a run publishes and polls as one tenant.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function retryTooMany<T>(deadline: number, call: () => Promise<ApiResponse<T>>): Promise<ApiResponse<T>> {
  for (;;) {
    const response = await call()
    if (response.status !== 429 || Date.now() >= deadline) return response
    await sleep(500 + Math.random() * 1000)
  }
}

/** Uploads `dir` as task `name`, publishes it and waits until the revision is built; it must end `expectState`. */
export async function publishTask(
  api: ApiClient,
  dir: string,
  name: string,
  options: { timeoutMs?: number; expectState?: Revision['state'] } = {},
): Promise<UploadedTask> {
  const deadline = Date.now() + (options.timeoutMs ?? 270_000)
  const archive = await packTask(dir, { name })
  const uploaded = ok(await retryTooMany(deadline, () => api.uploadTask(archive, { publish: true })), `uploadTask ${name}`)
  if (!uploaded.revision) throw new Error(`uploadTask of ${name} published no revision`)
  for (;;) {
    const wait = Math.max(1, Math.min(50, Math.ceil((deadline - Date.now()) / 1000)))
    const revision = ok(await retryTooMany(deadline, () => api.getRevision(uploaded.task.id, uploaded.revision!.id, wait)), `getRevision ${name}`)
    if (revision.state === 'ready' || revision.state === 'failed') {
      const expected = options.expectState ?? 'ready'
      if (revision.state !== expected)
        throw new Error(`revision ${revision.ref} is ${revision.state}, expected ${expected}; errors: ${JSON.stringify(revision.errors)}`)
      return { task: uploaded.task, revision }
    }
    if (Date.now() >= deadline) throw new Error(`revision ${revision.ref} is still ${revision.state} after ${options.timeoutMs ?? 270_000} ms`)
  }
}
