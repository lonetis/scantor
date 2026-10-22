import ConfirmModal from '~/components/ConfirmModal.vue'

export interface ConfirmOptions {
  title: string
  description?: string
  /** Names the action, for example "Delete scan" (never just "OK"). */
  confirmLabel: string
  confirmColor?: 'error' | 'warning' | 'primary' | 'neutral'
  /** When set, the user must type exactly this text (a task name, an email) before confirming. */
  typeToConfirm?: string
}

/**
 * Opens a ConfirmModal and resolves with the user's choice (docs/ui.md §5: destructive operations go
 * through a modal, never window.confirm()).
 */
export function useConfirm() {
  const overlay = useOverlay()

  async function confirm(options: ConfirmOptions): Promise<boolean> {
    // One overlay per question, removed again after it closed.
    const modal = overlay.create(ConfirmModal, { destroyOnClose: true })
    const result = await modal.open(options)
    return result === true
  }

  return { confirm }
}
