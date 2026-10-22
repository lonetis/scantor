import type { EndpointProfile } from '#shared/utils/enums'
import type { Config } from '../../utils/config'

// Endpoint profiles (docs/architecture.md §8): every URL handed to a node or its workers is computed from the
// node's `endpointProfile`. The built-in node uses the compose-internal names (`internal`); remote nodes use the
// public URLs (`public`). Presigned S3 URLs are signed for the profile's S3 endpoint by server/utils/s3.ts.

export interface EndpointUrls {
  /** orchestrator API for the daemon and the runtime (`SCANTOR_URL` in the worker env) */
  apiUrl: string
  /** AMQP URL for workers (`bootstrap.amqp.url`) */
  amqpUrl: string
  /** registry host in image references (daemon side) */
  registryHost: string
}

export type ProfileConfig = Pick<
  Config,
  'internalUrl' | 'publicUrl' | 'amqpInternalUrl' | 'amqpPublicUrl' | 'registryPort' | 'registryPublicHost'
>

export function endpointUrls(profile: EndpointProfile, config: ProfileConfig): EndpointUrls {
  if (profile === 'internal') {
    return { apiUrl: config.internalUrl, amqpUrl: config.amqpInternalUrl, registryHost: `localhost:${config.registryPort}` }
  }
  return { apiUrl: config.publicUrl, amqpUrl: config.amqpPublicUrl, registryHost: config.registryPublicHost }
}
