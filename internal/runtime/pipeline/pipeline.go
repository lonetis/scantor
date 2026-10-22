// Package pipeline writes the task-pipeline events of the describe and check modes (docs/runtime.md §16,
// docs/tasks.md §9.5): one JSON object per stdout line, `{"phase", "type": "log"|"error"|"result", …}`,
// with errors as BuildError. The task pipeline adds `v`, `seq` and `at` when it merges them.
package pipeline

import (
	"bytes"
	"encoding/json"
	"io"
	"sync"
	"unicode/utf8"

	"github.com/lonetis/scantor/internal/api"
)

// Event types and streams.
const (
	TypeLog    = "log"
	TypeError  = "error"
	TypeResult = "result"

	StreamStdout = "stdout"
	StreamStderr = "stderr"
	StreamCheck  = "check"
)

// Bounds of event texts (docs/tasks.md §9.8, §9.10).
const (
	MaxTextBytes    = 16 << 10
	MaxMessageBytes = 4 << 10
)

// Emitter writes the events of one phase; it is safe for concurrent use.
type Emitter struct {
	phase api.BuildPhase
	mu    sync.Mutex
	w     io.Writer
	err   error
}

// New returns an emitter of phase on w.
func New(w io.Writer, phase api.BuildPhase) *Emitter { return &Emitter{w: w, phase: phase} }

// Log emits a log event (longer texts are split at 16 KiB).
func (e *Emitter) Log(stream, text string) {
	for {
		chunk := text
		if len(chunk) > MaxTextBytes {
			cut := MaxTextBytes
			for cut > 0 && !utf8.RuneStart(text[cut]) {
				cut--
			}
			chunk, text = text[:cut], text[cut:]
		} else {
			text = ""
		}
		e.write(map[string]any{"phase": e.phase, "type": TypeLog, "stream": stream, "text": chunk})
		if text == "" {
			return
		}
	}
}

// Error emits a BuildError of the emitter's phase.
func (e *Emitter) Error(be api.BuildError) {
	be.Phase = e.phase
	be.Message = truncate(be.Message, MaxMessageBytes)
	e.write(map[string]any{"phase": e.phase, "type": TypeError, "error": be})
}

// Errorf emits a BuildError without a location.
func (e *Emitter) Errorf(message string) { e.Error(api.BuildError{Message: message}) }

// Result emits the result event with the given fields besides phase and type.
func (e *Emitter) Result(fields map[string]any) {
	ev := map[string]any{"phase": e.phase, "type": TypeResult}
	for k, v := range fields {
		ev[k] = v
	}
	e.write(ev)
}

// Err returns the first write error.
func (e *Emitter) Err() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.err
}

func (e *Emitter) write(ev map[string]any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.err != nil {
		return
	}
	if err := enc.Encode(ev); err != nil {
		e.err = err
		return
	}
	if _, err := e.w.Write(buf.Bytes()); err != nil {
		e.err = err
	}
}

// truncate cuts s to at most limit bytes at a rune boundary, ending with "…".
func truncate(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	const ellipsis = "…"
	cut := limit - len(ellipsis)
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + ellipsis
}
