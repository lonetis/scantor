import { describe, expect, it } from 'vitest'
import { labelTableElement } from '../../app/composables/useTableRowIds'
import { queryRowId } from '../../app/composables/useQuery'

// Tables (docs/ui.md §11 rules 3 and 6): UTable puts the aria-label on its wrapper, so the <table> is labelled by the
// wrapper and exposes the label as its accessible name; rows carry data-row-id.

class FakeElement {
  id = ''
  readonly attributes = new Map<string, string>()
  constructor(private readonly child: FakeElement | null = null) {}
  querySelector(selector: string): FakeElement | null {
    return selector === 'table' ? this.child : null
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }
}

function tableIn(label: string | null, id = ''): { root: FakeElement; table: FakeElement } {
  const table = new FakeElement()
  const root = new FakeElement(table)
  root.id = id
  if (label !== null) root.setAttribute('aria-label', label)
  return { root, table }
}

describe('labelTableElement', () => {
  it('labels the <table> by its wrapper, giving the wrapper an id when it has none', () => {
    const { root, table } = tableIn('Nodes')
    labelTableElement(root as unknown as Element, 'scantor-table-v-1')
    expect(root.id).toBe('scantor-table-v-1')
    expect(table.getAttribute('aria-labelledby')).toBe('scantor-table-v-1')
    // The label stays on the wrapper only, so `[aria-label="Nodes"]` still matches one element.
    expect(table.getAttribute('aria-label')).toBeNull()
  })

  it('keeps an existing wrapper id and is idempotent', () => {
    const { root, table } = tableIn('Revisions', 'revisions')
    labelTableElement(root as unknown as Element, 'fallback')
    labelTableElement(root as unknown as Element, 'fallback')
    expect(root.id).toBe('revisions')
    expect(table.getAttribute('aria-labelledby')).toBe('revisions')
  })

  it('removes its reference when the wrapper loses its label', () => {
    const { root, table } = tableIn('Jobs')
    labelTableElement(root as unknown as Element, 'jobs')
    root.removeAttribute('aria-label')
    labelTableElement(root as unknown as Element, 'jobs')
    expect(table.getAttribute('aria-labelledby')).toBeNull()
  })

  it('does nothing without a table', () => {
    const root = new FakeElement(null)
    root.setAttribute('aria-label', 'Empty')
    labelTableElement(root as unknown as Element, 'x')
    expect(root.id).toBe('')
  })
})

describe('queryRowId', () => {
  it('prefers seq, then id, then a scalar _id, then the position', () => {
    expect(queryRowId({ seq: 7, id: 'x' }, 0)).toBe(7)
    expect(queryRowId({ id: 'abc' }, 1)).toBe('abc')
    expect(queryRowId({ _id: 'failed', count: 3 }, 2)).toBe('failed')
    expect(queryRowId({ _id: null, count: 3 }, 3)).toBe(3)
    expect(queryRowId({ seq: '' }, 4)).toBe(4)
  })
})
