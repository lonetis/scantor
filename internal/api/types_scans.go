package api

import "encoding/json"

// Scan states (docs/data-model.md §6.1).
const (
	ScanCreating  = "creating"
	ScanRunning   = "running"
	ScanPaused    = "paused"
	ScanCompleted = "completed"
	ScanFailed    = "failed"
	ScanCancelled = "cancelled"
	ScanDeleting  = "deleting"
	ScanDeleted   = "deleted"
)

// NamedRef is an {id, name} reference.
type NamedRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ScanRevision is the revision a scan pins.
type ScanRevision struct {
	ID         string   `json:"id"`
	Number     int      `json:"number"`
	Ref        string   `json:"ref"`
	Language   string   `json:"language,omitempty"`
	Repository string   `json:"repository,omitempty"`
	Digest     string   `json:"digest,omitempty"`
	Platform   Platform `json:"platform"`
	Privileged bool     `json:"privileged"`
	Schedule   Schedule `json:"schedule"`
}

// Resolution is a recorded template resolution (docs/data-model.md §4.5.2).
type Resolution struct {
	Template      string          `json:"template"`
	ScanConfig    json.RawMessage `json:"scanConfig"`
	Provenance    json.RawMessage `json:"provenance"`
	ExpectedTotal *int64          `json:"expectedTotal"`
	At            Time            `json:"at"`
}

// Scheduling is the scheduling state of a scan.
type Scheduling struct {
	State        string                `json:"state"`
	Confirmed    int64                 `json:"confirmed"`
	TailHash     *string               `json:"tailHash"`
	Epoch        int                   `json:"epoch"`
	Restarts     int                   `json:"restarts"`
	Resolved     map[string]Resolution `json:"resolved"`
	Error        *ScantorError         `json:"error"`
	StartedAt    *Time                 `json:"startedAt"`
	CheckpointAt *Time                 `json:"checkpointAt"`
	DoneAt       *Time                 `json:"doneAt"`
}

// ScanStats are the analysis counts of a scan.
type ScanStats struct {
	Pending       int64   `json:"pending"`
	Retrying      int64   `json:"retrying"`
	Succeeded     int64   `json:"succeeded"`
	Failed        int64   `json:"failed"`
	Lost          int64   `json:"lost"`
	Cancelled     int64   `json:"cancelled"`
	ExpectedTotal *int64  `json:"expectedTotal"`
	RatePerMin    float64 `json:"ratePerMin"`
	RecountedAt   *Time   `json:"recountedAt"`
}

// ScanProgress is the derived progress of a scan.
type ScanProgress struct {
	Scheduled  int64    `json:"scheduled"`
	Terminal   int64    `json:"terminal"`
	Total      *int64   `json:"total"`
	Percent    *float64 `json:"percent"`
	ETASeconds *int64   `json:"etaSeconds"`
}

// ScanWorkers summarises a scan's workers.
type ScanWorkers struct {
	Desired int            `json:"desired"`
	Active  int            `json:"active"`
	Pending int            `json:"pending"`
	ByState map[string]int `json:"byState"`
}

// Breaker is the last circuit-breaker trip of a scan.
type Breaker struct {
	TrippedAt Time    `json:"trippedAt"`
	Ratio     float64 `json:"ratio"`
	Attempts  int64   `json:"attempts"`
	WindowMs  int64   `json:"windowMs"`
}

// Scan is the API representation of a scan (docs/api.md §2).
type Scan struct {
	ID          string          `json:"id"`
	UserID      string          `json:"userId"`
	Name        string          `json:"name,omitempty"`
	Task        NamedRef        `json:"task"`
	Revision    ScanRevision    `json:"revision"`
	State       string          `json:"state"`
	StateReason *StateReason    `json:"stateReason"`
	TaskConfig  json.RawMessage `json:"taskConfig"`
	ScanConfig  json.RawMessage `json:"scanConfig"`
	SecretPaths SecretPaths     `json:"secretPaths"`
	UploadIDs   []string        `json:"uploadIds"`
	Settings    ScanSettings    `json:"settings"`
	Round       int             `json:"round"`
	Scheduling  Scheduling      `json:"scheduling"`
	Stats       ScanStats       `json:"stats"`
	Progress    ScanProgress    `json:"progress"`
	Workers     ScanWorkers     `json:"workers"`
	Conditions  []Condition     `json:"conditions"`
	Breaker     *Breaker        `json:"breaker"`
	ClonedFrom  *string         `json:"clonedFrom"`
	CreatedAt   Time            `json:"createdAt"`
	UpdatedAt   Time            `json:"updatedAt"`
	StartedAt   *Time           `json:"startedAt"`
	PausedAt    *Time           `json:"pausedAt"`
	CompletedAt *Time           `json:"completedAt"`
	DeletedAt   *Time           `json:"deletedAt"`
}

// Settled reports whether the scan left creating and running (the settle condition of getScan?wait).
func (s Scan) Settled() bool { return s.State != ScanCreating && s.State != ScanRunning }

// ScanSummarySettings are the settings shown in scan lists.
type ScanSummarySettings struct {
	Workers   int `json:"workers"`
	Processes int `json:"processes"`
}

// ScanSummary is the list representation of a scan.
type ScanSummary struct {
	ID              string              `json:"id"`
	UserID          string              `json:"userId"`
	Name            string              `json:"name,omitempty"`
	Task            NamedRef            `json:"task"`
	Revision        ScanRevisionRef     `json:"revision"`
	State           string              `json:"state"`
	StateReason     *StateReason        `json:"stateReason"`
	Settings        ScanSummarySettings `json:"settings"`
	Progress        ScanProgress        `json:"progress"`
	Stats           ScanStats           `json:"stats"`
	ConditionsCount int                 `json:"conditionsCount"`
	CreatedAt       Time                `json:"createdAt"`
	CompletedAt     *Time               `json:"completedAt"`
}

// ScanRevisionRef is the short revision reference of a scan summary.
type ScanRevisionRef struct {
	ID     string `json:"id"`
	Number int    `json:"number"`
	Ref    string `json:"ref"`
}

// SettingsPatch is a partial ScanSettings without privileged (StartScan.settings). It is partial at every
// level: a field left out, also inside backoff, resources and nodeSelector, keeps the revision's default,
// so nothing the caller did not give is ever sent as a zero value or null.
type SettingsPatch struct {
	Workers               *int               `json:"workers,omitempty"`
	Processes             *int               `json:"processes,omitempty"`
	TimeoutMs             *int64             `json:"timeoutMs,omitempty"`
	MaxAttempts           *int               `json:"maxAttempts,omitempty"`
	Backoff               *BackoffPatch      `json:"backoff,omitempty"`
	Resources             *ResourcesPatch    `json:"resources,omitempty"`
	MaxAnalysesPerProcess *int               `json:"maxAnalysesPerProcess,omitempty"`
	NodeSelector          *NodeSelectorPatch `json:"nodeSelector,omitempty"`
}

// BackoffPatch is a partial Backoff.
type BackoffPatch struct {
	InitialMs *int64   `json:"initialMs,omitempty"`
	Factor    *float64 `json:"factor,omitempty"`
	MaxMs     *int64   `json:"maxMs,omitempty"`
	Jitter    *bool    `json:"jitter,omitempty"`
}

// ResourcesPatch is a partial Resources.
type ResourcesPatch struct {
	CPUs      *float64 `json:"cpus,omitempty"`
	MemoryMiB *int64   `json:"memoryMiB,omitempty"`
}

// NodeSelectorPatch is a partial NodeSelector. Labels left out are omitted; an explicit {} is sent as is.
type NodeSelectorPatch struct {
	Pool   *string           `json:"pool,omitempty"`
	Labels map[string]string `json:"labels,omitzero"`
}

// StartScan is the body of startScan.
type StartScan struct {
	Revision   string          `json:"revision"`
	Name       string          `json:"name,omitempty"`
	TaskConfig json.RawMessage `json:"taskConfig,omitempty"`
	ScanConfig json.RawMessage `json:"scanConfig,omitempty"`
	Settings   *SettingsPatch  `json:"settings,omitempty"`
	Confirm    bool            `json:"confirm,omitempty"`
}

// ListScansQuery holds the parameters of listScans.
type ListScansQuery struct {
	PageQuery
	States []string
	Task   string
	UserID string
}

// ScaleScan is the body of scaleScan; at least one field is required.
type ScaleScan struct {
	Workers   *int `json:"workers,omitempty"`
	Processes *int `json:"processes,omitempty"`
}

// RestartSettings are the overrides of restartScan.
type RestartSettings struct {
	Workers   *int `json:"workers,omitempty"`
	Processes *int `json:"processes,omitempty"`
}

// RestartScan is the body of restartScan.
type RestartScan struct {
	Name     string           `json:"name,omitempty"`
	Settings *RestartSettings `json:"settings,omitempty"`
}

// ScanJob is the response of retryFailedAnalyses and deleteScan.
type ScanJob struct {
	Scan Scan   `json:"scan"`
	Job  JobRef `json:"job"`
}

// InflightAnalysis is one item of listInflightAnalyses.
type InflightAnalysis struct {
	AnalysisID string          `json:"analysisId"`
	Seq        int64           `json:"seq"`
	Round      int             `json:"round"`
	Attempt    int             `json:"attempt"`
	StartedAt  Time            `json:"startedAt"`
	WorkerID   string          `json:"workerId"`
	NodeID     string          `json:"nodeId"`
	Progress   json.RawMessage `json:"progress"`
}

// InflightList is the response of listInflightAnalyses.
type InflightList struct {
	Items     []InflightAnalysis `json:"items"`
	UpdatedAt *Time              `json:"updatedAt"`
}

// WorkerSpec is the desired container spec of a worker.
type WorkerSpec struct {
	Repository string    `json:"repository"`
	Digest     string    `json:"digest"`
	Resources  Resources `json:"resources"`
	Privileged bool      `json:"privileged"`
	DinDMode   *string   `json:"dindMode"`
}

// WorkerProcesses are the process counts of a worker.
type WorkerProcesses struct {
	Desired  int `json:"desired"`
	Assigned int `json:"assigned"`
	Applied  int `json:"applied"`
	Running  int `json:"running"`
}

// WorkerExit is the last exit of a worker container.
type WorkerExit struct {
	ExitCode  int    `json:"exitCode"`
	OOMKilled bool   `json:"oomKilled"`
	At        Time   `json:"at"`
	LogTail   string `json:"logTail,omitempty"`
}

// WorkerContainer is the container state of a worker.
type WorkerContainer struct {
	ID            string      `json:"id"`
	Name          string      `json:"name"`
	StartedAt     *Time       `json:"startedAt"`
	Restarts      int         `json:"restarts"`
	LastExit      *WorkerExit `json:"lastExit"`
	NextRestartAt *Time       `json:"nextRestartAt"`
}

// WorkerRuntime is the runtime state of a worker.
type WorkerRuntime struct {
	Version         string        `json:"version"`
	ProtocolVersion int           `json:"protocolVersion"`
	BootstrappedAt  *Time         `json:"bootstrappedAt"`
	LastSeenAt      *Time         `json:"lastSeenAt"`
	LastError       *ScantorError `json:"lastError"`
}

// WorkerLogTail is the last on-demand log tail of a worker.
type WorkerLogTail struct {
	RequestID   string `json:"requestId"`
	RequestedAt *Time  `json:"requestedAt"`
	TailBytes   int    `json:"tailBytes"`
	Text        string `json:"text"`
	CollectedAt *Time  `json:"collectedAt"`
	Truncated   bool   `json:"truncated"`
}

// Worker is the API representation of a worker (docs/api.md §2).
type Worker struct {
	ID          string           `json:"id"`
	UserID      string           `json:"userId"`
	ScanID      string           `json:"scanId"`
	Role        string           `json:"role"`
	NodeID      *string          `json:"nodeId"`
	Epoch       int              `json:"epoch"`
	State       string           `json:"state"`
	StateReason *StateReason     `json:"stateReason"`
	Spec        WorkerSpec       `json:"spec"`
	Processes   WorkerProcesses  `json:"processes"`
	Container   *WorkerContainer `json:"container"`
	Runtime     *WorkerRuntime   `json:"runtime"`
	Logs        *WorkerLogTail   `json:"logs"`
	Node        *NamedRef        `json:"node"`
	Scan        *NamedRef        `json:"scan"`
	CreatedAt   Time             `json:"createdAt"`
	AssignedAt  *Time            `json:"assignedAt"`
	StartedAt   *Time            `json:"startedAt"`
	StoppedAt   *Time            `json:"stoppedAt"`
	UpdatedAt   Time             `json:"updatedAt"`
}

// WorkerLogs is the response of getWorkerLogs.
type WorkerLogs struct {
	Text        string `json:"text"`
	CollectedAt *Time  `json:"collectedAt"`
	RequestedAt *Time  `json:"requestedAt"`
	Pending     bool   `json:"pending"`
	Truncated   bool   `json:"truncated"`
}

// Analysis statuses (docs/data-model.md §6.3).
const (
	AnalysisPending   = "pending"
	AnalysisRetrying  = "retrying"
	AnalysisSucceeded = "succeeded"
	AnalysisFailed    = "failed"
	AnalysisLost      = "lost"
	AnalysisCancelled = "cancelled"
)

// Analysis is the API representation of an analysis (docs/api.md §2).
type Analysis struct {
	ID          string          `json:"id"`
	ScanID      string          `json:"scanId"`
	UserID      string          `json:"userId"`
	Seq         int64           `json:"seq"`
	Round       int             `json:"round"`
	Status      string          `json:"status"`
	Attempt     int             `json:"attempt"`
	Config      json.RawMessage `json:"config,omitempty"`
	Result      json.RawMessage `json:"result,omitempty"`
	Error       *ScantorError   `json:"error,omitempty"`
	Attempts    []Attempt       `json:"attempts"`
	Files       []FileRef       `json:"files"`
	LogTail     string          `json:"logTail,omitempty"`
	Timings     *Timings        `json:"timings,omitempty"`
	WorkerID    string          `json:"workerId,omitempty"`
	NodeID      string          `json:"nodeId,omitempty"`
	ExecutionID string          `json:"executionId,omitempty"`
	CreatedAt   Time            `json:"createdAt"`
	UpdatedAt   Time            `json:"updatedAt"`
}

// ListAnalysesQuery holds the parameters of listAnalyses.
type ListAnalysesQuery struct {
	Statuses []string
	AfterSeq *int64
	Limit    int
	Fields   []string
}

// QueryAnalyses is the body of queryAnalyses.
type QueryAnalyses struct {
	Filter     json.RawMessage `json:"filter"`
	Projection json.RawMessage `json:"projection,omitempty"`
	Sort       json.RawMessage `json:"sort,omitempty"`
	Limit      int             `json:"limit,omitempty"`
	AfterSeq   *int64          `json:"afterSeq,omitempty"`
}

// QueryResult is the response of queryAnalyses.
type QueryResult struct {
	Items      []json.RawMessage `json:"items"`
	NextCursor *string           `json:"nextCursor"`
}

// AggregateAnalyses is the body of aggregateAnalyses.
type AggregateAnalyses struct {
	Pipeline []json.RawMessage `json:"pipeline"`
	Limit    int               `json:"limit,omitempty"`
}

// AggregateResult is the response of aggregateAnalyses.
type AggregateResult struct {
	Items     []json.RawMessage `json:"items"`
	Truncated bool              `json:"truncated"`
}

// Export formats.
const (
	ExportJSONL = "jsonl"
	ExportCSV   = "csv"
)

// Export states.
const (
	ExportQueued  = "queued"
	ExportRunning = "running"
	ExportReady   = "ready"
	ExportFailed  = "failed"
)

// Export is the API representation of a background export.
type Export struct {
	ID         string          `json:"id"`
	UserID     string          `json:"userId"`
	ScanID     string          `json:"scanId"`
	Format     string          `json:"format"`
	Filter     json.RawMessage `json:"filter"`
	Fields     []string        `json:"fields"`
	AfterSeq   *int64          `json:"afterSeq"`
	State      string          `json:"state"`
	Bytes      int64           `json:"bytes"`
	Rows       int64           `json:"rows"`
	Error      *CodeMessage    `json:"error"`
	JobID      string          `json:"jobId"`
	Download   *DownloadURL    `json:"download,omitempty"`
	CreatedAt  Time            `json:"createdAt"`
	FinishedAt *Time           `json:"finishedAt"`
	UpdatedAt  Time            `json:"updatedAt"`
	ExpiresAt  Time            `json:"expiresAt"`
}

// Settled reports whether the export reached ready or failed.
func (e Export) Settled() bool { return e.State == ExportReady || e.State == ExportFailed }

// ExportScan is the body of exportScan.
type ExportScan struct {
	Format   string          `json:"format"`
	Filter   json.RawMessage `json:"filter,omitempty"`
	Fields   []string        `json:"fields,omitempty"`
	AfterSeq *int64          `json:"afterSeq,omitempty"`
}

// ExportInlineQuery holds the parameters of exportScanInline.
type ExportInlineQuery struct {
	Format   string
	Statuses []string
	Filter   json.RawMessage
	Fields   []string
	AfterSeq *int64
}
