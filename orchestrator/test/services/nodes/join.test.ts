import { describe, expect, it } from 'vitest'
import { buildNodeJoin, NODE_TOKEN_PLACEHOLDER, nodeImage } from '../../../server/services/nodes/join'

// NodeJoin (docs/api.md §4.17, docs/nodes.md §4): the exact docker run line and compose file, the image tag rule of
// decision 14 (the orchestrator version for releases, SCANTOR_IMAGE_TAG otherwise) and the token placeholder.

const TOKEN = 'snt_3q8ZkP2mW9xV7bN1cR4tY6uA0sD5fG8hJ2kL4zX7cV9'
const RELEASE = { publicUrl: 'https://scantor.example.com', imagePrefix: 'ghcr.io/lonetis/', imageTag: 'latest', version: '1.4.0' }

describe('nodeImage', () => {
  it('uses the release version, else SCANTOR_IMAGE_TAG', () => {
    expect(nodeImage(RELEASE)).toBe('ghcr.io/lonetis/scantor:1.4.0')
    expect(nodeImage({ ...RELEASE, version: '1.4.0-12-gabc1234' })).toBe('ghcr.io/lonetis/scantor:latest')
    expect(nodeImage({ imagePrefix: '', imageTag: 'dev', version: 'dev' })).toBe('scantor:dev')
  })
})

describe('buildNodeJoin', () => {
  it('produces the exact docs/nodes.md §4 docker run line (one line)', () => {
    expect(buildNodeJoin(TOKEN, RELEASE).dockerRun).toBe(
      'docker run -d --name scantor-node --restart unless-stopped -v /var/run/docker.sock:/var/run/docker.sock ' +
        `-e SCANTOR_URL=https://scantor.example.com -e SCANTOR_NODE_TOKEN=${TOKEN} ghcr.io/lonetis/scantor:1.4.0 node`,
    )
  })

  it('produces the exact docs/nodes.md §4 compose file', () => {
    expect(buildNodeJoin(TOKEN, RELEASE).compose).toBe(`name: scantor-node

services:
  node:
    image: ghcr.io/lonetis/scantor:1.4.0
    command: ["node"]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "/usr/local/bin/scantor", "node", "healthcheck"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s
    container_name: scantor-node
    stop_grace_period: 30s
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - SCANTOR_URL=https://scantor.example.com
      - SCANTOR_NODE_TOKEN=${TOKEN}
      # optional:
      # - SCANTOR_NODE_MAX_WORKERS=8
      # - SCANTOR_NODE_DIND=sysbox
      # - SCANTOR_CA_CERT=-----BEGIN CERTIFICATE-----...
`)
  })

  it('carries the env pair and supports the placeholder of getNodeJoin', () => {
    const join = buildNodeJoin(NODE_TOKEN_PLACEHOLDER, RELEASE)
    expect(join.env).toEqual({ SCANTOR_URL: 'https://scantor.example.com', SCANTOR_NODE_TOKEN: '${SCANTOR_NODE_TOKEN}' })
    expect(join.dockerRun).toContain('-e SCANTOR_NODE_TOKEN=${SCANTOR_NODE_TOKEN} ')
    expect(join.compose).toContain('- SCANTOR_NODE_TOKEN=${SCANTOR_NODE_TOKEN}\n')
  })
})
