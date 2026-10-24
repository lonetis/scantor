package runner

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/protocol"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/amqpx"
	"github.com/lonetis/scantor/internal/runtime/internal/fakebroker"
	"github.com/lonetis/scantor/internal/runtime/internal/fakeconn"
	"github.com/lonetis/scantor/internal/runtime/pool"
	"github.com/lonetis/scantor/internal/runtime/scerr"
	"github.com/lonetis/scantor/internal/runtime/upload"
)

func TestMain(m *testing.M) {
	if fakeconn.Active() {
		fakeconn.Main()
		return
	}
	os.Exit(m.Run())
}

const (
	testScan   = "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f"
	testWorker = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
	testNode   = "2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a"
)

// broker adapts the fake broker to the Broker interface.
type broker struct{ *fakebroker.Broker }

func (b broker) Consume(ctx context.Context, tag string) (SlotChannel, error) {
	c, err := b.Broker.Consume(ctx, tag)
	if err != nil {
		return nil, err
	}
	return c, nil
}

// spawner starts the fake connector in mode.
type spawner struct {
	mode  string
	fail  atomic.Int32 // fail the next n spawns
	count atomic.Int32
}

func (s *spawner) Spawn(ctx context.Context, slot, gen int, output pool.Sink) (*pool.Process, error) {
	s.count.Add(1)
	mode := s.mode
	if s.fail.Load() > 0 {
		s.fail.Add(-1)
		mode = "exitbeforeready"
	}
	argv, extra := fakeconn.Command(mode)
	return pool.Spawn(ctx, pool.Options{
		Argv: argv, Env: append(os.Environ(), extra...), Dir: os.TempDir(), Mode: protocol.ModeWorker, RuntimeVersion: "1.0.0",
		Limits: protocol.Limits{MaxResultBytes: 1 << 20, MaxAnalysisConfigBytes: 1 << 16, MaxFileBytes: 1 << 20, MaxFilesPerAnalysis: 10},
		Output: output, HelloTimeout: 10 * time.Second, ReadyTimeout: 10 * time.Second,
	})
}

type fakeUploader struct {
	mu    sync.Mutex
	calls []upload.Target
	err   error
}

func (u *fakeUploader) Upload(_ context.Context, t upload.Target, _ []upload.File) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.calls = append(u.calls, t)
	return u.err
}

type harness struct {
	t        *testing.T
	b        *fakebroker.Broker
	w        *Worker
	spawner  *spawner
	uploader *fakeUploader
	boot     *api.Bootstrap
	statuses map[int64]api.AnalysisStatusItem
	polls    atomic.Int32
	reports  []scerr.ScantorError
	mu       sync.Mutex
	runDone  chan struct{}
	cancel   context.CancelFunc
}

func testBootstrap(processes int) *api.Bootstrap {
	return &api.Bootstrap{
		Action: api.ActionRun,
		Worker: api.BootstrapWorker{ID: testWorker, Role: api.RoleRunner, ScanID: testScan, NodeID: testNode},
		Scan: api.BootstrapScan{
			ID: testScan, State: "running", Round: 1, TaskConfig: json.RawMessage(`{"greeting":"Hi"}`),
			Settings: api.RuntimeSettings{
				Processes: processes, TimeoutMs: 5000, MaxAttempts: 2,
				Backoff: api.Backoff{InitialMs: 1000, Factor: 2, MaxMs: 60000}, MaxAnalysesPerProcess: 1000,
			},
		},
		AMQP: api.BootstrapAMQP{
			Queue: "scantor.scan." + testScan, AnalysesExchange: "scantor.analyses", ResultsExchange: "scantor.results",
			RoutingKey: testScan, ConsumerTimeoutMs: 10 * 60 * 1000,
		},
		Uploads: api.BootstrapUploads{Mode: "presigned", MaxFileBytes: 1 << 20, MaxFilesPerAnalysis: 10, TimeoutMs: 60000},
		Limits: api.BootstrapLimits{
			MaxAnalysisConfigBytes: 1 << 16, MaxResultBytes: 1 << 20, MaxResultMessageBytes: 2 << 20, LogTailBytes: 32 << 10,
			LogTailEarlierBytes: 4 << 10, StackBytes: 16 << 10, MaxAnalysesPerScan: 1 << 30, MaxProcessesPerWorker: 8,
		},
		Intervals: api.BootstrapIntervals{StatePollMs: 5000, DrainGraceMs: 8000},
	}
}

func newHarness(t *testing.T, mode string, mutate ...func(*api.Bootstrap)) *harness {
	t.Helper()
	boot := testBootstrap(1)
	for _, m := range mutate {
		m(boot)
	}
	h := &harness{t: t, b: fakebroker.New(), spawner: &spawner{mode: mode}, uploader: &fakeUploader{}, boot: boot, statuses: map[int64]api.AnalysisStatusItem{}, runDone: make(chan struct{})}
	h.w = New(Config{
		Boot: boot, WorkRoot: t.TempDir(), Spawner: h.spawner, Broker: broker{h.b}, Uploader: h.uploader,
		Status: func(_ context.Context, seqs []int64) (*api.AnalysesStatusResponse, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			resp := &api.AnalysesStatusResponse{}
			for _, s := range seqs {
				if item, ok := h.statuses[s]; ok {
					resp.Items = append(resp.Items, item)
				}
			}
			return resp, nil
		},
		Now:     time.Now,
		PollNow: func() { h.polls.Add(1) },
		Report: func(_ context.Context, _ bool, e scerr.ScantorError, _ string) {
			h.mu.Lock()
			h.reports = append(h.reports, e)
			h.mu.Unlock()
		},
		FreeSpace: func() (int64, error) { return 1 << 40, nil },
		Probe:     func(context.Context) bool { return true },
	})
	return h
}

func (h *harness) start() {
	h.t.Helper()
	if err := h.w.Start(context.Background()); err != nil {
		h.t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	go func() {
		h.w.Run(ctx)
		close(h.runDone)
	}()
	h.t.Cleanup(func() {
		h.w.Stop()
		select {
		case <-h.runDone:
		case <-time.After(20 * time.Second):
			h.t.Error("the worker did not stop")
		}
		cancel()
	})
}

func analysisBody(seq int64, attempt int, config string) []byte {
	b, _ := json.Marshal(runtime.AnalysisMessage{
		V: 1, AnalysisID: runtime.AnalysisID(testScan, seq), ScanID: testScan, Seq: seq, Round: 1, Attempt: attempt,
		Config: json.RawMessage(config), ScheduledAt: 1761040805000,
	})
	return b
}

// waitFor polls cond for up to 15 s.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// results returns the published bodies of type typ, decoded.
func (h *harness) published(typ string) []map[string]any {
	var out []map[string]any
	for _, p := range h.b.Published() {
		if p.Type != typ || p.Outcome != amqpx.Confirmed {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal(p.Body, &m); err != nil {
			h.t.Fatal(err)
		}
		out = append(out, m)
	}
	return out
}

func (h *harness) waitPublished(typ string, n int) []map[string]any {
	h.t.Helper()
	waitFor(h.t, typ+" messages", func() bool { return len(h.published(typ)) >= n })
	return h.published(typ)
}

func TestSucceededResult(t *testing.T) {
	h := newHarness(t, "ok")
	h.start()
	h.b.Enqueue(analysisBody(7, 1, `{"mode":"log","name":"x"}`))
	res := h.waitPublished(runtime.TypeResult, 1)[0]
	if res["status"] != "succeeded" || res["seq"] != float64(7) || res["kind"] != "result" || res["error"] != nil {
		t.Fatalf("result %v", res)
	}
	r := res["result"].(map[string]any)
	if r["text"] != "Hello, x!" {
		t.Fatalf("result %v", r)
	}
	if !strings.Contains(res["logTail"].(string), "[info] hello n=1 s=x") {
		t.Fatalf("log tail %q", res["logTail"])
	}
	if res["workerId"] != testWorker || res["nodeId"] != testNode || res["analysisId"] != testScan+"-7" {
		t.Fatalf("identity %v", res)
	}
	waitFor(t, "ack", func() bool {
		_, _, _, c := h.w.State()
		return c.Succeeded == 1
	})
	waitFor(t, "empty queue", func() bool { r, d := h.b.Ready(); return r == 0 && d == 0 })
	procs, busy, consuming, _ := h.w.State()
	if procs.Running != 1 || len(busy) != 0 || !consuming {
		t.Fatalf("state %+v %v %v", procs, busy, consuming)
	}
}

func TestRetryThenFailed(t *testing.T) {
	h := newHarness(t, "ok")
	h.start()
	h.b.Enqueue(analysisBody(1, 1, `{"mode":"throw"}`))
	att := h.waitPublished(runtime.TypeAttempt, 1)[0]
	errObj := att["error"].(map[string]any)
	if errObj["type"] != "taskError" || errObj["retryable"] != true || errObj["phase"] != "run" || att["attempt"] != float64(1) {
		t.Fatalf("attempt %v", att)
	}
	var retry fakebroker.Published
	for _, p := range h.b.Published() {
		if p.Type == runtime.TypeAnalysis {
			retry = p
		}
	}
	at, ok := retry.Headers[runtime.HeaderDeliveryTime].(int64)
	if !ok || time.Until(time.UnixMilli(at)) < 0 || time.Until(time.UnixMilli(at)) > 2*time.Second {
		t.Fatalf("delivery time %v", retry.Headers)
	}
	var republished runtime.AnalysisMessage
	if err := json.Unmarshal(retry.Body, &republished); err != nil || republished.Attempt != 2 || republished.ScheduledAt != 1761040805000 {
		t.Fatalf("republish %s", retry.Body)
	}
	res := h.waitPublished(runtime.TypeResult, 1)[0]
	e := res["error"].(map[string]any)
	if res["status"] != "failed" || res["attempt"] != float64(2) || e["type"] != "taskError" || e["retryable"] != true || e["attempt"] != float64(2) {
		t.Fatalf("final %v", res)
	}
	_, _, _, c := h.w.State()
	if c.Retried != 1 || c.Failed != 1 {
		t.Fatalf("counters %+v", c)
	}
}

func TestNonRetryableAndValidationErrors(t *testing.T) {
	h := newHarness(t, "ok")
	h.start()
	h.b.Enqueue(analysisBody(1, 1, `{"mode":"fatal"}`))
	h.b.Enqueue(analysisBody(2, 1, `{"mode":"validation"}`))
	h.b.Enqueue(analysisBody(3, 1, `{"mode":"badResult"}`))
	h.b.Enqueue(analysisBody(4, 1, `{"mode":"claimTimeout"}`))
	results := h.waitPublished(runtime.TypeResult, 4)
	bySeq := map[float64]map[string]any{}
	for _, r := range results {
		bySeq[r["seq"].(float64)] = r["error"].(map[string]any)
	}
	if e := bySeq[1]; e["type"] != "fatal" || e["retryable"] != false || e["phase"] != "run" {
		t.Errorf("fatal %v", e)
	}
	if e := bySeq[2]; e["type"] != "validation" || e["phase"] != "validate" || e["details"] == nil {
		t.Errorf("validation %v", e)
	}
	// A result that is not an object fails the protocol schema: a protocol violation, classified as crash.
	if e := bySeq[3]; e["type"] != "crash" || e["details"].(map[string]any)["protocolError"] == nil {
		t.Errorf("bad result %v", e)
	}
	if e := bySeq[4]; e["type"] != "taskError" || e["attempt"] != float64(2) { // a claimed timeout is a taskError
		t.Errorf("claimed timeout %v", e)
	}
	if n := len(h.published(runtime.TypeAttempt)); n != 2 {
		t.Errorf("%d attempt events, want 2 (the crash and the taskError are retried once)", n)
	}
}

func TestTimeoutRecyclesTheProcess(t *testing.T) {
	h := newHarness(t, "ok", func(b *api.Bootstrap) {
		b.Scan.Settings.TimeoutMs = 300
		b.Scan.Settings.MaxAttempts = 1
	})
	h.start()
	h.b.Enqueue(analysisBody(1, 1, `{"mode":"sleepUncooperative","sleepMs":20000}`))
	res := h.waitPublished(runtime.TypeResult, 1)[0]
	e := res["error"].(map[string]any)
	if e["type"] != "timeout" || e["message"] != "run exceeded 300 ms" || e["retryable"] != true {
		t.Fatalf("timeout %v", e)
	}
	waitFor(t, "respawn", func() bool { return h.spawner.count.Load() >= 2 })
	h.b.Enqueue(analysisBody(2, 1, `{}`))
	h.waitPublished(runtime.TypeResult, 2)
}

func TestCrashDetails(t *testing.T) {
	h := newHarness(t, "ok", func(b *api.Bootstrap) { b.Scan.Settings.MaxAttempts = 1 })
	h.start()
	h.b.Enqueue(analysisBody(1, 1, `{"mode":"exit"}`))
	res := h.waitPublished(runtime.TypeResult, 1)[0]
	e := res["error"].(map[string]any)
	d := e["details"].(map[string]any)
	if e["type"] != "crash" || d["exitCode"] != float64(3) || d["oomKilled"] != false {
		t.Fatalf("crash %v", e)
	}
	h.b.Enqueue(analysisBody(2, 1, `{"mode":"garbage"}`))
	res = h.waitPublished(runtime.TypeResult, 2)[1]
	e = res["error"].(map[string]any)
	if e["type"] != "crash" || e["details"].(map[string]any)["protocolError"] == nil {
		t.Fatalf("protocol violation %v", e)
	}
}

func TestRedeliveredSkipAndMalformed(t *testing.T) {
	h := newHarness(t, "ok")
	succeeded, round := "succeeded", 1
	h.statuses[5] = api.AnalysisStatusItem{Seq: 5, Status: &succeeded, Round: &round}
	h.start()
	h.b.EnqueueRedelivered(analysisBody(5, 1, `{}`))
	waitFor(t, "skip", func() bool { _, _, _, c := h.w.State(); return c.RedeliveredSkipped == 1 })
	if len(h.published(runtime.TypeResult)) != 0 {
		t.Fatal("a skipped redelivery published")
	}
	h.b.EnqueueRedelivered(analysisBody(6, 1, `{}`)) // unknown: runs
	h.waitPublished(runtime.TypeResult, 1)

	bad := analysisBody(8, 1, `{}`)
	bad = []byte(strings.Replace(string(bad), testScan+"-8", testScan+"-9", 1))
	h.b.Enqueue(bad)
	res := h.waitPublished(runtime.TypeResult, 2)[1]
	e := res["error"].(map[string]any)
	if e["type"] != "validation" || e["phase"] != "validate" || !strings.Contains(e["message"].(string), "malformed analysis message: analysisId") {
		t.Fatalf("malformed %v", res)
	}
	h.b.Enqueue([]byte(`not json`))
	waitFor(t, "report", func() bool { h.mu.Lock(); defer h.mu.Unlock(); return len(h.reports) == 1 })
	waitFor(t, "drop", func() bool { r, _ := h.b.Ready(); return r == 0 })

	big := `{"pad":"` + strings.Repeat("x", 70000) + `"}`
	h.b.Enqueue(analysisBody(10, 1, big))
	res = h.waitPublished(runtime.TypeResult, 3)[2]
	if e := res["error"].(map[string]any); !strings.Contains(e["message"].(string), "analysis config is") {
		t.Fatalf("config size %v", e)
	}
}

func TestFilesAreUploadedAfterSuccess(t *testing.T) {
	h := newHarness(t, "ok")
	h.start()
	h.b.Enqueue(analysisBody(1, 1, `{"mode":"file","files":[{"name":"a.bin","content":"abc"}]}`))
	res := h.waitPublished(runtime.TypeResult, 1)[0]
	files := res["files"].([]any)
	if len(files) != 1 || files[0].(map[string]any)["sha256"] != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Fatalf("files %v", files)
	}
	if len(h.uploader.calls) != 1 || h.uploader.calls[0].Seq != 1 {
		t.Fatalf("uploads %+v", h.uploader.calls)
	}
	h.uploader.mu.Lock()
	h.uploader.err = scerr.New(api.ErrorPlatform, api.PhaseUpload, "storage quota exceeded")
	h.uploader.mu.Unlock()
	h.b.Enqueue(analysisBody(2, 1, `{"mode":"file","files":[{"name":"a.bin","content":"abc"}]}`))
	res = h.waitPublished(runtime.TypeResult, 2)[1]
	e := res["error"].(map[string]any)
	if res["status"] != "failed" || e["type"] != "platform" || e["phase"] != "upload" || e["retryable"] != false || len(res["files"].([]any)) != 0 {
		t.Fatalf("quota %v", res)
	}
}

func TestPublishNacksAreRetriedAndExhaustTheBudget(t *testing.T) {
	h := newHarness(t, "ok", func(b *api.Bootstrap) { b.AMQP.ConsumerTimeoutMs = 61500 })
	var nacks atomic.Int32
	h.b.Outcome = func(pub amqpx.Publication) amqpx.Outcome {
		if pub.Type == runtime.TypeResult && nacks.Add(1) <= 2 {
			return amqpx.Nacked
		}
		return amqpx.Confirmed
	}
	h.start()
	h.b.Enqueue(analysisBody(1, 1, `{}`))
	h.waitPublished(runtime.TypeResult, 1)
	if !h.w.Health().Healthy() {
		t.Fatal("two transient failures made the worker unhealthy")
	}

	// Every publish is nacked: the 1.5 s budget runs out, the delivery is given back and the worker is
	// unhealthy.
	h.b.Outcome = func(amqpx.Publication) amqpx.Outcome { return amqpx.Nacked }
	h.b.Enqueue(analysisBody(2, 1, `{}`))
	waitFor(t, "unhealthy", func() bool { return !h.w.Health().Healthy() })
	waitFor(t, "give back", func() bool { r, _ := h.b.Ready(); return r == 1 })
	if h.b.Consumers() != 0 {
		t.Fatal("an unhealthy worker consumes")
	}
	waitFor(t, "report", func() bool { h.mu.Lock(); defer h.mu.Unlock(); return len(h.reports) >= 1 })
}

func TestBrokerCancelDetachesTheDelivery(t *testing.T) {
	h := newHarness(t, "ok")
	h.start()
	h.b.Enqueue(analysisBody(1, 1, `{"mode":"sleep","sleepMs":600}`))
	waitFor(t, "busy", func() bool { _, busy, _, _ := h.w.State(); return len(busy) == 1 })
	h.b.CancelConsumers() // the message returns to the queue
	res := h.waitPublished(runtime.TypeResult, 1)[0]
	if res["status"] != "succeeded" {
		t.Fatalf("detached result %v", res)
	}
	// The slot re-consumes and runs the returned (redelivered) message again; duplicates are harmless.
	h.waitPublished(runtime.TypeResult, 2)
}

func TestReturnedRepublishDropsThePlan(t *testing.T) {
	h := newHarness(t, "ok")
	h.b.Outcome = func(pub amqpx.Publication) amqpx.Outcome {
		if pub.Type == runtime.TypeAnalysis {
			return amqpx.Returned
		}
		return amqpx.Confirmed
	}
	h.start()
	h.b.Enqueue(analysisBody(1, 1, `{"mode":"retry"}`))
	h.waitPublished(runtime.TypeAttempt, 1)
	waitFor(t, "poll", func() bool { return h.polls.Load() >= 1 })
}

func TestResize(t *testing.T) {
	h := newHarness(t, "ok")
	h.start()
	h.w.Resize(3)
	waitFor(t, "3 slots", func() bool { p, _, _, _ := h.w.State(); return p.Running == 3 })
	h.w.Resize(100) // clamped to maxProcessesPerWorker (8)
	waitFor(t, "8 slots", func() bool { p, _, _, _ := h.w.State(); return p.Running == 8 })
	h.w.Resize(2)
	waitFor(t, "2 slots", func() bool { p, _, _, _ := h.w.State(); return p.Running == 2 && h.b.Consumers() == 2 })
	for i := range 6 {
		h.b.Enqueue(analysisBody(int64(i), 1, `{}`))
	}
	h.waitPublished(runtime.TypeResult, 6)
}

func TestMaxAnalysesPerProcessRecycles(t *testing.T) {
	h := newHarness(t, "ok", func(b *api.Bootstrap) { b.Scan.Settings.MaxAnalysesPerProcess = 2 })
	h.start()
	for i := range 5 {
		h.b.Enqueue(analysisBody(int64(i), 1, `{}`))
	}
	h.waitPublished(runtime.TypeResult, 5)
	waitFor(t, "3 processes", func() bool { return h.spawner.count.Load() >= 3 })
}

func TestDrain(t *testing.T) {
	h := newHarness(t, "ok", func(b *api.Bootstrap) {
		b.Scan.Settings.Processes = 2
		b.Intervals.DrainGraceMs = 7000 // cancel{drain} at 1 s, kill at 6 s
		b.Scan.Settings.TimeoutMs = 60000
	})
	h.start()
	h.b.Enqueue(analysisBody(1, 1, `{"mode":"sleep","sleepMs":300}`))
	h.b.Enqueue(analysisBody(2, 1, `{"mode":"sleep","sleepMs":30000}`))
	waitFor(t, "both busy", func() bool { _, busy, _, _ := h.w.State(); return len(busy) == 2 })
	h.w.Drain()
	select {
	case <-h.runDone:
	case <-time.After(10 * time.Second):
		t.Fatal("drain did not finish")
	}
	results := h.published(runtime.TypeResult)
	if len(results) != 1 || results[0]["seq"] != float64(1) {
		t.Fatalf("results %v", results)
	}
	if r, _ := h.b.Ready(); r != 1 {
		t.Fatalf("the cancelled analysis was not given back: %d ready", r)
	}
}

func TestStopPublishesNothing(t *testing.T) {
	h := newHarness(t, "ok", func(b *api.Bootstrap) { b.Scan.Settings.TimeoutMs = 60000 })
	h.start()
	h.b.Enqueue(analysisBody(1, 1, `{"mode":"sleep","sleepMs":30000}`))
	waitFor(t, "busy", func() bool { _, busy, _, _ := h.w.State(); return len(busy) == 1 })
	start := time.Now()
	h.w.Stop()
	select {
	case <-h.runDone:
	case <-time.After(10 * time.Second):
		t.Fatal("stop did not finish")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatalf("stop took %s although the connector replied to cancel", time.Since(start))
	}
	if n := len(h.b.Published()); n != 0 {
		t.Fatalf("stop published %d messages", n)
	}
}

func TestBlockedConnectionStopsConsuming(t *testing.T) {
	h := newHarness(t, "ok")
	h.start()
	waitFor(t, "consuming", func() bool { return h.b.Consumers() == 1 })
	h.b.SetBlocked(true)
	waitFor(t, "not consuming", func() bool { _, _, consuming, _ := h.w.State(); return h.b.Consumers() == 0 && !consuming })
	h.b.Enqueue(analysisBody(1, 1, `{}`))
	time.Sleep(200 * time.Millisecond)
	if len(h.b.Published()) != 0 {
		t.Fatal("published while blocked")
	}
	h.b.SetBlocked(false)
	h.waitPublished(runtime.TypeResult, 1)
}

func TestStartupFailure(t *testing.T) {
	h := newHarness(t, "importerror")
	start := time.Now()
	err := h.w.Start(context.Background())
	var se *StartError
	if !errors.As(err, &se) {
		t.Fatalf("start: %v", err)
	}
	var spawnErr *pool.SpawnError
	if !errors.As(err, &spawnErr) || spawnErr.Connector == nil || spawnErr.Connector.Type != "taskError" {
		t.Fatalf("spawn error %#v", err)
	}
	if elapsed := time.Since(start); elapsed < 7*time.Second || h.spawner.count.Load() != 4 {
		t.Fatalf("retries: %d spawns in %s", h.spawner.count.Load(), elapsed)
	}
}

func TestLaterSpawnFailuresMakeTheWorkerUnhealthy(t *testing.T) {
	h := newHarness(t, "ok", func(b *api.Bootstrap) { b.Scan.Settings.MaxAttempts = 1 })
	h.start()
	h.spawner.fail.Store(3)
	h.b.Enqueue(analysisBody(1, 1, `{"mode":"exit"}`)) // the process dies; respawns fail 3 times
	waitFor(t, "unhealthy", func() bool { return !h.w.Health().Healthy() })
	reason, _ := h.w.Health().Reason()
	if reason.Phase != api.PhaseBootstrap {
		t.Fatalf("reason %+v", reason)
	}
}

// publishedAnalyses returns the retry republishes the broker saw with outcome out.
func (h *harness) publishedAnalyses(out amqpx.Outcome) []fakebroker.Published {
	var got []fakebroker.Published
	for _, p := range h.b.Published() {
		if p.Type == runtime.TypeAnalysis && p.Outcome == out {
			got = append(got, p)
		}
	}
	return got
}

// at returns the time a message of type typ for seq (and attempt, when > 0) was published and confirmed.
func (h *harness) at(typ string, seq float64, attempt float64) time.Time {
	for _, p := range h.b.Published() {
		var m map[string]any
		if p.Type != typ || p.Outcome != amqpx.Confirmed || json.Unmarshal(p.Body, &m) != nil {
			continue
		}
		if m["seq"] == seq && (attempt == 0 || m["attempt"] == attempt) {
			return p.At
		}
	}
	return time.Time{}
}

// A full scan queue nacks future-dated publishes too (RabbitMQ 4.4, docs/queue.md §3.3). The refused retry is
// backpressure, not a platform failure: the slot holds the delivery, republishes until the retry is due and then
// runs the next attempt on the held delivery.
func TestRetryRefusedByAFullQueueRunsOnTheHeldDelivery(t *testing.T) {
	h := newHarness(t, "ok")
	h.b.SetMaxLength(3)
	h.b.Enqueue(analysisBody(1, 1, `{"mode":"flaky","failAttempts":1}`))
	for seq := int64(2); seq <= 6; seq++ {
		h.b.Enqueue(analysisBody(seq, 1, `{"name":"later"}`))
	}
	h.start()
	results := h.waitPublished(runtime.TypeResult, 6)
	first := results[0]
	if first["seq"] != float64(1) || first["status"] != "succeeded" || first["attempt"] != float64(2) {
		t.Fatalf("the retried analysis %v", first)
	}
	attempts := h.published(runtime.TypeAttempt)
	if len(attempts) != 1 || attempts[0]["seq"] != float64(1) || attempts[0]["attempt"] != float64(1) {
		t.Fatalf("attempt events %v", attempts)
	}
	if n := len(h.publishedAnalyses(amqpx.Nacked)); n < 2 {
		t.Fatalf("%d refused republishes, want at least 2 (held until due)", n)
	}
	if n := len(h.publishedAnalyses(amqpx.Confirmed)); n != 0 {
		t.Fatalf("%d republishes accepted by a full queue", n)
	}
	// The next attempt waited for its backoff (1 s) although it ran on the held delivery.
	if gap := h.at(runtime.TypeResult, 1, 2).Sub(h.at(runtime.TypeAttempt, 1, 1)); gap < 900*time.Millisecond {
		t.Fatalf("the next attempt ran %s after the failed one; the backoff is 1 s", gap)
	}
	if !h.w.Health().Healthy() || len(h.reports) != 0 {
		t.Fatalf("a full queue made the worker unhealthy: %v", h.reports)
	}
	_, _, _, c := h.w.State()
	if c.Retried != 1 || c.Succeeded != 6 {
		t.Fatalf("counters %+v", c)
	}
	waitFor(t, "empty queue", func() bool { r, d := h.b.Ready(); return r == 0 && d == 0 })
}

// Once the queue has room again (at most 80 % of x-max-length), the held retry is republished before it is due
// and runs as a delivery of its own.
func TestHeldRetryIsRepublishedWhenTheQueueHasRoom(t *testing.T) {
	h := newHarness(t, "ok", func(b *api.Bootstrap) { b.Scan.Settings.Processes = 2 })
	h.b.SetMaxLength(4)
	h.b.Enqueue(analysisBody(1, 1, `{"mode":"retry","delayMs":4000}`))
	for seq := int64(2); seq <= 7; seq++ {
		h.b.Enqueue(analysisBody(seq, 1, `{"mode":"sleep","sleepMs":100}`))
	}
	h.start()
	waitFor(t, "a confirmed republish", func() bool { return len(h.publishedAnalyses(amqpx.Confirmed)) == 1 })
	if len(h.publishedAnalyses(amqpx.Nacked)) == 0 {
		t.Fatal("the full queue accepted the retry at once")
	}
	retry := h.publishedAnalyses(amqpx.Confirmed)[0]
	at, ok := retry.Headers[runtime.HeaderDeliveryTime].(int64)
	if !ok || time.UnixMilli(at).Before(retry.At.Add(900*time.Millisecond)) {
		t.Fatalf("delivery time %v of a republish at %s", retry.Headers, retry.At)
	}
	res := h.waitPublished(runtime.TypeResult, 7)
	for _, r := range res {
		if r["seq"] == float64(1) && (r["status"] != "failed" || r["attempt"] != float64(2)) {
			t.Fatalf("the retried analysis %v", r)
		}
	}
	if !h.w.Health().Healthy() {
		t.Fatal("a full queue made the worker unhealthy")
	}
}

// When the holding budget cannot cover another attempt, the refused delivery is given back with nack-requeue
// (uncounted, nothing lost) and the worker stays healthy.
func TestRefusedRetryIsGivenBackWhenTheBudgetCannotCoverAnAttempt(t *testing.T) {
	h := newHarness(t, "ok", func(b *api.Bootstrap) { b.AMQP.ConsumerTimeoutMs = 62500 }) // a 2.5 s budget
	h.b.SetMaxLength(1)
	h.b.Enqueue(analysisBody(1, 1, `{"mode":"flaky","failAttempts":1}`))
	h.b.Enqueue(analysisBody(2, 1, `{}`))
	h.b.Enqueue(analysisBody(3, 1, `{}`))
	h.start()
	// The analysis is given back after its budget and runs its first attempt again.
	waitFor(t, "two attempt events", func() bool { return len(h.published(runtime.TypeAttempt)) >= 2 })
	if len(h.published(runtime.TypeResult)) != 0 || len(h.publishedAnalyses(amqpx.Confirmed)) != 0 {
		t.Fatal("published although the queue refused the retry")
	}
	for _, a := range h.published(runtime.TypeAttempt) {
		if a["seq"] != float64(1) || a["attempt"] != float64(1) {
			t.Fatalf("attempt event %v", a)
		}
	}
	if !h.w.Health().Healthy() {
		t.Fatal("a full queue made the worker unhealthy")
	}
	h.b.SetMaxLength(0)
	h.waitPublished(runtime.TypeResult, 3)
	if len(h.publishedAnalyses(amqpx.Confirmed)) == 0 {
		t.Fatal("the retry was never republished")
	}
}

// The next attempt on a held delivery needs a new process when the failed one crashed: the slot respawns within
// the holding budget.
func TestHeldDeliveryRespawnsACrashedProcess(t *testing.T) {
	h := newHarness(t, "ok")
	h.b.SetMaxLength(1)
	h.b.Enqueue(analysisBody(1, 1, `{"mode":"flaky","failAttempts":1,"failWith":"exit"}`))
	h.b.Enqueue(analysisBody(2, 1, `{}`))
	h.b.Enqueue(analysisBody(3, 1, `{}`))
	h.start()
	res := h.waitPublished(runtime.TypeResult, 3)[0]
	if res["seq"] != float64(1) || res["status"] != "succeeded" || res["attempt"] != float64(2) {
		t.Fatalf("result %v", res)
	}
	att := h.published(runtime.TypeAttempt)
	if len(att) != 1 || att[0]["error"].(map[string]any)["type"] != "crash" {
		t.Fatalf("attempt events %v", att)
	}
	if h.spawner.count.Load() < 2 {
		t.Fatalf("%d spawns; the crashed process was not replaced", h.spawner.count.Load())
	}
}

// A draining worker runs no further attempt: a refused retry is given back at once.
func TestDrainGivesBackARefusedRetry(t *testing.T) {
	h := newHarness(t, "ok", func(b *api.Bootstrap) { b.Scan.Settings.Backoff.InitialMs = 30000 })
	h.b.SetMaxLength(1)
	h.b.Enqueue(analysisBody(1, 1, `{"mode":"flaky","failAttempts":1}`))
	h.b.Enqueue(analysisBody(2, 1, `{}`))
	h.b.Enqueue(analysisBody(3, 1, `{}`))
	h.start()
	waitFor(t, "a refused republish", func() bool { return len(h.publishedAnalyses(amqpx.Nacked)) >= 1 })
	start := time.Now()
	h.w.Drain()
	select {
	case <-h.runDone:
	case <-time.After(10 * time.Second):
		t.Fatal("drain did not finish")
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("the drain waited %s for a retry the queue refused", elapsed)
	}
	if r, _ := h.b.Ready(); r != 3 {
		t.Fatalf("%d ready messages, want 3 (the refused delivery was given back)", r)
	}
	if !h.w.Health().Healthy() {
		t.Fatal("a full queue made the worker unhealthy")
	}
}

// A held delivery that the broker took back (consumer cancelled, connection lost) runs again elsewhere: the slot
// stops holding its refused retry instead of running the next attempt on a delivery it no longer owns.
func TestDetachedDeliveryEndsTheHold(t *testing.T) {
	h := newHarness(t, "ok", func(b *api.Bootstrap) { b.Scan.Settings.Backoff.InitialMs = 3000 })
	h.b.SetMaxLength(1)
	h.b.Enqueue(analysisBody(1, 1, `{"mode":"flaky","failAttempts":1}`))
	h.b.Enqueue(analysisBody(2, 1, `{}`))
	h.b.Enqueue(analysisBody(3, 1, `{}`))
	h.start()
	waitFor(t, "a refused republish", func() bool { return len(h.publishedAnalyses(amqpx.Nacked)) >= 1 })
	h.b.CancelConsumers()
	// The redelivered message runs attempt 1 again: its attempt event is published a second time.
	waitFor(t, "attempt 1 again", func() bool { return len(h.published(runtime.TypeAttempt)) >= 2 })
	h.b.SetMaxLength(0)
	waitFor(t, "the retry accepted", func() bool { return len(h.publishedAnalyses(amqpx.Confirmed)) == 1 })
	accepted := h.publishedAnalyses(amqpx.Confirmed)[0].At
	waitFor(t, "attempt 2 of seq 1", func() bool { return !h.at(runtime.TypeResult, 1, 2).IsZero() })
	for _, p := range h.b.Published() {
		var m map[string]any
		if p.Type == runtime.TypeResult && json.Unmarshal(p.Body, &m) == nil && m["seq"] == float64(1) && p.At.Before(accepted) {
			t.Fatalf("seq 1 finished on the detached delivery before its retry was accepted: %v", m)
		}
	}
	if !h.w.Health().Healthy() {
		t.Fatal("a full queue made the worker unhealthy")
	}
}
