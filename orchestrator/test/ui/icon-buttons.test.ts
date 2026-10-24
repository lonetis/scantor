import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileDownloadLabel } from '../../app/composables/useAnalyses'

// docs/ui.md §11 rule 1: every icon-only button has an aria-label and the same text as its tooltip. This static
// check of the templates guards the conventions that implement it: an icon-only UButton or <button> sits directly in a
// UTooltip, Nuxt UI's own icon-only buttons go through SidebarCollapseButton, NumberInput and CloseButton, and menu
// triggers nest the tooltip inside UDropdownMenu.

const APP = join(__dirname, '../../app')

function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? vueFiles(path) : path.endsWith('.vue') ? [path] : []
  })
}

const templates = vueFiles(APP).map((path) => {
  const source = readFileSync(path, 'utf8')
  return { file: relative(APP, path), template: source.slice(source.indexOf('<template')) }
})

/** The opening tags of an element, honouring quoted attribute values (which contain `=>`). */
function openingTags(template: string, tag: string): { start: number; text: string }[] {
  const tags: { start: number; text: string }[] = []
  const pattern = new RegExp(`<${tag}\\b`, 'g')
  for (const match of template.matchAll(pattern)) {
    let quote: string | null = null
    for (let index = match.index; index < template.length; index++) {
      const char = template[index]!
      if (quote) {
        if (char === quote) quote = null
      } else if (char === '"' || char === "'") quote = char
      else if (char === '>') {
        tags.push({ start: match.index, text: template.slice(match.index, index + 1) })
        break
      }
    }
  }
  return tags
}

function previousLine(template: string, index: number): string {
  return template.slice(0, index).trimEnd().split('\n').at(-1) ?? ''
}

describe('icon-only buttons (docs/ui.md §11 rule 1)', () => {
  it('sit directly in a UTooltip', () => {
    const bare: string[] = []
    for (const { file, template } of templates) {
      for (const tag of ['UButton', 'button']) {
        for (const { start, text } of openingTags(template, tag)) {
          if (!/\s:?aria-label=/.test(text) || /\s:?label=/.test(text) || /\sto=|\s:to=/.test(text)) continue
          if (tag === 'button' && !text.endsWith('/>')) {
            const inner = template.slice(start + text.length, template.indexOf('</button>', start)).replace(/<[^>]+>/g, '').trim()
            if (inner) continue
          }
          if (!previousLine(template, start).includes('<UTooltip')) bare.push(`${file}: ${text.replace(/\s+/g, ' ').slice(0, 120)}`)
        }
      }
    }
    expect(bare).toEqual([])
  })

  it('use the wrappers for Nuxt UI components with icon-only buttons of their own', () => {
    const misuse = templates.flatMap(({ file, template }) => [
      ...(file !== 'components/NumberInput.vue' && template.includes('<UInputNumber') ? [`${file}: UInputNumber instead of NumberInput`] : []),
      ...(file !== 'components/SidebarCollapseButton.vue' && template.includes('<UDashboardSidebarCollapse') ? [`${file}: UDashboardSidebarCollapse instead of SidebarCollapseButton`] : []),
      ...(/<(UModal|USlideover)\b/.test(template) && !/<template #close="\{ ui \}">\s*<CloseButton\b/.test(template) ? [`${file}: modal or slideover without CloseButton`] : []),
      ...(/<UTooltip\b[^>]*>\s*<UDropdownMenu\b/.test(template) ? [`${file}: UTooltip around UDropdownMenu never reaches the trigger`] : []),
    ])
    expect(misuse).toEqual([])
  })
})

describe('fileDownloadLabel', () => {
  it('names the analysis of the chip, so the chips of different rows differ', () => {
    const scanId = '7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c'
    expect(fileDownloadLabel('data.json', `${scanId}-0`)).toBe('Download data.json of analysis 0')
    expect(fileDownloadLabel('data.json', `${scanId}-12`)).toBe('Download data.json of analysis 12')
    expect(fileDownloadLabel('report.txt', 'not-an-analysis-id')).toBe('Download report.txt')
  })
})
