package scantor

import "encoding/json"

// protocolVersion is the connector protocol version this connector implements (docs/protocol.md).
const protocolVersion = 1

// Fixed protocol v1 limits (docs/protocol.md §9).
const (
	defaultMaxLineBytes = 8 << 20
	maxErrorMessage     = 4096
	maxErrorStack       = 16384
	maxLogMessage       = 16384
	maxLogFields        = 16384
	maxProgressMessage  = 256
	initialCredit       = 256
	creditBatch         = 128
)

// inbound is the union of every runtime → connector message; unknown fields are ignored.
type inbound struct {
	Type string `json:"type"`
	ID   string `json:"id"`

	// welcome
	Limits *welcomeLimits `json:"limits"`

	// schedule, run
	Ctx            *wireContext    `json:"ctx"`
	ScanConfig     json.RawMessage `json:"scanConfig"`
	TaskConfig     json.RawMessage `json:"taskConfig"`
	AnalysisConfig json.RawMessage `json:"analysisConfig"`

	// cancel
	Reason string `json:"reason"`

	// fileRef
	FileRef *FileRef `json:"fileRef"`

	// templateItem
	Config json.RawMessage `json:"config"`

	// error
	Error *wireError `json:"error"`
}

type welcomeLimits struct {
	MaxLineBytes           int64 `json:"maxLineBytes"`
	MaxResultBytes         int64 `json:"maxResultBytes"`
	MaxAnalysisConfigBytes int64 `json:"maxAnalysisConfigBytes"`
	MaxFileBytes           int64 `json:"maxFileBytes"`
	MaxFilesPerAnalysis    int64 `json:"maxFilesPerAnalysis"`
}

// wireContext is the ctx object of schedule and run (docs/protocol.md §5.1).
type wireContext struct {
	ScanID      string  `json:"scanId"`
	AnalysisID  *string `json:"analysisId"`
	Seq         *int64  `json:"seq"`
	Round       *int64  `json:"round"`
	Attempt     int     `json:"attempt"`
	ExecutionID *string `json:"executionId"`
	DeadlineMs  *int64  `json:"deadlineMs"`
	TmpDir      string  `json:"tmpDir"`
	FilesDir    *string `json:"filesDir"`
}

// wireError is the error object of docs/protocol.md §7.1.
type wireError struct {
	Type      string  `json:"type"`
	Message   string  `json:"message"`
	Retryable *bool   `json:"retryable,omitempty"`
	DelayMs   *int64  `json:"delayMs,omitempty"`
	Stack     string  `json:"stack,omitempty"`
	Details   *object `json:"details,omitempty"`
}

type helloMsg struct {
	Type      string        `json:"type"`
	ID        string        `json:"id"`
	Protocol  protocolRange `json:"protocol"`
	Connector connectorInfo `json:"connector"`
	PID       int           `json:"pid"`
}

type protocolRange struct {
	Min int `json:"min"`
	Max int `json:"max"`
}

type connectorInfo struct {
	Language string `json:"language"`
	Version  string `json:"version"`
	Runtime  string `json:"runtime,omitempty"`
}

type idMsg struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type errorMsg struct {
	Type  string    `json:"type"`
	ID    string    `json:"id"`
	Error wireError `json:"error"`
}

type descriptionMsg struct {
	Type     string             `json:"type"`
	ID       string             `json:"id"`
	Schemas  descriptionSchemas `json:"schemas"`
	Schedule scheduleKind       `json:"schedule"`
	Warnings []string           `json:"warnings"`
}

type descriptionSchemas struct {
	TaskConfig     *object `json:"taskConfig"`
	ScanConfig     *object `json:"scanConfig"`
	AnalysisConfig *object `json:"analysisConfig"`
	Result         *object `json:"result"`
}

type scheduleKind struct {
	Kind     string `json:"kind"`
	Template string `json:"template,omitempty"`
}

type configMsg struct {
	Type   string  `json:"type"`
	ID     string  `json:"id"`
	Config *object `json:"config"`
}

type doneMsg struct {
	Type  string `json:"type"`
	ID    string `json:"id"`
	Count int64  `json:"count"`
}

type resultMsg struct {
	Type   string  `json:"type"`
	ID     string  `json:"id"`
	Result *object `json:"result"`
}

type fileMsg struct {
	Type        string  `json:"type"`
	ID          string  `json:"id"`
	Parent      string  `json:"parent"`
	Name        string  `json:"name"`
	Path        string  `json:"path"`
	ContentType *string `json:"contentType"`
}

type logMsg struct {
	Type    string  `json:"type"`
	Parent  *string `json:"parent"`
	Level   Level   `json:"level"`
	Message string  `json:"message"`
	Fields  *object `json:"fields,omitempty"`
}

type progressMsg struct {
	Type     string   `json:"type"`
	Parent   string   `json:"parent"`
	Fraction *float64 `json:"fraction"`
	Message  *string  `json:"message"`
}

type templateMsg struct {
	Type       string          `json:"type"`
	ID         string          `json:"id"`
	Parent     string          `json:"parent"`
	Template   string          `json:"template"`
	ScanConfig json.RawMessage `json:"scanConfig"`
	Credit     int             `json:"credit"`
}

type creditMsg struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	Credit int    `json:"credit"`
}
