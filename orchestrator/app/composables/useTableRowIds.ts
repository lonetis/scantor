import { useMutationObserver } from '@vueuse/core'
import type { Ref } from 'vue'

interface TableExpose<T> {
  $el?: HTMLElement
  tableApi?: { getRowModel(): { rows: { original: T }[] } }
}

/**
 * UTable cannot set attributes on its `<tr>` elements, but the test contract needs `data-row-id` on every row
 * (docs/ui.md §11). This keeps the attribute in sync after every render: data rows carry `data-selected`,
 * expanded rows do not, and virtualized rows carry `data-index`.
 */
export function useTableRowIds<T>(table: Ref<TableExpose<T> | null | undefined>, idOf: (row: T) => string | number) {
  function apply(): void {
    const instance = table.value
    const root = instance?.$el
    const rows = instance?.tableApi?.getRowModel().rows
    if (!root || !rows || typeof root.querySelectorAll !== 'function') return
    const elements = root.querySelectorAll<HTMLTableRowElement>('tbody > tr[data-selected]')
    elements.forEach((element, position) => {
      const indexAttribute = element.getAttribute('data-index')
      const index = indexAttribute === null ? position : Number(indexAttribute)
      const row = rows[index]
      if (!row) return
      const id = String(idOf(row.original))
      if (element.getAttribute('data-row-id') !== id) element.setAttribute('data-row-id', id)
    })
  }

  const target = computed(() => table.value?.$el ?? null)
  useMutationObserver(target, apply, { childList: true, subtree: true })
  watch(target, () => nextTick(apply), { immediate: true })
  onUpdated(() => nextTick(apply))
}
