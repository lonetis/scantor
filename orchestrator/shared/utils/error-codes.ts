// The error-code table of docs/api.md §1.7: every code with its HTTP status and a short UI title. The server
// takes the status from here (server/utils/errors.ts apiError), the UI takes the title.

export const ERROR_CODES = {
  validationFailed: { status: 400, title: 'Invalid input' },
  badRequest: { status: 400, title: 'Bad request' },
  queryRejected: { status: 400, title: 'Query rejected' },
  passkeysDisabled: { status: 400, title: 'Passkeys are disabled' },
  unauthorized: { status: 401, title: 'Not signed in' },
  setupTokenInvalid: { status: 401, title: 'Invalid setup token' },
  forbidden: { status: 403, title: 'Not allowed' },
  adminRequired: { status: 403, title: 'Admin required' },
  sessionRequired: { status: 403, title: 'Browser session required' },
  banned: { status: 403, title: 'Account banned' },
  privilegedNotAllowed: { status: 403, title: 'Privileged tasks not allowed' },
  quotaExceeded: { status: 403, title: 'Storage quota exceeded' },
  notFound: { status: 404, title: 'Not found' },
  methodNotAllowed: { status: 405, title: 'Method not allowed' },
  invalidState: { status: 409, title: 'Not possible in the current state' },
  alreadyExists: { status: 409, title: 'Already exists' },
  workspaceDirty: { status: 409, title: 'Workspace has unpublished changes' },
  gitDiverged: { status: 409, title: 'Git history diverged' },
  taskInUse: { status: 409, title: 'Task is in use' },
  uploadInUse: { status: 409, title: 'Upload is in use' },
  revisionNotReady: { status: 409, title: 'Revision is not ready' },
  revisionUnavailable: { status: 409, title: 'Revision no longer exists' },
  nothingToRetry: { status: 409, title: 'Nothing to retry' },
  exportTooLarge: { status: 409, title: 'Export too large' },
  staleEpoch: { status: 409, title: 'Stale scheduler epoch' },
  nodeInstanceConflict: { status: 409, title: 'Node instance conflict' },
  builtInNode: { status: 409, title: 'Not allowed on the built-in node' },
  setupCompleted: { status: 409, title: 'Setup already completed' },
  lastCredential: { status: 409, title: 'Last credential' },
  payloadTooLarge: { status: 413, title: 'Payload too large' },
  unsupportedMediaType: { status: 415, title: 'Unsupported media type' },
  configInvalid: { status: 422, title: 'Configuration rejected' },
  confirmationRequired: { status: 422, title: 'Confirmation required' },
  scanTooLarge: { status: 422, title: 'Scan too large' },
  manifestInvalid: { status: 422, title: 'Invalid manifest' },
  invalidPath: { status: 422, title: 'Invalid path' },
  gitFailed: { status: 422, title: 'Git operation failed' },
  incompatibleVersion: { status: 426, title: 'Incompatible version' },
  tooManyRequests: { status: 429, title: 'Too many requests' },
  internal: { status: 500, title: 'Unexpected server error' },
  brokerAlarm: { status: 503, title: 'The message broker is out of resources' },
  unavailable: { status: 503, title: 'Service unavailable' },
  queryTimeout: { status: 504, title: 'Query timed out' },
} as const satisfies Record<string, { status: number; title: string }>

export type ErrorCode = keyof typeof ERROR_CODES

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_CODES, value)
}

export function errorStatus(code: ErrorCode): number {
  return ERROR_CODES[code].status
}

export function errorTitleFor(code: string): string {
  return isErrorCode(code) ? ERROR_CODES[code].title : 'Request failed'
}
