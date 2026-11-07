import { beforeEach, describe, expect, it, vi } from 'vitest'

// ensureVolume against a fake Docker client (docs/deployment.md §5.1): plain and bind-backed volumes, and the refusal to
// start when an existing volume is not where its variable says.

const volumes = new Map<string, { Name: string; Driver: string; Options: Record<string, string> | null }>()
const created: unknown[] = []

vi.mock('dockerode', () => ({
  default: class {
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

const { ensureVolume, volumeBindPath, VolumeLocationError } = await import('../../server/utils/docker')
const { BootAbortError } = await import('../../server/utils/boot')
const { useLogger } = await import('../../server/utils/logger')

const log = useLogger('test')
const WORKSPACES = { variable: 'SCANTOR_WORKSPACES_DATA', path: null }

beforeEach(() => {
  volumes.clear()
  created.length = 0
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
