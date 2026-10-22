package scantor_test

import (
	"context"
	"errors"
	"fmt"
	"iter"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	scantor "github.com/lonetis/scantor/connectors/go"
)

// echo mirrors the conformance fixture of docs/protocol.md §12.2 in Go.

type echoTaskConfig struct {
	Greeting string         `json:"greeting" jsonschema:"default=Hello"`
	APIToken scantor.Secret `json:"apiToken,omitempty"`
}

type echoAnalysisConfig struct {
	Name    string `json:"name" jsonschema:"default=world"`
	Mode    string `json:"mode" jsonschema:"default=ok"`
	SleepMs int    `json:"sleepMs" jsonschema:"default=0"`
	Bytes   int    `json:"bytes" jsonschema:"default=0"`
}

type echoCtx struct {
	ScanID         string `json:"scanId"`
	AnalysisID     string `json:"analysisId"`
	Seq            int64  `json:"seq"`
	Attempt        int    `json:"attempt"`
	HasDeadline    bool   `json:"hasDeadline"`
	TmpDirWritable bool   `json:"tmpDirWritable"`
}

type echoResult struct {
	Text         string            `json:"text" jsonschema:"minLength=1"`
	Ctx          echoCtx           `json:"ctx"`
	SecretLength int               `json:"secretLength"`
	Files        []scantor.FileRef `json:"files"`
}

var errBoom = errors.New("boom")

func echoRun(ctx scantor.Context, ac echoAnalysisConfig, tc echoTaskConfig) (echoResult, error) {
	res := echoResult{Text: tc.Greeting + ", " + ac.Name + "!", SecretLength: len(tc.APIToken)}
	_, hasDeadline := ctx.Deadline()
	res.Ctx = echoCtx{
		ScanID: ctx.ScanID(), AnalysisID: ctx.AnalysisID(), Seq: ctx.Seq(), Attempt: ctx.Attempt(),
		HasDeadline:    hasDeadline,
		TmpDirWritable: os.WriteFile(filepath.Join(ctx.TmpDir(), "probe"), []byte("x"), 0o644) == nil,
	}
	switch ac.Mode {
	case "fatal":
		return res, scantor.Fatal("fatal requested")
	case "retry":
		return res, scantor.Retry("retry requested", 0)
	case "retryAfter":
		return res, scantor.Retry("retry requested", 1500*time.Millisecond)
	case "throw":
		return res, fmt.Errorf("wrapped: %w", errBoom)
	case "panic":
		panic("boom")
	case "invalidResult":
		res.Text = ""
	case "sleep":
		select {
		case <-time.After(time.Duration(ac.SleepMs) * time.Millisecond):
		case <-ctx.Done():
			return res, ctx.Err()
		}
	case "sleepUncooperative":
		time.Sleep(time.Duration(ac.SleepMs) * time.Millisecond)
	case "oversized":
		res.Text = strings.Repeat("x", ac.Bytes)
	case "stdout":
		fmt.Println(`{"type":"result","id":"r0","result":{}}`)
		fmt.Fprintln(os.Stderr, "noise")
	case "log":
		ctx.Log(scantor.LevelInfo, "hello", "n", 1)
	case "progress":
		ctx.Progress(0.5, "half")
	case "file":
		a, err := ctx.Files().Put("a.bin", []byte("abc"), "application/octet-stream")
		if err != nil {
			return res, err
		}
		b, err := ctx.Files().Put("b.txt", []byte("hello"), "")
		if err != nil {
			return res, err
		}
		path := filepath.Join(ctx.TmpDir(), "c.json")
		if err := os.WriteFile(path, []byte(`{"c":1}`), 0o644); err != nil {
			return res, err
		}
		c, err := ctx.Files().PutFile("c.json", path, "")
		if err != nil {
			return res, err
		}
		if err := os.WriteFile(path, []byte("changed"), 0o644); err != nil {
			return res, err
		}
		res.Files = []scantor.FileRef{a, b, c}
	case "fileError":
		if _, err := ctx.Files().Put("ok.bin", []byte("x"), ""); err != nil {
			return res, err
		}
	case "badName":
		_, err := ctx.Files().Put("bad/name", []byte("x"), "")
		return res, err
	}
	return res, nil
}

func echoTask() *scantor.Task {
	return scantor.NewTask[echoTaskConfig, scantor.Empty, echoAnalysisConfig](nil, echoRun)
}

func run(rt *fakeRuntime, id string, ctx map[string]any, ac, tc any) {
	rt.send(map[string]any{"type": "run", "id": id, "ctx": ctx, "analysisConfig": ac, "taskConfig": tc})
}

func TestHandshake(t *testing.T) {
	rt := start(t, echoTask())
	hello := rt.handshake()
	if hello.str("id") != "hello" || hello.obj("protocol").num("min") != 1 || hello.obj("protocol").num("max") != 1 {
		t.Fatalf("hello: %v", hello)
	}
	conn := hello.obj("connector")
	if conn.str("language") != "go" || conn.str("version") != scantor.Version || conn.str("runtime") != runtime.Version() {
		t.Fatalf("connector: %v", conn)
	}
	if int(hello.num("pid")) != os.Getpid() {
		t.Fatalf("pid %v", hello["pid"])
	}
	rt.in.Close()
	if code := rt.waitExit(); code != 0 {
		t.Fatalf("exit code %d after end of input", code)
	}
}

func TestHandshakeRejectedByRuntime(t *testing.T) {
	rt := start(t, echoTask())
	rt.expect("hello")
	rt.send(map[string]any{"type": "error", "id": "hello", "error": map[string]any{"type": "validation", "message": "connector protocol 1..1 is not supported"}})
	if code := rt.waitExit(); code == 0 {
		t.Fatal("a rejected connector must exit non-zero")
	}
	if m, ok := rt.next(time.Second); ok {
		t.Fatalf("no message may follow a rejection, got %v", m)
	}
}

func TestInvalidDefinitions(t *testing.T) {
	type openConfig = map[string]any
	cases := map[string]*scantor.Task{
		"run is required": scantor.NewTask[echoTaskConfig, scantor.Empty, scantor.Empty, echoResult](nil, nil),
		"must be a struct": scantor.NewTask[openConfig, scantor.Empty, scantor.Empty](nil,
			func(scantor.Context, scantor.Empty, openConfig) (echoResult, error) { return echoResult{}, nil }),
		"result type": scantor.NewTask[scantor.Empty, scantor.Empty, scantor.Empty](nil,
			func(scantor.Context, scantor.Empty, scantor.Empty) (string, error) { return "", nil }),
		"not an integer": scantor.NewTask[struct {
			N int `json:"n" jsonschema:"default=abc"`
		}, scantor.Empty, scantor.Empty](nil, func(scantor.Context, scantor.Empty, struct {
			N int `json:"n" jsonschema:"default=abc"`
		}) (echoResult, error) {
			return echoResult{}, nil
		}),
	}
	for want, task := range cases {
		t.Run(want, func(t *testing.T) {
			rt := start(t, task)
			rt.expect("hello")
			rt.welcome(defaultLimits)
			e := rt.expect("error")
			if e.str("id") != "hello" || e.obj("error").str("type") != "validation" || !strings.Contains(e.obj("error").str("message"), want) {
				t.Fatalf("got %v", e)
			}
			if code := rt.waitExit(); code != 1 {
				t.Fatalf("exit code %d, want 1", code)
			}
		})
	}
}

func TestDescribe(t *testing.T) {
	rt := start(t, echoTask())
	rt.handshake()
	rt.send(map[string]any{"type": "describe", "id": "d1"})
	d := rt.expect("description")
	if d.str("id") != "d1" || d.obj("schedule").str("kind") != "template" || d.obj("schedule").str("template") != "single" {
		t.Fatalf("description: %v", d)
	}
	schemas := d.obj("schemas")
	tc := schemas.obj("taskConfig")
	if tc["additionalProperties"] != false || tc["required"] != nil {
		t.Fatalf("task config must be closed with no required fields: %v", tc)
	}
	props := tc.obj("properties")
	if props.obj("greeting")["default"] != "Hello" || props.obj("apiToken")["writeOnly"] != true {
		t.Fatalf("task config properties: %v", props)
	}
	ac := schemas.obj("analysisConfig")
	if ac["additionalProperties"] != false || len(ac.obj("properties")) != 4 {
		t.Fatalf("analysis config: %v", ac)
	}
	files := schemas.obj("result").obj("properties").obj("files").obj("items")
	if files["x-scantor"] != "file" {
		t.Fatalf("files items must carry x-scantor: %v", files)
	}
	empty := schemas.obj("scanConfig")
	if len(empty) != 3 || empty["type"] != "object" || empty["additionalProperties"] != false || len(empty.obj("properties")) != 0 {
		t.Fatalf("Empty: %v", empty)
	}
}

func TestDescribeScheduleKinds(t *testing.T) {
	custom := func(scantor.Context, scantor.Empty, scantor.Empty) iter.Seq2[scantor.Empty, error] { return nil }
	runEmpty := func(scantor.Context, scantor.Empty, scantor.Empty) (echoResult, error) { return echoResult{}, nil }
	if name := scantor.TemplateName(scantor.NewTask(custom, runEmpty)); name != "" {
		t.Fatalf("a custom schedule is reported as template %q", name)
	}
}

func TestRunEcho(t *testing.T) {
	rt := start(t, echoTask())
	rt.handshake()
	dir := execDir(t)
	deadline := time.Now().Add(time.Minute).UnixMilli()
	run(rt, "r1", runCtx(dir, 7, deadline), map[string]any{}, map[string]any{})
	r := rt.expect("result").obj("result")
	if r.str("text") != "Hello, world!" {
		t.Fatalf("result %v", r)
	}
	ctx := r.obj("ctx")
	if ctx.str("scanId") != "scan-1" || ctx.str("analysisId") != "scan-1-7" || ctx.num("seq") != 7 || ctx.num("attempt") != 2 ||
		ctx["hasDeadline"] != true || ctx["tmpDirWritable"] != true {
		t.Fatalf("ctx %v", ctx)
	}
	if files, ok := r["files"].([]any); !ok || len(files) != 0 {
		t.Fatalf("a nil slice must be sent as []: %v", r["files"])
	}
	run(rt, "r2", runCtx(dir, 8, nil), map[string]any{}, map[string]any{"greeting": "Hi", "apiToken": "s3cret"})
	r = rt.expect("result").obj("result")
	if r.str("text") != "Hi, world!" || r.num("secretLength") != 6 || r.obj("ctx")["hasDeadline"] != false {
		t.Fatalf("result %v", r)
	}
	// Fifty sequential runs on one process (R14).
	for i := range 50 {
		run(rt, "s"+itoa(i), runCtx(dir, i, nil), map[string]any{"name": itoa(i)}, map[string]any{})
		if got := rt.expect("result"); got.str("id") != "s"+itoa(i) {
			t.Fatalf("reply id %v", got)
		}
	}
}

func TestRunInvalidConfig(t *testing.T) {
	rt := start(t, echoTask())
	rt.handshake()
	dir := execDir(t)
	for i, ac := range []map[string]any{{"name": 5}, {"nmae": "x"}} {
		run(rt, "r"+itoa(i), runCtx(dir, i, nil), ac, map[string]any{})
		e := rt.expect("error").obj("error")
		if e.str("type") != "validation" || len(e.obj("details")["issues"].([]any)) == 0 {
			t.Fatalf("%v: %v", ac, e)
		}
	}
	run(rt, "rt", runCtx(dir, 3, nil), map[string]any{}, map[string]any{"greeting": 1})
	if e := rt.expect("error").obj("error"); e.str("type") != "validation" || !strings.Contains(e.str("message"), "task config") {
		t.Fatalf("task config: %v", e)
	}
}

func TestRunErrors(t *testing.T) {
	rt := start(t, echoTask())
	rt.handshake()
	dir := execDir(t)
	cases := []struct {
		mode, typ, message string
		delayMs            any
		stack              string
	}{
		{"fatal", "fatal", "fatal requested", nil, ""},
		{"retry", "retry", "retry requested", nil, ""},
		{"retryAfter", "retry", "retry requested", float64(1500), ""},
		{"throw", "taskError", "wrapped: boom", nil, ""},
		{"panic", "taskError", "panic: boom", nil, "conn_test.go"},
		{"invalidResult", "validation", "result is invalid: /text", nil, ""},
		{"badName", "validation", `file name "bad/name"`, nil, ""},
	}
	for i, tc := range cases {
		run(rt, "r"+itoa(i), runCtx(dir, i, nil), map[string]any{"mode": tc.mode}, map[string]any{})
		e := rt.expect("error")
		w := e.obj("error")
		if e.str("id") != "r"+itoa(i) || w.str("type") != tc.typ || !strings.Contains(w.str("message"), tc.message) || w["delayMs"] != tc.delayMs {
			t.Errorf("%s: %v", tc.mode, w)
		}
		if tc.stack != "" && !strings.Contains(w.str("stack"), tc.stack) {
			t.Errorf("%s: stack does not mention %s: %q", tc.mode, tc.stack, w.str("stack"))
		}
	}
}

func TestFatalfWraps(t *testing.T) {
	err := scantor.Fatalf("lookup failed: %w", errBoom)
	if !errors.Is(err, errBoom) || err.Error() != "lookup failed: boom" {
		t.Fatalf("Fatalf: %v", err)
	}
}

func TestOversizedResultIsSent(t *testing.T) {
	rt := start(t, echoTask())
	rt.handshake()
	run(rt, "r1", runCtx(execDir(t), 1, nil), map[string]any{"mode": "oversized", "bytes": 2 << 20}, map[string]any{})
	if r := rt.expect("result").obj("result"); len(r.str("text")) != 2<<20 {
		t.Fatal("the connector leaves the result size limit to the runtime (R6)")
	}
	run(rt, "r2", runCtx(execDir(t), 2, nil), map[string]any{"mode": "oversized", "bytes": 9 << 20}, map[string]any{})
	if e := rt.expect("error").obj("error"); e.str("type") != "validation" || !strings.Contains(e.str("message"), "line limit") {
		t.Fatalf("a result above the protocol line limit: %v", e)
	}
}

func TestCancel(t *testing.T) {
	for _, mode := range []string{"sleep", "sleepUncooperative"} {
		t.Run(mode, func(t *testing.T) {
			rt := start(t, echoTask())
			rt.handshake()
			run(rt, "r1", runCtx(execDir(t), 1, nil), map[string]any{"mode": mode, "sleepMs": 60000}, map[string]any{})
			time.Sleep(200 * time.Millisecond)
			sent := time.Now()
			rt.send(map[string]any{"type": "cancel", "id": "r1", "reason": "drain"})
			e := rt.expect("error")
			if w := e.obj("error"); e.str("id") != "r1" || w.str("type") != "cancelled" || w.str("message") != "cancelled: drain" {
				t.Fatalf("got %v", e)
			}
			if time.Since(sent) > 2*time.Second {
				t.Fatalf("cancellation took %s", time.Since(sent))
			}
		})
	}
}

func TestDeadline(t *testing.T) {
	rt := start(t, echoTask())
	rt.handshake()
	deadline := time.Now().Add(300 * time.Millisecond)
	run(rt, "r1", runCtx(execDir(t), 1, deadline.UnixMilli()), map[string]any{"mode": "sleep", "sleepMs": 60000}, map[string]any{})
	e := rt.expect("error").obj("error")
	if e.str("type") != "cancelled" || !strings.Contains(e.str("message"), "deadline") {
		t.Fatalf("got %v", e)
	}
	if time.Now().Before(deadline) || time.Since(deadline) > 2*time.Second {
		t.Fatalf("cancelled at the wrong time (deadline %s, now %s)", deadline, time.Now())
	}
}

func TestFiles(t *testing.T) {
	rt := start(t, echoTask())
	rt.handshake()
	dir := execDir(t)
	run(rt, "r1", runCtx(dir, 1, nil), map[string]any{"mode": "file"}, map[string]any{})
	wantContent := []string{"abc", "hello", `{"c":1}`}
	wantType := []any{"application/octet-stream", nil, nil}
	var refs []any
	for i := range 3 {
		f := rt.expect("file")
		if f.str("parent") != "r1" || f["contentType"] != wantType[i] {
			t.Fatalf("file %d: %v", i, f)
		}
		path := f.str("path")
		if filepath.Dir(path) != filepath.Join(dir, "files") {
			t.Fatalf("file %d outside filesDir: %s", i, path)
		}
		if got, _ := os.ReadFile(path); string(got) != wantContent[i] {
			t.Fatalf("file %d content %q", i, got)
		}
		ref := map[string]any{"id": "id-" + itoa(i), "name": f.str("name"), "size": len(wantContent[i]),
			"sha256": strings.Repeat("a", 64), "contentType": "application/octet-stream"}
		refs = append(refs, ref)
		rt.send(map[string]any{"type": "fileRef", "id": f.str("id"), "fileRef": ref})
	}
	r := rt.expect("result").obj("result")
	files := r["files"].([]any)
	for i := range refs {
		if files[i].(map[string]any)["id"] != refs[i].(map[string]any)["id"] {
			t.Fatalf("result files %v", files)
		}
	}
}

func TestFileErrors(t *testing.T) {
	rt := start(t, echoTask())
	rt.handshake()
	run(rt, "r1", runCtx(execDir(t), 1, nil), map[string]any{"mode": "fileError"}, map[string]any{})
	f := rt.expect("file")
	rt.send(map[string]any{"type": "error", "id": f.str("id"), "error": map[string]any{"type": "validation", "message": "harness says no", "retryable": false}})
	if e := rt.expect("error").obj("error"); e.str("type") != "validation" || e.str("message") != "harness says no" {
		t.Fatalf("got %v", e)
	}
	limits := map[string]any{}
	for k, v := range defaultLimits {
		limits[k] = v
	}
	limits["maxFilesPerAnalysis"] = 2
	rt2 := start(t, echoTask())
	rt2.expect("hello")
	rt2.welcome(limits)
	rt2.expect("ready")
	run(rt2, "r1", runCtx(execDir(t), 1, nil), map[string]any{"mode": "file"}, map[string]any{})
	for range 2 {
		f := rt2.expect("file")
		rt2.send(map[string]any{"type": "fileRef", "id": f.str("id"), "fileRef": map[string]any{
			"id": "x", "name": f.str("name"), "size": 1, "sha256": strings.Repeat("a", 64), "contentType": "application/octet-stream"}})
	}
	if e := rt2.expect("error").obj("error"); e.str("type") != "validation" || !strings.Contains(e.str("message"), "at most 2 files") {
		t.Fatalf("got %v", e)
	}
}

func TestLogsAndProgress(t *testing.T) {
	rt := start(t, echoTask())
	rt.handshake()
	dir := execDir(t)
	run(rt, "r1", runCtx(dir, 1, nil), map[string]any{"mode": "log"}, map[string]any{})
	l := rt.expect("log")
	if l.str("parent") != "r1" || l.str("level") != "info" || l.str("message") != "hello" || l.obj("fields").num("n") != 1 {
		t.Fatalf("log %v", l)
	}
	rt.expect("result")
	run(rt, "r2", runCtx(dir, 2, nil), map[string]any{"mode": "progress"}, map[string]any{})
	p := rt.expect("progress")
	if p.str("parent") != "r2" || p.num("fraction") != 0.5 || p.str("message") != "half" {
		t.Fatalf("progress %v", p)
	}
	rt.expect("result")
	run(rt, "r3", runCtx(dir, 3, nil), map[string]any{"mode": "stdout"}, map[string]any{})
	if r := rt.expect("result"); r.str("id") != "r3" {
		t.Fatalf("stdout output must not reach the protocol: %v", r)
	}
}

func TestUnknownRequestAndUnknownFields(t *testing.T) {
	rt := start(t, echoTask())
	rt.handshake()
	rt.send(map[string]any{"type": "frobnicate", "id": "z1"})
	e := rt.expect("error")
	if e.str("id") != "z1" || e.obj("error").str("type") != "validation" || e.obj("error").str("message") != "unsupported request frobnicate" {
		t.Fatalf("got %v", e)
	}
	rt.send(map[string]any{"type": "run", "id": "r1", "ctx": runCtx(execDir(t), 1, nil), "analysisConfig": map[string]any{},
		"taskConfig": map[string]any{}, "xFuture": 1})
	rt.expect("result")
}

func TestShutdown(t *testing.T) {
	rt := start(t, echoTask())
	rt.handshake()
	rt.send(map[string]any{"type": "shutdown", "id": "x1", "graceMs": 5000})
	if code := rt.waitExit(); code != 0 {
		t.Fatalf("exit code %d", code)
	}
}

// schedule mirrors the conformance fixture "schedule".

type scheduleScanConfig struct {
	Count   int  `json:"count" jsonschema:"default=3"`
	FailAt  *int `json:"failAt" jsonschema:"default=null"`
	FatalAt *int `json:"fatalAt" jsonschema:"default=null"`
	Invalid bool `json:"invalid,omitempty"`
}

type nAnalysisConfig struct {
	N    int      `json:"n" jsonschema:"required,minimum=0"`
	Tags []string `json:"tags,omitempty"`
}

type nResult struct {
	N int `json:"n"`
}

func scheduleN(ctx scantor.Context, sc scheduleScanConfig, _ scantor.Empty) iter.Seq2[nAnalysisConfig, error] {
	return func(yield func(nAnalysisConfig, error) bool) {
		for i := range sc.Count {
			if sc.FailAt != nil && *sc.FailAt == i {
				yield(nAnalysisConfig{}, errBoom)
				return
			}
			if sc.FatalAt != nil && *sc.FatalAt == i {
				yield(nAnalysisConfig{}, scantor.Fatal("fatal at "+itoa(i)))
				return
			}
			n := i
			if sc.Invalid {
				n = -1
			}
			if !yield(nAnalysisConfig{N: n}, nil) {
				return
			}
		}
	}
}

func runN(ctx scantor.Context, ac nAnalysisConfig, _ scantor.Empty) (nResult, error) {
	return nResult{N: ac.N}, nil
}

func scheduleTask() *scantor.Task { return scantor.NewTask(scheduleN, runN) }

func schedule(rt *fakeRuntime, id string, sc map[string]any, dir string) {
	rt.send(map[string]any{"type": "schedule", "id": id, "ctx": scheduleCtx(dir), "scanConfig": sc, "taskConfig": map[string]any{}})
}

func TestSchedule(t *testing.T) {
	rt := start(t, scheduleTask())
	rt.handshake()
	rt.send(map[string]any{"type": "describe", "id": "d1"})
	if d := rt.expect("description"); d.obj("schedule").str("kind") != "custom" {
		t.Fatalf("schedule kind %v", d.obj("schedule"))
	}
	dir := t.TempDir()
	schedule(rt, "s1", map[string]any{"count": 3, "failAt": nil, "fatalAt": nil}, dir)
	for i := range 3 {
		a := rt.expect("analysis")
		if a.str("id") != "s1" || a.obj("config").num("n") != float64(i) {
			t.Fatalf("item %d: %v", i, a)
		}
		if _, hasTags := a.obj("config")["tags"]; hasTags {
			t.Fatalf("omitempty fields stay omitted: %v", a)
		}
	}
	if d := rt.expect("done"); d.str("id") != "s1" || d.num("count") != 3 {
		t.Fatalf("done %v", d)
	}
	schedule(rt, "s2", map[string]any{"count": 0}, dir)
	if d := rt.expect("done"); d.num("count") != 0 {
		t.Fatalf("done %v", d)
	}
	schedule(rt, "s3", map[string]any{"count": 5, "failAt": 2}, dir)
	rt.expect("analysis")
	rt.expect("analysis")
	if e := rt.expect("error").obj("error"); e.str("type") != "taskError" || e.str("message") != "boom" {
		t.Fatalf("failAt: %v", e)
	}
	schedule(rt, "s4", map[string]any{"count": 5, "fatalAt": 0}, dir)
	if e := rt.expect("error").obj("error"); e.str("type") != "fatal" {
		t.Fatalf("fatalAt: %v", e)
	}
	schedule(rt, "s5", map[string]any{"count": 2, "invalid": true}, dir)
	if e := rt.expect("error").obj("error"); e.str("type") != "validation" || !strings.Contains(e.str("message"), "analysis config 0") {
		t.Fatalf("invalid item: %v", e)
	}
}

// TestScheduleBackpressure stalls reading fd 4 and checks that a cancel sent during the stall is
// still received (S5).
func TestScheduleBackpressure(t *testing.T) {
	rt := start(t, scheduleTask())
	rt.handshake()
	schedule(rt, "s1", map[string]any{"count": 100000}, t.TempDir())
	for i := range 1000 {
		if a := rt.expect("analysis"); a.obj("config").num("n") != float64(i) {
			t.Fatalf("item %d out of order", i)
		}
	}
	rt.send(map[string]any{"type": "cancel", "id": "s1", "reason": "stop"})
	for {
		m, ok := rt.next(10 * time.Second)
		if !ok {
			t.Fatal("output closed")
		}
		if m.str("type") == "analysis" {
			continue
		}
		if m.str("type") != "error" || m.obj("error").str("type") != "cancelled" || m.obj("error").str("message") != "cancelled: stop" {
			t.Fatalf("got %v", m)
		}
		break
	}
}

func TestFilesAndProgressInSchedule(t *testing.T) {
	var putErr error
	sched := func(ctx scantor.Context, _ scantor.Empty, _ scantor.Empty) iter.Seq2[nAnalysisConfig, error] {
		return func(yield func(nAnalysisConfig, error) bool) {
			_, putErr = ctx.Files().Put("a.txt", []byte("x"), "")
			ctx.Progress(0.5, "ignored")
			ctx.Log(scantor.Level("loud"), "unknown levels become info")
			if ctx.Seq() != -1 || ctx.AnalysisID() != "" {
				yield(nAnalysisConfig{}, errors.New("schedule ctx"))
				return
			}
			yield(nAnalysisConfig{N: 1}, nil)
		}
	}
	rt := start(t, scantor.NewTask(sched, runN))
	rt.handshake()
	schedule(rt, "s1", map[string]any{}, t.TempDir())
	if l := rt.expect("log"); l.str("level") != "info" || l.str("parent") != "s1" {
		t.Fatalf("log %v", l)
	}
	rt.expect("analysis")
	rt.expect("done")
	var e *scantor.Error
	if !errors.As(putErr, &e) || e.Type != "validation" || e.Message != "files are only available in run" {
		t.Fatalf("Put in schedule: %v", putErr)
	}
}

func TestCancelledContextIsVisible(t *testing.T) {
	cause := make(chan error, 1)
	runFn := func(ctx scantor.Context, _ scantor.Empty, _ scantor.Empty) (nResult, error) {
		<-ctx.Done()
		cause <- context.Cause(ctx)
		return nResult{}, ctx.Err()
	}
	rt := start(t, scantor.NewTask[scantor.Empty, scantor.Empty](nil, runFn))
	rt.handshake()
	run(rt, "r1", runCtx(execDir(t), 0, nil), map[string]any{}, map[string]any{})
	rt.send(map[string]any{"type": "cancel", "id": "r1", "reason": "stop"})
	rt.expect("error")
	if err := <-cause; err == nil || err.Error() != "cancelled: stop" {
		t.Fatalf("cause %v", err)
	}
}
