package local

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/internal/fakeconn"
)

// recorder is a Sink that keeps the typed events and calls onEvent for each, outside its lock.
type recorder struct {
	mu      sync.Mutex
	events  []any
	onEvent func(ev any)
}

func (r *recorder) Emit(ev any) {
	r.mu.Lock()
	r.events = append(r.events, ev)
	r.mu.Unlock()
	if r.onEvent != nil {
		r.onEvent(ev)
	}
}

func (r *recorder) Err() error { return nil }

func (r *recorder) all() []any {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]any(nil), r.events...)
}

func (r *recorder) results() []ResultEvent {
	var out []ResultEvent
	for _, ev := range r.all() {
		if res, ok := ev.(ResultEvent); ok {
			out = append(out, res)
		}
	}
	return out
}

func (r *recorder) end(t *testing.T) EndEvent {
	t.Helper()
	all := r.all()
	if len(all) == 0 {
		t.Fatal("no events")
	}
	end, ok := all[len(all)-1].(EndEvent)
	if !ok {
		t.Fatalf("the last event is %T, not end", all[len(all)-1])
	}
	return end
}

// spawns counts the connector processes that started: the fake connector prints "importing fake" on
// stdout before its handshake, an unattributed log line.
func (r *recorder) spawns() int {
	n := 0
	for _, ev := range r.all() {
		if l, ok := ev.(LogEvent); ok && l.Seq == nil && l.Stream == "stdout" && l.Text == "importing fake" {
			n++
		}
	}
	return n
}

// fakeConfig is the runtime config of the fake connector in mode with the schedule kind schedule.
func fakeConfig(t *testing.T, mode, schedule string) runtime.Config {
	t.Helper()
	argv, extra := fakeconn.Command(mode)
	environ := append(os.Environ(), extra...)
	if schedule != "" {
		environ = append(environ, fakeconn.EnvSchedule+"="+schedule)
	}
	return runtime.Config{
		Language: "python", ConnectorCmd: strconv.Quote(argv[0]) + " " + argv[1],
		WorkRoot: filepath.Join(t.TempDir(), "scantor"), Environ: environ,
	}
}

// runStream runs local mode with Stream set and a recorder; opts may change the options first.
func runStream(t *testing.T, spec *Spec, cfg runtime.Config, rec *recorder, opts func(*Options)) int {
	t.Helper()
	o := Options{Spec: spec, Config: cfg, Stderr: os.Stderr, TaskDir: t.TempDir(), Events: rec, Stream: true}
	if opts != nil {
		opts(&o)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	code := Run(ctx, o)
	if end := rec.end(t); end.ExitCode != code {
		t.Fatalf("end exitCode %d, process exit code %d", end.ExitCode, code)
	}
	return code
}

// An unbounded schedule streams: results arrive while it still produces, and the queue between the
// producer and the lanes stays bounded.
func TestStreamResultsBeforeScheduleEnds(t *testing.T) {
	spec := baseSpec(t)
	spec.ScanConfig = json.RawMessage(`{"end":1000000000000}`)
	spec.Limit = 0
	spec.Processes = 2
	signals := make(chan os.Signal, 1)
	var mu sync.Mutex
	scheduled, results, maxPending := 0, 0, 0
	rec := &recorder{}
	rec.onEvent = func(ev any) {
		mu.Lock()
		defer mu.Unlock()
		switch ev.(type) {
		case ScheduledEvent:
			scheduled++
		case ResultEvent:
			results++
			if results == 20 {
				signals <- syscall.SIGINT
			}
		}
		maxPending = max(maxPending, scheduled-results)
	}
	code := runStream(t, spec, fakeConfig(t, "ok", "range"), rec, func(o *Options) { o.Signals = signals })
	end := rec.end(t)
	if code != ExitPlatform || end.Reason != ReasonInterrupted {
		t.Fatalf("exit %d, end %+v", code, end)
	}
	// 2 × processes queued, processes running and one item the blocked producer already announced.
	if limit := 3*spec.Processes + 1; maxPending > limit {
		t.Fatalf("%d items scheduled but not final at once; the bound is %d", maxPending, limit)
	}
	if results < 20 {
		t.Fatalf("%d results", results)
	}
	for _, ev := range rec.all() {
		if start, ok := ev.(StartEvent); ok && (start.Limit != 0 || start.Processes != 2) {
			t.Fatalf("start %+v", start)
		}
	}
}

func TestStreamLimit(t *testing.T) {
	spec := baseSpec(t)
	spec.ScanConfig = json.RawMessage(`{"end":10}`)
	spec.Limit = 3
	rec := &recorder{}
	if code := runStream(t, spec, fakeConfig(t, "ok", "range"), rec, nil); code != ExitOK {
		t.Fatalf("exit %d", code)
	}
	if n, end := len(rec.results()), rec.end(t); n != 3 || end.Reason != ReasonLimit || end.Summary.Succeeded != 3 {
		t.Fatalf("%d results, end %+v", n, end)
	}

	spec = baseSpec(t)
	spec.ScanConfig = json.RawMessage(`{"end":5}`)
	spec.Limit = 0
	rec = &recorder{}
	if code := runStream(t, spec, fakeConfig(t, "ok", "range"), rec, nil); code != ExitOK {
		t.Fatalf("exit %d", code)
	}
	if n, end := len(rec.results()), rec.end(t); n != 5 || end.Reason != ReasonDone {
		t.Fatalf("no limit: %d results, end %+v", n, end)
	}
}

// A custom schedule keeps the describe process while it produces (processes + 1 in total); a native
// template hands it to lane 0. Without Stream the first lane reuses it after the schedule was collected.
func TestStreamProcessCount(t *testing.T) {
	cases := []struct {
		name     string
		schedule string
		scan     string
		stream   bool
		spawns   int
	}{
		{"custom schedule", "custom", `{"count":3}`, true, 2},
		{"native template", "range", `{"end":3}`, true, 1},
		{"custom schedule collected", "custom", `{"count":3}`, false, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			spec := baseSpec(t)
			spec.ScanConfig = json.RawMessage(tc.scan)
			rec := &recorder{}
			code := runStream(t, spec, fakeConfig(t, "ok", tc.schedule), rec, func(o *Options) { o.Stream = tc.stream })
			if code != ExitOK || len(rec.results()) != 3 || rec.end(t).Reason != ReasonDone {
				t.Fatalf("exit %d, %d results, end %+v", code, len(rec.results()), rec.end(t))
			}
			if n := rec.spawns(); n != tc.spawns {
				t.Fatalf("%d connector processes, want %d", n, tc.spawns)
			}
		})
	}
}

// A schedule error stops production; the items already produced finish and the run exits 1.
func TestStreamScheduleFailure(t *testing.T) {
	spec := baseSpec(t)
	spec.ScanConfig = json.RawMessage(`{"count":5,"fatalAt":2}`)
	rec := &recorder{}
	code := runStream(t, spec, fakeConfig(t, "ok", "custom"), rec, nil)
	end := rec.end(t)
	if code != ExitFailures || end.Reason != ReasonScheduleFailed || len(rec.results()) != 2 || end.Summary.Succeeded != 2 {
		t.Fatalf("exit %d, %d results, end %+v", code, len(rec.results()), end)
	}
}

// The delay before the next attempt is capped at MaxDelay unless UncappedRetryDelay is set.
func TestStreamUncappedRetryDelay(t *testing.T) {
	for _, uncapped := range []bool{false, true} {
		spec := baseSpec(t)
		spec.AnalysisConfig = json.RawMessage(`{"mode":"retry","delayMs":5000}`)
		spec.MaxAttempts = 2
		spec.Backoff = api.Backoff{InitialMs: 1000, Factor: 2, MaxMs: 600000}
		signals := make(chan os.Signal, 1)
		var delay time.Duration
		rec := &recorder{}
		rec.onEvent = func(ev any) {
			if a, ok := ev.(AttemptEvent); ok {
				delay = a.NextAttemptAt.Sub(a.At.Time)
				signals <- syscall.SIGTERM // the wait for the next attempt ends with the abort
			}
		}
		code := runStream(t, spec, fakeConfig(t, "ok", ""), rec, func(o *Options) {
			o.Signals = signals
			o.UncappedRetryDelay = uncapped
			o.Stream = uncapped
		})
		if code != ExitPlatform || rec.end(t).Reason != ReasonInterrupted {
			t.Fatalf("uncapped %v: exit %d, end %+v", uncapped, code, rec.end(t))
		}
		if uncapped && (delay < 4900*time.Millisecond || delay > 5100*time.Millisecond) {
			t.Fatalf("uncapped delay %s, want 5s", delay)
		}
		if !uncapped && delay > MaxDelay+50*time.Millisecond {
			t.Fatalf("capped delay %s, want at most %s", delay, MaxDelay)
		}
	}
}

// Consecutive failed spawns of the lanes fail their items with platform errors and then abort the run.
func TestStreamSpawnFailuresAbort(t *testing.T) {
	initial, maximum := spawnBackoffInitial, spawnBackoffMax
	spawnBackoffInitial, spawnBackoffMax = 10*time.Millisecond, 40*time.Millisecond
	t.Cleanup(func() { spawnBackoffInitial, spawnBackoffMax = initial, maximum })

	// The connector command starts the fake connector once (describe and schedule) and fails afterwards.
	dir := t.TempDir()
	script := filepath.Join(dir, "connector.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nif [ -e \"$1\" ]; then echo 'cannot start' >&2; exit 3; fi\n: > \"$1\"\nexec \"$2\" '-test.run=^$'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := fakeConfig(t, "ok", "custom")
	argv, _ := fakeconn.Command("ok")
	cfg.ConnectorCmd = "/bin/sh " + strconv.Quote(script) + " " + strconv.Quote(filepath.Join(dir, "started")) + " " + strconv.Quote(argv[0])

	spec := baseSpec(t)
	spec.ScanConfig = json.RawMessage(`{"count":10}`)
	spec.Limit = 0
	rec := &recorder{}
	code := runStream(t, spec, cfg, rec, nil)
	end := rec.end(t)
	if code != ExitPlatform || end.Reason != ReasonStartFailed {
		t.Fatalf("exit %d, end %+v", code, end)
	}
	results := rec.results()
	if len(results) != maxSpawnFailures {
		t.Fatalf("%d results, want %d", len(results), maxSpawnFailures)
	}
	for _, res := range results {
		if res.Error == nil || res.Error.Type != api.ErrorPlatform || res.Error.Phase != api.PhaseBootstrap {
			t.Fatalf("result %+v", res)
		}
	}
}

// Closing Stop aborts the run with reason outputFailed and exit 3.
func TestStreamStopOutputFailed(t *testing.T) {
	spec := baseSpec(t)
	spec.ScanConfig = json.RawMessage(`{"end":1000000000000}`)
	spec.Limit = 0
	stop := make(chan struct{})
	var once sync.Once
	rec := &recorder{}
	rec.onEvent = func(ev any) {
		if _, ok := ev.(ResultEvent); ok {
			once.Do(func() { close(stop) })
		}
	}
	code := runStream(t, spec, fakeConfig(t, "ok", "range"), rec, func(o *Options) { o.Stop = stop })
	if end := rec.end(t); code != ExitPlatform || end.Reason != ReasonOutputFailed {
		t.Fatalf("exit %d, end %+v", code, end)
	}
}

// FileOwner owns the files directory and everything written below it.
func TestStreamFileOwner(t *testing.T) {
	owner := FileOwner{UID: os.Getuid(), GID: os.Getgid()}
	if os.Geteuid() == 0 {
		owner = FileOwner{UID: 4242, GID: 4343}
	}
	spec := baseSpec(t)
	spec.AnalysisConfig = json.RawMessage(`{"mode":"file","files":[{"name":"a.txt","content":"abc"}]}`)
	rec := &recorder{}
	if code := runStream(t, spec, fakeConfig(t, "ok", ""), rec, func(o *Options) { o.FileOwner = &owner }); code != ExitOK {
		t.Fatalf("exit %d", code)
	}
	files := rec.results()[0].Files
	if len(files) != 1 {
		t.Fatalf("files %+v", files)
	}
	file := filepath.Join(spec.OutDir, filepath.FromSlash(files[0].Path))
	for _, p := range []string{filepath.Join(spec.OutDir, "files"), filepath.Join(spec.OutDir, "files", "0"), filepath.Dir(file), file} {
		fi, err := os.Lstat(p)
		if err != nil {
			t.Fatal(err)
		}
		st := fi.Sys().(*syscall.Stat_t)
		if int(st.Uid) != owner.UID || int(st.Gid) != owner.GID {
			t.Fatalf("%s is owned by %d:%d, want %d:%d", p, st.Uid, st.Gid, owner.UID, owner.GID)
		}
	}
}
