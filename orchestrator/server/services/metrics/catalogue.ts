import { MetricsRegistry } from './registry'

/*
 * The metric catalogue of docs/deployment.md §13.1 (also named by docs/queue.md §6.11). Every metric of the
 * orchestrator is declared here, once. Counters and histograms are updated in-process by their owners; gauges
 * derived from MongoDB, the RabbitMQ management API and process state are refreshed at scrape time by
 * server/services/metrics/collect.ts. Other areas record through the helpers at the bottom.
 */

export const metricsRegistry = new MetricsRegistry()
const m = metricsRegistry

export const buildInfo = m.gauge('scantor_build_info', 'Always 1; the orchestrator version as label', ['version'])
export const scansByState = m.gauge('scantor_scans', 'Scans by state', ['state'])
export const scanQueueMessages = m.gauge(
  'scantor_scan_queue_messages',
  'Messages of each scan queue by state, from the RabbitMQ management API (refreshed every 15 s)',
  ['scanId', 'state'],
)
export const ingestMessages = m.counter('scantor_ingest_messages_total', 'Ingested messages by kind and outcome', ['kind', 'outcome'])
export const ingestLag = m.gauge('scantor_ingest_lag_messages', 'Ready messages of scantor.results.ingest')
export const ingestFlushSeconds = m.histogram('scantor_ingest_flush_seconds', 'Duration of one ingest batch flush')
export const ingestBatchSize = m.histogram('scantor_ingest_batch_size', 'Messages per ingest batch', [], [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000])
export const ingestWholeBatchFailures = m.counter(
  'scantor_ingest_whole_batch_failures_total',
  'Batches nacked and retried after a transient MongoDB failure',
)
export const ingestWriteFailed = m.counter(
  'scantor_ingest_write_failed_total',
  'Analysis writes that failed even in the follow-up write; acked and logged',
)
export const deadLetters = m.counter('scantor_dead_letters_total', 'Messages handled by the dead-letter consumer', ['source', 'reason'])
export const breakerTrips = m.counter('scantor_breaker_trips_total', 'Scans paused by the failure-rate breaker')
export const analysesCompleted = m.counter('scantor_analyses_completed_total', 'Terminal analyses written', ['status'])
export const workersByState = m.gauge('scantor_workers', 'Workers by state and role', ['state', 'role'])
export const nodesByState = m.gauge('scantor_nodes', 'Nodes by state', ['state'])
export const nodeHeartbeatAge = m.gauge('scantor_node_heartbeat_age_seconds', 'Seconds since the last status of each node', ['node'])
export const nodeDiskFree = m.gauge('scantor_node_disk_free_bytes', 'Free disk reported by each node', ['node'])
export const nodeWorkersCapacity = m.gauge('scantor_node_workers_capacity', 'Worker capacity of each node', ['node'])
export const rabbitmqAlarm = m.gauge('scantor_rabbitmq_alarm', '1 while a RabbitMQ resource alarm is active', ['type'])
export const jobsByKindAndState = m.gauge('scantor_jobs', 'Background jobs by kind and state', ['kind', 'state'])
export const editorsByState = m.gauge('scantor_editors', 'Editor containers by state', ['state'])
export const helpersRunning = m.gauge('scantor_helpers_running', 'Workspace helpers in flight')
export const helperDuration = m.histogram('scantor_helper_duration_seconds', 'Workspace helper runs', ['op', 'outcome'])
export const httpRequests = m.counter('scantor_http_requests_total', 'API requests by method, route pattern and status', [
  'method',
  'route',
  'status',
])
export const httpRequestDuration = m.histogram('scantor_http_request_duration_seconds', 'API latency by method and route pattern', [
  'method',
  'route',
])
export const registryGcLastSuccessTimestamp = m.gauge(
  'scantor_registry_gc_last_success_timestamp_seconds',
  'Unix time of the last successful registry garbage collection',
)

// ── recording helpers for other areas ──────────────────────────────────────

/** Terminal analyses written outside the ingestor (stall gap fill → lost, cancel → cancelled). */
export function recordAnalysesCompleted(status: string, count = 1): void {
  if (count > 0) analysesCompleted.inc({ status }, count)
}

/** The workspace helper runner reports its in-flight count and every finished run (docs/deployment.md §13.1). */
export function setHelpersRunning(count: number): void {
  helpersRunning.set(undefined, count)
}

export function observeHelperRun(op: string, outcome: 'ok' | 'error' | 'timeout' | (string & {}), seconds: number): void {
  helperDuration.observe({ op, outcome }, seconds)
}
