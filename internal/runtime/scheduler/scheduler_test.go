package scheduler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	"github.com/lonetis/scantor/internal/runtime/bootstrap"
	"github.com/lonetis/scantor/internal/runtime/canonical"
	"github.com/lonetis/scantor/internal/runtime/internal/fakebroker"
	"github.com/lonetis/scantor/internal/runtime/internal/fakeconn"
	"github.com/lonetis/scantor/internal/runtime/pool"
	"github.com/lonetis/scantor/internal/runtime/scerr"
	"github.com/lonetis/scantor/internal/templates"
)

func TestMain(m *testing.M) {
	if fakeconn.Active() {
		fakeconn.Main()
		return
	}
	os.Exit(m.Run())
}

const testScan = "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f"

type fakeAPI struct {
	mu          sync.Mutex
	resolved    []api.SchedulerResolvedRequest
	checkpoints []api.SchedulerCheckpointRequest
	done        []api.SchedulerDoneRequest
	errors      []scerr.ScantorError
	stale       bool
	stored      *api.Resolution // answered with stored: false when set
}

func (f *fakeAPI) Resolved(_ context.Context, req api.SchedulerResolvedRequest) (*api.SchedulerResolvedResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stale {
		return nil, bootstrap.ErrStaleEpoch
	}
	f.resolved = append(f.resolved, req)
	if f.stored != nil {
		return &api.SchedulerResolvedResponse{Stored: false, Resolution: *f.stored}, nil
	}
	return &api.SchedulerResolvedResponse{Stored: true, Resolution: api.Resolution{Template: req.Template, ScanConfig: req.ScanConfig}}, nil
}

func (f *fakeAPI) Checkpoint(_ context.Context, req api.SchedulerCheckpointRequest) (*api.SchedulerCheckpointResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stale {
		return nil, fmt.Errorf("%w: test", bootstrap.ErrStaleEpoch)
	}
	f.checkpoints = append(f.checkpoints, req)
	return &api.SchedulerCheckpointResponse{Confirmed: req.Confirmed, TailHash: req.TailHash}, nil
}

func (f *fakeAPI) Done(_ context.Context, req api.SchedulerDoneRequest) (*api.SchedulerDoneResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stale {
		return nil, bootstrap.ErrStaleEpoch
	}
	f.done = append(f.done, req)
	return &api.SchedulerDoneResponse{Scheduling: api.SchedulingState{State: req.Outcome, Confirmed: req.Confirmed}}, nil
}

func (f *fakeAPI) ReportError(_ context.Context, _ bool, e scerr.ScantorError, _ string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.errors = append(f.errors, e)
	return true
}

func (f *fakeAPI) ReportRestart(ctx context.Context, e scerr.ScantorError, tail string) bool {
	return f.ReportError(ctx, false, e, tail)
}

func (f *fakeAPI) snapshot() fakeAPI {
	f.mu.Lock()
	defer f.mu.Unlock()
	return fakeAPI{resolved: append(f.resolved[:0:0], f.resolved...), checkpoints: append(f.checkpoints[:0:0], f.checkpoints...), done: append(f.done[:0:0], f.done...), errors: append(f.errors[:0:0], f.errors...)}
}

type spawner struct{ count atomic.Int32 }

func (s *spawner) Spawn(ctx context.Context, _, _ int, output pool.Sink) (*pool.Process, error) {
	s.count.Add(1)
	argv, extra := fakeconn.Command("ok")
	return pool.Spawn(ctx, pool.Options{
		Argv: argv, Env: append(os.Environ(), extra...), Dir: os.TempDir(), Mode: protocol.ModeWorker, RuntimeVersion: "1.0.0",
		Output: output, HelloTimeout: 10 * time.Second, ReadyTimeout: 10 * time.Second,
	})
}

func schedBoot(schedule api.Schedule, scanConfig string) *api.Bootstrap {
	return &api.Bootstrap{
		Action: api.ActionRun,
		Worker: api.BootstrapWorker{ID: "7c6d5e4f-3a2b-4c1d-9e0f-8a7b6c5d4e3f", Role: api.RoleScheduler, ScanID: testScan, Epoch: 1},
		Scan: api.BootstrapScan{
			ID: testScan, Round: 2, TaskConfig: json.RawMessage(`{}`), ScanConfig: json.RawMessage(scanConfig),
			Settings: api.RuntimeSettings{Processes: 1, TimeoutMs: 5000, MaxAttempts: 3, Backoff: api.Backoff{InitialMs: 50, Factor: 2, MaxMs: 200}},
		},
		Revision: api.BootstrapRevision{Entry: "main.py", ProtocolVersion: 1, Schedule: schedule},
		AMQP:     api.BootstrapAMQP{AnalysesExchange: "scantor.analyses", ResultsExchange: "scantor.results", RoutingKey: testScan},
		Limits:   api.BootstrapLimits{MaxAnalysisConfigBytes: 1 << 16, MaxAnalysesPerScan: 1 << 30, StackBytes: 16 << 10},
		Intervals: api.BootstrapIntervals{
			CheckpointMs: 100, CheckpointItems: 1000, DrainGraceMs: 5000, BackpressureWaitMs: 100,
		},
		Scheduler: &api.BootstrapScheduler{Resolved: map[string]api.Resolution{}},
	}
}

type harness struct {
	t     *testing.T
	b     *fakebroker.Broker
	api   *fakeAPI
	s     *Scheduler
	spawn *spawner
	polls atomic.Int32
}

func newHarness(t *testing.T, boot *api.Bootstrap) *harness {
	t.Helper()
	h := &harness{t: t, b: fakebroker.New(), api: &fakeAPI{}, spawn: &spawner{}}
	h.s = New(Config{
		Boot: boot, Publisher: h.b, Depth: h.b, API: h.api, Spawner: h.spawn, Env: templates.Env{TmpDir: t.TempDir()},
		Now: time.Now, PollNow: func() { h.polls.Add(1) }, WorkRoot: t.TempDir(),
	})
	return h
}

func (h *harness) run() error {
	h.t.Helper()
	done := make(chan error, 1)
	go func() { done <- h.s.Run(context.Background()) }()
	select {
	case err := <-done:
		return err
	case <-time.After(30 * time.Second):
		h.t.Fatal("the scheduler did not finish")
		return nil
	}
}

// items returns the configs of the confirmed analysis messages by seq.
func (h *harness) items() map[int64]runtime.AnalysisMessage {
	out := map[int64]runtime.AnalysisMessage{}
	for _, p := range h.b.Published() {
		if p.Outcome != amqpx.Confirmed {
			continue
		}
		var m runtime.AnalysisMessage
		if err := json.Unmarshal(p.Body, &m); err != nil {
			h.t.Fatal(err)
		}
		out[m.Seq] = m
	}
	return out
}

func hashOf(t *testing.T, cfg string) string {
	h, err := canonical.Hash([]byte(cfg))
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func TestNativeTemplate(t *testing.T) {
	h := newHarness(t, schedBoot(api.Schedule{Kind: "template", Template: "range"}, `{"start":0,"end":10}`))
	if err := h.run(); err != nil {
		t.Fatal(err)
	}
	items := h.items()
	if len(items) != 10 {
		t.Fatalf("%d items", len(items))
	}
	for seq, m := range items {
		if m.AnalysisID != fmt.Sprintf("%s-%d", testScan, seq) || m.Round != 2 || m.Attempt != 1 || m.ScheduledAt == 0 {
			t.Fatalf("item %+v", m)
		}
		if string(m.Config) != fmt.Sprintf(`{"value":%d}`, seq) {
			t.Fatalf("config %s", m.Config)
		}
	}
	a := h.api.snapshot()
	if len(a.resolved) != 1 || a.resolved[0].Key != "schedule" || a.resolved[0].Template != "range" || a.resolved[0].Epoch != 1 {
		t.Fatalf("resolved %+v", a.resolved)
	}
	if len(a.done) != 1 || a.done[0].Outcome != "done" || a.done[0].Confirmed != 10 || *a.done[0].TailHash != hashOf(t, `{"value":9}`) {
		t.Fatalf("done %+v", a.done)
	}
}

func TestResumeVerifiesTheTail(t *testing.T) {
	boot := schedBoot(api.Schedule{Kind: "template", Template: "range"}, `{"start":0,"end":10}`)
	tail := hashOf(t, `{"value":4}`)
	boot.Scheduler.Checkpoint = api.Checkpoint{Confirmed: 5, TailHash: &tail}
	h := newHarness(t, boot)
	if err := h.run(); err != nil {
		t.Fatal(err)
	}
	items := h.items()
	if len(items) != 5 {
		t.Fatalf("%d items published", len(items))
	}
	for seq := range items {
		if seq < 5 {
			t.Fatalf("replayed seq %d was published", seq)
		}
	}

	for name, cp := range map[string]api.Checkpoint{
		"item 4 hash mismatch on resume": {Confirmed: 5, TailHash: &tail},
		"produced only 10 items":         {Confirmed: 20, TailHash: &tail},
	} {
		boot := schedBoot(api.Schedule{Kind: "template", Template: "range"}, `{"start":100,"end":110}`)
		boot.Scheduler.Checkpoint = cp
		h := newHarness(t, boot)
		if err := h.run(); err != nil {
			t.Fatal(err)
		}
		a := h.api.snapshot()
		if len(a.done) != 1 || a.done[0].Outcome != "failed" || a.done[0].Error.Type != "validation" ||
			!strings.Contains(a.done[0].Error.Message, "schedule() is not deterministic") || !strings.Contains(a.done[0].Error.Message, name) {
			t.Fatalf("%s: done %+v", name, a.done)
		}
	}
}

func TestBackpressureRepublishesNackedSeqs(t *testing.T) {
	h := newHarness(t, schedBoot(api.Schedule{Kind: "template", Template: "range"}, `{"start":0,"end":40}`))
	var nacks atomic.Int32
	h.b.Outcome = func(amqpx.Publication) amqpx.Outcome {
		if ready, _ := h.b.Ready(); ready >= 5 {
			nacks.Add(1)
			return amqpx.Nacked
		}
		return amqpx.Confirmed
	}
	var sawBackpressure atomic.Bool
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-time.After(5 * time.Millisecond):
			}
			if _, p := h.s.State(); p.Backpressure {
				sawBackpressure.Store(true)
				_ = drainQueue(h.b, 3) // runners consume some messages
			}
		}
	}()
	err := h.run()
	close(stop)
	if err != nil {
		t.Fatal(err)
	}
	if nacks.Load() == 0 || !sawBackpressure.Load() {
		t.Fatalf("no backpressure: %d nacks", nacks.Load())
	}
	if items := h.items(); len(items) != 40 {
		t.Fatalf("%d items confirmed", len(items))
	}
	if a := h.api.snapshot(); a.done[0].Confirmed != 40 {
		t.Fatalf("done %+v", a.done[0])
	}
}

// start runs the scheduler in the background; the channel receives Run's result.
func (h *harness) start() <-chan error {
	done := make(chan error, 1)
	go func() { done <- h.s.Run(context.Background()) }()
	return done
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// The scheduler keeps at most half of x-max-length in the queue (ready plus in flight), so retries, which count
// toward the limit while they are delayed, fit into the other half (docs/runtime.md §11.4). It waits for room
// without running into the broker's limit, and reopens once a fifth of its share is free.
func TestShareKeepsHalfTheQueueFree(t *testing.T) {
	boot := schedBoot(api.Schedule{Kind: "template", Template: "range"}, `{"start":0,"end":30}`)
	boot.AMQP.MaxLength = 20 // share 10, reopens with room for 2
	h := newHarness(t, boot)
	h.b.SetMaxLength(20)
	done := h.start()
	published := func() int64 { _, p := h.s.State(); return p.Published }
	waitUntil(t, "the share used up", func() bool { _, p := h.s.State(); return p.Published == 10 && p.Backpressure })
	reads := h.b.DepthReads()
	waitUntil(t, "the ready count read again", func() bool { return h.b.DepthReads() > reads+1 })
	if n := published(); n != 10 {
		t.Fatalf("%d items published into a share of 10", n)
	}
	if err := drainQueue(h.b, 1); err != nil {
		t.Fatal(err)
	}
	reads = h.b.DepthReads()
	waitUntil(t, "two more reads", func() bool { return h.b.DepthReads() > reads+1 })
	if n := published(); n != 10 {
		t.Fatalf("published %d with room for 1; the share reopens with room for 2", n)
	}
	if err := drainQueue(h.b, 1); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "two more items", func() bool { return published() == 12 })
	// Runners drain the rest.
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-time.After(5 * time.Millisecond):
			}
			if ready, _ := h.b.Ready(); ready > 10 {
				t.Errorf("%d ready messages; the share is 10", ready)
			}
			_ = drainQueue(h.b, 2)
		}
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the scheduler did not finish")
	}
	for _, p := range h.b.Published() {
		if p.Outcome != amqpx.Confirmed {
			t.Fatalf("the broker refused a publish (%s): the share must keep the queue below its limit", p.Outcome)
		}
	}
	if a := h.api.snapshot(); len(a.done) != 1 || a.done[0].Confirmed != 30 {
		t.Fatalf("done %+v", a.done)
	}
	if _, p := h.s.State(); p.Backpressure {
		t.Fatal("backpressure still reported after the end")
	}
}

// A missing scan queue keeps the scheduler waiting and makes it poll state; it publishes once the queue exists.
func TestShareWaitsForTheQueue(t *testing.T) {
	boot := schedBoot(api.Schedule{Kind: "template", Template: "range"}, `{"start":0,"end":5}`)
	boot.AMQP.MaxLength = 100
	h := newHarness(t, boot)
	h.b.SetMissing(true)
	done := h.start()
	waitUntil(t, "a state poll", func() bool { return h.polls.Load() > 0 })
	if _, p := h.s.State(); p.Published != 0 || !p.Backpressure {
		t.Fatalf("progress %+v while the queue is missing", p)
	}
	h.b.SetMissing(false)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if a := h.api.snapshot(); len(a.done) != 1 || a.done[0].Confirmed != 5 {
		t.Fatalf("done %+v", a.done)
	}
}

// When the ready count cannot be read, the scheduler publishes up to the broker's limit (one window at a time).
func TestShareFallsBackToTheBrokerLimit(t *testing.T) {
	boot := schedBoot(api.Schedule{Kind: "template", Template: "range"}, `{"start":0,"end":20}`)
	boot.AMQP.MaxLength = 4
	h := newHarness(t, boot)
	h.b.SetDepthErr(errors.New("channel_max reached"))
	if err := h.run(); err != nil {
		t.Fatal(err)
	}
	if a := h.api.snapshot(); len(a.done) != 1 || a.done[0].Confirmed != 20 {
		t.Fatalf("done %+v", a.done)
	}
}

// drainQueue removes up to n ready messages, as runners would.
func drainQueue(b *fakebroker.Broker, n int) error {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	ch, err := b.Consume(ctx, "drainer")
	if err != nil {
		return err
	}
	defer ch.Close()
	for range n {
		select {
		case d := <-ch.Deliveries():
			_ = ch.Ack(d.DeliveryTag)
		case <-ctx.Done():
			return nil
		}
	}
	return nil
}

func TestCustomSchedule(t *testing.T) {
	h := newHarness(t, schedBoot(api.Schedule{Kind: "custom"}, `{"count":5}`))
	if err := h.run(); err != nil {
		t.Fatal(err)
	}
	items := h.items()
	if len(items) != 5 || string(items[4].Config) != `{"n":4}` {
		t.Fatalf("items %v", items)
	}
	if a := h.api.snapshot(); len(a.done) != 1 || a.done[0].Outcome != "done" || a.done[0].Confirmed != 5 {
		t.Fatalf("done %+v", a.done)
	}
}

func TestCustomScheduleErrors(t *testing.T) {
	// fatal: done with outcome failed after the items before it.
	h := newHarness(t, schedBoot(api.Schedule{Kind: "custom"}, `{"count":5,"fatalAt":3}`))
	if err := h.run(); err != nil {
		t.Fatal(err)
	}
	a := h.api.snapshot()
	if len(a.done) != 1 || a.done[0].Outcome != "failed" || a.done[0].Error.Type != "fatal" || a.done[0].Confirmed != 3 || a.done[0].Error.Phase != "schedule" {
		t.Fatalf("fatal: %+v", a.done)
	}

	// a retryable failure is reported and the schedule restarts in process from the confirmed prefix.
	boot := schedBoot(api.Schedule{Kind: "custom"}, `{"count":5,"failAt":2}`)
	boot.Scheduler.Restarts = 4
	h = newHarness(t, boot)
	done := make(chan error, 1)
	go func() { done <- h.s.Run(context.Background()) }()
	waitFor(t, "two error reports", func() bool { return len(h.api.snapshot().errors) >= 2 })
	h.s.Stop()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	a = h.api.snapshot()
	if e := a.errors[0]; e.Type != "taskError" || e.Phase != "schedule" || !e.Retryable || e.Attempt != 5 || !strings.Contains(e.Message, "boom at 2") {
		t.Fatalf("report %+v", e)
	}
	if a.errors[1].Attempt != 6 || len(a.done) != 0 || h.spawn.count.Load() < 2 {
		t.Fatalf("restart: %+v, %d done, %d spawns", a.errors[1], len(a.done), h.spawn.count.Load())
	}
	if items := h.items(); len(items) != 2 {
		t.Fatalf("items %v", items)
	}

	// done.count mismatch is a protocol violation (crash, retryable).
	h = newHarness(t, schedBoot(api.Schedule{Kind: "custom"}, `{"count":2,"badCount":true}`))
	go func() { done <- h.s.Run(context.Background()) }()
	waitFor(t, "a report", func() bool { return len(h.api.snapshot().errors) >= 1 })
	h.s.Stop()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if e := h.api.snapshot().errors[0]; e.Type != "crash" || !strings.Contains(string(e.Details), "done.count") {
		t.Fatalf("bad count %+v", e)
	}
}

func TestLimits(t *testing.T) {
	boot := schedBoot(api.Schedule{Kind: "custom"}, `{"count":5}`)
	boot.Limits.MaxAnalysesPerScan = 3
	h := newHarness(t, boot)
	if err := h.run(); err != nil {
		t.Fatal(err)
	}
	a := h.api.snapshot()
	if len(a.done) != 1 || a.done[0].Outcome != "failed" || a.done[0].Confirmed != 3 ||
		a.done[0].Error.Message != "schedule() produced more than 3 analyses (SCANTOR_MAX_ANALYSES_PER_SCAN)" {
		t.Fatalf("limit %+v", a.done)
	}
	boot = schedBoot(api.Schedule{Kind: "custom"}, `{"count":2,"itemBytes":2000}`)
	boot.Limits.MaxAnalysisConfigBytes = 1000
	h = newHarness(t, boot)
	if err := h.run(); err != nil {
		t.Fatal(err)
	}
	if a := h.api.snapshot(); !strings.Contains(a.done[0].Error.Message, "analysis config 0 is") {
		t.Fatalf("size %+v", a.done[0].Error)
	}
}

func TestItemTimeout(t *testing.T) {
	boot := schedBoot(api.Schedule{Kind: "custom"}, `{"hang":true}`)
	boot.Scan.Settings.TimeoutMs = 300
	h := newHarness(t, boot)
	done := make(chan error, 1)
	go func() { done <- h.s.Run(context.Background()) }()
	waitFor(t, "a report", func() bool { return len(h.api.snapshot().errors) >= 1 })
	h.s.Stop()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if e := h.api.snapshot().errors[0]; e.Type != "timeout" || !e.Retryable || e.Message != "schedule() produced no item within 300 ms" {
		t.Fatalf("timeout %+v", e)
	}
}

func TestWrappedTemplateWithCredit(t *testing.T) {
	h := newHarness(t, schedBoot(api.Schedule{Kind: "custom"}, `{"wrap":{"template":"range","scanConfig":{"end":300},"credit":10}}`))
	if err := h.run(); err != nil {
		t.Fatal(err)
	}
	if items := h.items(); len(items) != 300 || string(items[299].Config) != `{"value":299}` {
		t.Fatalf("%d items", len(items))
	}
	a := h.api.snapshot()
	if len(a.resolved) != 1 || a.resolved[0].Key != "call:0" || !sameJSON(a.resolved[0].ScanConfig, `{"end":300,"start":0,"step":1}`) {
		t.Fatalf("resolved %+v %s", a.resolved, a.resolved[0].ScanConfig)
	}

	h = newHarness(t, schedBoot(api.Schedule{Kind: "custom"}, `{"wrap":{"template":"range","scanConfig":{"end":300},"stopAfter":5}}`))
	if err := h.run(); err != nil {
		t.Fatal(err)
	}
	if items := h.items(); len(items) != 5 {
		t.Fatalf("stopAfter: %d items", len(items))
	}

	h = newHarness(t, schedBoot(api.Schedule{Kind: "custom"}, `{"wrap":{"template":"range","scanConfig":{"step":0}}}`))
	if err := h.run(); err != nil {
		t.Fatal(err)
	}
	if a := h.api.snapshot(); a.done[0].Outcome != "failed" || a.done[0].Error.Type != "validation" {
		t.Fatalf("invalid wrapped config %+v", a.done[0])
	}
}

func TestStaleEpochFences(t *testing.T) {
	h := newHarness(t, schedBoot(api.Schedule{Kind: "template", Template: "range"}, `{"end":10}`))
	h.api.stale = true
	if err := h.run(); err != nil {
		t.Fatal(err)
	}
	if a := h.api.snapshot(); len(a.done) != 0 {
		t.Fatalf("a fenced scheduler called done: %+v", a.done)
	}
	if len(h.items()) != 0 {
		t.Fatal("a fenced scheduler published")
	}
}

func TestDrainCancelsTheSchedule(t *testing.T) {
	h := newHarness(t, schedBoot(api.Schedule{Kind: "custom"}, `{"hang":true}`))
	done := make(chan error, 1)
	go func() { done <- h.s.Run(context.Background()) }()
	waitFor(t, "scheduling", func() bool { p, _ := h.s.State(); return p.Busy == 1 && p.Running == 1 })
	time.Sleep(100 * time.Millisecond)
	start := time.Now()
	h.s.Drain()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("drain did not finish")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatalf("drain took %s", time.Since(start))
	}
	a := h.api.snapshot()
	if len(a.done) != 0 || len(a.errors) != 0 {
		t.Fatalf("drain: done %+v errors %+v", a.done, a.errors)
	}
}

// TestStoredResolutionOfAnotherTemplate: a stored resolution under the same key but of another template
// means the schedule is not deterministic; scheduling fails instead of streaming the wrong template.
func TestStoredResolutionOfAnotherTemplate(t *testing.T) {
	for _, tc := range []struct {
		name   string
		stored map[string]api.Resolution
		answer *api.Resolution
	}{
		{name: "in bootstrap", stored: map[string]api.Resolution{"schedule": {Template: "repeat", ScanConfig: json.RawMessage(`{"times":3}`)}}},
		{name: "answered by resolved", answer: &api.Resolution{Template: "repeat", ScanConfig: json.RawMessage(`{"times":3}`)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			boot := schedBoot(api.Schedule{Kind: "template", Template: "range"}, `{"end":3}`)
			if tc.stored != nil {
				boot.Scheduler.Resolved = tc.stored
			}
			h := newHarness(t, boot)
			h.api.stored = tc.answer
			if err := h.run(); err != nil {
				t.Fatal(err)
			}
			done := h.api.snapshot().done
			if len(done) != 1 || done[0].Outcome != api.OutcomeFailed || done[0].Error == nil || done[0].Error.Type != api.ErrorValidation ||
				!strings.Contains(done[0].Error.Message, "not deterministic") || len(h.items()) != 0 {
				t.Fatalf("done %+v, items %d", done, len(h.items()))
			}
		})
	}
}

func TestStoredResolutionIsReused(t *testing.T) {
	boot := schedBoot(api.Schedule{Kind: "template", Template: "range"}, `{"end":100}`)
	boot.Scheduler.Resolved = map[string]api.Resolution{"schedule": {Template: "range", ScanConfig: json.RawMessage(`{"start":0,"end":3,"step":1}`)}}
	h := newHarness(t, boot)
	if err := h.run(); err != nil {
		t.Fatal(err)
	}
	if len(h.items()) != 3 || len(h.api.snapshot().resolved) != 0 {
		t.Fatalf("items %d, resolved %+v", len(h.items()), h.api.snapshot().resolved)
	}
}

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

func sameJSON(a json.RawMessage, b string) bool {
	ca, err1 := canonical.Transform(a)
	cb, err2 := canonical.Transform([]byte(b))
	return err1 == nil && err2 == nil && string(ca) == string(cb)
}
