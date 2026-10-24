import { useMutationObserver } from '@vueuse/core'
import type { Ref } from 'vue'

interface TableExpose<T> {
  $el?: HTMLElement
  tableApi?: { getRowModel(): { rows: { original: T }[] } }
}

/** The `<table>` inside a UTable root carries no name of its own: it is labelled by the root and its `aria-label`. */
export function labelTableElement(root: Element, fallbackId: string): void {
  const table = root.querySelector('table')
  if (!table) return
  const label = root.getAttribute('aria-label')
  if (!label) {
    if (table.getAttribute('aria-labelledby') === root.id) table.removeAttribute('aria-labelledby')
    return
  }
  if (!root.id) root.id = fallbackId
  if (table.getAttribute('aria-labelledby') !== root.id) table.setAttribute('aria-labelledby', root.id)
}

/**
 * UTable cannot set attributes on its `<table>` and `<tr>` elements, but the test contract needs `data-row-id` on
 * every row and the table's `aria-label` as the accessible name of the `<table>` (docs/ui.md §11). UTable puts the
 * `aria-label` on its wrapper; the `<table>` is labelled by that wrapper (`aria-labelledby`, whose referenced
 * `aria-label` is the name), so the label stays where locators find it and is not duplicated. This keeps both in sync
 * after every render: data rows carry `data-selected`, expanded rows do not, and virtualized rows carry
 * `data-index`.
 */
export function useTableRowIds<T>(table: Ref<TableExpose<T> | null | undefined>, idOf: (row: T, index: number) => string | number) {
  const fallbackId = `scantor-table-${useId()}`

  function apply(): void {
    const instance = table.value
    const root = instance?.$el
    const rows = instance?.tableApi?.getRowModel().rows
    if (!root || !rows || typeof root.querySelectorAll !== 'function') return
    labelTableElement(root, fallbackId)
    const elements = root.querySelectorAll<HTMLTableRowElement>('tbody > tr[data-selected]')
    elements.forEach((element, position) => {
      const indexAttribute = element.getAttribute('data-index')
      const index = indexAttribute === null ? position : Number(indexAttribute)
      const row = rows[index]
      if (!row) return
      const id = String(idOf(row.original, index))
      if (element.getAttribute('data-row-id') !== id) element.setAttribute('data-row-id', id)
    })
  }

  const target = computed(() => table.value?.$el ?? null)
  useMutationObserver(target, apply, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] })
  watch(target, () => nextTick(apply), { immediate: true })
  onUpdated(() => nextTick(apply))
}
