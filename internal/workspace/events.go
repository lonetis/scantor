package workspace

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"

	"github.com/lonetis/scantor/internal/redact"
)

// Events writes the helper's stderr protocol (docs/editor.md §9.3): one JSON object per line, either a
// log line {"type":"log","level":"info"|"warn","msg":…}, the snapshot summary
// {"type":"summary",…} or a final {"type":"error","error":{code,message,path?,details?}}. Every message is
// redacted, so a git credential never reaches the orchestrator's logs. A nil *Events discards everything.
type Events struct {
	mu  sync.Mutex
	enc *json.Encoder
	// redactions are literal secrets (the git credential) removed from every message in addition to the
	// pattern-based redaction.
	redactions []string
}

// NewEvents returns an event writer on w (the helper's stderr).
func NewEvents(w io.Writer) *Events {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	return &Events{enc: enc}
}

// AddRedaction removes the literal value s from every later message.
func (e *Events) AddRedaction(s string) {
	if e == nil || s == "" {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.redactions = append(e.redactions, s)
}

// Infof writes an info log line.
func (e *Events) Infof(format string, args ...any) { e.log("info", fmt.Sprintf(format, args...)) }

// Warnf writes a warn log line.
func (e *Events) Warnf(format string, args ...any) { e.log("warn", fmt.Sprintf(format, args...)) }

func (e *Events) log(level, msg string) {
	if e == nil {
		return
	}
	e.write(struct {
		Type  string `json:"type"`
		Level string `json:"level"`
		Msg   string `json:"msg"`
	}{"log", level, e.clean(msg)})
}

// Summary writes the final summary line of a snapshot.
func (e *Events) Summary(s PackSummary) {
	if e == nil {
		return
	}
	e.write(struct {
		Type string `json:"type"`
		PackSummary
	}{"summary", s})
}

// ErrorBody is the error object of the final error line, and of a git candidate's rejection.
type ErrorBody struct {
	Code    Code           `json:"code"`
	Message string         `json:"message"`
	Path    string         `json:"path,omitempty"`
	Details map[string]any `json:"details,omitempty"`
}

// Error writes the final error line of a failed run.
func (e *Events) Error(err *Error) {
	if e == nil || err == nil {
		return
	}
	e.write(struct {
		Type  string    `json:"type"`
		Error ErrorBody `json:"error"`
	}{"error", ErrorBody{Code: err.Code, Message: e.clean(err.Error()), Path: err.Path, Details: err.Details}})
}

// Redact applies the event redaction to s (for messages that end up in other outputs).
func (e *Events) Redact(s string) string {
	if e == nil {
		return redact.String(s)
	}
	return e.clean(s)
}

func (e *Events) clean(s string) string {
	e.mu.Lock()
	secrets := e.redactions
	e.mu.Unlock()
	for _, secret := range secrets {
		s = strings.ReplaceAll(s, secret, redact.Mask)
	}
	return redact.String(s)
}

func (e *Events) write(v any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	// stderr is the only diagnostics channel of a helper; a failed write cannot be reported anywhere.
	_ = e.enc.Encode(v)
}
