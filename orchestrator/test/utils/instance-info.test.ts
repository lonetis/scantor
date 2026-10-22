import { describe, expect, it } from 'vitest'
import { parseConfig } from '../../server/utils/config'
import { buildInstanceInfo, toolUrl } from '../../server/utils/instance-info'
import type { UserPrincipal } from '../../server/utils/principal'

// getInstanceInfo (docs/api.md §4.1): features, limits, CLI image and admin tools; never secrets.

function principal(isAdmin: boolean): UserPrincipal {
  return { kind: 'user', via: 'session', user: { id: 'u', email: 'u@x', name: 'u', role: isAdmin ? 'admin' : 'user' }, isAdmin }
}

describe('buildInstanceInfo', () => {
  const { config } = parseConfig({
    SCANTOR_PUBLIC_URL: 'https://scantor.example.com',
    SCANTOR_EDITOR_URL: 'https://editor.scantor.example.com',
    SCANTOR_DOMAIN: 'scantor.example.com',
    SCANTOR_IMAGE_TAG: '1.4',
  })

  it('describes the instance for a user without admin tools', () => {
    const info = buildInstanceInfo(config, principal(false))
    expect(info).toMatchObject({
      publicUrl: 'https://scantor.example.com',
      editorUrl: 'https://editor.scantor.example.com',
      mcpUrl: 'https://scantor.example.com/mcp',
      cliImage: 'ghcr.io/lonetis/scantor:1.4',
      features: { passkeys: true, mcp: true, mcpOAuth: true, editor: true },
      limits: { waitMaxSeconds: 120, maxWorkersPerScan: 100 },
      user: { id: 'u', role: 'user' },
    })
    expect(info.adminTools).toBeUndefined()
    expect(JSON.stringify(info)).not.toContain('insecure-dev')
  })

  it('adds the tool URLs for admins', () => {
    expect(buildInstanceInfo(config, principal(true)).adminTools).toEqual({
      enabled: true,
      items: [
        { target: 'rabbitmq', title: 'RabbitMQ management', url: 'https://rabbitmq.scantor.example.com/' },
        { target: 'mongo-express', title: 'mongo-express', url: 'https://mongo-express.scantor.example.com/' },
        { target: 'rustfs', title: 'RustFS console', url: 'https://rustfs.scantor.example.com/rustfs/console/' },
        { target: 'traefik', title: 'Traefik dashboard', url: 'https://traefik.scantor.example.com/dashboard/' },
      ],
    })
  })

  it('has no tool URLs without Traefik', () => {
    expect(toolUrl({ publicUrl: 'http://localhost:3000', domain: null }, 'rabbitmq')).toBeNull()
    expect(toolUrl({ publicUrl: 'https://scantor.localhost:8443', domain: 'scantor.localhost' }, 'traefik')).toBe(
      'https://traefik.scantor.localhost:8443/dashboard/',
    )
  })
})
