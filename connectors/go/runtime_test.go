package scantor_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	scantor "github.com/lonetis/scantor/connectors/go"
)

// schemasDir is the repository's schemas/ directory (the test image copies it to the same relative
// location next to the connector).
var schemasDir = filepath.Join("..", "..", "schemas")

var (
	protocolOnce  sync.Once
	protocolCheck func([]byte) error
	protocolErr   error
)

// protocolValidator validates connector lines against schemas/protocol (conformance case P1).
func protocolValidator(t *testing.T) func([]byte) error {
	t.Helper()
	protocolOnce.Do(func() {
		files, err := filepath.Glob(filepath.Join(schemasDir, "protocol", "*.json"))
		if err == nil && len(files) == 0 {
			err = os.ErrNotExist
		}
		if err != nil {
			protocolErr = err
			return
		}
		docs := map[string][]byte{}
		for _, f := range files {
			raw, err := os.ReadFile(f)
			if err != nil {
				protocolErr = err
				return
			}
			docs[filepath.Base(f)] = raw
		}
		protocolCheck, protocolErr = scantor.ProtocolValidator(docs)
	})
	if protocolErr != nil {
		t.Fatalf("load protocol schemas from %s: %v", schemasDir, protocolErr)
	}
	return protocolCheck
}

// msg is one decoded protocol message.
type msg map[string]any

func (m msg) str(key string) string {
	s, _ := m[key].(string)
	return s
}

func (m msg) obj(key string) msg {
	o, _ := m[key].(map[string]any)
	return o
}

func (m msg) num(key string) float64 {
	n, _ := m[key].(float64)
	return n
}

// fakeRuntime plays the runtime's side of the protocol against an in-process connector.
type fakeRuntime struct {
	t      *testing.T
	in     *io.PipeWriter
	lines  chan []byte
	exit   chan int
	stderr *lockedBuffer
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// start serves task over pipes. Every line the connector writes is checked against
// message.schema.json#/$defs/connectorToRuntime (conformance case P1).
func start(t *testing.T, task *scantor.Task) *fakeRuntime {
	t.Helper()
	check := protocolValidator(t)
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	rt := &fakeRuntime{t: t, in: inW, lines: make(chan []byte, 1<<16), exit: make(chan int, 1), stderr: &lockedBuffer{}}
	go func() {
		code := scantor.ServeStreams(task, inR, outW, rt.stderr)
		outW.Close()
		inR.Close()
		rt.exit <- code
	}()
	go func() {
		defer close(rt.lines)
		r := bufio.NewReaderSize(outR, 1<<20)
		for {
			line, err := r.ReadBytes('\n')
			if len(line) > 0 {
				if line[len(line)-1] != '\n' {
					t.Errorf("line without a trailing newline: %q", line)
				}
				if err := check(line); err != nil {
					t.Errorf("invalid protocol line %s: %v", truncate(line), err)
				}
				rt.lines <- line
			}
			if err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() { inW.Close() })
	return rt
}

func truncate(b []byte) string {
	if len(b) > 300 {
		return string(b[:300]) + "…"
	}
	return string(b)
}

func (rt *fakeRuntime) send(v any) {
	rt.t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		rt.t.Fatal(err)
	}
	if _, err := rt.in.Write(append(raw, '\n')); err != nil {
		rt.t.Fatalf("send %s: %v", raw, err)
	}
}

// next returns the next message within the timeout.
func (rt *fakeRuntime) next(timeout time.Duration) (msg, bool) {
	rt.t.Helper()
	select {
	case line, ok := <-rt.lines:
		if !ok {
			return nil, false
		}
		var m msg
		if err := json.Unmarshal(line, &m); err != nil {
			rt.t.Fatalf("decode %s: %v", line, err)
		}
		return m, true
	case <-time.After(timeout):
		rt.t.Fatalf("no message within %s (stderr: %s)", timeout, rt.stderr.String())
		return nil, false
	}
}

// expect returns the next message and checks its type.
func (rt *fakeRuntime) expect(typ string) msg {
	rt.t.Helper()
	m, ok := rt.next(10 * time.Second)
	if !ok {
		rt.t.Fatalf("connector closed its output, expected %s (stderr: %s)", typ, rt.stderr.String())
	}
	if m.str("type") != typ {
		rt.t.Fatalf("expected %s, got %v", typ, m)
	}
	return m
}

var defaultLimits = map[string]any{
	"maxLineBytes": 8388608, "maxResultBytes": 1048576, "maxAnalysisConfigBytes": 65536,
	"maxFileBytes": 1073741824, "maxFilesPerAnalysis": 100,
}

func (rt *fakeRuntime) welcome(limits map[string]any) {
	rt.send(map[string]any{
		"type": "welcome", "id": "hello", "protocolVersion": 1, "mode": "worker",
		"runtime": map[string]any{"version": "1.4.0"}, "limits": limits, "cancelGraceMs": 5000,
	})
}

// handshake performs hello → welcome → ready with the default limits.
func (rt *fakeRuntime) handshake() msg {
	rt.t.Helper()
	hello := rt.expect("hello")
	rt.welcome(defaultLimits)
	rt.expect("ready")
	return hello
}

// waitExit returns the connector's exit code.
func (rt *fakeRuntime) waitExit() int {
	rt.t.Helper()
	select {
	case code := <-rt.exit:
		return code
	case <-time.After(10 * time.Second):
		rt.t.Fatal("the connector did not exit")
		return -1
	}
}

// runCtx is a run ctx; dir must exist with tmp/ and files/.
func runCtx(dir string, seq int, deadlineMs any) map[string]any {
	return map[string]any{
		"scanId": "scan-1", "analysisId": "scan-1-" + itoa(seq), "seq": seq, "round": 1, "attempt": 2,
		"executionId": "exec-" + itoa(seq), "deadlineMs": deadlineMs,
		"tmpDir": filepath.Join(dir, "tmp"), "filesDir": filepath.Join(dir, "files"),
	}
}

func scheduleCtx(dir string) map[string]any {
	return map[string]any{
		"scanId": "scan-1", "analysisId": nil, "seq": nil, "round": nil, "attempt": 1,
		"executionId": nil, "deadlineMs": nil, "tmpDir": dir, "filesDir": nil,
	}
}

// execDir creates an execution directory with tmp/ and files/.
func execDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, sub := range []string{"tmp", "files"} {
		if err := os.Mkdir(filepath.Join(dir, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func itoa(i int) string { return strconv.Itoa(i) }
