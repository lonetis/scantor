package api

import "encoding/json"

// Wire types of the runtime API (/api/runtime/*, docs/api.md §8).

// Runtime actions returned by bootstrap and state polls.
const (
	ActionRun   = "run"
	ActionDrain = "drain"
	ActionStop  = "stop"
)

// Worker roles.
const (
	RoleScheduler = "scheduler"
	RoleRunner    = "runner"
)

// BootstrapWorker is the worker identity of a bootstrap.
type BootstrapWorker struct {
	ID     string `json:"id"`
	Role   string `json:"role"`
	ScanID string `json:"scanId"`
	NodeID string `json:"nodeId"`
	Epoch  int    `json:"epoch"`
}

// RuntimeSettings are the scan settings a runtime needs.
type RuntimeSettings struct {
	Processes             int       `json:"processes"`
	TimeoutMs             int64     `json:"timeoutMs"`
	MaxAttempts           int       `json:"maxAttempts"`
	Backoff               Backoff   `json:"backoff"`
	Resources             Resources `json:"resources"`
	MaxAnalysesPerProcess int       `json:"maxAnalysesPerProcess"`
}

// BootstrapScan is the scan part of a bootstrap. ScanConfig is absent for runners. Configs carry
// secrets in plaintext.
type BootstrapScan struct {
	ID         string          `json:"id"`
	State      string          `json:"state"`
	Round      int             `json:"round"`
	TaskConfig json.RawMessage `json:"taskConfig"`
	ScanConfig json.RawMessage `json:"scanConfig,omitempty"`
	Settings   RuntimeSettings `json:"settings"`
}

// BootstrapRevision is the revision part of a bootstrap; Entry is the normalised manifest entry.
type BootstrapRevision struct {
	ID              string   `json:"id"`
	Number          int      `json:"number"`
	Entry           string   `json:"entry"`
	ProtocolVersion int      `json:"protocolVersion"`
	Schedule        Schedule `json:"schedule"`
}

// BootstrapAMQP holds the per-scan broker credentials for the node's endpoint profile.
type BootstrapAMQP struct {
	URL               string `json:"url"`
	VHost             string `json:"vhost"`
	Username          string `json:"username"`
	Password          string `json:"password"`
	Queue             string `json:"queue"`
	AnalysesExchange  string `json:"analysesExchange"`
	ResultsExchange   string `json:"resultsExchange"`
	RoutingKey        string `json:"routingKey"`
	HeartbeatSeconds  int    `json:"heartbeatSeconds"`
	ConsumerTimeoutMs int64  `json:"consumerTimeoutMs"`
}

// Upload modes of a bootstrap.
const UploadModePresigned = "presigned"

// BootstrapUploads are the file upload settings.
type BootstrapUploads struct {
	Mode                string `json:"mode"`
	MaxFileBytes        int64  `json:"maxFileBytes"`
	MaxFilesPerAnalysis int    `json:"maxFilesPerAnalysis"`
	TimeoutMs           int64  `json:"timeoutMs"`
}

// BootstrapLimits are the size and count limits a runtime enforces.
type BootstrapLimits struct {
	MaxAnalysisConfigBytes int64 `json:"maxAnalysisConfigBytes"`
	MaxResultBytes         int64 `json:"maxResultBytes"`
	MaxResultMessageBytes  int64 `json:"maxResultMessageBytes"`
	LogTailBytes           int   `json:"logTailBytes"`
	LogTailEarlierBytes    int   `json:"logTailEarlierBytes"`
	StackBytes             int   `json:"stackBytes"`
	MaxAnalysesPerScan     int64 `json:"maxAnalysesPerScan"`
	MaxProcessesPerWorker  int   `json:"maxProcessesPerWorker"`
	MinFreeTmpBytes        int64 `json:"minFreeTmpBytes"`
}

// BootstrapIntervals are the timers of a runtime.
type BootstrapIntervals struct {
	StatePollMs        int64   `json:"statePollMs"`
	StatePollJitter    float64 `json:"statePollJitter"`
	CheckpointMs       int64   `json:"checkpointMs"`
	CheckpointItems    int64   `json:"checkpointItems"`
	DrainGraceMs       int64   `json:"drainGraceMs"`
	BackpressureWaitMs int64   `json:"backpressureWaitMs"`
}

// Checkpoint is a scheduler checkpoint: the contiguous confirmed prefix and the hash of its last item.
type Checkpoint struct {
	Confirmed int64   `json:"confirmed"`
	TailHash  *string `json:"tailHash"`
}

// UploadSource is a presigned GET of an upload referenced by the configs.
type UploadSource struct {
	URL       string `json:"url"`
	SHA256    string `json:"sha256"`
	Bytes     int64  `json:"bytes"`
	ExpiresAt Time   `json:"expiresAt"`
}

// DataSources are the base URLs of template data sources.
type DataSources struct {
	Tranco string `json:"tranco"`
	Crux   string `json:"crux"`
}

// BootstrapScheduler is the scheduler-only part of a bootstrap.
type BootstrapScheduler struct {
	Restarts    int                     `json:"restarts"`
	Checkpoint  Checkpoint              `json:"checkpoint"`
	Resolved    map[string]Resolution   `json:"resolved"`
	Uploads     map[string]UploadSource `json:"uploads"`
	DataSources DataSources             `json:"dataSources"`
}

// Bootstrap is the response of GET /api/runtime/bootstrap. When Action is "stop" the runtime exits 0
// without connecting; the other fields may then be absent.
type Bootstrap struct {
	ServerTime int64               `json:"serverTime"`
	Action     string              `json:"action"`
	Worker     BootstrapWorker     `json:"worker"`
	Scan       BootstrapScan       `json:"scan"`
	Revision   BootstrapRevision   `json:"revision"`
	AMQP       BootstrapAMQP       `json:"amqp"`
	Uploads    BootstrapUploads    `json:"uploads"`
	Limits     BootstrapLimits     `json:"limits"`
	Intervals  BootstrapIntervals  `json:"intervals"`
	Scheduler  *BootstrapScheduler `json:"scheduler"`
}

// RuntimeProcesses are the process counts a runtime reports.
type RuntimeProcesses struct {
	Running int `json:"running"`
	Busy    int `json:"busy"`
}

// BusyAnalysis is one in-flight analysis of a runner.
type BusyAnalysis struct {
	Seq         int64           `json:"seq"`
	Round       int             `json:"round"`
	Attempt     int             `json:"attempt"`
	ExecutionID string          `json:"executionId"`
	StartedAt   Time            `json:"startedAt"`
	Progress    json.RawMessage `json:"progress"`
}

// BusyProgress is the latest `progress` message of an in-flight analysis.
type BusyProgress struct {
	Fraction *float64 `json:"fraction"`
	Message  *string  `json:"message"`
}

// RuntimeCounters are a runner's cumulative counters.
type RuntimeCounters struct {
	Succeeded          int64 `json:"succeeded"`
	Failed             int64 `json:"failed"`
	Retried            int64 `json:"retried"`
	RedeliveredSkipped int64 `json:"redeliveredSkipped"`
}

// SchedulerProgress is the scheduler part of a state poll.
type SchedulerProgress struct {
	Published    int64 `json:"published"`
	Confirmed    int64 `json:"confirmed"`
	Nacked       int64 `json:"nacked"`
	Backpressure bool  `json:"backpressure"`
}

// RuntimeStateRequest is the body of POST /api/runtime/state. Busy must be an empty list (not null)
// for schedulers; Scheduler is null for runners.
type RuntimeStateRequest struct {
	Processes     RuntimeProcesses   `json:"processes"`
	Busy          []BusyAnalysis     `json:"busy"`
	Consuming     bool               `json:"consuming"`
	ClockOffsetMs int64              `json:"clockOffsetMs"`
	TmpFreeBytes  int64              `json:"tmpFreeBytes"`
	Counters      RuntimeCounters    `json:"counters"`
	Scheduler     *SchedulerProgress `json:"scheduler"`
}

// MarshalJSON encodes a nil Busy as [].
func (r RuntimeStateRequest) MarshalJSON() ([]byte, error) {
	type plain RuntimeStateRequest
	p := plain(r)
	if p.Busy == nil {
		p.Busy = []BusyAnalysis{}
	}
	return marshalNoEscape(p)
}

// RuntimeStateResponse is the response of POST /api/runtime/state.
type RuntimeStateResponse struct {
	ServerTime int64  `json:"serverTime"`
	Action     string `json:"action"`
	Processes  int    `json:"processes"`
	ScanState  string `json:"scanState"`
	NextPollMs int64  `json:"nextPollMs"`
}

// PresignFile is one file of a presign request; FileID is the uuid v4 the runtime generated.
type PresignFile struct {
	FileID      string `json:"fileId"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	ContentType string `json:"contentType"`
}

// PresignRequest is the body of POST /api/runtime/uploads/presign.
type PresignRequest struct {
	Seq         int64         `json:"seq"`
	Round       int           `json:"round"`
	Attempt     int           `json:"attempt"`
	ExecutionID string        `json:"executionId"`
	Files       []PresignFile `json:"files"`
}

// PresignedUpload is one presigned PUT; the runtime must send exactly Headers.
type PresignedUpload struct {
	FileID    string            `json:"fileId"`
	Name      string            `json:"name"`
	URL       string            `json:"url"`
	Method    string            `json:"method"`
	Headers   map[string]string `json:"headers"`
	ExpiresAt Time              `json:"expiresAt"`
}

// PresignResponse is the response of POST /api/runtime/uploads/presign.
type PresignResponse struct {
	Files []PresignedUpload `json:"files"`
}

// AnalysesStatusRequest is the body of POST /api/runtime/analyses/status (at most 1000 seqs).
type AnalysesStatusRequest struct {
	Seqs []int64 `json:"seqs"`
}

// AnalysisStatusItem is the stored status of one seq; nil fields mean "no document".
type AnalysisStatusItem struct {
	Seq     int64   `json:"seq"`
	Status  *string `json:"status"`
	Round   *int    `json:"round"`
	Attempt *int    `json:"attempt"`
}

// AnalysesStatusResponse is the response of POST /api/runtime/analyses/status.
type AnalysesStatusResponse struct {
	Items []AnalysisStatusItem `json:"items"`
}

// Resolution keys.
const ResolutionKeySchedule = "schedule"

// SchedulerResolvedRequest is the body of POST /api/runtime/scheduler/resolved. Key is "schedule" or
// "call:<n>".
type SchedulerResolvedRequest struct {
	Epoch         int             `json:"epoch"`
	Key           string          `json:"key"`
	Template      string          `json:"template"`
	ScanConfig    json.RawMessage `json:"scanConfig"`
	Provenance    json.RawMessage `json:"provenance"`
	ExpectedTotal *int64          `json:"expectedTotal"`
}

// SchedulerResolvedResponse is the response of POST /api/runtime/scheduler/resolved; when Stored is
// false a resolution already existed and the runtime must use it.
type SchedulerResolvedResponse struct {
	Stored     bool       `json:"stored"`
	Resolution Resolution `json:"resolution"`
}

// SchedulerCheckpointRequest is the body of POST /api/runtime/scheduler/checkpoint.
type SchedulerCheckpointRequest struct {
	Epoch     int     `json:"epoch"`
	Confirmed int64   `json:"confirmed"`
	TailHash  *string `json:"tailHash"`
}

// SchedulerCheckpointResponse is the response of POST /api/runtime/scheduler/checkpoint.
type SchedulerCheckpointResponse struct {
	Confirmed  int64   `json:"confirmed"`
	TailHash   *string `json:"tailHash"`
	ServerTime int64   `json:"serverTime"`
}

// Scheduler outcomes.
const (
	OutcomeDone   = "done"
	OutcomeFailed = "failed"
)

// SchedulerDoneRequest is the body of POST /api/runtime/scheduler/done.
type SchedulerDoneRequest struct {
	Epoch     int           `json:"epoch"`
	Outcome   string        `json:"outcome"`
	Confirmed int64         `json:"confirmed"`
	TailHash  *string       `json:"tailHash"`
	Error     *ScantorError `json:"error,omitempty"`
}

// SchedulingState is the scheduling part of a scheduler/done response.
type SchedulingState struct {
	State     string `json:"state"`
	Confirmed int64  `json:"confirmed"`
}

// SchedulerDoneResponse is the response of POST /api/runtime/scheduler/done.
type SchedulerDoneResponse struct {
	ServerTime int64           `json:"serverTime"`
	Scheduling SchedulingState `json:"scheduling"`
}

// RuntimeErrorContext is optional context of an error report (stderrTail ≤ 4 KiB).
type RuntimeErrorContext struct {
	StderrTail string `json:"stderrTail,omitempty"`
}

// RuntimeErrorReport is the body of POST /api/runtime/errors.
type RuntimeErrorReport struct {
	Fatal   bool                 `json:"fatal"`
	Error   ScantorError         `json:"error"`
	Context *RuntimeErrorContext `json:"context,omitempty"`
}

// RuntimeErrorResponse is the response of POST /api/runtime/errors (HTTP 202).
type RuntimeErrorResponse struct {
	Recorded bool `json:"recorded"`
}
