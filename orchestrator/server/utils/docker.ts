import Docker from 'dockerode'
import { useConfig } from './config'
import { managedLabels } from './labels'
import { type Logger, useLogger } from './logger'

// Docker access of the orchestrator (host Docker socket): helpers, editors, test runs and the boot objects of
// docs/architecture.md §4.1 step 6. Builds never use dockerode (they run `scantor task build`).

export const EGRESS_NETWORK = 'scantor-egress'
/** The compose network of master workers and editors (docs/nodes.md §6.8, editor.md §4): user code runs on it. */
export const SANDBOX_NETWORK = 'scantor-sandbox'
export const WORKSPACES_VOLUME = 'scantor-workspaces'
export const EDITOR_HOME_VOLUME = 'scantor-editor-home'

let docker: Docker | null = null

export function useDocker(): Docker {
  docker ??= new Docker()
  return docker
}

function isStatus(error: unknown, status: number): boolean {
  return (error as { statusCode?: number } | null)?.statusCode === status
}

/** `<SCANTOR_IMAGE_PREFIX><image>:<SCANTOR_IMAGE_TAG>`, the reference of a scantor image of this deployment. */
export function scantorImageRef(image: string): string {
  const config = useConfig()
  return `${config.imagePrefix}${image}:${config.imageTag}`
}

/** Ensures the bridge network `scantor-egress` without inter-container traffic, carrying the managed labels. */
export async function ensureEgressNetwork(log: Logger = useLogger('docker')): Promise<void> {
  const client = useDocker()
  try {
    const existing = await client.getNetwork(EGRESS_NETWORK).inspect()
    if (existing.Options?.['com.docker.network.bridge.enable_icc'] !== 'false') {
      log.warn('network scantor-egress exists with inter-container traffic enabled; recreate it to restore isolation', {
        network: EGRESS_NETWORK,
      })
    }
    return
  } catch (error) {
    if (!isStatus(error, 404)) throw error
  }
  try {
    await client.createNetwork({
      Name: EGRESS_NETWORK,
      Driver: 'bridge',
      CheckDuplicate: true,
      Options: { 'com.docker.network.bridge.enable_icc': 'false' },
      Labels: managedLabels('network'),
    })
    log.info('created network', { network: EGRESS_NETWORK })
  } catch (error) {
    if (!isStatus(error, 409)) throw error
  }
}

/** Ensures a named volume (idempotent: VolumeCreate returns the existing volume). */
export async function ensureVolume(name: string, log: Logger = useLogger('docker')): Promise<void> {
  const client = useDocker()
  try {
    await client.getVolume(name).inspect()
    return
  } catch (error) {
    if (!isStatus(error, 404)) throw error
  }
  await client.createVolume({ Name: name })
  log.info('created volume', { volume: name })
}

/** Pulls an image in the background, logging the outcome; used for the editor image at boot. */
export function pullImageInBackground(ref: string, log: Logger = useLogger('docker')): void {
  const client = useDocker()
  client.pull(ref, (error: Error | null, stream?: NodeJS.ReadableStream) => {
    if (error || !stream) {
      log.warn('background image pull failed', { image: ref, err: error })
      return
    }
    client.modem.followProgress(stream, (finishError: Error | null) => {
      if (finishError) log.warn('background image pull failed', { image: ref, err: finishError })
      else log.info('pulled image', { image: ref })
    })
  })
}

/** True when the Docker daemon answers a ping. */
export async function dockerReachable(): Promise<boolean> {
  try {
    await useDocker().ping({ abortSignal: AbortSignal.timeout(3000) } as never)
    return true
  } catch {
    return false
  }
}
