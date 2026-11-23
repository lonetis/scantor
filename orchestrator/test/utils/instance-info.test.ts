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

  it('describes the public origin: no tunnel URL, downloads on, the full wait', () => {
    const info = buildInstanceInfo(config, principal(false))
    expect(info).toMatchObject({ origin: 'public', tunnelUrl: null, features: { downloads: true }, limits: { waitMaxSeconds: 120 } })
    expect(buildInstanceInfo(config, principal(false), 'public')).toEqual(info)
  })

  it('describes the tunnel origin for a request through the tunnel URL (docs/api.md §4.1)', () => {
    const tunnel = parseConfig({
      SCANTOR_PUBLIC_URL: 'https://scantor.example.com',
      SCANTOR_EDITOR_URL: 'https://editor.scantor.example.com',
      SCANTOR_DOMAIN: 'scantor.example.com',
      SCANTOR_TUNNEL_URL: 'https://tunnel.example.org',
    }).config
    const info = buildInstanceInfo(tunnel, principal(true), 'tunnel')
    expect(info).toMatchObject({
      origin: 'tunnel',
      publicUrl: 'https://scantor.example.com',
      tunnelUrl: 'https://tunnel.example.org',
      editorUrl: 'https://editor.scantor.example.com',
      mcpUrl: 'https://tunnel.example.org/mcp',
      features: { passkeys: true, mcp: true, mcpOAuth: true, editor: false, downloads: false },
      limits: { waitMaxSeconds: 90 },
    })
    // The admin tool links do not depend on the origin; the UI decides what to show through the tunnel.
    expect(info.adminTools).toEqual(buildInstanceInfo(tunnel, principal(true), 'public').adminTools)

    // The public origin of the same instance names the tunnel URL but keeps its own MCP URL and features.
    expect(buildInstanceInfo(tunnel, principal(false), 'public')).toMatchObject({
      origin: 'public',
      tunnelUrl: 'https://tunnel.example.org',
      mcpUrl: 'https://scantor.example.com/mcp',
      features: { editor: true, downloads: true },
      limits: { waitMaxSeconds: 120 },
    })
  })

  it('has MCP OAuth and passkeys through an https tunnel even when the public URL is plain http', () => {
    const tunnel = parseConfig({ SCANTOR_PUBLIC_URL: 'http://10.0.0.5:3000', SCANTOR_TUNNEL_URL: 'https://tunnel.example.org' }).config
    expect(buildInstanceInfo(tunnel, principal(false), 'public').features).toMatchObject({ passkeys: false, mcpOAuth: false })
    expect(buildInstanceInfo(tunnel, principal(false), 'tunnel').features).toMatchObject({ passkeys: true, mcpOAuth: true })
    const off = parseConfig({ SCANTOR_TUNNEL_URL: 'https://tunnel.example.org', SCANTOR_MCP_ENABLED: 'false' }).config
    expect(buildInstanceInfo(off, principal(false), 'tunnel')).toMatchObject({ mcpUrl: null, features: { mcp: false, mcpOAuth: false } })
  })

  it('has no tool URLs without Traefik', () => {
    expect(toolUrl({ publicUrl: 'http://localhost:3000', domain: null }, 'rabbitmq')).toBeNull()
    expect(toolUrl({ publicUrl: 'https://scantor.localhost:8443', domain: 'scantor.localhost' }, 'traefik')).toBe(
      'https://traefik.scantor.localhost:8443/dashboard/',
    )
  })
})
