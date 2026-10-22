// Package bootstrap is the runtime's side of the runtime API (docs/runtime.md §4, §5, docs/api.md §8):
// bootstrap with retries and its exit semantics, state polls, the corrected clock, rate-limited error
// reports and the scheduler routes with epoch fencing.
package bootstrap

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/runtime/logtail"
	"github.com/lonetis/scantor/internal/runtime/scerr"
)

// Errors with a fixed meaning for the runtime.
var (
	// ErrUnauthorized: the worker token was rejected (401); the worker is no longer active, so the
	// runtime behaves as for action "stop" (exit 0).
	ErrUnauthorized = errors.New("the orchestrator rejected the worker token (401): the worker is no longer active")
	// ErrIncompatible: the orchestrator does not accept this runtime version (426, exit 1).
	ErrIncompatible = errors.New("the orchestrator does not accept this runtime version (426)")
	// ErrStaleEpoch: a newer scheduler epoch exists (409 staleEpoch); the scheduler exits 0.
	ErrStaleEpoch = errors.New("scheduler epoch was superseded (409 staleEpoch)")
)

// Rate limits and retries of error reports (docs/runtime.md §4.3).
const (
	reportInterval = 10 * time.Second
	reportTries    = 3
	maxStderrTail  = 4 << 10
)

// Client wraps the runtime API client with the clock and the runtime's retry rules.
type Client struct {
	api    *api.Client
	clock  *Clock
	logger *slog.Logger

	reportMu   sync.Mutex
	lastReport map[string]time.Time
}

// NewClient returns a client; logger may be nil.
func NewClient(c *api.Client, clock *Clock, logger *slog.Logger) *Client {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &Client{api: c, clock: clock, logger: logger, lastReport: map[string]time.Time{}}
}

// Clock returns the corrected clock.
func (c *Client) Clock() *Clock { return c.clock }

// HTTPClient returns the HTTP client with the transport policy (for presigned URLs and data sources).
func (c *Client) HTTPClient() *http.Client { return c.api.HTTPClient() }

func status(err error) int {
	if e, ok := api.AsError(err); ok {
		return e.Status
	}
	return 0
}

// classify maps the fixed-meaning statuses to their errors.
func classify(err error) error {
	switch status(err) {
	case http.StatusUnauthorized:
		return fmt.Errorf("%w: %v", ErrUnauthorized, err)
	case http.StatusUpgradeRequired:
		return fmt.Errorf("%w: %v", ErrIncompatible, err)
	}
	if stale, _ := api.IsStaleEpoch(err); stale {
		return fmt.Errorf("%w: %v", ErrStaleEpoch, err)
	}
	return err
}

// bootstrapRetry retries everything except 401, 426 and refused transport, forever (1 s → 60 s, ×2,
// full jitter).
func bootstrapRetry() *api.RetryPolicy {
	p := api.RetryForever()
	p.RetryIf = func(err error) bool {
		switch status(err) {
		case http.StatusUnauthorized, http.StatusUpgradeRequired:
			return false
		}
		return !errors.Is(err, api.ErrPlaintextRefused) && !errors.Is(err, context.Canceled)
	}
	return p
}

// Bootstrap calls GET /api/runtime/bootstrap until it succeeds. It returns ErrUnauthorized for 401 and
// ErrIncompatible for 426; the clock takes its first sample from the response.
func (c *Client) Bootstrap(ctx context.Context) (*api.Bootstrap, error) {
	b, resp, err := c.api.RuntimeBootstrap(ctx, bootstrapRetry())
	if err != nil {
		return nil, classify(err)
	}
	c.clock.Observe(b.ServerTime, resp.Sent, resp.Received)
	return b, nil
}

// State sends one state poll (never retried). 401 becomes ErrUnauthorized.
func (c *Client) State(ctx context.Context, req api.RuntimeStateRequest) (*api.RuntimeStateResponse, error) {
	out, resp, err := c.api.RuntimeState(ctx, req)
	if err != nil {
		return nil, classify(err)
	}
	c.clock.Observe(out.ServerTime, resp.Sent, resp.Received)
	return out, nil
}

// Presign calls POST /api/runtime/uploads/presign once; the uploader retries transient failures within
// the holding budget and counts each of them for the health state (docs/runtime.md §8.8, §12).
func (c *Client) Presign(ctx context.Context, req api.PresignRequest) (*api.PresignResponse, error) {
	out, err := c.api.RuntimePresignUploads(ctx, req, nil)
	if err != nil {
		return nil, classify(err)
	}
	return out, nil
}

// AnalysesStatus calls POST /api/runtime/analyses/status once with a 5 s timeout.
func (c *Client) AnalysesStatus(ctx context.Context, seqs []int64) (*api.AnalysesStatusResponse, error) {
	out, err := c.api.RuntimeAnalysesStatus(ctx, seqs)
	if err != nil {
		return nil, classify(err)
	}
	return out, nil
}

// schedulerRetry retries the scheduler routes until success (1 s → 60 s), except 401 and 409 staleEpoch.
func schedulerRetry() *api.RetryPolicy {
	p := api.RetryUnlessStaleEpoch(api.RetryForever())
	inner := p.RetryIf
	p.RetryIf = func(err error) bool {
		return status(err) != http.StatusUnauthorized && inner(err)
	}
	return p
}

// Resolved records a template resolution (retried until success).
func (c *Client) Resolved(ctx context.Context, req api.SchedulerResolvedRequest) (*api.SchedulerResolvedResponse, error) {
	out, err := c.api.SchedulerResolved(ctx, req, schedulerRetry())
	if err != nil {
		return nil, classify(err)
	}
	return out, nil
}

// Checkpoint stores the confirmed prefix once; failures are retried by the caller at the next interval
// (docs/runtime.md §11.5).
func (c *Client) Checkpoint(ctx context.Context, req api.SchedulerCheckpointRequest) (*api.SchedulerCheckpointResponse, error) {
	sent := time.Now()
	out, err := c.api.SchedulerCheckpoint(ctx, req, nil)
	if err != nil {
		return nil, classify(err)
	}
	c.clock.Observe(out.ServerTime, sent, time.Now())
	return out, nil
}

// Done reports the end of scheduling, retried until it succeeds or returns 409/401.
func (c *Client) Done(ctx context.Context, req api.SchedulerDoneRequest) (*api.SchedulerDoneResponse, error) {
	sent := time.Now()
	out, err := c.api.SchedulerDone(ctx, req, schedulerRetry())
	if err != nil {
		return nil, classify(err)
	}
	c.clock.Observe(out.ServerTime, sent, time.Now())
	return out, nil
}

// ReportError sends POST /api/runtime/errors with at most 3 tries. Non-fatal reports are limited to one
// per (type, phase) per 10 s; a suppressed or failed report is logged and returns false. The error is
// stamped with the corrected clock when it has no time.
func (c *Client) ReportError(ctx context.Context, fatal bool, e scerr.ScantorError, stderrTail string) bool {
	return c.report(ctx, fatal, !fatal, e, stderrTail)
}

// ReportRestart reports a retryable scheduling error before an in-process restart (docs/runtime.md
// §11.9). The orchestrator counts scheduler restarts from these reports, so they bypass the rate limit;
// the restart backoff already paces them.
func (c *Client) ReportRestart(ctx context.Context, e scerr.ScantorError, stderrTail string) bool {
	return c.report(ctx, false, false, e, stderrTail)
}

func (c *Client) report(ctx context.Context, fatal, limited bool, e scerr.ScantorError, stderrTail string) bool {
	if e.At.IsZero() {
		e.At = c.clock.Now()
	}
	e = e.Truncate(scerr.MaxStackBytes)
	key := string(e.Type) + "/" + string(e.Phase)
	if limited {
		c.reportMu.Lock()
		last, seen := c.lastReport[key]
		if seen && time.Since(last) < reportInterval {
			c.reportMu.Unlock()
			c.logger.Debug("error report suppressed by the rate limit", "type", e.Type, "phase", e.Phase)
			return false
		}
		c.lastReport[key] = time.Now()
		c.reportMu.Unlock()
	}
	report := api.RuntimeErrorReport{Fatal: fatal, Error: e.API()}
	if stderrTail != "" {
		report.Context = &api.RuntimeErrorContext{StderrTail: logtail.Render([]byte(stderrTail), int64(len(stderrTail)), maxStderrTail)}
	}
	if _, err := c.api.RuntimeReportError(ctx, report, api.RetryAttempts(reportTries)); err != nil {
		c.logger.Warn("cannot report a worker error", "type", e.Type, "phase", e.Phase, "err", err)
		return false
	}
	return true
}
