import { describe, expect, it } from 'vitest'
import { isForbiddenImageLabelKey, isManagedContainer, MANAGED_KINDS, managedLabels, managedNamePrefix } from '../../server/utils/labels'
import { readRepoFile } from '../helpers/repo'

// Managed labels against schemas/managed-labels.json, the file Go internal/container reads too (security.md LBL-1).

const spec = JSON.parse(readRepoFile('schemas/managed-labels.json')) as {
  fixed: Record<string, string>
  kindKey: string
  kinds: Record<string, { identity: string[]; namePrefix?: string }>
}

describe('managedLabels', () => {
  it('covers every kind of the shared file', () => {
    expect(new Set(MANAGED_KINDS)).toEqual(new Set(Object.keys(spec.kinds)))
  })

  it.each(Object.keys(spec.kinds))('labels a %s with the fixed set and its kind', (kind) => {
    const labels = managedLabels(kind as (typeof MANAGED_KINDS)[number])
    expect(labels).toEqual({ ...spec.fixed, [spec.kindKey]: kind })
    expect(labels['traefik.enable']).toBe('false')
    expect(labels['com.docker.compose.project']).toBe('scantor-managed')
  })

  it('adds only the identity labels of the kind', () => {
    expect(managedLabels('helper', { 'scantor.user': 'u', 'scantor.op': 'snapshot' })).toMatchObject({ 'scantor.user': 'u', 'scantor.op': 'snapshot' })
    expect(() => managedLabels('editor', { 'scantor.scan': 's' })).toThrow()
  })

  it('recognises containers only by labels and name prefix', () => {
    const labels = managedLabels('editor', { 'scantor.user': 'u' })
    expect(managedNamePrefix('editor')).toBe('scantor-editor-')
    expect(managedNamePrefix('network')).toBeNull()
    expect(isManagedContainer('editor', '/scantor-editor-u', labels)).toBe(true)
    expect(isManagedContainer('editor', 'evil-editor', labels)).toBe(false)
    expect(isManagedContainer('editor', 'scantor-editor-u', { ...labels, 'scantor.kind': 'worker' })).toBe(false)
    expect(isManagedContainer('editor', 'scantor-editor-u', undefined)).toBe(false)
  })

  it('rejects forbidden image label keys (Dockerfile rule D9)', () => {
    for (const key of ['traefik.http.routers.x.rule', 'Traefik.enable', 'com.docker.compose.project', 'scantor.kind', 'my$key']) {
      expect(isForbiddenImageLabelKey(key), key).toBe(true)
    }
    for (const key of ['org.opencontainers.image.source', 'maintainer']) expect(isForbiddenImageLabelKey(key), key).toBe(false)
  })
})
