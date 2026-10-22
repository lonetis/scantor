import { useConfig } from '../../utils/config'
import { useDocker } from '../../utils/docker'
import { useKeys } from '../../utils/keys'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { getCachedUser, isUserBanned } from '../../utils/user-cache'
import { ensureUserDirs } from '../helpers'
import { EditorActivity } from './activity'
import { EditorCodeStore, FailureLimiter } from './codes'
import { dockerEditorOperations } from './container'
import { betterAuthEditorKeys } from './keys'
import { EditorManager } from './manager'
import { EditorProxy } from './proxy'
import { EditorReaper } from './reaper'
import { EditorSessions } from './sessions'
import { connectEditorSocket, prepareSocketDirectory, removeSocketFile } from './socket'

/*
 * The editor area's process-wide objects (docs/editor.md §6–§8), wired once from the configuration:
 *
 *   codes      one-time handoff codes (createEditorSession issues, the editor listener redeems)
 *   sessions   `scantor_editor` cookie validation with the user and editor-state caches
 *   proxy      per-user HTTP agents and WebSocket relays to code-server's socket
 *   activity   throttled `editors.lastActivityAt` writes for the idle reaper
 *   manager    the editors state machine (start, stop, purge)
 *   reaper     idle, key-expiry, stuck-state and orphan sweeps
 *
 * Routes (server/api/editor), the editor listener (server/plugins/20.editor-listener.ts) and the reconciler tasks
 * (server/plugins/70.editor.ts) share them through useEditorRuntime().
 */

export interface EditorRuntime {
  codes: EditorCodeStore
  limiter: FailureLimiter
  sessions: EditorSessions
  proxy: EditorProxy
  activity: EditorActivity
  manager: EditorManager
  reaper: EditorReaper
}

let runtime: EditorRuntime | null = null

export function useEditorRuntime(): EditorRuntime {
  if (runtime) return runtime
  const config = useConfig()
  const { editors, authApiKeys } = useCollections()
  const log = useLogger('editor')
  const keyring = useKeys()

  const codes = new EditorCodeStore()
  const sessions = new EditorSessions({
    sign: (userId, editorStartedAtMs, expiresAtMs) => keyring.editorCookie(userId, editorStartedAtMs, expiresAtMs),
    getUser: (userId) => getCachedUser(userId),
    isBanned: (user) => isUserBanned(user),
    loadEditor: (userId) => editors.findOne({ _id: userId }, { projection: { state: 1, startedAt: 1 } }),
    codes,
  })
  const activity = new EditorActivity(async (userId, at) => {
    await editors.updateOne({ _id: userId, state: 'running' }, { $set: { lastActivityAt: at } })
  }, log)
  const proxy = new EditorProxy({
    connect: (userId) => connectEditorSocket(userId),
    security: { dashboardOrigin: new URL(config.publicUrl).origin, https: new URL(config.editorUrl).protocol === 'https:' },
    dashboardUrl: config.publicUrl,
    onRequest: (userId) => activity.touch(userId),
    log,
  })
  const docker = dockerEditorOperations(useDocker())
  const keys = betterAuthEditorKeys(authApiKeys, config.editorApiKeyTtlMs)
  const manager = new EditorManager({
    editors,
    config,
    docker,
    keys,
    sockets: {
      prepare: (userId) => prepareSocketDirectory(userId),
      remove: (userId) => removeSocketFile(userId),
      connect: (userId) => connectEditorSocket(userId),
    },
    ensureUserDirs,
    hooks: {
      onStateChanged: (userId) => sessions.invalidate(userId),
      onTeardown: (userId) => {
        proxy.closeUser(userId)
        codes.revokeUser(userId)
        activity.forget(userId)
        sessions.invalidate(userId)
      },
    },
    log,
  })
  const reaper = new EditorReaper({ editors, docker, keys, manager, config, log: log.child({ task: 'editor-reaper' }) })
  runtime = { codes, limiter: new FailureLimiter(), sessions, proxy, activity, manager, reaper }
  return runtime
}

/** Test seam: replaces (or with null resets) the runtime. */
export function setEditorRuntimeForTesting(next: EditorRuntime | null): void {
  runtime = next
}
