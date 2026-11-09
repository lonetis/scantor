defineRouteMeta({
  openAPI: {
    tags: ['scripts'],
    operationId: 'listScripts',
    summary: 'List scripts',
    description:
      'Lists your scripts, newest first. A script is a Python folder in your workspace (.scripts/<name>/ with scantor-script.yaml, Dockerfile, main.py) that evaluates the results and files of your scans on the master; it has no revisions, a run always uses the folder as it is when the run starts. Each item carries its cached workspace status, the config and result schemas its code last reported (describe) and its latest run. Filter with q (substring of name or description). Admins see every user’s scripts and may filter with userId. Page with cursor and limit. Use getScript for the newest runs of one script.',
    'x-scantor-scope': 'owner',
    'x-mcp': true,
    parameters: [
      { name: 'q', in: 'query', required: false, description: 'Case-insensitive substring of the name or description.', schema: { type: 'string', maxLength: 64 } },
      { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      { name: 'userId', in: 'query', required: false, description: 'Admins only: the owner to list.', schema: { type: 'string', format: 'uuid' } },
    ],
    responses: {
      200: {
        description: 'A page of scripts',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items', 'nextCursor'],
              properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Script' } }, nextCursor: { type: ['string', 'null'] } },
            },
          },
        },
      },
      400: { description: 'Invalid query', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'userId of another user without admin power', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    $global: {
      components: {
        schemas: {
          ScriptRunPointer: {
            type: 'object',
            description: 'The newest run of a script.',
            required: ['id', 'state', 'createdAt', 'finishedAt'],
            properties: {
              id: { type: 'string', format: 'uuid', description: 'the scriptRunId (getScriptRun)' },
              state: { type: 'string', enum: ['queued', 'building', 'running', 'completed', 'failed', 'cancelled'] },
              createdAt: { type: 'string', format: 'date-time' },
              finishedAt: { type: ['string', 'null'], format: 'date-time' },
            },
          },
          ScriptRunSummary: {
            type: 'object',
            description: 'A run of a script in recentRuns; getScriptRun returns the whole run with its result, errors, outputs and log tail.',
            required: ['id', 'state', 'createdAt', 'finishedAt', 'progress'],
            properties: {
              id: { type: 'string', format: 'uuid', description: 'the scriptRunId (getScriptRun)' },
              state: { type: 'string', enum: ['queued', 'building', 'running', 'completed', 'failed', 'cancelled'] },
              createdAt: { type: 'string', format: 'date-time' },
              finishedAt: { type: ['string', 'null'], format: 'date-time' },
              progress: {
                description: 'the last progress the script reported (ctx.progress)',
                anyOf: [
                  {
                    type: 'object',
                    required: ['done', 'total', 'message', 'updatedAt'],
                    properties: {
                      done: { type: 'number', minimum: 0 },
                      total: { type: ['number', 'null'] },
                      message: { type: ['string', 'null'] },
                      updatedAt: { type: 'string', format: 'date-time' },
                    },
                  },
                  { type: 'null' },
                ],
              },
            },
          },
          ScriptDescribe: {
            type: 'object',
            description:
              'The JSON Schemas the script code reported when a run started (its config model and its result model) for the folder content packSha256. The config schema applies to a new run while packSha256 equals workspace.packSha256.',
            required: ['packSha256', 'configSchema', 'resultSchema', 'at'],
            properties: {
              packSha256: { type: 'string' },
              configSchema: { type: ['object', 'null'], additionalProperties: true },
              resultSchema: { type: ['object', 'null'], additionalProperties: true },
              at: { type: 'string', format: 'date-time' },
            },
          },
          Script: {
            type: 'object',
            description:
              'A script: a folder .scripts/<name>/ in your workspace (manifest scantor-script.yaml, Dockerfile, entry main.py) identified by a name unique among your scripts. Scripts have no revisions: each run builds the folder as it is when the run starts.',
            required: ['id', 'userId', 'name', 'language', 'description', 'source', 'workspace', 'describe', 'latestRun', 'createdAt', 'updatedAt'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              userId: { type: 'string' },
              name: { type: 'string', description: 'slug, immutable; equals the manifest name' },
              language: { type: 'string', description: 'a language of listLanguages that supports scripts' },
              description: { type: ['string', 'null'] },
              source: {
                type: 'object',
                required: ['kind'],
                properties: { kind: { type: 'string', enum: ['scaffold', 'upload'], description: 'how the script was created' } },
              },
              workspace: {
                type: 'object',
                description: 'Cached status of the script folder, refreshed whenever a helper computes it.',
                required: ['packSha256', 'fileCount', 'bytes', 'checkedAt'],
                properties: {
                  packSha256: { type: ['string', 'null'], description: 'hash of the folder content a run would build' },
                  fileCount: { type: 'integer' },
                  bytes: { type: 'integer' },
                  checkedAt: { type: ['string', 'null'], format: 'date-time' },
                },
              },
              describe: { anyOf: [{ $ref: '#/components/schemas/ScriptDescribe' }, { type: 'null' }] },
              latestRun: { anyOf: [{ $ref: '#/components/schemas/ScriptRunPointer' }, { type: 'null' }] },
              recentRuns: {
                type: 'array',
                maxItems: 10,
                description: 'the newest runs, newest first (getScript and createScript only)',
                items: { $ref: '#/components/schemas/ScriptRunSummary' },
              },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  },
})

import { defineEventHandler } from 'h3'
import { listScriptsQuery } from '#shared/schemas/scripts'
import { listScripts } from '../../services/scripts'
import { requireUser } from '../../utils/authz'
import { validateQuery } from '../../utils/zod'

export default defineEventHandler(async (event) => {
  const principal = requireUser(event)
  const query = validateQuery(event, listScriptsQuery)
  return listScripts(principal, query)
})
