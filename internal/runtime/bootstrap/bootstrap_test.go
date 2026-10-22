package bootstrap

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/runtime/internal/fakeapi"
	"github.com/lonetis/scantor/internal/runtime/scerr"
	"github.com/lonetis/scantor/internal/version"
)

const workerID = "7c6d5e4f-3a2b-4c1d-9e0f-8a7b6c5d4e3f"

func newClient(t *testing.T, srv *fakeapi.Server) *Client {
	t.Helper()
	c, err := api.New(api.Options{
		BaseURL:    srv.URL,
		Credential: api.Credential{Kind: api.PrincipalWorker, Token: fakeapi.Token(workerID)},
		Policy:     api.Policy{EnforcePlaintext: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	return NewClient(c, NewClock(), nil)
}

func TestClock(t *testing.T) {
	c := NewClock()
	base := time.Unix(1000, 0)
	c.now = func() time.Time { return base }
	// First sample: server 5 s ahead at the response, rtt 100 ms → offset = serverTime + rtt/2 − t1.
	sent := base.Add(-100 * time.Millisecond)
	c.Observe(base.Add(5*time.Second).UnixMilli(), sent, base)
	if got := c.Offset(); got != 5*time.Second+50*time.Millisecond {
		t.Fatalf("first offset %v", got)
	}
	// A slow sample (rtt 3 s) is discarded.
	c.Observe(base.Add(time.Hour).UnixMilli(), base.Add(-3*time.Second), base)
	if got := c.Offset(); got != 5*time.Second+50*time.Millisecond {
		t.Fatalf("slow sample applied: %v", got)
	}
	// A fast sample moves the offset by 20 % (EWMA).
	c.Observe(base.Add(10*time.Second).UnixMilli(), base, base)
	want := time.Duration(0.8*float64(5*time.Second+50*time.Millisecond) + 0.2*float64(10*time.Second))
	if got := c.Offset(); got != want {
		t.Fatalf("EWMA offset %v, want %v", got, want)
	}
	if got := c.Now(); got != base.Add(want) {
		t.Fatalf("Now %v", got)
	}
}

func TestBootstrapRetriesAndExits(t *testing.T) {
	srv := fakeapi.New()
	defer srv.Close()
	srv.Bootstrap = api.Bootstrap{Action: api.ActionRun, Worker: api.BootstrapWorker{ID: workerID, Role: api.RoleRunner}}
	srv.BootstrapFailures, srv.BootstrapStatus = 2, http.StatusServiceUnavailable
	c := newClient(t, srv)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	b, err := c.Bootstrap(ctx)
	if err != nil || b.Worker.ID != workerID {
		t.Fatalf("bootstrap after failures: %v %+v", err, b)
	}
	srv.Snapshot(func(s *fakeapi.Server) {
		h := s.Headers[0]
		if h.Get("User-Agent") != "scantor-runtime/"+version.Version || h.Get("X-Scantor-Version") != version.Version {
			t.Errorf("headers %v", h)
		}
	})

	for status, want := range map[int]error{http.StatusUnauthorized: ErrUnauthorized, http.StatusUpgradeRequired: ErrIncompatible} {
		srv.Snapshot(func(s *fakeapi.Server) { s.BootstrapFailures, s.BootstrapStatus = 1, status })
		if _, err := c.Bootstrap(ctx); !errors.Is(err, want) {
			t.Fatalf("status %d: %v", status, err)
		}
	}
}

func TestPlaintextToPublicHostRefused(t *testing.T) {
	c, err := api.New(api.Options{
		BaseURL:    "http://203.0.113.10:3000",
		Credential: api.Credential{Kind: api.PrincipalWorker, Token: fakeapi.Token(workerID)},
		Policy:     api.Policy{EnforcePlaintext: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := NewClient(c, NewClock(), nil).Bootstrap(ctx); !errors.Is(err, api.ErrPlaintextRefused) {
		t.Fatalf("got %v", err)
	}
}

func TestSchedulerRoutes(t *testing.T) {
	srv := fakeapi.New()
	defer srv.Close()
	c := newClient(t, srv)
	ctx := context.Background()
	hash := "sha256:x"
	if _, err := c.Checkpoint(ctx, api.SchedulerCheckpointRequest{Epoch: 1, Confirmed: 5, TailHash: &hash}); err != nil {
		t.Fatal(err)
	}
	srv.Snapshot(func(s *fakeapi.Server) { s.Epoch = 2 })
	if _, err := c.Checkpoint(ctx, api.SchedulerCheckpointRequest{Epoch: 1, Confirmed: 6}); !errors.Is(err, ErrStaleEpoch) {
		t.Fatalf("stale checkpoint: %v", err)
	}
	if _, err := c.Done(ctx, api.SchedulerDoneRequest{Epoch: 1, Outcome: api.OutcomeDone}); !errors.Is(err, ErrStaleEpoch) {
		t.Fatalf("stale done: %v", err)
	}
	total := int64(10)
	res, err := c.Resolved(ctx, api.SchedulerResolvedRequest{Epoch: 2, Key: "schedule", Template: "range", ScanConfig: []byte(`{}`), Provenance: []byte(`{}`), ExpectedTotal: &total})
	if err != nil || !res.Stored {
		t.Fatalf("resolved: %v %+v", err, res)
	}
	res, err = c.Resolved(ctx, api.SchedulerResolvedRequest{Epoch: 2, Key: "schedule", Template: "range", ScanConfig: []byte(`{"x":1}`), Provenance: []byte(`{}`)})
	if err != nil || res.Stored || string(res.Resolution.ScanConfig) != `{}` {
		t.Fatalf("second resolution: %v %+v", err, res)
	}
}

// TestReportRestartIsNotRateLimited: the orchestrator counts scheduler restarts from these reports, so
// two restarts within 10 s are both reported (docs/runtime.md §11.9).
func TestReportRestartIsNotRateLimited(t *testing.T) {
	srv := fakeapi.New()
	defer srv.Close()
	c := newClient(t, srv)
	e := scerr.New(api.ErrorTaskError, api.PhaseSchedule, "boom")
	for i := range 2 {
		if !c.ReportRestart(context.Background(), e, "") {
			t.Fatalf("restart report %d suppressed", i+1)
		}
	}
	srv.Snapshot(func(s *fakeapi.Server) {
		if len(s.Errors) != 2 || s.Errors[1].Fatal || s.Errors[1].Error.Phase != api.PhaseSchedule {
			t.Fatalf("reports %+v", s.Errors)
		}
	})
}

func TestReportErrorRateLimit(t *testing.T) {
	srv := fakeapi.New()
	defer srv.Close()
	c := newClient(t, srv)
	ctx := context.Background()
	e := scerr.New(api.ErrorPlatform, api.PhaseUpload, "s3 down")
	if !c.ReportError(ctx, false, e, "") {
		t.Fatal("first report suppressed")
	}
	if c.ReportError(ctx, false, e, "") {
		t.Fatal("second report within 10 s not suppressed")
	}
	if !c.ReportError(ctx, false, scerr.New(api.ErrorPlatform, api.PhasePublish, "nack"), "") {
		t.Fatal("other phase suppressed")
	}
	if !c.ReportError(ctx, true, e, strings.Repeat("x", 10000)) {
		t.Fatal("fatal report suppressed")
	}
	srv.Snapshot(func(s *fakeapi.Server) {
		if len(s.Errors) != 3 {
			t.Fatalf("%d reports", len(s.Errors))
		}
		last := s.Errors[2]
		if !last.Fatal || last.Context == nil || len(last.Context.StderrTail) > 4096 || last.Error.At.IsZero() {
			t.Fatalf("fatal report %+v", last)
		}
	})
}

func TestPoller(t *testing.T) {
	srv := fakeapi.New()
	defer srv.Close()
	srv.State = func(req api.RuntimeStateRequest) (api.RuntimeStateResponse, int) {
		return api.RuntimeStateResponse{Action: api.ActionDrain, Processes: 3, NextPollMs: 50}, http.StatusOK
	}
	c := newClient(t, srv)
	got := make(chan *api.RuntimeStateResponse, 10)
	p := &Poller{Client: c, Interval: 20 * time.Millisecond, Jitter: 0.2,
		Build:  func() api.RuntimeStateRequest { return api.RuntimeStateRequest{ClockOffsetMs: 7} },
		Handle: func(r *api.RuntimeStateResponse) { got <- r }}
	ctx, cancel := context.WithCancel(context.Background())
	go p.Run(ctx)
	for range 2 {
		select {
		case r := <-got:
			if r.Action != api.ActionDrain || r.Processes != 3 {
				t.Fatalf("response %+v", r)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("no poll")
		}
	}
	srv.Snapshot(func(s *fakeapi.Server) {
		s.State = func(api.RuntimeStateRequest) (api.RuntimeStateResponse, int) {
			return api.RuntimeStateResponse{}, http.StatusUnauthorized
		}
	})
	p.PollNow()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case r := <-got:
			if r.Action == api.ActionStop {
				cancel()
				srv.Snapshot(func(s *fakeapi.Server) {
					if s.States[0].ClockOffsetMs != 7 || s.States[0].Busy == nil {
						t.Errorf("request %+v", s.States[0])
					}
				})
				return
			}
		case <-deadline:
			t.Fatal("401 did not become stop")
		}
	}
}
