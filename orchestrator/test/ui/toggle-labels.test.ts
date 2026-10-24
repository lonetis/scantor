import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// docs/ui.md §11 rule 8: reka-ui names a checkbox or switch once from the text of its <label for> and never reads it
// again, so a control whose label changes ("I want to start about N analyses") keeps its first name unless it also
// binds the label as aria-label. This static check of the templates guards that convention.

const APP = join(__dirname, '../../app')

function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? vueFiles(path) : path.endsWith('.vue') ? [path] : []
  })
}

/** The opening tags of an element, honouring quoted attribute values (which contain `=>`). */
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

describe('checkboxes and switches with a bound label (docs/ui.md §11 rule 8)', () => {
  it('bind an aria-label as well', () => {
    const unnamed: string[] = []
    for (const path of vueFiles(APP)) {
      const source = readFileSync(path, 'utf8')
      const template = source.slice(source.indexOf('<template'))
      for (const tag of ['UCheckbox', 'USwitch']) {
        for (const text of openingTags(template, tag)) {
          if (/\s(:|v-bind:)label=/.test(text) && !/\s:?aria-label=/.test(text)) unnamed.push(`${relative(APP, path)}: ${text.replace(/\s+/g, ' ')}`)
        }
      }
    }
    expect(unnamed).toEqual([])
  })

  it('finds the bound labels it guards', () => {
    const source = readFileSync(join(APP, 'components/NewScanForm.vue'), 'utf8')
    expect(openingTags(source, 'UCheckbox').some((text) => text.includes(':label="confirmLabel"') && text.includes(':aria-label="confirmLabel"'))).toBe(true)
  })
})
