package api

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// Typed methods of the runtime API (/api/runtime/*, docs/api.md §8). They require a worker client
// (PrincipalWorker). Timeouts follow docs/runtime.md §4.3 (bootstrap 30 s, others 15 s); retry
// policies are passed by the caller because they differ per route (RetryForever for bootstrap and
// the scheduler routes, RetryWithin for presign, none for state polls).

// Per-route timeouts of the runtime API.
const (
	BootstrapTimeout      = 30 * time.Second
	RuntimeCallTimeout    = 15 * time.Second
	AnalysesStatusTimeout = 5 * time.Second
	// MaxStatusSeqs bounds the seqs of one analyses/status request.
	MaxStatusSeqs = 1000
)

var errNotWorker = errors.New("runtime API calls need a worker credential")

func (c *Client) workerCall(ctx context.Context, req Request, out any) (*Response, error) {
	if c.cred.Kind != PrincipalWorker {
		return nil, errNotWorker
	}
	return c.Do(ctx, req, out)
}

// IsStaleEpoch reports whether err is the scheduler fence (409 staleEpoch) and returns the current
// epoch from its details when present.
func IsStaleEpoch(err error) (bool, int) {
	e, ok := AsError(err)
	if !ok || e.Code != CodeStaleEpoch {
		return false, 0
	}
	var d StaleEpochDetails
	if err := e.DecodeDetails(&d); err != nil {
		return true, 0
	}
	return true, d.CurrentEpoch
}

// RetryUnlessStaleEpoch wraps a policy so that 409 staleEpoch, 401 and other non-temporary client
// errors stop retrying, as the scheduler routes require.
func RetryUnlessStaleEpoch(p *RetryPolicy) *RetryPolicy {
	cp := *p
	cp.RetryIf = func(err error) bool {
		if stale, _ := IsStaleEpoch(err); stale {
			return false
		}
		return Temporary(err)
	}
	return &cp
}

// RuntimeBootstrap calls runtimeBootstrap. A 401 means the worker is no longer active (exit 0); a 426
// means the runtime is outside the version window (exit 1).
func (c *Client) RuntimeBootstrap(ctx context.Context, retry *RetryPolicy) (*Bootstrap, *Response, error) {
	var out Bootstrap
	resp, err := c.workerCall(ctx, Request{Method: http.MethodGet, Path: "/api/runtime/bootstrap", Timeout: BootstrapTimeout, Retry: retry}, &out)
	if err != nil {
		return nil, resp, err
	}
	return &out, resp, nil
}

// RuntimeState calls runtimeState (never retried; the next poll is the retry).
func (c *Client) RuntimeState(ctx context.Context, body RuntimeStateRequest) (*RuntimeStateResponse, *Response, error) {
	var out RuntimeStateResponse
	resp, err := c.workerCall(ctx, Request{Method: http.MethodPost, Path: "/api/runtime/state", Body: body, Timeout: RuntimeCallTimeout}, &out)
	if err != nil {
		return nil, resp, err
	}
	return &out, resp, nil
}

// RuntimePresignUploads calls runtimePresignUploads.
func (c *Client) RuntimePresignUploads(ctx context.Context, body PresignRequest, retry *RetryPolicy) (*PresignResponse, error) {
	var out PresignResponse
	if _, err := c.workerCall(ctx, Request{Method: http.MethodPost, Path: "/api/runtime/uploads/presign", Body: body, Timeout: RuntimeCallTimeout, Retry: retry}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RuntimeAnalysesStatus calls runtimeAnalysesStatus (one try, 5 s timeout).
func (c *Client) RuntimeAnalysesStatus(ctx context.Context, seqs []int64) (*AnalysesStatusResponse, error) {
	if len(seqs) > MaxStatusSeqs {
		return nil, errors.New("analyses/status accepts at most 1000 seqs")
	}
	var out AnalysesStatusResponse
	if _, err := c.workerCall(ctx, Request{Method: http.MethodPost, Path: "/api/runtime/analyses/status", Body: AnalysesStatusRequest{Seqs: seqs}, Timeout: AnalysesStatusTimeout}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SchedulerResolved calls schedulerResolved.
func (c *Client) SchedulerResolved(ctx context.Context, body SchedulerResolvedRequest, retry *RetryPolicy) (*SchedulerResolvedResponse, error) {
	var out SchedulerResolvedResponse
	if _, err := c.workerCall(ctx, Request{Method: http.MethodPost, Path: "/api/runtime/scheduler/resolved", Body: body, Timeout: RuntimeCallTimeout, Retry: retry}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SchedulerCheckpoint calls schedulerCheckpoint.
func (c *Client) SchedulerCheckpoint(ctx context.Context, body SchedulerCheckpointRequest, retry *RetryPolicy) (*SchedulerCheckpointResponse, error) {
	var out SchedulerCheckpointResponse
	if _, err := c.workerCall(ctx, Request{Method: http.MethodPost, Path: "/api/runtime/scheduler/checkpoint", Body: body, Timeout: RuntimeCallTimeout, Retry: retry}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SchedulerDone calls schedulerDone.
func (c *Client) SchedulerDone(ctx context.Context, body SchedulerDoneRequest, retry *RetryPolicy) (*SchedulerDoneResponse, error) {
	var out SchedulerDoneResponse
	if _, err := c.workerCall(ctx, Request{Method: http.MethodPost, Path: "/api/runtime/scheduler/done", Body: body, Timeout: RuntimeCallTimeout, Retry: retry}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RuntimeReportError calls runtimeReportError (HTTP 202).
func (c *Client) RuntimeReportError(ctx context.Context, body RuntimeErrorReport, retry *RetryPolicy) (*RuntimeErrorResponse, error) {
	var out RuntimeErrorResponse
	if _, err := c.workerCall(ctx, Request{Method: http.MethodPost, Path: "/api/runtime/errors", Body: body, Timeout: RuntimeCallTimeout, Retry: retry}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
