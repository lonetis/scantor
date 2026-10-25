// Browser download helpers. API downloads are plain navigations (anchors or presigned URLs), never fetches,
// so large files stream straight to disk (docs/ui.md §8).

/** Starts a download of a same-origin API URL through a temporary anchor with a `download` attribute. */
export function downloadFromUrl(url: string, filename = ''): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/** Follows a presigned S3 URL (forced `Content-Disposition` makes the browser download it). */
export function navigateToDownload(url: string): void {
  window.location.assign(url)
}

/** Opens a URL in a new tab without giving it access to this window. */
export function openInNewTab(url: string): void {
  window.open(url, '_blank', 'noopener')
}
