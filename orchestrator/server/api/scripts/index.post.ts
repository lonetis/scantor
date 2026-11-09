defineRouteMeta({
  openAPI: {
    tags: ['scripts'],
    operationId: 'createScript',
    summary: 'Create a script from the scaffold',
    description:
      'Creates a Python script and renders the script scaffold into your workspace (folder .scripts/<name>/): scantor-script.yaml, Dockerfile, requirements.txt, models.py (paste the Result model of the task whose results you evaluate) and a working main.py that streams the succeeded analyses of the first scan, counts them, reports progress, writes a CSV output and returns a summary. Next steps: read the scripts guide (getAuthoringGuide with language python and kind script, or the resource scantor://guide/scripts), edit the files (writeScriptFiles or the editor), then startScriptRun with settings.limit for a sample run before a full run. 409 alreadyExists when the name is taken (tasks and scripts may share a name); 400 for a reserved name (upload, import-git, new, latest).',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['name'],
            properties: {
              name: { type: 'string', pattern: '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$', description: 'slug unique among your scripts; immutable' },
              description: { type: 'string', maxLength: 1024 },
            },
          },
        },
      },
    },
    responses: {
      201: { description: 'The script (recentRuns is empty)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Script' } } } },
      400: { description: 'Invalid input', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'Name taken', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      413: { description: 'The workspace is full', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      503: { description: 'No workspace helper slot became free', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseStatus } from 'h3'
import { createScriptBody } from '#shared/schemas/scripts'
import { createScript } from '../../services/scripts'
import { requireUser } from '../../utils/authz'
import { validateBody } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const body = await validateBody(event, createScriptBody)
  const script = await createScript(principal, body)
  setResponseStatus(event, 201)
  return script
})
