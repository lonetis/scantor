import { readFileSync } from 'node:fs'
import { stackEnv } from './docker'
import { env } from './env'
import { stackKeys } from './keys'

// White-box access to the stack's registry for the e2e runtime specs (docs/api.md §6): a task image's manifest is
// taken out of the registry and put back byte for byte, so a node's pull of that one image fails and later succeeds.
// Only repositories of tasks the test uploaded itself are touched; the registry's blob GC runs once a day
// (SCANTOR_REGISTRY_GC_INTERVAL), so the image's layers stay in place while the manifest is gone.

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

function registryUrl(path: string): string {
  return `http://127.0.0.1:${stackEnv().SCANTOR_REGISTRY_PORT || '5000'}/v2/${path}`
}

/** A registry token of the orchestrator credential (pull, push and delete on `tasks/*`) for one repository. */
async function registryToken(repository: string): Promise<string> {
  const basic = Buffer.from(`orchestrator:${stackKeys().registryPushPassword()}`).toString('base64')
  const url = `${env.publicUrl}/api/registry/token?service=scantor-registry&scope=${encodeURIComponent(`repository:${repository}:pull,push,delete`)}`
  const response = await fetch(url, { headers: { Authorization: `Basic ${basic}` } })
  if (!response.ok) throw new Error(`registry token for ${repository}: ${response.status} ${await response.text()}`)
  return ((await response.json()) as { token: string }).token
}

export interface TakenManifest {
  /** Puts the manifest back under its digest (idempotent). */
  restore(): Promise<void>
}

/** Deletes the manifest `digest` of `repository` from the registry and returns a handle that restores it. */
export async function takeManifest(repository: string, digest: string): Promise<TakenManifest> {
  const token = await registryToken(repository)
  const url = registryUrl(`${repository}/manifests/${digest}`)
  const fetched = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_TYPES } })
  if (!fetched.ok) throw new Error(`GET ${repository}@${digest}: ${fetched.status} ${await fetched.text()}`)
  const contentType = fetched.headers.get('content-type') ?? 'application/vnd.oci.image.index.v1+json'
  const body = Buffer.from(await fetched.arrayBuffer())
  const deleted = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
  if (deleted.status !== 202) throw new Error(`DELETE ${repository}@${digest}: ${deleted.status} ${await deleted.text()}`)
  let restored = false
  return {
    restore: async () => {
      if (restored) return
      const fresh = await registryToken(repository)
      const put = await fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${fresh}`, 'Content-Type': contentType }, body })
      if (put.status !== 201) throw new Error(`PUT ${repository}@${digest}: ${put.status} ${await put.text()}`)
      restored = true
    },
  }
}

/** The joined remote node of the test stack (`remote-1`, pool `remote`), written by the runner. */
export function remoteNode(): { id: string; name: string; pool: string; labels: Record<string, string> } {
  return JSON.parse(readFileSync(env.paths.remoteNode, 'utf8')) as { id: string; name: string; pool: string; labels: Record<string, string> }
}
