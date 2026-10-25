// The Scalar API reference at /api/docs (docs/ui.md §13, docs/api.md §1.1). Nitro's built-in Scalar page loaded
// `https://cdn.jsdelivr.net/npm/@scalar/api-reference` unversioned, so any new npm release (or a compromised CDN) ran
// on the dashboard origin with the admin's session. The page is served by server/routes/api/docs.get.ts instead and
// loads one exact build: the pinned version, checked by its Subresource Integrity hash, and the docs CSP admits that
// one URL and no other script origin. The pin is listed in docs/development.md §11; a bump changes the version and the
// hash together (sha384 of `dist/browser/standalone.js` of the npm package, which jsDelivr serves unchanged).

export const SCALAR_VERSION = '1.73.1'
export const SCALAR_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/dist/browser/standalone.js`
export const SCALAR_BUNDLE_INTEGRITY = 'sha384-kYDGzV91Jnn3TbHINV3nt54riK2uMJDfN5Al8dAkz4FssELTBWbD8rgw32sTKfOi'

export interface ApiDocsPage {
  title: string
  description: string
  /** the OpenAPI document Scalar renders */
  documentUrl: string
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * The HTML of the reference page: Scalar's HTML integration reads its configuration from the (empty, never executed)
 * `#api-reference` element and mounts itself next to it.
 */
export function renderApiDocsPage(page: ApiDocsPage): string {
  const configuration = escapeHtml(JSON.stringify({ url: page.documentUrl }))
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${escapeHtml(page.description)}" />
    <title>${escapeHtml(page.title)}</title>
  </head>
  <body>
    <script id="api-reference" data-configuration="${configuration}"></script>
    <script src="${SCALAR_BUNDLE_URL}" integrity="${SCALAR_BUNDLE_INTEGRITY}" crossorigin="anonymous"></script>
  </body>
</html>
`
}
