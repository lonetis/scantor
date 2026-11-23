import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  downloadsUnavailableText,
  nodesConnectText,
  publicPageText,
  publicToolsUrl,
  TUNNEL_PAGE_UNAVAILABLE,
  TUNNEL_TOOLS_UNAVAILABLE,
  tunnelCliText,
  tunnelIndicatorText,
} from '../../app/utils/tunnel'

// The copy of the tunnel notices (docs/ui.md §3.2, §4.1, §5.20): every notice names the public URL, or says "the
// public URL" while it is unknown, and never calls the tunnel URL anything else.

const PUBLIC = 'https://scantor.example.com'

describe('tunnel notices', () => {
  it('names the public URL, or the public URL in words while it is unknown', () => {
    expect(tunnelIndicatorText(PUBLIC)).toBe(
      'Loaded through the tunnel URL. The editor, file downloads and the admin tools are available at https://scantor.example.com.',
    )
    expect(tunnelIndicatorText(null)).toContain('available at the public URL.')
    expect(downloadsUnavailableText(PUBLIC)).toBe('Downloads are available only at https://scantor.example.com, not through the tunnel URL')
    expect(downloadsUnavailableText(undefined)).toContain('only at the public URL')
    expect(nodesConnectText(PUBLIC)).toBe('Nodes connect to https://scantor.example.com, never through the tunnel URL.')
    expect(tunnelCliText(PUBLIC)).toBe(
      'Through the tunnel URL the CLI and MCP clients reach the API; file, export and bundle downloads, including the test-run files of ' +
        'scantor dev run --remote, need SCANTOR_URL=https://scantor.example.com.',
    )
    expect(tunnelCliText('')).toContain('SCANTOR_URL=the public URL.')
  })

  it('sends the route guard to the same path on the public URL', () => {
    expect(TUNNEL_PAGE_UNAVAILABLE).toBe('Not available through the tunnel URL')
    expect(publicPageText(PUBLIC, '/editor?task=echo')).toBe('Open https://scantor.example.com/editor?task=echo instead.')
    expect(publicPageText(`${PUBLIC}/`, '/editor')).toBe('Open https://scantor.example.com/editor instead.')
    expect(publicPageText(null, '/editor')).toBe('Open it at the public URL instead.')
  })

  it('links the admin tools alert to the admin tools page of the public URL', () => {
    expect(TUNNEL_TOOLS_UNAVAILABLE).toBe('Infrastructure tools are not served through the tunnel URL')
    expect(publicToolsUrl(PUBLIC)).toBe('https://scantor.example.com/admin/tools')
    expect(publicToolsUrl('http://localhost:3000//')).toBe('http://localhost:3000/admin/tools')
    expect(publicToolsUrl(null)).toBeNull()
    expect(publicToolsUrl('')).toBeNull()
    expect(publicToolsUrl('javascript:alert(1)')).toBeNull()
  })
})

// The controls that follow a presigned S3 link (TUNNEL-013, docs/ui.md §1): disabled without features.downloads, a link
// only with it, and a click handler that loads the instance info first (useInstance().downloadsAvailable), so a page of
// the tunnel URL never leaves for an unreachable S3 host. A static check of the sources, as icon-buttons.test.ts does.
describe('presigned download controls', () => {
  const APP = join(__dirname, '../../app')
  const source = (file: string) => readFileSync(join(APP, file), 'utf8')

  /** The opening tag of the UButton that contains `marker` (attributes hold no `>` in these templates). */
  function buttonWith(file: string, marker: string): string {
    const text = source(file)
    const at = text.indexOf(marker)
    expect(at, `${file}: ${marker}`).toBeGreaterThan(0)
    const start = text.lastIndexOf('<UButton', at)
    return text.slice(start, text.indexOf('>', at) + 1)
  }

  it.each([
    ['components/FileChip.vue', 'icon="i-lucide-download"'],
    ['components/TestRunAnalysisSlideover.vue', 'icon="i-lucide-file-down"'],
    ['components/ExportsPanel.vue', 'label="Download"'],
    ['components/BundleModal.vue', 'label="Download bundle"'],
    ['pages/tasks/[taskId]/revisions/[revision].vue', 'label="Download source"'],
    ['pages/scripts/[scriptId]/runs/[runId].vue', 'label="Download source"'],
    ['pages/scripts/[scriptId]/runs/[runId].vue', ':label="`Download ${stripEscapes(output.name)}`"'],
  ])('%s (%s) is disabled without the downloads feature and links only with it', (file, marker) => {
    const button = buttonWith(file, marker)
    expect(button).toContain(':disabled="!features.downloads"')
    if (button.includes(':href=')) expect(button).toMatch(/:href="features\.downloads \? [^"]+ : undefined"/)
  })

  it.each(['components/FileChip.vue', 'components/TestRunAnalysisSlideover.vue', 'composables/useExports.ts', 'composables/useBundle.ts'])(
    '%s checks the loaded instance info before it follows a presigned link',
    (file) => {
      expect(source(file)).toContain('if (!(await downloadsAvailable())) return')
    },
  )

  it('FileChip loads a preview only once the instance info allows downloads, and loads the info itself while it is missing', () => {
    const chip = source('components/FileChip.vue')
    expect(chip).toContain('const previewAllowed = computed(() => instanceInfo.value !== null && features.value.downloads)')
    expect(chip).toMatch(/if \(instanceInfo\.value === null\) \{\s+\/\/[^\n]*\n\s+loadInfo\(\)/)
    expect(chip).toContain('if (!previewAllowed.value) return')
  })
})
