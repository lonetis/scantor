import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { dialogContent } from '../../app/utils/dialog'

// docs/ui.md §11 rule 5: an opening dialog focuses itself, not its header's CloseButton, whose tooltip would open on
// that focus as the topmost dismissable layer and take the first Escape (FEATURES UI-NAV-025, UI-NAV-028).

const APP = join(__dirname, '../../app')

function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? vueFiles(path) : path.endsWith('.vue') ? [path] : []
  })
}

/** The opening tags of an element, honouring quoted attribute values (which contain `>` in arrow functions). */
function openingTags(template: string, tag: string): string[] {
  const tags: string[] = []
  for (const match of template.matchAll(new RegExp(`<${tag}\\b`, 'g'))) {
    let quote: string | null = null
    for (let index = match.index; index < template.length; index++) {
      const char = template[index]!
      if (quote) {
        if (char === quote) quote = null
      } else if (char === '"' || char === "'") quote = char
      else if (char === '>') {
        tags.push(template.slice(match.index, index + 1))
        break
      }
    }
  }
  return tags
}

describe('dialogContent', () => {
  it('keeps reka-ui from focusing the first control and focuses the dialog itself', () => {
    const dialog = { focus: vi.fn() }
    const event = { preventDefault: vi.fn(), target: dialog } as unknown as Event
    dialogContent.onOpenAutoFocus(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(dialog.focus).toHaveBeenCalledWith({ preventScroll: true })
  })
})

describe('modals and slideovers (docs/ui.md §11 rule 5)', () => {
  it('bind dialogContent as their content props', () => {
    const tags: string[] = []
    const missing: string[] = []
    for (const path of vueFiles(APP)) {
      const source = readFileSync(path, 'utf8')
      const template = source.slice(source.indexOf('<template'))
      for (const tag of ['UModal', 'USlideover']) {
        for (const text of openingTags(template, tag)) {
          tags.push(text)
          if (!/\s:content="dialogContent"/.test(text)) missing.push(`${relative(APP, path)}: ${text.replace(/\s+/g, ' ')}`)
        }
      }
    }
    expect(tags.length).toBeGreaterThan(10)
    expect(missing).toEqual([])
  })
})
