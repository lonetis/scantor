defineRouteMeta({
  openAPI: {
    tags: ['catalog'],
    operationId: 'getTemplate',
    summary: 'Get a template',
    description: 'Returns one schedule template by name with the JSON Schemas of its scan config and analysis config and an example.',
    'x-scantor-scope': 'owner',
    'x-mcp': false,
    parameters: [{ name: 'template', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z][a-z0-9]{0,31}$' } }],
    responses: {
      200: { description: 'The template', content: { 'application/json': { schema: { $ref: '#/components/schemas/Template' } } } },
      404: { description: 'No such template', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
})

import { defineEventHandler } from 'h3'
import { templateParams } from '#shared/schemas/tasks'
import { findTemplate } from '../../../services/catalog/templates'
import { requireUser } from '../../../utils/authz'
import { apiError } from '../../../utils/errors'
import { validateParams } from '../../../utils/zod'

export default defineEventHandler(async (event) => {
  requireUser(event)
  const { template } = validateParams(event, templateParams)
  const found = await findTemplate(template)
  if (!found) throw apiError('notFound', `template ${template} not found`)
  return found
})
