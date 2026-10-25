import type { Server } from 'node:http'
import { defineNitroPlugin } from 'nitropack/runtime'
import { useEditorRuntime } from '../services/editor'
import { closeEditorServer, createEditorServer, EDITOR_LISTENER_PORT, listenEditorServer } from '../services/editor/listener'
import { registerComponentTask } from '../utils/boot'
import { proxyTrust } from '../utils/trusted-proxy'

// The editor origin (docs/editor.md §8.1, security.md ED-1): a dedicated HTTP listener on container port 3001 that
// serves `/_auth` and the HTTP + WebSocket relay to the users' code-server sockets. It runs where the `api` component
// runs (the one-time codes it redeems live in that process) and starts with the components, after boot.

const MINUTE_MS = 60_000

export default defineNitroPlugin(() => {
  let server: Server | null = null
  let timers: NodeJS.Timeout[] = []

  registerComponentTask({
    component: 'api',
    name: 'editor-listener',
    async start({ config, log }) {
      const runtime = useEditorRuntime()
      const listener = createEditorServer({
        editorUrl: config.editorUrl,
        publicUrl: config.publicUrl,
        isTrustedProxy: proxyTrust(),
        sessions: runtime.sessions,
        proxy: runtime.proxy,
        limiter: runtime.limiter,
        log,
      })
      await listenEditorServer(listener, EDITOR_LISTENER_PORT, { retryAddressInUseMs: import.meta.dev ? 10_000 : 0, log })
      server = listener
      timers = [
        setInterval(() => {
          runtime.codes.sweep()
          runtime.limiter.sweep()
        }, MINUTE_MS),
        // Open WebSockets keep an editor alive (docs/editor.md §6.4).
        setInterval(() => runtime.activity.heartbeat(runtime.proxy.usersWithOpenWebSockets()), MINUTE_MS),
      ]
      for (const timer of timers) timer.unref()
      log.info('editor listener started', { port: EDITOR_LISTENER_PORT, editorUrl: config.editorUrl })
    },
    async stop() {
      for (const timer of timers) clearInterval(timer)
      timers = []
      useEditorRuntime().proxy.closeAll()
      if (server) await closeEditorServer(server)
      server = null
    },
  })
})
