import { useClipboard } from '@vueuse/core'

/** Copies text to the clipboard and confirms with a "Copied" toast (docs/ui.md §7). */
export function useCopy() {
  const toast = useToast()
  const { copy: writeClipboard, copied, isSupported } = useClipboard({ copiedDuring: 1500, legacy: true })

  async function copy(text: string): Promise<boolean> {
    try {
      await writeClipboard(text)
    } catch (error) {
      console.error('[copy] writing to the clipboard failed', error)
      toast.add({ title: 'Copy failed', description: 'The browser did not allow access to the clipboard.', color: 'error', icon: 'i-lucide-circle-alert' })
      return false
    }
    toast.add({ id: 'copied', title: 'Copied', color: 'success', icon: 'i-lucide-check', duration: 1500 })
    return true
  }

  return { copy, copied, isSupported }
}
