// Content props of every modal and slideover (`:content="dialogContent"`, docs/ui.md §11 rule 5). When a dialog opens,
// reka-ui focuses its first focusable element, which is the header's CloseButton: its tooltip opens on that focus as
// the topmost dismissable layer, so the first Escape would only close the tooltip and leave the dialog open. The
// dialog focuses itself instead (reka-ui's own fallback when nothing inside is focusable): Escape closes it at once,
// a field with `autofocus` still takes the focus, and Tab enters the dialog's controls inside the focus trap.

export const dialogContent = {
  /** reka-ui dispatches the event on the dialog element itself (FocusScope's container). */
  onOpenAutoFocus(event: Event): void {
    event.preventDefault()
    ;(event.target as HTMLElement | null)?.focus({ preventScroll: true })
  },
}
