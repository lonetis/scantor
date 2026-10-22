package pool

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/protocol"
	"github.com/lonetis/scantor/internal/runtime/internal/fakeconn"
)

func TestMain(m *testing.M) {
	if fakeconn.Active() {
		fakeconn.Main()
		return
	}
	os.Exit(m.Run())
}

func TestParseCommand(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"python -m scantor.serve {entry}", []string{"python", "-m", "scantor.serve", "main.py"}},
		{"{entry}", []string{"main.py"}},
		{`  xvfb-run  -a "python -m" {entry}  `, []string{"xvfb-run", "-a", "python -m", "main.py"}},
		{`a "b \"c\" \\d" e\f`, []string{"a", `b "c" \d`, `e\f`}},
		{`x"y z"w ""`, []string{"xy zw", ""}},
		{"a\tb\nc", []string{"a", "b", "c"}},
		{"--entry={entry}.bak", []string{"--entry=main.py.bak"}},
	}
	for _, c := range cases {
		got, err := ParseCommand(c.in, "main.py")
		if err != nil {
			t.Fatalf("%q: %v", c.in, err)
		}
		if strings.Join(got, "|") != strings.Join(c.want, "|") || len(got) != len(c.want) {
			t.Errorf("ParseCommand(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	for _, bad := range []string{`a "b`, "", "   "} {
		if _, err := ParseCommand(bad, "x"); err == nil {
			t.Errorf("ParseCommand(%q) succeeded", bad)
		}
	}
}

func TestResolveExecutable(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(bin, "tool")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "plain"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	env := []string{"PATH=/nonexistent:" + bin}
	if got, err := ResolveExecutable("tool", dir, env); err != nil || got != exe {
		t.Fatalf("PATH lookup: %q %v", got, err)
	}
	if got, err := ResolveExecutable("bin/tool", dir, env); err != nil || got != exe {
		t.Fatalf("relative path: %q %v", got, err)
	}
	if _, err := ResolveExecutable("plain", dir, env); err == nil {
		t.Fatal("non-executable resolved")
	}
	if _, err := ResolveExecutable("missing", dir, env); err == nil {
		t.Fatal("missing resolved")
	}
}

func TestConnectorEnv(t *testing.T) {
	env := ConnectorEnv([]string{
		"PATH=/bin", "SCANTOR_WORKER_TOKEN=swt_x.y", "SCANTOR_URL=http://o", "SCANTOR_CA_CERT=pem",
		"SCANTOR_ALLOW_INSECURE_TRANSPORT=true", "SCANTOR_DIND=1", "TMPDIR=/tmp", "SCANTOR_PROTOCOL_IN_FD=9",
	}, "/tmp/scantor/proc-2-1", 2)
	got := map[string]string{}
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		if _, dup := got[k]; dup {
			t.Fatalf("duplicate %s", k)
		}
		got[k] = v
	}
	for _, k := range protocol.RuntimeOnlyEnv {
		if _, ok := got[k]; ok {
			t.Fatalf("%s leaked into the connector environment", k)
		}
	}
	want := map[string]string{
		"PATH": "/bin", "SCANTOR_DIND": "1", "TMPDIR": "/tmp/scantor/proc-2-1", "SCANTOR_PROTOCOL_IN_FD": "3",
		"SCANTOR_PROTOCOL_OUT_FD": "4", "SCANTOR_PROTOCOL_VERSIONS": "1", "SCANTOR_PROCESS_INDEX": "2",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
}

type lines struct {
	mu  sync.Mutex
	got []string
}

func (l *lines) sink(stream, line string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.got = append(l.got, stream+": "+line)
}

func (l *lines) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.got...)
}

func spawnFake(t *testing.T, mode string, mutate ...func(*Options)) (*Process, error) {
	t.Helper()
	argv, extra := fakeconn.Command(mode)
	opts := Options{
		Argv: argv, Env: append(os.Environ(), extra...), Dir: t.TempDir(), Mode: protocol.ModeLocal,
		RuntimeVersion: "1.2.3",
		Limits:         protocol.Limits{MaxResultBytes: 1 << 20, MaxAnalysisConfigBytes: 1 << 16, MaxFileBytes: 1 << 30, MaxFilesPerAnalysis: 100},
		HelloTimeout:   5 * time.Second, ReadyTimeout: 5 * time.Second,
	}
	for _, m := range mutate {
		m(&opts)
	}
	p, err := Spawn(context.Background(), opts)
	if p != nil {
		t.Cleanup(func() { p.Kill(); <-p.Done() })
	}
	return p, err
}

func runCtx(dir string) protocol.Ctx {
	seq, round := int64(3), 1
	aid, eid := "s-3", "e"
	files := filepath.Join(dir, "files")
	_ = os.MkdirAll(files, 0o700)
	return protocol.Ctx{ScanID: "s", AnalysisID: &aid, Seq: &seq, Round: &round, Attempt: 1, ExecutionID: &eid, TmpDir: dir, FilesDir: &files}
}

// next returns the next event of c within 10 s.
func next(t *testing.T, c *Call) Event {
	t.Helper()
	select {
	case ev := <-c.Events():
		return ev
	case <-time.After(10 * time.Second):
		t.Fatal("no event within 10 s")
		return Event{}
	}
}

func TestHandshakeAndRun(t *testing.T) {
	out := &lines{}
	p, err := spawnFake(t, "ok", func(o *Options) { o.Output = out.sink })
	if err != nil {
		t.Fatal(err)
	}
	if p.Hello().Connector.Language != "python" || p.Hello().PID != p.PID() || p.ProtocolVersion() != 1 {
		t.Fatalf("hello %+v", p.Hello())
	}
	call, err := p.Run(runCtx(t.TempDir()), json.RawMessage(`{"mode":"log","name":"x"}`), json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Run(runCtx(t.TempDir()), json.RawMessage(`{}`), json.RawMessage(`{}`)); !errors.Is(err, ErrBusy) {
		t.Fatalf("second request: %v", err)
	}
	ev := next(t, call)
	res, ok := ev.Msg.(protocol.Result)
	if !ok || res.ID != call.ID || !strings.Contains(string(res.Result), "Hello, x!") {
		t.Fatalf("event %+v", ev)
	}
	call.End()
	p.Flush(time.Second)
	got := strings.Join(out.all(), "\n")
	for _, want := range []string{"stdout: importing fake", "stderr: importing fake", "stderr: [info] hello n=1 s=x"} {
		if !strings.Contains(got, want) {
			t.Errorf("output lacks %q:\n%s", want, got)
		}
	}
	p.Shutdown(5 * time.Second)
	if st := p.ExitStatus(); st.Code != 0 || st.KilledByRuntime {
		t.Fatalf("shutdown: %+v", st)
	}
}

func TestRequestSinkAttribution(t *testing.T) {
	def, req := &lines{}, &lines{}
	p, err := spawnFake(t, "ok", func(o *Options) { o.Output = def.sink })
	if err != nil {
		t.Fatal(err)
	}
	p.SetSink(req.sink)
	call, err := p.Run(runCtx(t.TempDir()), json.RawMessage(`{"mode":"stdout"}`), json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := next(t, call).Msg.(protocol.Result); !ok {
		t.Fatal("no result")
	}
	p.Flush(time.Second)
	call.End()
	p.ClearSink()
	got := strings.Join(req.all(), "\n")
	if !strings.Contains(got, `stdout: {"type":"result","id":"r0","result":{}}`) || !strings.Contains(got, "stderr: noise") {
		t.Fatalf("request output %q", got)
	}
}

func TestSpawnFailures(t *testing.T) {
	cases := map[string]func(*testing.T, *SpawnError){
		"nohello": func(t *testing.T, e *SpawnError) {
			if !strings.Contains(e.Reason, "did not send hello within") {
				t.Fatalf("%v", e)
			}
		},
		"badversion": func(t *testing.T, e *SpawnError) {
			if !e.Unsupported || !strings.Contains(e.Reason, "connector protocol 5..6 is not supported by runtime 1.2.3 (protocol 1..1)") {
				t.Fatalf("%v", e)
			}
		},
		"importerror": func(t *testing.T, e *SpawnError) {
			if e.Connector == nil || e.Connector.Type != "taskError" || !strings.Contains(e.Connector.Message, "boom at import") {
				t.Fatalf("%+v", e)
			}
		},
		"invalid": func(t *testing.T, e *SpawnError) {
			if e.Connector == nil || e.Connector.Type != "validation" {
				t.Fatalf("%+v", e)
			}
		},
		"exitbeforeready": func(t *testing.T, e *SpawnError) {
			if e.Exit == nil || e.Exit.Code != 3 || !strings.Contains(e.StderrTail, "cannot import") {
				t.Fatalf("%+v", e)
			}
		},
		"garbage": func(t *testing.T, e *SpawnError) {
			if !strings.Contains(e.Reason, "protocol violation") {
				t.Fatalf("%+v", e)
			}
		},
	}
	for mode, check := range cases {
		t.Run(mode, func(t *testing.T) {
			t.Parallel()
			_, err := spawnFake(t, mode, func(o *Options) { o.HelloTimeout = 500 * time.Millisecond })
			var se *SpawnError
			if !errors.As(err, &se) {
				t.Fatalf("err = %v", err)
			}
			check(t, se)
		})
	}
	_, err := Spawn(context.Background(), Options{Argv: []string{"/nonexistent/connector"}, Dir: t.TempDir()})
	var se *SpawnError
	if !errors.As(err, &se) || !strings.Contains(se.Reason, "cannot start") {
		t.Fatalf("missing binary: %v", err)
	}
}

func TestProtocolViolationsDuringRun(t *testing.T) {
	for _, mode := range []string{"garbage", "doubleReply"} {
		t.Run(mode, func(t *testing.T) {
			p, err := spawnFake(t, "ok")
			if err != nil {
				t.Fatal(err)
			}
			call, err := p.Run(runCtx(t.TempDir()), json.RawMessage(`{"mode":"`+mode+`"}`), json.RawMessage(`{}`))
			if err != nil {
				t.Fatal(err)
			}
			var violation error
			for violation == nil {
				ev := next(t, call)
				if ev.Exit != nil {
					t.Fatal("exit before the violation")
				}
				violation = ev.Violation
			}
			if ev := next(t, call); ev.Exit == nil || !ev.Exit.KilledByRuntime {
				t.Fatalf("after the violation: %+v", ev)
			}
			if p.Usable() {
				t.Fatal("a violating process stays usable")
			}
		})
	}
}

func TestCrashAndKillGroup(t *testing.T) {
	p, err := spawnFake(t, "ok")
	if err != nil {
		t.Fatal(err)
	}
	call, err := p.Run(runCtx(t.TempDir()), json.RawMessage(`{"mode":"exit"}`), json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	ev := next(t, call)
	if ev.Exit == nil || ev.Exit.Code != 3 || ev.Exit.KilledByRuntime {
		t.Fatalf("crash: %+v", ev)
	}

	out := &lines{}
	p2, err := spawnFake(t, "ok")
	if err != nil {
		t.Fatal(err)
	}
	p2.SetSink(out.sink)
	call, err = p2.Run(runCtx(t.TempDir()), json.RawMessage(`{"mode":"child"}`), json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	var child int
	deadline := time.Now().Add(10 * time.Second)
	for child == 0 && time.Now().Before(deadline) {
		for _, l := range out.all() {
			if s, ok := strings.CutPrefix(l, "stderr: child pid "); ok {
				child, _ = strconv.Atoi(s)
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if child == 0 {
		t.Fatal("child pid not reported")
	}
	p2.Kill()
	ev = next(t, call)
	if ev.Exit == nil || ev.Exit.Signal != "SIGKILL" || !ev.Exit.KilledByRuntime {
		t.Fatalf("kill: %+v", ev)
	}
	// The grandchild is in the connector's process group and must be gone too (it is reparented and
	// reaped by init or the test's subreaper; signal 0 then fails).
	gone := false
	for range 100 {
		if err := syscall.Kill(child, 0); err != nil {
			gone = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !gone {
		var pgid int
		pgid, _ = syscall.Getpgid(child)
		if pgid == p2.PID() {
			t.Fatalf("grandchild %d survived the process-group kill", child)
		}
	}
}

func TestCancelAndScheduleStream(t *testing.T) {
	p, err := spawnFake(t, "ok")
	if err != nil {
		t.Fatal(err)
	}
	call, err := p.Run(runCtx(t.TempDir()), json.RawMessage(`{"mode":"sleep","sleepMs":60000}`), json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := call.Cancel(protocol.CancelDrain); err != nil {
		t.Fatal(err)
	}
	ev := next(t, call)
	if e, ok := ev.Msg.(protocol.Error); !ok || e.Error.Type != "cancelled" {
		t.Fatalf("cancel: %+v", ev)
	}
	call.End()

	sched, err := p.Schedule(protocol.Ctx{ScanID: "s", Attempt: 1, TmpDir: t.TempDir()}, json.RawMessage(`{"count":5}`), json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	for i := range 5 {
		ev := next(t, sched)
		a, ok := ev.Msg.(protocol.Analysis)
		if !ok || string(a.Config) != `{"n":`+strconv.Itoa(i)+`}` {
			t.Fatalf("item %d: %+v", i, ev)
		}
	}
	if d, ok := next(t, sched).Msg.(protocol.Done); !ok || d.Count != 5 {
		t.Fatal("done")
	}
	sched.End()
}

func TestFlowThroughUnreadPipe(t *testing.T) {
	// While the consumer does not read events, the connector blocks on fd 4 (pipe backpressure).
	p, err := spawnFake(t, "ok")
	if err != nil {
		t.Fatal(err)
	}
	sched, err := p.Schedule(protocol.Ctx{ScanID: "s", Attempt: 1, TmpDir: t.TempDir()}, json.RawMessage(`{"count":20000,"itemBytes":100}`), json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if err := sched.Cancel(protocol.CancelStop); err != nil { // the connector still reads fd 3
		t.Fatal(err)
	}
	n := 0
	for {
		ev := next(t, sched)
		if _, ok := ev.Msg.(protocol.Analysis); ok {
			n++
			continue
		}
		if e, ok := ev.Msg.(protocol.Error); !ok || e.Error.Type != "cancelled" {
			t.Fatalf("end: %+v", ev)
		}
		break
	}
	if n == 0 || n >= 20000 {
		t.Fatalf("%d items before the cancel took effect", n)
	}
	sched.End()
}
