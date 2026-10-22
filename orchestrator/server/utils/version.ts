// The scantor version of this orchestrator build. `__SCANTOR_VERSION__` is replaced at build time from the
// docker-bake VERSION build argument (nuxt.config.ts); unbundled code (unit tests) sees `dev`.

declare const __SCANTOR_VERSION__: string | undefined

export const scantorVersion: string = typeof __SCANTOR_VERSION__ === 'string' ? __SCANTOR_VERSION__ : 'dev'

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/
const VERSION_PREFIX = /^v?(\d+)\.(\d+)\.(\d+)/

/** A release version is exactly `X.Y.Z`; builds from main (`git describe`) and dev builds are not. */
export function isReleaseVersion(version: string): boolean {
  return RELEASE_VERSION.test(version)
}

/**
 * Image tag handed to users and nodes (getInstanceInfo.cliImage, NodeJoin): the orchestrator version when it is
 * a release version, otherwise SCANTOR_IMAGE_TAG (docs/api.md §4.1, decision 14).
 */
export function clientImageTag(version: string, configuredTag: string): string {
  return isReleaseVersion(version) ? version : configuredTag
}

export type VersionCheck = { ok: true } | { ok: false; serverVersion: string; minVersion: string }

/**
 * Version window of machine clients (docs/api.md §1.10): a release orchestrator accepts node daemons and runtimes
 * of its own and the previous minor version. Non-release orchestrators (dev builds, builds from main) accept any
 * client, because they have no comparable version.
 */
export function checkClientVersion(serverVersion: string, clientVersion: string | null | undefined): VersionCheck {
  const server = VERSION_PREFIX.exec(serverVersion)
  if (!server || !isReleaseVersion(serverVersion)) return { ok: true }
  const major = Number(server[1])
  const minor = Number(server[2])
  const minMinor = Math.max(0, minor - 1)
  const minVersion = `${major}.${minMinor}.0`
  const client = clientVersion ? VERSION_PREFIX.exec(clientVersion.trim()) : null
  if (!client) return { ok: false, serverVersion, minVersion }
  const clientMajor = Number(client[1])
  const clientMinor = Number(client[2])
  if (clientMajor === major && clientMinor >= minMinor && clientMinor <= minor) return { ok: true }
  return { ok: false, serverVersion, minVersion }
}
