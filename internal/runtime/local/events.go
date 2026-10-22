package local

import (
	"bytes"
	"encoding/json"
	"io"
	"sync"
	"time"

	"github.com/lonetis/scantor/internal/api"
)

// Event types of the local-mode output (docs/runtime.md §15.3).
const (
	EventStart     = "start"
	EventResolved  = "resolved"
	EventScheduled = "scheduled"
	EventLog       = "log"
	EventAttempt   = "attempt"
	EventResult    = "result"
	EventError     = "error"
	EventEnd       = "end"
)

// End reasons.
const (
	ReasonDone           = "done"
	ReasonLimit          = "limit"
	ReasonScheduleFailed = "scheduleFailed"
	ReasonStartFailed    = "startFailed"
	ReasonTimeout        = "timeout"
	ReasonInterrupted    = "interrupted"
)

// ConnectorRef identifies the connector in the start event.
type ConnectorRef struct {
	Language string `json:"language"`
	Version  string `json:"version"`
}

// StartEvent is emitted after describe.
type StartEvent struct {
	Type            string       `json:"type"`
	At              api.Time     `json:"at"`
	RuntimeVersion  string       `json:"runtimeVersion"`
	Language        string       `json:"language"`
	ProtocolVersion int          `json:"protocolVersion"`
	Connector       ConnectorRef `json:"connector"`
	Schedule        api.Schedule `json:"schedule"`
	Limit           int          `json:"limit"`
	Processes       int          `json:"processes"`
	DebugPort       *int         `json:"debugPort,omitempty"`
}

// ResolvedEvent is emitted when a template resolved (key schedule or call:<n>).
type ResolvedEvent struct {
	Type          string          `json:"type"`
	At            api.Time        `json:"at"`
	Key           string          `json:"key"`
	Template      string          `json:"template"`
	ScanConfig    json.RawMessage `json:"scanConfig"`
	Provenance    json.RawMessage `json:"provenance"`
	ExpectedTotal *int64          `json:"expectedTotal"`
}

// ScheduledEvent is emitted for every item taken from the stream.
type ScheduledEvent struct {
	Type   string          `json:"type"`
	At     api.Time        `json:"at"`
	Seq    int64           `json:"seq"`
	Config json.RawMessage `json:"config"`
}

// LogEvent is one output line; Seq and Attempt are null outside analyses.
type LogEvent struct {
	Type    string   `json:"type"`
	At      api.Time `json:"at"`
	Seq     *int64   `json:"seq"`
	Attempt *int     `json:"attempt"`
	Stream  string   `json:"stream"`
	Text    string   `json:"text"`
}

// AttemptEvent is a retryable failure with attempts left.
type AttemptEvent struct {
	Type          string           `json:"type"`
	At            api.Time         `json:"at"`
	Seq           int64            `json:"seq"`
	Attempt       int              `json:"attempt"`
	Error         api.ScantorError `json:"error"`
	NextAttemptAt api.Time         `json:"nextAttemptAt"`
}

// File is a file of a successful analysis; Path is relative to the output directory.
type File struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	ContentType string `json:"contentType"`
	Path        string `json:"path"`
}

// Attempt is an earlier failed attempt of an analysis.
type Attempt struct {
	Attempt    int               `json:"attempt"`
	StartedAt  api.Time          `json:"startedAt"`
	FinishedAt api.Time          `json:"finishedAt"`
	DurationMs int64             `json:"durationMs"`
	Error      *api.ScantorError `json:"error"`
	LogTail    string            `json:"logTail"`
}

// Timings are the timings of the final attempt.
type Timings struct {
	ScheduledAt api.Time `json:"scheduledAt"`
	StartedAt   api.Time `json:"startedAt"`
	FinishedAt  api.Time `json:"finishedAt"`
	DurationMs  int64    `json:"durationMs"`
}

// ResultEvent is emitted when an analysis is final.
type ResultEvent struct {
	Type     string            `json:"type"`
	At       api.Time          `json:"at"`
	Seq      int64             `json:"seq"`
	Status   string            `json:"status"`
	Attempt  int               `json:"attempt"`
	Config   json.RawMessage   `json:"config"`
	Result   json.RawMessage   `json:"result"`
	Error    *api.ScantorError `json:"error"`
	Files    []File            `json:"files"`
	LogTail  string            `json:"logTail"`
	Attempts []Attempt         `json:"attempts"`
	Timings  Timings           `json:"timings"`
}

// ErrorEvent is a failure not tied to an analysis.
type ErrorEvent struct {
	Type  string           `json:"type"`
	At    api.Time         `json:"at"`
	Error api.ScantorError `json:"error"`
}

// Summary counts the final analyses.
type Summary struct {
	Analyses  int `json:"analyses"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
}

// EndEvent is the last line.
type EndEvent struct {
	Type     string   `json:"type"`
	At       api.Time `json:"at"`
	Reason   string   `json:"reason"`
	Summary  Summary  `json:"summary"`
	ExitCode int      `json:"exitCode"`
}

// Emitter writes events as NDJSON lines; it is safe for concurrent use.
type Emitter struct {
	mu  sync.Mutex
	w   io.Writer
	err error
}

// NewEmitter returns an emitter on w (stdout).
func NewEmitter(w io.Writer) *Emitter { return &Emitter{w: w} }

// Emit writes one event. The first write error is kept (Err); later events are dropped.
func (e *Emitter) Emit(ev any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(ev); err != nil {
		e.mu.Lock()
		e.err = err
		e.mu.Unlock()
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.err != nil {
		return
	}
	if _, err := e.w.Write(buf.Bytes()); err != nil {
		e.err = err
	}
}

// Err returns the first write error.
func (e *Emitter) Err() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.err
}

func at(t time.Time) api.Time { return api.NewTime(t) }

// InvalidSpec reports a spec that cannot be used: an error event and the end event with exit code 3
// (docs/runtime.md §15.4).
func InvalidSpec(w io.Writer, err error) {
	e := NewEmitter(w)
	now := at(time.Now())
	e.Emit(ErrorEvent{Type: EventError, At: now, Error: api.ScantorError{Type: api.ErrorValidation, Phase: api.PhaseBootstrap, Message: err.Error(), At: now}})
	e.Emit(EndEvent{Type: EventEnd, At: now, Reason: ReasonStartFailed, ExitCode: ExitPlatform})
}
