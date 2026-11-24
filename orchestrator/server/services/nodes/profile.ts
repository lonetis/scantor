import { isIP } from 'node:net'
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

export type EndpointHostsConfig = ProfileConfig & Pick<Config, 's3InternalUrl' | 's3PublicUrl' | 'trancoUrl' | 'cruxUrl' | 'cruxCacheUrl'>

/** The host name of a URL (lowercase, without a trailing dot); null for an IP literal or an unparsable URL. */
function hostNameOf(url: string): string | null {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
  if (host === '' || isIP(host.replace(/^\[|\]$/g, '')) !== 0) return null
  return host
}

/**
 * The host names of every URL the orchestrator hands to the workers of a node with this profile (hello
 * `config.endpointHosts`, docs/api.md §7.1): the worker `SCANTOR_URL`, the AMQP URL, the S3 endpoint of the profile
 * (server/utils/s3.ts s3EndpointFor) and the template data sources. The node resolver resolves them through the host
 * nameservers (docs/nodes.md §6.11). Sorted and unique; IP literals are left out.
 */
export function endpointHosts(profile: EndpointProfile, config: EndpointHostsConfig): string[] {
  const urls = endpointUrls(profile, config)
  const s3Url = profile === 'internal' ? config.s3InternalUrl : config.s3PublicUrl
  const hosts = new Set<string>()
  for (const url of [urls.apiUrl, urls.amqpUrl, s3Url, config.trancoUrl, config.cruxUrl, config.cruxCacheUrl]) {
    const host = hostNameOf(url)
    if (host) hosts.add(host)
  }
  return [...hosts].sort()
}
