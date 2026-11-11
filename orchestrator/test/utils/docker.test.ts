import { beforeEach, describe, expect, it, vi } from 'vitest'

// ensureVolume against a fake Docker client (docs/deployment.md §5.1): plain and bind-backed volumes, and the refusal to
// start when an existing volume is not where its variable says. ensureEgressNetwork (docs/nodes.md §6.8): an isolated
// network, and a plain one only with SCANTOR_ALLOW_UNISOLATED_NETWORKS where the daemon cannot isolate.

const volumes = new Map<string, { Name: string; Driver: string; Options: Record<string, string> | null }>()
const created: unknown[] = []
const networks = new Map<string, { Name: string; Options: Record<string, string> }>()
const createdNetworks: { Name: string; Options: Record<string, string>; Labels: Record<string, string> }[] = []
const daemon = { canIsolate: true }

vi.mock('dockerode', () => ({
  default: class {
    getNetwork(name: string) {
      return {
        inspect: async () => {
          const network = networks.get(name)
          if (!network) throw Object.assign(new Error('no such network'), { statusCode: 404 })
          return network
        },
      }
    }

    async createNetwork(options: { Name: string; Options: Record<string, string>; Labels: Record<string, string> }) {
      if (networks.has(options.Name)) throw Object.assign(new Error('network exists'), { statusCode: 409 })
      if (!daemon.canIsolate && options.Options['com.docker.network.bridge.enable_icc'] === 'false') {
        throw Object.assign(new Error('cannot restrict inter-container communication or run without the userland proxy'), { statusCode: 500 })
      }
      createdNetworks.push(options)
      networks.set(options.Name, { Name: options.Name, Options: options.Options })
    }

    getVolume(name: string) {
      return {
        inspect: async () => {
          const volume = volumes.get(name)
          if (!volume) throw Object.assign(new Error('no such volume'), { statusCode: 404 })
          return volume
        },
      }
    }

    async createVolume(options: { Name: string; Driver?: string; DriverOpts?: Record<string, string> }) {
      created.push(options)
      volumes.set(options.Name, { Name: options.Name, Driver: options.Driver ?? 'local', Options: options.DriverOpts ?? null })
    }
  },
}))

const { ensureEgressNetwork, ensureVolume, volumeBindPath, VolumeLocationError } = await import('../../server/utils/docker')
const { BootAbortError } = await import('../../server/utils/boot')
const { useLogger } = await import('../../server/utils/logger')
const { setConfigForTesting } = await import('../../server/utils/config')

const log = useLogger('test')
const WORKSPACES = { variable: 'SCANTOR_WORKSPACES_DATA', path: null }

beforeEach(() => {
  volumes.clear()
  created.length = 0
  networks.clear()
  createdNetworks.length = 0
  daemon.canIsolate = true
  vi.unstubAllEnvs()
  setConfigForTesting(null)
})

describe('ensureEgressNetwork', () => {
  it('creates scantor-egress without inter-container traffic and with the managed labels', async () => {
    await ensureEgressNetwork(log)
    expect(createdNetworks).toHaveLength(1)
    expect(createdNetworks[0]!.Options).toEqual({ 'com.docker.network.bridge.enable_icc': 'false' })
    expect(createdNetworks[0]!.Labels['scantor.kind']).toBe('network')
  })

  it('fails with a hint when the daemon cannot isolate and the opt-in is off', async () => {
    daemon.canIsolate = false
    await expect(ensureEgressNetwork(log)).rejects.toThrow(/SCANTOR_ALLOW_UNISOLATED_NETWORKS=true/)
    expect(createdNetworks).toEqual([])
  })

  it('creates a plain bridge network with SCANTOR_ALLOW_UNISOLATED_NETWORKS when the daemon cannot isolate', async () => {
    vi.stubEnv('SCANTOR_ALLOW_UNISOLATED_NETWORKS', 'true')
    setConfigForTesting(null)
    daemon.canIsolate = false
    await ensureEgressNetwork(log)
    expect(createdNetworks).toHaveLength(1)
    expect(createdNetworks[0]!.Options).toEqual({})
    expect(createdNetworks[0]!.Labels['scantor.kind']).toBe('network')
  })

  it('keeps isolation with the opt-in when the daemon can isolate, and never touches an existing network', async () => {
    vi.stubEnv('SCANTOR_ALLOW_UNISOLATED_NETWORKS', 'true')
    setConfigForTesting(null)
    await ensureEgressNetwork(log)
    await ensureEgressNetwork(log)
    expect(createdNetworks).toHaveLength(1)
    expect(createdNetworks[0]!.Options).toEqual({ 'com.docker.network.bridge.enable_icc': 'false' })
  })
})

describe('volumeBindPath', () => {
  it('reads the directory of a local bind volume and nothing else', () => {
    expect(volumeBindPath({ Driver: 'local', Options: { type: 'none', o: 'bind', device: '/mnt/disk1/w/' } })).toBe('/mnt/disk1/w')
    expect(volumeBindPath({ Driver: 'local', Options: { type: 'none', o: 'rbind,ro', device: '/x' } })).toBeNull()
    expect(volumeBindPath({ Driver: 'local', Options: { type: 'none', o: 'ro,bind', device: '/x' } })).toBe('/x')
    expect(volumeBindPath({ Driver: 'local', Options: null })).toBeNull()
    expect(volumeBindPath({ Driver: 'local', Options: { type: 'nfs', o: 'addr=10.0.0.1', device: ':/export' } })).toBeNull()
    expect(volumeBindPath({ Driver: 'other', Options: { type: 'none', o: 'bind', device: '/x' } })).toBeNull()
  })
})

describe('ensureVolume', () => {
  it('creates a plain volume, or one bound to the configured directory', async () => {
    await ensureVolume('scantor-workspaces', WORKSPACES, log)
    await ensureVolume('scantor-editor-home', { variable: 'SCANTOR_EDITOR_HOME_DATA', path: '/mnt/disk2/homes' }, log)
    expect(created).toEqual([
      { Name: 'scantor-workspaces' },
      { Name: 'scantor-editor-home', Driver: 'local', DriverOpts: { type: 'none', o: 'bind', device: '/mnt/disk2/homes' } },
    ])
  })

  it('keeps an existing volume that is already at the configured location', async () => {
    volumes.set('scantor-workspaces', { Name: 'scantor-workspaces', Driver: 'local', Options: null })
    volumes.set('scantor-editor-home', { Name: 'scantor-editor-home', Driver: 'local', Options: { type: 'none', o: 'bind', device: '/mnt/h' } })
    await ensureVolume('scantor-workspaces', WORKSPACES, log)
    await ensureVolume('scantor-editor-home', { variable: 'SCANTOR_EDITOR_HOME_DATA', path: '/mnt/h' }, log)
    expect(created).toEqual([])
  })

  it.each([
    [null, '/mnt/disk1/w', 'volume scantor-workspaces is a plain Docker volume, but SCANTOR_WORKSPACES_DATA asks for the directory /mnt/disk1/w'],
    ['/mnt/old', '/mnt/new', 'volume scantor-workspaces is bound to /mnt/old, but SCANTOR_WORKSPACES_DATA asks for the directory /mnt/new'],
    ['/mnt/old', null, 'volume scantor-workspaces is bound to /mnt/old, but SCANTOR_WORKSPACES_DATA asks for a plain Docker volume'],
  ])('refuses the start when the volume is at %j but the variable says %j', async (current, wanted, message) => {
    volumes.set('scantor-workspaces', {
      Name: 'scantor-workspaces',
      Driver: 'local',
      Options: current ? { type: 'none', o: 'bind', device: current } : null,
    })
    const error = await ensureVolume('scantor-workspaces', { variable: 'SCANTOR_WORKSPACES_DATA', path: wanted }, log).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(VolumeLocationError)
    expect(error).toBeInstanceOf(BootAbortError)
    expect((error as Error).message).toContain(message)
    expect((error as Error).message).toContain('docker volume rm scantor-workspaces')
    expect(created).toEqual([])
  })
})
