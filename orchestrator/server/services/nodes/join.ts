import type { NodeJoin } from '#shared/types/nodes'
import { clientImageTag } from '../../utils/version'

// Join instructions of a remote node (docs/api.md §4.17, docs/nodes.md §4): the exact `docker run` line and compose
// file with the token inlined (createNode, rotateNodeToken) or the placeholder `${SCANTOR_NODE_TOKEN}` (getNodeJoin).
// The image tag is the orchestrator version for releases and SCANTOR_IMAGE_TAG otherwise (decision 14).

export const NODE_TOKEN_PLACEHOLDER = '${SCANTOR_NODE_TOKEN}'

export interface JoinSettings {
  publicUrl: string
  imagePrefix: string
  imageTag: string
  version: string
}

export function nodeImage(settings: Pick<JoinSettings, 'imagePrefix' | 'imageTag' | 'version'>): string {
  return `${settings.imagePrefix}scantor:${clientImageTag(settings.version, settings.imageTag)}`
}

export function buildNodeJoin(token: string, settings: JoinSettings): NodeJoin {
  const image = nodeImage(settings)
  const dockerRun =
    'docker run -d --name scantor-node --restart unless-stopped ' +
    '-v /var/run/docker.sock:/var/run/docker.sock ' +
    `-e SCANTOR_URL=${settings.publicUrl} -e SCANTOR_NODE_TOKEN=${token} ${image} node`
  const compose = [
    'name: scantor-node',
    '',
    'services:',
    '  node:',
    `    image: ${image}`,
    '    command: ["node"]',
    '    restart: unless-stopped',
    '    healthcheck:',
    '      test: ["CMD", "/usr/local/bin/scantor", "node", "healthcheck"]',
    '      interval: 30s',
    '      timeout: 5s',
    '      retries: 3',
    '      start_period: 60s',
    '    container_name: scantor-node',
    '    stop_grace_period: 30s',
    '    volumes:',
    '      - /var/run/docker.sock:/var/run/docker.sock',
    '    environment:',
    `      - SCANTOR_URL=${settings.publicUrl}`,
    `      - SCANTOR_NODE_TOKEN=${token}`,
    '      # optional:',
    '      # - SCANTOR_NODE_MAX_WORKERS=8',
    '      # - SCANTOR_NODE_DIND=sysbox',
    '      # - SCANTOR_CA_CERT=-----BEGIN CERTIFICATE-----...',
    '',
  ].join('\n')
  return { dockerRun, compose, env: { SCANTOR_URL: settings.publicUrl, SCANTOR_NODE_TOKEN: token } }
}
