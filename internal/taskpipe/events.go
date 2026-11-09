package taskpipe

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/lonetis/scantor/internal/api"
)

// EventVersion is the version of the task-pipeline event format (docs/tasks.md §9.8), which script
// builds share.
const EventVersion = 1

// Event types.
const (
	EventLog    = "log"
	EventError  = "error"
	EventResult = "result"
)

// Log streams: the origin of a log event's text.
const (
	StreamPipeline = "pipeline"
	StreamBuild    = "build"
	StreamStdout   = "stdout"
	StreamStderr   = "stderr"
	StreamCheck    = "check"
)

// Log levels; info is the default and is omitted on the wire.
const (
	LevelInfo    = "info"
	LevelWarning = "warning"
)

// Limits of the event stream (docs/tasks.md §9.10).
const (
	// MaxEventText bounds the text of one log event; longer output is split.
	MaxEventText = 16 << 10
	// MaxLogBytes bounds the log text of one pipeline run; afterwards one truncation event is emitted
	// and later log events are dropped (errors and the result are kept).
	MaxLogBytes = 10 << 20
	// MaxErrorMessage bounds a BuildError message.
	MaxErrorMessage = 4 << 10
)

// EventOf is one pipeline event whose result payload has type R. Log and error events are the same for
// every command; only the result differs.
type EventOf[R any] struct {
	V      int             `json:"v"`
	Seq    int64           `json:"seq"`
	At     api.Time        `json:"at"`
	Phase  api.BuildPhase  `json:"phase"`
	Type   string          `json:"type"`
	Stream string          `json:"stream,omitempty"`
	Level  string          `json:"level,omitempty"`
	Text   *string         `json:"text,omitempty"`
	Error  *api.BuildError `json:"error,omitempty"`
	Result R               `json:"result,omitempty"`
}

// Event is one task-pipeline event (pack, check-static, build).
type Event = EventOf[*Result]

// ScriptEvent is one event of `scantor script build`; its result is a ScriptResult.
type ScriptEvent = EventOf[*ScriptResult]

// EventFormat selects how an Emitter writes events.
type EventFormat string

// Event formats: one JSON object per line, or lines for humans.
const (
	EventsNDJSON EventFormat = "ndjson"
	EventsText   EventFormat = "text"
)

// ParseEventFormat validates the value of --events.
func ParseEventFormat(s string) (EventFormat, error) {
	switch EventFormat(s) {
	case EventsNDJSON, EventsText:
		return EventFormat(s), nil
	default:
		return "", fmt.Errorf("invalid event format %q: use ndjson or text", s)
	}
}

// Emitter numbers events and writes them in order. It is safe for concurrent use. A write error stops
// further output; Err reports it.
type Emitter struct {
	mu        sync.Mutex
	w         io.Writer
	format    EventFormat
	now       func() time.Time
	seq       int64
	logBytes  int
	truncated bool
	err       error
}

// NewEmitter returns an emitter writing to w in format.
func NewEmitter(w io.Writer, format EventFormat) *Emitter {
	return &Emitter{w: w, format: format, now: time.Now}
}

// Err returns the first write error.
func (e *Emitter) Err() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.err
}

// Log emits text as log events of stream, split into chunks of at most MaxEventText bytes. A trailing
// newline is dropped. level is LevelInfo or LevelWarning.
func (e *Emitter) Log(phase api.BuildPhase, stream, level, text string) {
	text = strings.TrimSuffix(text, "\n")
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, chunk := range splitText(text, MaxEventText) {
		if e.truncated {
			return
		}
		if e.logBytes+len(chunk) > MaxLogBytes {
			e.truncated = true
			msg := fmt.Sprintf("log output truncated after %d MiB; later log lines are dropped", MaxLogBytes>>20)
			e.emit(Event{Phase: phase, Type: EventLog, Stream: StreamPipeline, Level: LevelWarning, Text: &msg})
			return
		}
		e.logBytes += len(chunk)
		c := chunk
		ev := Event{Phase: phase, Type: EventLog, Stream: stream, Text: &c}
		if level == LevelWarning {
			ev.Level = LevelWarning
		}
		e.emit(ev)
	}
}

// Error emits an error event; the error's phase is the event's phase.
func (e *Emitter) Error(be api.BuildError) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.emit(Event{Phase: be.Phase, Type: EventError, Error: &be})
}

// Result emits the final result event of a task command.
func (e *Emitter) Result(phase api.BuildPhase, r *Result) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.emit(Event{Phase: phase, Type: EventResult, Result: r})
}

// ScriptResult emits the final result event of a script build.
func (e *Emitter) ScriptResult(phase api.BuildPhase, r *ScriptResult) {
	e.mu.Lock()
	defer e.mu.Unlock()
	ev := ScriptEvent{Phase: phase, Type: EventResult, Result: r}
	stamp(e, &ev)
	e.write(ev, func() string { return renderScriptResult(r) })
}

func (e *Emitter) emit(ev Event) {
	stamp(e, &ev)
	e.write(ev, func() string { return renderText(ev) })
}

// stamp fills the frame of e's next event: the format version, the sequence number and the time.
func stamp[R any](e *Emitter, ev *EventOf[R]) {
	ev.V = EventVersion
	ev.Seq = e.seq
	ev.At = api.NewTime(e.now())
	e.seq++
}

// write writes a stamped event: ev as one JSON line, or the text rendering for humans.
func (e *Emitter) write(ev any, text func() string) {
	if e.err != nil {
		return
	}
	var err error
	if e.format == EventsText {
		_, err = io.WriteString(e.w, text())
	} else {
		var b []byte
		if b, err = marshalEvent(ev); err == nil {
			_, err = e.w.Write(append(b, '\n'))
		}
	}
	if err != nil {
		e.err = fmt.Errorf("write events: %w", err)
	}
}

func marshalEvent(ev any) ([]byte, error) {
	var sb strings.Builder
	enc := json.NewEncoder(&sb)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(ev); err != nil {
		return nil, err
	}
	return []byte(strings.TrimSuffix(sb.String(), "\n")), nil
}

// splitText splits s into chunks of at most n bytes without splitting UTF-8 sequences. An empty text is
// one empty chunk.
func splitText(s string, n int) []string {
	if len(s) <= n {
		return []string{s}
	}
	var out []string
	for len(s) > n {
		cut := n
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		if cut == 0 {
			cut = n
		}
		out = append(out, s[:cut])
		s = s[cut:]
	}
	if s != "" {
		out = append(out, s)
	}
	return out
}

// truncateMessage bounds a BuildError message to MaxErrorMessage bytes.
func truncateMessage(s string) string {
	if len(s) <= MaxErrorMessage {
		return s
	}
	return splitText(s, MaxErrorMessage-3)[0] + "..."
}

// renderText renders an event for humans: "[phase] text", "[phase] warning: text",
// "[phase] error: file:line:col: message" and a result summary.
func renderText(ev Event) string {
	switch ev.Type {
	case EventLog:
		text := ""
		if ev.Text != nil {
			text = *ev.Text
		}
		if ev.Level == LevelWarning {
			return fmt.Sprintf("[%s] warning: %s\n", ev.Phase, text)
		}
		return fmt.Sprintf("[%s] %s\n", ev.Phase, text)
	case EventError:
		return fmt.Sprintf("[%s] error: %s\n", ev.Phase, FormatBuildError(*ev.Error))
	case EventResult:
		return renderResult(ev.Result)
	}
	return ""
}

// FormatBuildError renders "<file>:<line>:<column>: <message>" with the parts that are set.
func FormatBuildError(be api.BuildError) string {
	loc := be.File
	if loc != "" && be.Line > 0 {
		loc = fmt.Sprintf("%s:%d", loc, be.Line)
		if be.Column > 0 {
			loc = fmt.Sprintf("%s:%d", loc, be.Column)
		}
	}
	if loc == "" {
		return be.Message
	}
	return loc + ": " + be.Message
}

func renderResult(r *Result) string {
	if r == nil {
		return ""
	}
	return renderOutcome(r.OK, r.Image, r.Pack, r.Errors)
}

func renderScriptResult(r *ScriptResult) string {
	if r == nil {
		return ""
	}
	return renderOutcome(r.OK, r.Image, r.Pack, r.Errors)
}

// renderOutcome renders the summary of a result: the image or pack of a success, or every error.
func renderOutcome(ok bool, image *Image, pack *Summary, errs []api.BuildError) string {
	var b strings.Builder
	if ok {
		b.WriteString("[result] ok")
		if image != nil {
			fmt.Fprintf(&b, ": image %s (%s)", image.Ref, formatBytes(image.Bytes))
		} else if pack != nil {
			fmt.Fprintf(&b, ": %d files, sha256 %s", pack.FileCount, pack.PackSHA256)
		}
		b.WriteString("\n")
		return b.String()
	}
	fmt.Fprintf(&b, "[result] failed with %d error(s)\n", len(errs))
	for _, be := range errs {
		fmt.Fprintf(&b, "  [%s] %s\n", be.Phase, FormatBuildError(be))
	}
	return b.String()
}

// formatBytes renders a byte count with a binary unit.
func formatBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	v, exp := float64(n), 0
	for v >= unit && exp < 4 {
		v /= unit
		exp++
	}
	return fmt.Sprintf("%.1f %s", v, []string{"B", "KiB", "MiB", "GiB", "TiB"}[exp])
}
