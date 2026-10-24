// Clipboard writes for the copy buttons (docs/ui.md §7). The Clipboard API needs a secure context and permission;
// the `execCommand('copy')` fallback covers plain-http deployments. Unlike VueUse's useClipboard, both paths report
// a refusal, so the UI can say "Copy failed" instead of a false "Copied".

export interface ClipboardEnvironment {
  clipboard?: { writeText(text: string): Promise<void> } | undefined
  document?: Pick<Document, 'createElement' | 'execCommand' | 'activeElement'> & { body: Pick<HTMLElement, 'appendChild'> } | undefined
}

function browserEnvironment(): ClipboardEnvironment {
  return {
    clipboard: typeof navigator === 'undefined' ? undefined : navigator.clipboard,
    document: typeof document === 'undefined' ? undefined : document,
  }
}

/** Copies through a selected, off-screen textarea; true when the browser reports success. */
function legacyCopy(text: string, doc: NonNullable<ClipboardEnvironment['document']>): boolean {
  const focused = doc.activeElement as HTMLElement | null
  const area = doc.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  doc.body.appendChild(area)
  try {
    area.select()
    return doc.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
    focused?.focus?.({ preventScroll: true })
  }
}

/** Writes text to the clipboard; rejects when neither the Clipboard API nor the fallback could copy it. */
export async function writeClipboard(text: string, environment: ClipboardEnvironment = browserEnvironment()): Promise<void> {
  let apiError: unknown = null
  if (environment.clipboard) {
    try {
      await environment.clipboard.writeText(text)
      return
    } catch (error) {
      apiError = error
    }
  }
  if (environment.document && legacyCopy(text, environment.document)) return
  throw new Error('the browser refused to copy to the clipboard', apiError ? { cause: apiError } : undefined)
}
