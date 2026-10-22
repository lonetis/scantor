defineRouteMeta({
  openAPI: {
    tags: ['catalog'],
    operationId: 'getAuthoringGuide',
    summary: 'Get the authoring guide of a language',
    description:
      'Returns the task authoring guide of a language (python, typescript, javascript or go) as Markdown: the task folder layout, the manifest, how to define the config and result types and the schedule and run functions with the connector, files, errors and retries, templates, testing and publishing. Read it before writing or changing task code.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [{ name: 'language', in: 'path', required: true, schema: { type: 'string', enum: ['python', 'typescript', 'javascript', 'go'] } }],
    responses: {
      200: { description: 'The guide', content: { 'text/markdown': { schema: { type: 'string' } } } },
      404: { description: 'No guide for this language', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseHeader } from 'h3'
import { languageParams } from '#shared/schemas/tasks'
import { requireUser } from '../../../utils/authz'
import { apiError } from '../../../utils/errors'
import { readGuide } from '../../../utils/guide-assets'
import { authoringGuide } from '../../../utils/guides'
import { validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  requireUser(event)
  const { language } = validateParams(event, languageParams)
  const guide = await authoringGuide(language, readGuide)
  if (guide === null) throw apiError('notFound', `no authoring guide for language ${language}`)
  setResponseHeader(event, 'content-type', 'text/markdown; charset=utf-8')
  return guide
})
