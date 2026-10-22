/*
 * The editor listener's own pages (docs/editor.md §8.2): small static HTML without scripts. They link back to the
 * dashboard, never embed request data, and are sent with `Cache-Control: no-store` plus a restrictive policy of
 * their own on top of the `frame-ancestors` header every editor-origin response carries.
 */

export interface EditorPage {
  status: number
  /** extra response headers (for example `Retry-After`) */
  headers?: Record<string, string>
  body: string
}

/** Content-Security-Policy of the listener's own pages (an additional header next to `frame-ancestors`). */
export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

function render(options: { title: string; message: string; dashboardUrl?: string; refreshSeconds?: number }): string {
  const refresh = options.refreshSeconds ? `<meta http-equiv="refresh" content="${options.refreshSeconds}">` : ''
  const link = options.dashboardUrl
    ? `<p><a href="${escapeHtml(options.dashboardUrl)}" target="_top" rel="noopener noreferrer">Open the scantor dashboard</a></p>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
${refresh}<title>${escapeHtml(options.title)} · scantor editor</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
         background: #0f172a; color: #e2e8f0; }
  main { max-width: 32rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.1rem; margin: 0 0 .5rem; }
  p { margin: .5rem 0; color: #94a3b8; }
  a { color: #4ade80; }
  @media (prefers-color-scheme: light) { body { background: #f8fafc; color: #0f172a; } p { color: #475569; } a { color: #15803d; } }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(options.title)}</h1>
<p>${escapeHtml(options.message)}</p>
${link}
</main>
</body>
</html>
`
}

/** 401: no valid `scantor_editor` cookie, or an invalid, used or expired one-time code. */
export function unauthorizedPage(dashboardUrl: string, reason: 'cookie' | 'code'): EditorPage {
  const message =
    reason === 'code'
      ? 'This editor link is invalid, was already used or has expired. Open the editor again from the dashboard.'
      : 'You are not signed in to this editor. Open the editor from the dashboard.'
  return { status: 401, body: render({ title: 'Not signed in', message, dashboardUrl }) }
}

/** 410: the editor this cookie belongs to was stopped or restarted. */
export function editorEndedPage(dashboardUrl: string): EditorPage {
  return {
    status: 410,
    body: render({
      title: 'Editor stopped',
      message: 'Your editor is no longer running. Open it again from the dashboard to start it.',
      dashboardUrl,
    }),
  }
}

/** 503 with a refresh while the editor container is starting. */
export function startingPage(): EditorPage {
  return {
    status: 503,
    headers: { 'retry-after': '2' },
    body: render({ title: 'Starting your editor…', message: 'This page reloads by itself once the editor is ready.', refreshSeconds: 2 }),
  }
}

/** 502: the editor's socket could not be reached. */
export function badGatewayPage(dashboardUrl: string): EditorPage {
  return {
    status: 502,
    body: render({
      title: 'Editor not reachable',
      message: 'The editor did not answer. If this persists, stop and reopen the editor from the dashboard.',
      dashboardUrl,
    }),
  }
}

/** 429: too many failed one-time codes from this client. */
export function tooManyRequestsPage(): EditorPage {
  return {
    status: 429,
    headers: { 'retry-after': '60' },
    body: render({ title: 'Too many attempts', message: 'Too many invalid editor links were opened from this address. Try again in a minute.' }),
  }
}

/** 405 for a method other than GET on `/_auth`. */
export function methodNotAllowedPage(): EditorPage {
  return { status: 405, headers: { allow: 'GET' }, body: render({ title: 'Method not allowed', message: 'Only GET is allowed here.' }) }
}

/** 400 for a request target that is not an origin-form path. */
export function badRequestPage(): EditorPage {
  return { status: 400, body: render({ title: 'Bad request', message: 'The request target is not valid.' }) }
}
