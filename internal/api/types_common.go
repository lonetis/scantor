package api

import "encoding/json"

// ErrorType classifies a ScantorError (docs/runtime.md §9.2).
type ErrorType string

// ScantorError types.
const (
	ErrorTaskError  ErrorType = "taskError"
	ErrorFatal      ErrorType = "fatal"
	ErrorRetry      ErrorType = "retry"
	ErrorTimeout    ErrorType = "timeout"
	ErrorCrash      ErrorType = "crash"
	ErrorValidation ErrorType = "validation"
	ErrorPlatform   ErrorType = "platform"
	ErrorCancelled  ErrorType = "cancelled"
)

// ErrorPhase says where a ScantorError happened (docs/runtime.md §9.3).
type ErrorPhase string

// ScantorError phases.
const (
	PhaseBootstrap ErrorPhase = "bootstrap"
	PhaseSchedule  ErrorPhase = "schedule"
	PhaseRun       ErrorPhase = "run"
	PhaseValidate  ErrorPhase = "validate"
	PhaseUpload    ErrorPhase = "upload"
	PhasePublish   ErrorPhase = "publish"
	PhasePlatform  ErrorPhase = "platform"
	PhaseIngest    ErrorPhase = "ingest"
)

// ScantorError is the unified, runtime-owned error model (docs/data-model.md §4.6). The REST API and
// runtime routes use ISO timestamps; AMQP bodies use epoch milliseconds and have their own type.
type ScantorError struct {
	Type      ErrorType       `json:"type"`
	Message   string          `json:"message"`
	Retryable bool            `json:"retryable"`
	Phase     ErrorPhase      `json:"phase"`
	Attempt   int             `json:"attempt"`
	Stack     string          `json:"stack,omitempty"`
	Details   json.RawMessage `json:"details,omitempty"`
	At        Time            `json:"at"`
}

// FileRef references a file attached to an analysis (docs/data-model.md §4.6).
type FileRef struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	ContentType string `json:"contentType"`
}

// BuildPhase is the phase of a BuildError: the task-pipeline phases plus `config` and `schedule`, which
// only test runs use.
type BuildPhase string

// BuildError phases.
const (
	BuildPhasePack     BuildPhase = "pack"
	BuildPhaseStatic   BuildPhase = "static"
	BuildPhaseBuild    BuildPhase = "build"
	BuildPhaseDescribe BuildPhase = "describe"
	BuildPhaseCheck    BuildPhase = "check"
	BuildPhasePush     BuildPhase = "push"
	BuildPhasePlatform BuildPhase = "platform"
	BuildPhaseConfig   BuildPhase = "config"
	BuildPhaseSchedule BuildPhase = "schedule"
)

// BuildError is a structured task-pipeline error (docs/tasks.md §9.8). File is relative to the task
// root; Line and Column are 1-based and 0 when unknown.
type BuildError struct {
	Phase   BuildPhase `json:"phase"`
	File    string     `json:"file,omitempty"`
	Line    int        `json:"line,omitempty"`
	Column  int        `json:"column,omitempty"`
	Message string     `json:"message"`
}

// ScheduleKind kinds.
const (
	ScheduleKindTemplate = "template"
	ScheduleKindCustom   = "custom"
)

// Schedule says how scheduling runs: `{kind: "template", template}` or `{kind: "custom"}`.
type Schedule struct {
	Kind     string `json:"kind"`
	Template string `json:"template,omitempty"`
}

// ConnectorInfo identifies the connector of a description.
type ConnectorInfo struct {
	Language string `json:"language"`
	Version  string `json:"version"`
}

// TypeSchemas holds the JSON Schemas of the four task types.
type TypeSchemas struct {
	TaskConfig     json.RawMessage `json:"taskConfig"`
	ScanConfig     json.RawMessage `json:"scanConfig"`
	AnalysisConfig json.RawMessage `json:"analysisConfig"`
	Result         json.RawMessage `json:"result"`
}

// SecretPaths lists the JSON pointers of writeOnly values per type.
type SecretPaths struct {
	TaskConfig     []string `json:"taskConfig"`
	ScanConfig     []string `json:"scanConfig"`
	AnalysisConfig []string `json:"analysisConfig"`
	Result         []string `json:"result"`
}

// UploadPaths lists the JSON pointers of upload-id fields per config type.
type UploadPaths struct {
	TaskConfig []string `json:"taskConfig"`
	ScanConfig []string `json:"scanConfig"`
}

// Description is the describe output (schemas/describe.schema.json, docs/tasks.md §7).
type Description struct {
	ProtocolVersion int           `json:"protocolVersion"`
	Connector       ConnectorInfo `json:"connector"`
	Schemas         TypeSchemas   `json:"schemas"`
	Schedule        Schedule      `json:"schedule"`
	SecretPaths     SecretPaths   `json:"secretPaths"`
	UploadPaths     UploadPaths   `json:"uploadPaths"`
	FileRefPaths    []string      `json:"fileRefPaths"`
	Warnings        []string      `json:"warnings"`
}

// Backoff is the retry backoff of scan settings: the delay after failed attempt n is
// min(maxMs, initialMs × factor^(n−1)), uniform in [delay/2, delay] with jitter.
type Backoff struct {
	InitialMs int64   `json:"initialMs"`
	Factor    float64 `json:"factor"`
	MaxMs     int64   `json:"maxMs"`
	Jitter    bool    `json:"jitter"`
}

// Resources are per-process resources.
type Resources struct {
	CPUs      float64 `json:"cpus"`
	MemoryMiB int64   `json:"memoryMiB"`
}

// NodeSelector filters placement by node pool and labels.
type NodeSelector struct {
	Pool   string            `json:"pool"`
	Labels map[string]string `json:"labels"`
}

// ScanSettings are the platform-level knobs of a scan (docs/data-model.md §4.5.1). settingsDefaults of a
// revision omit nodeSelector.
type ScanSettings struct {
	Workers               int           `json:"workers"`
	Processes             int           `json:"processes"`
	TimeoutMs             int64         `json:"timeoutMs"`
	MaxAttempts           int           `json:"maxAttempts"`
	Backoff               Backoff       `json:"backoff"`
	Resources             Resources     `json:"resources"`
	MaxAnalysesPerProcess int           `json:"maxAnalysesPerProcess"`
	NodeSelector          *NodeSelector `json:"nodeSelector,omitempty"`
	Privileged            bool          `json:"privileged"`
}

// Fallback scan settings used when the manifest omits a default (docs/data-model.md §4.5.1).
const (
	DefaultWorkers               = 1
	DefaultProcesses             = 1
	DefaultTimeoutMs             = 300000
	DefaultMaxAttempts           = 3
	DefaultBackoffInitialMs      = 5000
	DefaultBackoffFactor         = 2
	DefaultBackoffMaxMs          = 600000
	DefaultBackoffJitter         = true
	DefaultCPUs                  = 1
	DefaultMemoryMiB             = 512
	DefaultMaxAnalysesPerProcess = 1000
	DefaultNodePool              = "shared"
)

// DefaultScanSettings returns the fallback settings without a node selector.
func DefaultScanSettings() ScanSettings {
	return ScanSettings{
		Workers:     DefaultWorkers,
		Processes:   DefaultProcesses,
		TimeoutMs:   DefaultTimeoutMs,
		MaxAttempts: DefaultMaxAttempts,
		Backoff: Backoff{
			InitialMs: DefaultBackoffInitialMs,
			Factor:    DefaultBackoffFactor,
			MaxMs:     DefaultBackoffMaxMs,
			Jitter:    DefaultBackoffJitter,
		},
		Resources:             Resources{CPUs: DefaultCPUs, MemoryMiB: DefaultMemoryMiB},
		MaxAnalysesPerProcess: DefaultMaxAnalysesPerProcess,
	}
}

// Platform is an image platform.
type Platform struct {
	OS      string `json:"os"`
	Arch    string `json:"arch"`
	Variant string `json:"variant,omitempty"`
}

// StateReason explains the last state transition.
type StateReason struct {
	Code    string `json:"code"`
	Message string `json:"message,omitempty"`
	At      *Time  `json:"at,omitempty"`
}

// Page is a cursor-paginated list (docs/api.md §1.8). Bounded lists have no nextCursor.
type Page[T any] struct {
	Items      []T     `json:"items"`
	NextCursor *string `json:"nextCursor,omitempty"`
}

// List is a bounded list without a cursor.
type List[T any] struct {
	Items []T `json:"items"`
}

// PageQuery holds the common list parameters.
type PageQuery struct {
	Limit  int
	Cursor string
}

// JobRef references a background job.
type JobRef struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	State string `json:"state"`
}

// JobSubject is the document a job works on.
type JobSubject struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

// Progress is a job's progress; Total is nil when unknown.
type Progress struct {
	Done  int64  `json:"done"`
	Total *int64 `json:"total"`
}

// CodeMessage is a short error of jobs and exports.
type CodeMessage struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Job is the API representation of a job (docs/api.md §4.16).
type Job struct {
	ID         string       `json:"id"`
	Kind       string       `json:"kind"`
	Subject    JobSubject   `json:"subject"`
	State      string       `json:"state"`
	Progress   Progress     `json:"progress"`
	Attempts   int          `json:"attempts"`
	Error      *CodeMessage `json:"error"`
	CreatedAt  Time         `json:"createdAt"`
	StartedAt  *Time        `json:"startedAt"`
	FinishedAt *Time        `json:"finishedAt"`
}

// Job states.
const (
	JobQueued    = "queued"
	JobRunning   = "running"
	JobSucceeded = "succeeded"
	JobFailed    = "failed"
	JobCancelled = "cancelled"
)

// Event is one timeline entry (docs/data-model.md §4.11).
type Event struct {
	ID         string          `json:"id"`
	At         Time            `json:"at"`
	Type       string          `json:"type"`
	Level      string          `json:"level"`
	UserID     *string         `json:"userId"`
	ScanID     string          `json:"scanId,omitempty"`
	TaskID     string          `json:"taskId,omitempty"`
	RevisionID string          `json:"revisionId,omitempty"`
	WorkerID   string          `json:"workerId,omitempty"`
	NodeID     string          `json:"nodeId,omitempty"`
	Message    string          `json:"message"`
	Data       json.RawMessage `json:"data,omitempty"`
}

// Condition is a bounded status entry of a scan (docs/data-model.md §4.5.4).
type Condition struct {
	Type      string          `json:"type"`
	Severity  string          `json:"severity"`
	Reason    string          `json:"reason"`
	Message   string          `json:"message"`
	Since     Time            `json:"since"`
	UpdatedAt Time            `json:"updatedAt"`
	Details   json.RawMessage `json:"details,omitempty"`
}

// Timings of an analysis attempt.
type Timings struct {
	ScheduledAt *Time `json:"scheduledAt"`
	StartedAt   *Time `json:"startedAt"`
	FinishedAt  *Time `json:"finishedAt"`
	DurationMs  int64 `json:"durationMs"`
}

// Attempt is one entry of an analysis's attempt history. Test-run analyses omit the round and worker
// fields.
type Attempt struct {
	Attempt     int           `json:"attempt"`
	Round       int           `json:"round,omitempty"`
	ExecutionID string        `json:"executionId,omitempty"`
	WorkerID    string        `json:"workerId,omitempty"`
	NodeID      string        `json:"nodeId,omitempty"`
	StartedAt   *Time         `json:"startedAt"`
	FinishedAt  *Time         `json:"finishedAt"`
	DurationMs  int64         `json:"durationMs"`
	Error       *ScantorError `json:"error"`
	LogTail     string        `json:"logTail"`
}
