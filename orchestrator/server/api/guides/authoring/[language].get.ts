defineRouteMeta({
  openAPI: {
    tags: ['catalog'],
    operationId: 'getAuthoringGuide',
    summary: 'Get the authoring guide of a language',
    description:
      'Returns an authoring guide of a language as Markdown. kind task (default; python, typescript, javascript or go): the task folder layout, the manifest, how to define the config and result types and the schedule and run functions with the connector, files, errors and retries, templates, testing and publishing. kind script (python only): the scripts guide, how a script streams the analyses of scans with scantor.script, writes outputs, reports progress, checkpoints and resumes. Read it before writing or changing task or script code.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      { name: 'language', in: 'path', required: true, schema: { type: 'string', enum: ['python', 'typescript', 'javascript', 'go'] } },
      {
        name: 'kind',
        in: 'query',
        required: false,
        description: 'task: the task authoring guide; script: the scripts guide (languages with script support only).',
        schema: { type: 'string', enum: ['task', 'script'], default: 'task' },
      },
    ],
    responses: {
      200: { description: 'The guide', content: { 'text/markdown': { schema: { type: 'string' } } } },
      404: { description: 'No guide of this kind for this language', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseHeader } from 'h3'
import { authoringGuideQuery, languageParams } from '#shared/schemas/tasks'
import { requireUser } from '../../../utils/authz'
import { apiError } from '../../../utils/errors'
import { readGuide } from '../../../utils/guide-assets'
import { authoringGuide } from '../../../utils/guides'
import { validateParams, validateQuery } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  requireUser(event)
  const { language } = validateParams(event, languageParams)
  const { kind } = validateQuery(event, authoringGuideQuery)
  const guide = await authoringGuide(language, readGuide, kind)
  if (guide === null)
    throw apiError('notFound', kind === 'script' ? `no scripts guide for language ${language}` : `no authoring guide for language ${language}`)
  setResponseHeader(event, 'content-type', 'text/markdown; charset=utf-8')
  return guide
})
