import Docker from 'dockerode'
import { BootAbortError } from './boot'
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

/** Docker's healthcheck durations are integer nanoseconds. */
export const NS_PER_SECOND = 1_000_000_000

/** A container healthcheck in the Engine API's shape (`Config.Healthcheck`). */
export interface ContainerHealthcheck {
  Test: string[]
  Interval: number
  Timeout: number
  Retries: number
  StartPeriod: number
  StartInterval: number
}

/**
 * The healthcheck of runtime containers in local mode (test runs; docs/runtime.md §5.3): `scantor runtime healthcheck`
 * reads the runtime's heartbeat file. The values equal Go's `container.RuntimeHealthcheck` (internal/container), which
 * the node daemon and the CLI use for workers and dev runs.
 */
export const RUNTIME_HEALTHCHECK: ContainerHealthcheck = {
  Test: ['CMD', '/scantor/scantor', 'runtime', 'healthcheck'],
  Interval: 30 * NS_PER_SECOND,
  Timeout: 10 * NS_PER_SECOND,
  Retries: 3,
  StartPeriod: 120 * NS_PER_SECOND,
  StartInterval: 5 * NS_PER_SECOND,
}

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

/** Where a volume keeps its data (docs/deployment.md §5.1): the variable that configures it and its host directory. */
export interface VolumeLocation {
  /** the configuring variable, named in errors */
  variable: string
  /** host directory the volume is bound to; null = a plain named volume */
  path: string | null
}

/** An existing volume whose data lives elsewhere than its variable says: only the operator can move the data. */
export class VolumeLocationError extends BootAbortError {}

/** The host directory a volume is bound to (local driver, `type=none`, `o=bind`), or null for a plain volume. */
export function volumeBindPath(volume: { Driver?: string; Options?: Record<string, string> | null }): string | null {
  const options = volume.Options ?? {}
  const bind = (options.o ?? '').split(',').includes('bind')
  if (volume.Driver !== 'local' || options.type !== 'none' || !bind || !options.device) return null
  return options.device.length > 1 ? options.device.replace(/\/+$/, '') : options.device
}

/**
 * Ensures a named volume at its configured location. A missing volume is created, bound to `location.path` when one
 * is set (the directory must exist on the Docker host; mounting fails otherwise). An existing volume must already be
 * at that location: switching it would hide its data, so a mismatch refuses the start with VolumeLocationError.
 */
export async function ensureVolume(name: string, location: VolumeLocation, log: Logger = useLogger('docker')): Promise<void> {
  const client = useDocker()
  let existing: Docker.VolumeInspectInfo | null = null
  try {
    existing = await client.getVolume(name).inspect()
  } catch (error) {
    if (!isStatus(error, 404)) throw error
  }
  if (existing) {
    const current = volumeBindPath(existing)
    if (current === location.path) return
    const is = current ? `is bound to ${current}` : 'is a plain Docker volume'
    const wants = location.path ? `the directory ${location.path}` : `a plain Docker volume`
    throw new VolumeLocationError(
      `volume ${name} ${is}, but ${location.variable} asks for ${wants}: copy its data to the new location, remove the ` +
        `volume (docker volume rm ${name}) and start again (docs/deployment.md §5.1)`,
    )
  }
  await client.createVolume(
    location.path ? { Name: name, Driver: 'local', DriverOpts: { type: 'none', o: 'bind', device: location.path } } : { Name: name },
  )
  log.info('created volume', { volume: name, path: location.path })
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
