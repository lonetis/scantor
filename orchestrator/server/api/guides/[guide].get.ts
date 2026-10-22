defineRouteMeta({
  openAPI: {
    tags: ['catalog'],
    operationId: 'getGuide',
    summary: 'Get a user guide',
    description: 'Returns a user guide as Markdown: templates, manifest, errors-and-retries, cli, mcp or remote-nodes.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [
      { name: 'guide', in: 'path', required: true, schema: { type: 'string', enum: ['templates', 'manifest', 'errors-and-retries', 'cli', 'mcp', 'remote-nodes'] } },
    ],
    responses: {
      200: { description: 'The guide', content: { 'text/markdown': { schema: { type: 'string' } } } },
      404: { description: 'No such guide', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler, setResponseHeader } from 'h3'
import { guideParams } from '#shared/schemas/tasks'
import { requireUser } from '../../utils/authz'
import { apiError } from '../../utils/errors'
import { readGuide } from '../../utils/guide-assets'
import { namedGuide } from '../../utils/guides'
import { validateParams } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  requireUser(event)
  const { guide } = validateParams(event, guideParams)
  const text = await namedGuide(guide, readGuide)
  if (text === null) throw apiError('notFound', `no guide named ${guide}`)
  setResponseHeader(event, 'content-type', 'text/markdown; charset=utf-8')
  return text
})
