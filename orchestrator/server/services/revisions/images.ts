import { useConfig } from '../../utils/config'
import { useDocker } from '../../utils/docker'
import { REGISTRY_INTERNAL_URL } from '../../utils/health'
import { useKeys } from '../../utils/keys'
import type { Logger } from '../../utils/logger'
import { REGISTRY_SERVICE } from '../registry/jwt'
import { issueRegistryToken, ORCHESTRATOR_USERNAME, productionTokenDeps } from '../registry/token'

// Task images (docs/architecture.md §4.3, §4.4; docs/deployment.md §14.1): revisions are pushed to the master
// registry as `tasks/<taskId>:<revisionId>`; task deletion removes their manifests through the registry HTTP API at
// http://registry:5000 with a token of the orchestrator credential (blobs are reclaimed by registry GC), and removes
// the task's images (revision and draft tags) from the master's Docker daemon.

const REQUEST_TIMEOUT_MS = 30_000
/** Media types a manifest HEAD accepts, so the registry reports the digest of what was pushed (index or manifest). */
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

export function taskRepository(taskId: string): string {
  return `tasks/${taskId}`
}

async function orchestratorToken(repository: string): Promise<string> {
  const outcome = await issueRegistryToken(
    {
      credential: { username: ORCHESTRATOR_USERNAME, password: useKeys().registryPushPassword() },
      service: REGISTRY_SERVICE,
      scopes: [`repository:${repository}:pull,delete`],
      grantType: null,
    },
    productionTokenDeps(),
  )
  if (outcome.status !== 200) throw new Error(`minting a registry token failed: ${outcome.body.errors[0]?.message ?? outcome.status}`)
  return String(outcome.body.token)
}

async function registryFetch(path: string, token: string, init: { method: string; headers?: Record<string, string> }): Promise<Response> {
  return fetch(`${REGISTRY_INTERNAL_URL}${path}`, {
    method: init.method,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
}

/** Digests of every tagged manifest of a repository; an unknown repository has none. */
async function taggedDigests(repository: string, token: string): Promise<string[]> {
  const listed = await registryFetch(`/v2/${repository}/tags/list`, token, { method: 'GET' })
  if (listed.status === 404) return []
  if (!listed.ok) throw new Error(`listing the tags of ${repository} failed: HTTP ${listed.status}`)
  const body = (await listed.json()) as { tags?: string[] | null }
  const digests: string[] = []
  for (const tag of body.tags ?? []) {
    const head = await registryFetch(`/v2/${repository}/manifests/${encodeURIComponent(tag)}`, token, { method: 'HEAD', headers: { accept: MANIFEST_ACCEPT } })
    if (head.status === 404) continue
    const digest = head.headers.get('docker-content-digest')
    if (!head.ok || !digest) throw new Error(`resolving ${repository}:${tag} failed: HTTP ${head.status}`)
    digests.push(digest)
  }
  return digests
}

/**
 * Deletes every manifest of a task repository: the recorded digests plus whatever the repository still has tagged
 * (a build that pushed after its revision was failed). A missing manifest or repository is not an error.
 */
export async function deleteTaskManifests(taskId: string, recordedDigests: readonly string[], log: Logger): Promise<number> {
  const repository = taskRepository(taskId)
  const token = await orchestratorToken(repository)
  const digests = new Set([...recordedDigests, ...(await taggedDigests(repository, token))])
  let deleted = 0
  for (const digest of digests) {
    const response = await registryFetch(`/v2/${repository}/manifests/${digest}`, token, { method: 'DELETE' })
    if (response.status === 202) {
      deleted++
      continue
    }
    if (response.status === 404) continue
    throw new Error(`deleting manifest ${repository}@${digest} failed: HTTP ${response.status}`)
  }
  if (deleted > 0) log.info('deleted registry manifests of a task', { repository, deleted })
  return deleted
}

/** The local references of a task's images: revision tags `localhost:<port>/tasks/<taskId>` and drafts `tasks/<taskId>`. */
export function localTaskReferences(taskId: string, registryPort: number): string[] {
  const repository = taskRepository(taskId)
  return [`localhost:${registryPort}/${repository}`, repository]
}

/** Removes every local image of a task (revision and draft tags). Images still used by a container are kept. */
export async function removeLocalTaskImages(taskId: string, log: Logger): Promise<number> {
  const docker = useDocker()
  let removed = 0
  for (const reference of localTaskReferences(taskId, useConfig().registryPort)) {
    const images = await docker.listImages({ filters: { reference: [reference] } })
    for (const image of images) {
      for (const tag of image.RepoTags ?? []) {
        if (!tag.startsWith(`${reference}:`)) continue
        try {
          await docker.getImage(tag).remove({ noprune: false })
          removed++
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode
          if (status === 404) continue
          // 409: a container still uses the image; the node's image GC removes it later.
          log.warn('removing a task image failed', { image: tag, status, err: error })
        }
      }
    }
  }
  return removed
}
