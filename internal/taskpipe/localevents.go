package taskpipe

import (
	"encoding/json"
	"fmt"

	"github.com/lonetis/scantor/internal/api"
)

// Local-mode event types (docs/runtime.md §15.3).
const (
	LocalEventStart     = "start"
	LocalEventResolved  = "resolved"
	LocalEventScheduled = "scheduled"
	LocalEventLog       = "log"
	LocalEventAttempt   = "attempt"
	LocalEventResult    = "result"
	LocalEventError     = "error"
	LocalEventEnd       = "end"
)

// LocalEvent is one stdout line of the runtime in local mode, as consumers read it. Only the fields of
// its type are set; unknown fields are ignored, so newer runtimes stay readable.
type LocalEvent struct {
	Type string    `json:"type"`
	At   *api.Time `json:"at,omitempty"`

	// start
	RuntimeVersion  string             `json:"runtimeVersion,omitempty"`
	Language        string             `json:"language,omitempty"`
	ProtocolVersion int                `json:"protocolVersion,omitempty"`
	Connector       *api.ConnectorInfo `json:"connector,omitempty"`
	Schedule        *api.Schedule      `json:"schedule,omitempty"`
	Limit           int                `json:"limit,omitempty"`
	Processes       int                `json:"processes,omitempty"`
	DebugPort       int                `json:"debugPort,omitempty"`

	// resolved
	Key           string          `json:"key,omitempty"`
	Template      string          `json:"template,omitempty"`
	ScanConfig    json.RawMessage `json:"scanConfig,omitempty"`
	Provenance    json.RawMessage `json:"provenance,omitempty"`
	ExpectedTotal *int64          `json:"expectedTotal,omitempty"`

	// scheduled, log, attempt, result
	Seq     *int64          `json:"seq,omitempty"`
	Config  json.RawMessage `json:"config,omitempty"`
	Attempt *int            `json:"attempt,omitempty"`
	Stream  string          `json:"stream,omitempty"`
	Text    string          `json:"text,omitempty"`

	// attempt, result, error
	Error         *api.ScantorError `json:"error,omitempty"`
	NextAttemptAt *api.Time         `json:"nextAttemptAt,omitempty"`

	// result
	Status   string          `json:"status,omitempty"`
	Result   json.RawMessage `json:"result,omitempty"`
	Files    []LocalFile     `json:"files,omitempty"`
	LogTail  string          `json:"logTail,omitempty"`
	Attempts []api.Attempt   `json:"attempts,omitempty"`
	Timings  *api.Timings    `json:"timings,omitempty"`

	// end
	Reason   string        `json:"reason,omitempty"`
	Summary  *LocalSummary `json:"summary,omitempty"`
	ExitCode *int          `json:"exitCode,omitempty"`
}

// LocalFile is a file of a local-mode result; Path is relative to the out directory.
type LocalFile struct {
	api.FileRef
	Path string `json:"path"`
}

// LocalSummary counts the analyses of a local run.
type LocalSummary struct {
	Analyses  int `json:"analyses"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
}

// ParseLocalEvent decodes one stdout line of a local run.
func ParseLocalEvent(line []byte) (LocalEvent, error) {
	var ev LocalEvent
	if err := json.Unmarshal(line, &ev); err != nil {
		return LocalEvent{}, fmt.Errorf("invalid local-mode event: %w", err)
	}
	if ev.Type == "" {
		return LocalEvent{}, fmt.Errorf("invalid local-mode event: no type")
	}
	return ev, nil
}
