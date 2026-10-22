package taskpipe

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"google.golang.org/protobuf/encoding/protowire"
)

// The Engine API streams BuildKit progress as JSON messages {"id": "moby.buildkit.trace", "aux":
// "<base64>"} whose aux is a protobuf moby.buildkit.v1.StatusResponse (buildkit
// api/services/control/control.proto). Only the fields rendered into the build log are decoded here,
// with protowire, so the pipeline does not depend on BuildKit's gRPC control API.

// Field numbers of control.proto.
const (
	fieldStatusVertexes = 1
	fieldStatusLogs     = 3
	fieldStatusWarnings = 4

	fieldVertexDigest    = 1
	fieldVertexName      = 3
	fieldVertexCached    = 4
	fieldVertexStarted   = 5
	fieldVertexCompleted = 6
	fieldVertexError     = 7

	fieldLogVertex = 1
	fieldLogMsg    = 4

	fieldWarningVertex = 1
	fieldWarningShort  = 3
)

type traceVertex struct {
	digest, name, err  string
	cached             bool
	started, completed bool
}

type traceLog struct {
	vertex string
	msg    []byte
}

type traceWarning struct {
	vertex, short string
}

type traceStatus struct {
	vertexes []traceVertex
	logs     []traceLog
	warnings []traceWarning
}

// decodeTraceAux decodes the aux value of a moby.buildkit.trace message: a JSON string holding the
// base64 protobuf.
func decodeTraceAux(aux json.RawMessage) (traceStatus, error) {
	var b64 string
	if err := json.Unmarshal(aux, &b64); err != nil {
		return traceStatus{}, fmt.Errorf("buildkit trace: %w", err)
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return traceStatus{}, fmt.Errorf("buildkit trace: %w", err)
	}
	return decodeStatus(raw)
}

var errProto = errors.New("buildkit trace: malformed protobuf")

// fields iterates over the fields of a protobuf message, calling fn with the field number, wire type
// and the raw value (bytes for length-delimited fields, the varint otherwise).
func fields(b []byte, fn func(num protowire.Number, typ protowire.Type, data []byte, v uint64)) error {
	for len(b) > 0 {
		num, typ, n := protowire.ConsumeTag(b)
		if n < 0 {
			return errProto
		}
		b = b[n:]
		switch typ {
		case protowire.BytesType:
			data, m := protowire.ConsumeBytes(b)
			if m < 0 {
				return errProto
			}
			fn(num, typ, data, 0)
			b = b[m:]
		case protowire.VarintType:
			v, m := protowire.ConsumeVarint(b)
			if m < 0 {
				return errProto
			}
			fn(num, typ, nil, v)
			b = b[m:]
		default:
			m := protowire.ConsumeFieldValue(num, typ, b)
			if m < 0 {
				return errProto
			}
			b = b[m:]
		}
	}
	return nil
}

func decodeStatus(b []byte) (traceStatus, error) {
	var st traceStatus
	var inner error
	err := fields(b, func(num protowire.Number, typ protowire.Type, data []byte, _ uint64) {
		if typ != protowire.BytesType || inner != nil {
			return
		}
		switch num {
		case fieldStatusVertexes:
			var v traceVertex
			inner = fields(data, func(n protowire.Number, t protowire.Type, d []byte, x uint64) {
				switch {
				case n == fieldVertexDigest && t == protowire.BytesType:
					v.digest = string(d)
				case n == fieldVertexName && t == protowire.BytesType:
					v.name = string(d)
				case n == fieldVertexCached && t == protowire.VarintType:
					v.cached = x != 0
				case n == fieldVertexStarted && t == protowire.BytesType:
					v.started = true
				case n == fieldVertexCompleted && t == protowire.BytesType:
					v.completed = true
				case n == fieldVertexError && t == protowire.BytesType:
					v.err = string(d)
				}
			})
			st.vertexes = append(st.vertexes, v)
		case fieldStatusLogs:
			var l traceLog
			inner = fields(data, func(n protowire.Number, t protowire.Type, d []byte, _ uint64) {
				switch {
				case n == fieldLogVertex && t == protowire.BytesType:
					l.vertex = string(d)
				case n == fieldLogMsg && t == protowire.BytesType:
					l.msg = bytes.Clone(d)
				}
			})
			st.logs = append(st.logs, l)
		case fieldStatusWarnings:
			var w traceWarning
			inner = fields(data, func(n protowire.Number, t protowire.Type, d []byte, _ uint64) {
				switch {
				case n == fieldWarningVertex && t == protowire.BytesType:
					w.vertex = string(d)
				case n == fieldWarningShort && t == protowire.BytesType:
					w.short = string(d)
				}
			})
			st.warnings = append(st.warnings, w)
		}
	})
	if err == nil {
		err = inner
	}
	return st, err
}

// traceRenderer turns BuildKit status updates into build log lines like BuildKit's plain progress
// output: "#3 [2/4] RUN pip install …", "#3 <output line>", "#3 DONE", "#3 CACHED", "#3 ERROR: …".
type traceRenderer struct {
	numbers map[string]int
	order   []string
	state   map[string]*vertexState
	emit    func(level, text string)
}

type vertexState struct {
	named, done bool
	partial     []byte
}

func newTraceRenderer(emit func(level, text string)) *traceRenderer {
	return &traceRenderer{numbers: map[string]int{}, state: map[string]*vertexState{}, emit: emit}
}

func (t *traceRenderer) vertex(digest string) (int, *vertexState) {
	n, ok := t.numbers[digest]
	if !ok {
		n = len(t.numbers) + 1
		t.numbers[digest] = n
		t.order = append(t.order, digest)
		t.state[digest] = &vertexState{}
	}
	return n, t.state[digest]
}

// render emits one status update: newly started vertexes, then the log output and warnings of the
// update, then the vertexes that completed (so a step's output comes before its DONE or ERROR line).
func (t *traceRenderer) render(st traceStatus) {
	for _, v := range st.vertexes {
		n, s := t.vertex(v.digest)
		if !s.named && v.name != "" && (v.started || v.cached || v.completed) {
			s.named = true
			t.emit(LevelInfo, fmt.Sprintf("#%d %s", n, v.name))
		}
	}
	for _, l := range st.logs {
		n, s := t.vertex(l.vertex)
		data := append(s.partial, l.msg...)
		lines := bytes.Split(data, []byte("\n"))
		s.partial = bytes.Clone(lines[len(lines)-1])
		for _, line := range lines[:len(lines)-1] {
			t.emit(LevelInfo, fmt.Sprintf("#%d %s", n, strings.TrimRight(string(line), "\r")))
		}
	}
	for _, w := range st.warnings {
		if ignoredWarning(w.short) {
			continue
		}
		n, _ := t.vertex(w.vertex)
		t.emit(LevelWarning, fmt.Sprintf("#%d %s", n, w.short))
	}
	for _, v := range st.vertexes {
		n, s := t.vertex(v.digest)
		if s.done || (!v.completed && !v.cached) {
			continue
		}
		s.done = true
		t.flush(n, s)
		switch {
		case v.err != "":
			t.emit(LevelInfo, fmt.Sprintf("#%d ERROR: %s", n, v.err))
		case v.cached:
			t.emit(LevelInfo, fmt.Sprintf("#%d CACHED", n))
		default:
			t.emit(LevelInfo, fmt.Sprintf("#%d DONE", n))
		}
	}
}

// ignoredWarning drops BuildKit's lint warning about `ARG SCANTOR_BASE` without a default: rule D3
// requires exactly that.
func ignoredWarning(short string) bool {
	return strings.HasPrefix(short, "InvalidDefaultArgInFrom") && strings.Contains(short, "SCANTOR_BASE")
}

// close flushes unterminated output lines.
func (t *traceRenderer) close() {
	for _, digest := range t.order {
		t.flush(t.numbers[digest], t.state[digest])
	}
}

func (t *traceRenderer) flush(n int, s *vertexState) {
	if len(s.partial) > 0 {
		t.emit(LevelInfo, fmt.Sprintf("#%d %s", n, string(s.partial)))
		s.partial = nil
	}
}
