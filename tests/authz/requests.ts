import type { PathParams, QueryParams } from '../helpers/api-client'
import { GIT_REPOS } from '../helpers/fixtures-server'

// The parameter map and the request factories of the authorization matrix (docs/testing.md §8.5, docs/security.md §7):
// a value for every path parameter name and, per operationId, a minimal valid request that addresses or references
// the given resources (A's seeded ids, or throwaway copies for destructive operations). matrix.spec.ts fails for an
// operation of the OpenAPI document without an entry here, so a new route cannot skip the matrix: add its factory
// (docs/development.md §9.1, CLAUDE.md "When you change X").

/** The resources a request addresses: A's seeded ids by default, throwaway copies for destructive cases. */
export interface Ids {
  task: string
  revision: string
  scanId: string
  analysisId: string
  fileId: string
  testRunId: string
  testRunFileId: string
  exportId: string
  uploadId: string
  credentialId: string
  keyId: string
  clientId: string
  jobId: string
  workerId: string
  userId: string
  nodeId: string
  template: string
  language: string
  guide: string
  /** git credential host of the fixtures server */
  gitHost: string
  /** scantor version for the machine APIs (X-Scantor-Version, hello) */
  version: string
  /** node identity for the node API */
  instanceId: string
}

export interface RequestSpec {
  path?: PathParams
  query?: QueryParams
  /** JSON body, or a Buffer with its Content-Type in `headers` */
  body?: unknown
  headers?: Record<string, string>
}

export interface OperationRequests {
  /** a minimal valid request addressing or referencing `ids` */
  valid(ids: Ids): RequestSpec
  /**
   * A side-effect-free variant for principals that may call the operation: it passes the scope checks and then fails
   * validation (or is a no-op), so the "ok" checks of the owner and the admin never create, start or change anything.
   * Absent when `valid` is itself free of side effects or acts only on throwaway copies.
   */
  safe?(ids: Ids): RequestSpec
  /** the body references owned documents (revision, upload, credential): docs/security.md §7 "create references" */
  bodyRefs?: true
}

/** Path parameters that name a resource owned by a user (another user's value is 404, never 403). */
export const OWNED_PARAMS = new Set([
  'task',
  'revision',
  'scanId',
  'analysisId',
  'fileId',
  'testRunId',
  'exportId',
  'uploadId',
  'credentialId',
  'keyId',
  'clientId',
  'jobId',
  'workerId',
])

/** A value for every path parameter name of the document. */
export const PARAMS: Record<string, (ids: Ids) => string> = {
  task: (ids) => ids.task,
  revision: (ids) => ids.revision,
  scanId: (ids) => ids.scanId,
  analysisId: (ids) => ids.analysisId,
  fileId: (ids) => ids.fileId,
  testRunId: (ids) => ids.testRunId,
  exportId: (ids) => ids.exportId,
  uploadId: (ids) => ids.uploadId,
  credentialId: (ids) => ids.credentialId,
  keyId: (ids) => ids.keyId,
  clientId: (ids) => ids.clientId,
  jobId: (ids) => ids.jobId,
  workerId: (ids) => ids.workerId,
  userId: (ids) => ids.userId,
  nodeId: (ids) => ids.nodeId,
  template: (ids) => ids.template,
  language: (ids) => ids.language,
  guide: (ids) => ids.guide,
}

const SMALL = { workers: 1, processes: 1, resources: { cpus: 0.25, memoryMiB: 256 } }
/** `wait` above its maximum: 400 validationFailed after every scope check, without side effects. */
const BAD_WAIT = { wait: 999 }
const none = (): RequestSpec => ({})
const machine = (ids: Ids) => ({ 'X-Scantor-Version': ids.version, 'User-Agent': `scantor-node/${ids.version}` })
const capacity = { cpus: 1, memoryBytes: 1073741824, diskFreeBytes: 107374182400, dindMode: 'disabled', maxWorkers: 1, egressDenyApplied: true }
/** `info` of postNodeStatus: the capacity and the daemon version. */
const nodeInfo = (ids: Ids) => ({ version: ids.version, ...capacity })
const scantorError = { type: 'taskError', message: 'authz matrix', retryable: false, phase: 'run', attempt: 1, at: new Date(0).toISOString() }

export const REQUESTS: Record<string, OperationRequests> = {
  // ── public, setup, tools ──────────────────────────────────────────────────────────────────────────
  getHealth: { valid: none },
  getSetupStatus: { valid: none },
  createSetupAdmin: { valid: () => ({ body: { email: 'authz-setup@scantor.test', name: 'authz setup', password: 'authz-setup-password-0' } }) },
  createSetupPasskeyToken: { valid: () => ({ body: { email: 'authz-setup@scantor.test', name: 'authz setup' } }) },
  toolsForwardAuth: {
    valid: (ids) => ({ headers: { 'X-Forwarded-Host': `rabbitmq.${ids.gitHost.replace(/^git\./, '')}`, 'X-Forwarded-Uri': '/', 'X-Forwarded-Method': 'GET' } }),
  },

  // ── instance and account (caller-scoped) ──────────────────────────────────────────────────────────
  getInstanceInfo: { valid: none },
  getMetrics: { valid: none },
  getAccount: { valid: none },
  updateAccount: { valid: () => ({ body: { name: 'authz matrix' } }), safe: () => ({ body: { name: '' } }) },
  setAccountPassword: { valid: () => ({ body: { newPassword: 'authz-matrix-password-1' } }), safe: () => ({ body: { newPassword: 'x' } }) },
  removeAccountPassword: { valid: none },
  listApiKeys: { valid: none },
  createApiKey: { valid: () => ({ body: { name: 'authz-matrix', expiresInDays: 1 } }), safe: () => ({ body: { name: '' } }) },
  deleteApiKey: { valid: none },
  listOAuthApps: { valid: none },
  revokeOAuthApp: { valid: none },
  createToolsSession: { valid: () => ({ query: { target: 'rabbitmq' } }) },

  // ── catalog ───────────────────────────────────────────────────────────────────────────────────────
  listLanguages: { valid: none },
  listScaffolds: { valid: none },
  listTemplates: { valid: none },
  getTemplate: { valid: none },
  estimateTemplate: { valid: (ids) => ({ body: { scanConfig: { upload: ids.uploadId } } }), bodyRefs: true },
  getGuide: { valid: none },
  getAuthoringGuide: { valid: none },

  // ── credentials ───────────────────────────────────────────────────────────────────────────────────
  listCredentials: { valid: none },
  createCredential: {
    valid: (ids) => ({ body: { kind: 'gitToken', name: 'authz-matrix', host: ids.gitHost, username: 'authz', token: 'authz-token' } }),
    safe: (ids) => ({ body: { kind: 'gitToken', name: '', host: ids.gitHost, username: 'authz', token: 'authz-token' } }),
  },
  updateCredential: { valid: () => ({ body: { name: 'authz-renamed' } }) },
  deleteCredential: { valid: none },

  // ── tasks, files, git ─────────────────────────────────────────────────────────────────────────────
  listTasks: { valid: none },
  createTask: { valid: () => ({ body: { name: 'authz-matrix-task', language: 'python' } }), safe: () => ({ body: { name: 'new', language: 'python' } }) },
  uploadTask: {
    // An empty gzip stream: never a valid task folder.
    valid: () => ({
      body: Buffer.from('1f8b0800000000000003030000000000000000', 'hex'),
      headers: { 'Content-Type': 'application/gzip' },
      query: { publish: false },
    }),
    safe: () => ({ body: Buffer.from('1f8b0800000000000003030000000000000000', 'hex'), headers: { 'Content-Type': 'application/gzip' }, query: BAD_WAIT }),
  },
  importGitTask: {
    valid: (ids) => ({ body: { url: GIT_REPOS.private, credentialId: ids.credentialId } }),
    safe: (ids) => ({ body: { url: 'ext::sh -c touch% /tmp/pwned', credentialId: ids.credentialId } }),
    bodyRefs: true,
  },
  getTask: { valid: none },
  deleteTask: { valid: none },
  getTaskWorkspace: { valid: none },
  downloadTaskWorkspace: { valid: none },
  listTaskFiles: { valid: () => ({ query: { recursive: true } }) },
  readTaskFile: { valid: () => ({ query: { path: 'scantor.yaml' } }) },
  writeTaskFiles: { valid: () => ({ body: { files: { 'authz-notes.txt': 'written by the authorization matrix\n' } } }) },
  deleteTaskFile: { valid: () => ({ query: { path: 'scantor.yaml' } }) },
  pullGitTask: { valid: () => ({ body: {} }) },

  // ── revisions and test runs ───────────────────────────────────────────────────────────────────────
  listRevisions: { valid: none },
  publishRevision: { valid: () => ({ body: { message: 'authz matrix' } }), safe: () => ({ body: {}, query: BAD_WAIT }) },
  getRevision: { valid: none },
  getRevisionBuildLog: { valid: none },
  downloadRevisionSource: { valid: none },
  listTestRuns: { valid: none },
  testTask: { valid: () => ({ body: { scanConfig: { items: ['authz-matrix'] }, limit: 1 } }), safe: () => ({ body: {}, query: BAD_WAIT }) },
  getTestRun: { valid: () => ({ query: { analyses: true } }) },
  cancelTestRun: { valid: none },
  getTestRunFileDownload: { valid: (ids) => ({ path: { fileId: ids.testRunFileId } }) },
  streamTestRun: { valid: none },

  // ── uploads ───────────────────────────────────────────────────────────────────────────────────────
  listUploads: { valid: none },
  createUpload: {
    valid: () => ({ body: Buffer.from('authz.example\n'), headers: { 'Content-Type': 'text/plain' }, query: { name: 'authz-matrix.txt', kind: 'list' } }),
    safe: () => ({ body: Buffer.from('authz.example\n'), headers: { 'Content-Type': 'text/plain' }, query: { name: 'authz-matrix.txt', kind: 'bogus' } }),
  },
  getUpload: { valid: none },
  deleteUpload: { valid: none },

  // ── scans, analyses, exports, jobs ────────────────────────────────────────────────────────────────
  listScans: { valid: none },
  startScan: {
    valid: (ids) => ({ body: { revision: ids.revision, scanConfig: { items: ['authz-matrix'] }, settings: SMALL } }),
    safe: (ids) => ({ body: { revision: ids.revision, settings: { ...SMALL, workers: 0 } } }),
    bodyRefs: true,
  },
  getScan: { valid: none },
  deleteScan: { valid: none },
  pauseScan: { valid: none },
  resumeScan: { valid: none },
  cancelScan: { valid: none },
  restartScan: { valid: () => ({ body: { name: 'authz-matrix-restart' } }), safe: () => ({ body: { settings: { workers: 0 } } }) },
  scaleScan: { valid: () => ({ body: { workers: 1 } }) },
  retryFailedAnalyses: { valid: none },
  listScanConditions: { valid: none },
  listScanEvents: { valid: none },
  listInflightAnalyses: { valid: none },
  listScanWorkers: { valid: none },
  getWorkerLogs: { valid: () => ({ query: { wait: 0 } }) },
  listAnalyses: { valid: none },
  queryAnalyses: { valid: () => ({ body: { filter: {}, limit: 1 } }) },
  aggregateAnalyses: { valid: () => ({ body: { pipeline: [{ $count: 'n' }] } }) },
  exportScanInline: { valid: () => ({ query: { format: 'jsonl' } }) },
  exportScan: { valid: () => ({ body: { format: 'jsonl' } }), safe: () => ({ body: { format: 'jsonl' }, query: BAD_WAIT }) },
  getAnalysis: { valid: none },
  getFileDownload: { valid: none },
  listExports: { valid: none },
  getExport: { valid: none },
  deleteExport: { valid: none },
  listJobs: { valid: none },
  getJob: { valid: none },

  // ── editor (always the caller's own) ──────────────────────────────────────────────────────────────
  getEditor: { valid: none },
  createEditorSession: { valid: () => ({ body: {} }), safe: () => ({ body: { open: 'new' } }) },
  stopEditor: { valid: none },

  // ── users and nodes (admin) ───────────────────────────────────────────────────────────────────────
  listUsers: { valid: none },
  createUser: {
    valid: () => ({ body: { email: 'authz-matrix-user@scantor.test', name: 'authz matrix', password: 'authz-matrix-password-2' } }),
    safe: () => ({ body: { email: 'not-an-email', name: 'authz matrix', password: 'authz-matrix-password-2' } }),
  },
  getUser: { valid: none },
  updateUser: { valid: () => ({ body: { name: 'authz matrix renamed' } }) },
  setUserPassword: { valid: () => ({ body: { password: 'authz-matrix-password-3' } }) },
  banUser: { valid: () => ({ body: { reason: 'authz matrix', cancelScans: false } }) },
  unbanUser: { valid: none },
  deleteUser: { valid: none },
  listNodes: { valid: none },
  createNode: { valid: () => ({ body: { name: 'authz-matrix-node', pool: 'authz-matrix' } }), safe: () => ({ body: { name: '' } }) },
  getNode: { valid: none },
  updateNode: { valid: () => ({ body: { cordoned: true } }) },
  getNodeJoin: { valid: none },
  rotateNodeToken: { valid: none },
  revokeNodeToken: { valid: none },
  deleteNode: { valid: none },
  listNodeWorkers: { valid: none },
  listNodeEvents: { valid: none },

  // ── node API ──────────────────────────────────────────────────────────────────────────────────────
  nodeHello: {
    valid: (ids) => ({
      headers: machine(ids),
      body: {
        instanceId: ids.instanceId,
        version: ids.version,
        info: { hostname: 'authz-matrix', os: 'linux', arch: 'amd64', kernel: '6.0.0', dockerVersion: '29.9.2', ...capacity },
      },
    }),
  },
  getNodeAssignments: { valid: (ids) => ({ headers: { ...machine(ids), 'X-Scantor-Instance-Id': ids.instanceId }, query: { wait: 0 } }) },
  postNodeStatus: {
    valid: (ids) => ({
      headers: { ...machine(ids), 'X-Scantor-Instance-Id': ids.instanceId },
      body: {
        instanceId: ids.instanceId,
        appliedRev: 0,
        clockOffsetMs: 0,
        info: nodeInfo(ids),
        workers: [{ workerId: ids.workerId, state: 'running', containerId: 'authzmatrix0', restarts: 0 }],
      },
    }),
  },
  postWorkerLogs: {
    valid: (ids) => ({
      headers: { ...machine(ids), 'X-Scantor-Instance-Id': ids.instanceId },
      body: { requestId: '00000000-0000-4000-8000-000000000000', text: 'authz matrix\n', bytes: 13, truncated: false, collectedAt: new Date(0).toISOString() },
    }),
  },
  getRegistryToken: { valid: (ids) => ({ query: { service: 'scantor-registry', scope: `repository:tasks/${ids.task}:pull` } }) },
  createRegistryToken: {
    valid: (ids) => ({
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: Buffer.from(
        new URLSearchParams({
          grant_type: 'password',
          service: 'scantor-registry',
          username: 'node',
          password: 'snt_invalid',
          scope: `repository:tasks/${ids.task}:pull`,
        }).toString(),
      ),
    }),
  },

  // ── runtime API (worker tokens) ───────────────────────────────────────────────────────────────────
  runtimeBootstrap: { valid: (ids) => ({ headers: { 'X-Scantor-Version': ids.version } }) },
  runtimeState: {
    valid: (ids) => ({
      headers: { 'X-Scantor-Version': ids.version },
      body: { processes: { running: 1, busy: 0 }, busy: [], consuming: false, clockOffsetMs: 0, tmpFreeBytes: 1073741824 },
    }),
  },
  runtimePresignUploads: {
    valid: (ids) => ({
      headers: { 'X-Scantor-Version': ids.version },
      body: {
        seq: 0,
        round: 1,
        attempt: 1,
        executionId: '00000000-0000-4000-8000-000000000001',
        files: [{ name: 'authz.txt', size: 5, contentType: 'text/plain' }],
      },
    }),
  },
  runtimeAnalysesStatus: { valid: (ids) => ({ headers: { 'X-Scantor-Version': ids.version }, body: { seqs: [0] } }) },
  runtimeReportError: { valid: (ids) => ({ headers: { 'X-Scantor-Version': ids.version }, body: { fatal: false, error: scantorError } }) },
  schedulerResolved: {
    valid: (ids) => ({
      headers: { 'X-Scantor-Version': ids.version },
      body: { epoch: 0, key: 'authz', template: 'list', scanConfig: {}, provenance: {}, expectedTotal: 1 },
    }),
  },
  schedulerCheckpoint: { valid: (ids) => ({ headers: { 'X-Scantor-Version': ids.version }, body: { epoch: 0, confirmed: 0, tailHash: null } }) },
  schedulerDone: { valid: (ids) => ({ headers: { 'X-Scantor-Version': ids.version }, body: { epoch: 0, outcome: 'done', confirmed: 0, tailHash: null } }) },
}
