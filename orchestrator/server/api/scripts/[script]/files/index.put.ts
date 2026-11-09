defineRouteMeta({
  openAPI: {
    tags: ['script-files'],
    operationId: 'writeScriptFiles',
    summary: 'Write script files',
    description:
      'Creates or overwrites up to 200 files in a script folder (.scripts/<name>/ in your workspace) in one call: files maps a relative path to UTF-8 text or {base64}. Parent folders are created. Paths must be relative, /-separated, without .. or backslashes (422 invalidPath). Returns the written paths and the new folder hash (workspace.packSha256). The change takes effect with the next run: startScriptRun builds the folder as it is then (use settings.limit for a quick sample run). 413 when the script folder or workspace caps are exceeded.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [{ name: 'script', in: 'path', required: true, description: 'Script id or one of your script names.', schema: { type: 'string', maxLength: 64 } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['files'],
            properties: {
              files: {
                type: 'object',
                minProperties: 1,
                maxProperties: 200,
                description: 'path → UTF-8 text, or {"base64": "<data>"} for binary content',
                additionalProperties: {
                  anyOf: [
                    { type: 'string' },
                    { type: 'object', additionalProperties: false, required: ['base64'], properties: { base64: { type: 'string', contentEncoding: 'base64' } } },
                  ],
                },
              },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Written',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['written', 'workspace'],
              properties: {
                written: { type: 'array', items: { type: 'string' } },
                workspace: { type: 'object', required: ['packSha256'], properties: { packSha256: { type: 'string' } } },
              },
            },
          },
        },
      },
      404: { description: 'No such script', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      413: { description: 'Caps exceeded', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      422: { description: 'Invalid path', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { scriptParams, writeScriptFilesBody } from '#shared/schemas/scripts'
import { writeScriptFiles } from '../../../../services/scripts/files'
import { requireUser, resolveScript } from '../../../../utils/authz'
import { validateBody, validateParams } from '../../../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const { script } = validateParams(event, scriptParams)
  const body = await validateBody(event, writeScriptFilesBody)
  return writeScriptFiles(await resolveScript(principal, script), body.files)
})
