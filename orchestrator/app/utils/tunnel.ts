import { safeHttpUrl } from './navigation'

// Copy for the dashboard loaded through the tunnel URL (docs/ui.md §1): presigned S3 downloads, the editor, the admin
// tools and the node endpoints are not served through the tunnel URL, so the UI names the public URL for them (which
// can be internal or, with Traefik, public itself). Whether a page came through the tunnel URL is getInstanceInfo's
// `origin` (useInstance().isTunnel), never window.location.

/** Title of the toast when a page that needs the public URL is opened through the tunnel URL. */
export const TUNNEL_PAGE_UNAVAILABLE = 'Not available through the tunnel URL'

function publicUrlText(publicUrl: string | null | undefined): string {
  return publicUrl || 'the public URL'
}

/** The tooltip of the sidebar's tunnel badge. */
export function tunnelIndicatorText(publicUrl: string | null | undefined): string {
  return `Loaded through the tunnel URL. The editor, file downloads and the admin tools are available at ${publicUrlText(publicUrl)}.`
}

/** The tooltip of a disabled download control. */
export function downloadsUnavailableText(publicUrl: string | null | undefined): string {
  return `Downloads are available only at ${publicUrlText(publicUrl)}, not through the tunnel URL`
}

/** Where a page that needs the public URL is available (the toast of the route guard, the admin tools alert). */
export function publicPageText(publicUrl: string | null | undefined, path: string): string {
  return publicUrl ? `Open ${publicUrl.replace(/\/+$/, '')}${path} instead.` : 'Open it at the public URL instead.'
}

/** The title of the admin tools alert through the tunnel URL, which replaces the tool grid there. */
export const TUNNEL_TOOLS_UNAVAILABLE = 'Infrastructure tools are not served through the tunnel URL'

/** The admin tools page on the public URL, linked from that alert; null while the public URL is unknown. */
export function publicToolsUrl(publicUrl: string | null | undefined): string | null {
  return publicUrl ? safeHttpUrl(`${publicUrl.replace(/\/+$/, '')}/admin/tools`) : null
}

/** The note of the node join instructions: nodes never use the tunnel URL. */
export function nodesConnectText(publicUrl: string | null | undefined): string {
  return `Nodes connect to ${publicUrlText(publicUrl)}, never through the tunnel URL.`
}

/** The hint under the CLI snippets when SCANTOR_URL is the tunnel URL. */
export function tunnelCliText(publicUrl: string | null | undefined): string {
  return (
    'Through the tunnel URL the CLI and MCP clients reach the API; file, export and bundle downloads, including the test-run files of ' +
    `scantor dev run --remote, need SCANTOR_URL=${publicUrlText(publicUrl)}.`
  )
}
