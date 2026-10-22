defineRouteMeta({
  openAPI: {
    tags: ['editor'],
    operationId: 'createEditorSession',
    summary: 'Open the browser editor',
    description:
      'Starts your browser editor if it is stopped and returns a one-time URL on the editor origin (valid 60 s, single use) that signs the browser in to the editor. The response does not wait for the editor to become ready: `editor.state` is `starting` or `running`. `open` names one of your tasks whose folder the editor opens; without it the editor opens the workspace root. Session or `default` API key only: the editor\'s own API key gets 403. 404 for an unknown task; 429 when SCANTOR_EDITOR_MAX_RUNNING editors are already starting or running.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              open: {
                type: 'string',
                minLength: 1,
                maxLength: 64,
                pattern: '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$',
                description: 'name of one of your tasks; the editor opens its folder',
              },
            },
          },
        },
      },
    },
    responses: {
      201: { description: 'The one-time editor URL', content: { 'application/json': { schema: { $ref: '#/components/schemas/EditorSession' } } } },
      400: { description: 'Invalid body', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'The editor API key cannot open editor sessions', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'Unknown task', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'The editor is still stopping', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      429: { description: 'Too many editors are running', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { createEditorSessionBody } from '#shared/schemas/editor'
import type { EditorSession } from '#shared/types/editor'
import { useEditorRuntime } from '../../services/editor'
import { requireUser, resolveTask } from '../../utils/authz'
import { useConfig } from '../../utils/config'
import { isoDate, isoDateOrNull } from '../../utils/serialize'
import { validateBody } from '../../utils/zod'

export default defineEventHandler(async (event): Promise<EditorSession> => {
  const principal = requireUser(event, { editorKey: false })
  const body = await validateBody(event, createEditorSessionBody)
  // A name lookup never crosses users, not even for admins: the editor shows only the caller's workspace.
  const open = body.open ? (await resolveTask(principal, body.open)).name : null
  const runtime = useEditorRuntime()
  const editor = await runtime.manager.ensureStarted({ id: principal.user.id, email: principal.user.email })
  const { code, expiresAt } = runtime.codes.issue(principal.user.id, open)
  setResponseStatus(event, 201)
  return {
    url: `${useConfig().editorUrl}/_auth?code=${code}`,
    expiresAt: isoDate(expiresAt),
    editor: {
      state: editor.state === 'running' ? 'running' : 'starting',
      startedAt: isoDateOrNull(editor.startedAt),
      lastActivityAt: isoDateOrNull(editor.lastActivityAt),
    },
  }
})
