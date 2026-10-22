// Package upload stores the files of a successful execution (docs/runtime.md §8.8): one presign call for
// all files, then PUTs with exactly the returned headers, at most 4 in parallel, each bounded by
// uploads.timeoutMs; transient failures are retried within the holding budget, an expired URL triggers
// one new presign for the remaining files. The orchestrator chooses every key.
package upload

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/runtime/scerr"
)

// Parallelism is the number of concurrent PUTs per execution.
const Parallelism = 4

// Retry backoff of transient failures (1 s → 30 s, ×2, full jitter).
const (
	retryInitial = time.Second
	retryMax     = 30 * time.Second
)

// File is a registered file of an execution.
type File struct {
	ID          string
	Name        string
	Path        string
	Size        int64
	SHA256      string
	ContentType string
}

// Target identifies the execution the files belong to.
type Target struct {
	Seq         int64
	Round       int
	Attempt     int
	ExecutionID string
}

// Presigner requests presigned PUT URLs (one attempt per call).
type Presigner interface {
	Presign(ctx context.Context, req api.PresignRequest) (*api.PresignResponse, error)
}

// TransientError is a platform failure that may succeed later (network, timeouts, 5xx, 429); the
// caller gives the delivery back when the budget is exhausted (docs/runtime.md §8.8).
type TransientError struct{ Err error }

func (e *TransientError) Error() string { return "transient upload failure: " + e.Err.Error() }
func (e *TransientError) Unwrap() error { return e.Err }

// Uploader uploads the files of executions.
type Uploader struct {
	Presigner Presigner
	// HTTP performs the PUTs; it applies the transport policy and sends no credentials.
	HTTP *http.Client
	// Policy checks every presigned URL before its first connection.
	Policy api.Policy
	// Timeout bounds one PUT (uploads.timeoutMs).
	Timeout time.Duration
	// Now is the corrected clock (URL expiry).
	Now func() time.Time
	// OnTransient is called for every transient failure (health accounting, docs/runtime.md §12).
	OnTransient func(error)
	Logger      *slog.Logger
}

// Upload uploads files. The context's deadline is the holding budget. It returns nil, a
// *TransientError (budget exhausted), a scerr.ScantorError (deterministic failure to record on the
// analysis), or an error from the orchestrator that ends the worker (bootstrap.ErrUnauthorized).
func (u *Uploader) Upload(ctx context.Context, t Target, files []File) error {
	if len(files) == 0 {
		return nil
	}
	remaining := files
	represigned := false
	for {
		urls, err := u.presign(ctx, t, remaining)
		if err != nil {
			return err
		}
		failed, expired, err := u.putAll(ctx, remaining, urls)
		if err != nil {
			return err
		}
		if len(failed) == 0 {
			return nil
		}
		if !expired || represigned {
			return deterministic("presigned upload URL expired before the upload finished")
		}
		represigned, remaining = true, failed
	}
}

func deterministic(format string, args ...any) error {
	return scerr.Newf(api.ErrorPlatform, api.PhaseUpload, format, args...)
}

func (u *Uploader) presign(ctx context.Context, t Target, files []File) (map[string]api.PresignedUpload, error) {
	req := api.PresignRequest{Seq: t.Seq, Round: t.Round, Attempt: t.Attempt, ExecutionID: t.ExecutionID}
	for _, f := range files {
		req.Files = append(req.Files, api.PresignFile{FileID: f.ID, Name: f.Name, Size: f.Size, SHA256: f.SHA256, ContentType: f.ContentType})
	}
	var resp *api.PresignResponse
	err := u.retry(ctx, func(ctx context.Context) error {
		r, err := u.Presigner.Presign(ctx, req)
		if err != nil {
			return classifyPresign(err)
		}
		resp = r
		return nil
	})
	if err != nil {
		return nil, err
	}
	urls := make(map[string]api.PresignedUpload, len(resp.Files))
	for _, f := range resp.Files {
		urls[f.FileID] = f
	}
	for _, f := range files {
		if _, ok := urls[f.ID]; !ok {
			return nil, deterministic("the orchestrator did not presign file %s", f.Name)
		}
	}
	return urls, nil
}

// classifyPresign maps presign failures (docs/runtime.md §8.8 table).
func classifyPresign(err error) error {
	e, ok := api.AsError(err)
	if !ok {
		if api.Temporary(err) {
			return &TransientError{Err: err}
		}
		return err
	}
	switch {
	case e.Temporary():
		return &TransientError{Err: err}
	case e.Status == http.StatusUnauthorized:
		return err
	case e.Code == api.CodeValidationFailed || e.Status == http.StatusBadRequest:
		return scerr.New(api.ErrorValidation, api.PhaseUpload, e.Message)
	case e.Code == api.CodeQuotaExceeded:
		return scerr.New(api.ErrorPlatform, api.PhaseUpload, "storage quota exceeded")
	default:
		return deterministic("presign failed: %s (%s, HTTP %d)", e.Message, e.Code, e.Status)
	}
}

// putAll uploads every file; it returns the files that failed with an expired URL.
func (u *Uploader) putAll(ctx context.Context, files []File, urls map[string]api.PresignedUpload) ([]File, bool, error) {
	var mu sync.Mutex
	var expired []File
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(Parallelism)
	for _, f := range files {
		g.Go(func() error {
			target := urls[f.ID]
			err := u.retry(gctx, func(ctx context.Context) error { return u.put(ctx, f, target) })
			if errors.Is(err, errExpired) {
				mu.Lock()
				expired = append(expired, f)
				mu.Unlock()
				return nil
			}
			return err
		})
	}
	if err := g.Wait(); err != nil {
		return nil, false, err
	}
	return expired, len(expired) > 0, nil
}

var errExpired = errors.New("presigned URL expired")

func (u *Uploader) put(ctx context.Context, f File, target api.PresignedUpload) error {
	if err := u.Policy.CheckTransport(ctx, target.URL); err != nil {
		if errors.Is(err, api.ErrPlaintextRefused) {
			return deterministic("upload URL refused by the transport policy: %v", err)
		}
		return &TransientError{Err: err}
	}
	if !target.ExpiresAt.IsZero() && u.now().After(target.ExpiresAt.Time) {
		return errExpired
	}
	method := target.Method
	if method == "" {
		method = http.MethodPut
	}
	timeout := u.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	file, err := os.Open(f.Path)
	if err != nil {
		return deterministic("cannot read file %s: %v", f.Name, err)
	}
	defer file.Close()
	req, err := http.NewRequestWithContext(ctx, method, target.URL, io.NopCloser(file))
	if err != nil {
		return deterministic("invalid upload URL for %s: %v", f.Name, err)
	}
	req.ContentLength = f.Size
	for k, v := range target.Headers {
		if http.CanonicalHeaderKey(k) == "Content-Length" {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil || n != f.Size {
				return deterministic("presigned Content-Length %q does not match the size of %s (%d)", v, f.Name, f.Size)
			}
			continue
		}
		req.Header.Set(k, v)
	}
	if f.Size == 0 {
		req.Body = http.NoBody
	}
	resp, err := u.HTTP.Do(req)
	if err != nil {
		if errors.Is(err, api.ErrPlaintextRefused) {
			return deterministic("upload URL refused by the transport policy: %v", err)
		}
		return &TransientError{Err: fmt.Errorf("PUT %s: %w", f.Name, err)}
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		_ = resp.Body.Close()
	}()
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return nil
	case resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusRequestTimeout:
		return &TransientError{Err: fmt.Errorf("PUT %s: HTTP %d", f.Name, resp.StatusCode)}
	case resp.StatusCode == http.StatusForbidden && !target.ExpiresAt.IsZero() && !u.now().Before(target.ExpiresAt.Add(-5*time.Second)):
		return errExpired
	default:
		return deterministic("upload of %s rejected by storage: HTTP %d", f.Name, resp.StatusCode)
	}
}

// retry runs fn until it succeeds or fails with a non-transient error, backing off 1 s → 30 s between
// transient failures while the context (the holding budget) allows.
func (u *Uploader) retry(ctx context.Context, fn func(context.Context) error) error {
	for attempt := 1; ; attempt++ {
		err := fn(ctx)
		var te *TransientError
		if !errors.As(err, &te) {
			return err
		}
		if u.OnTransient != nil {
			u.OnTransient(err)
		}
		if u.Logger != nil {
			u.Logger.Warn("transient upload failure", "attempt", attempt, "err", err)
		}
		delay := time.Duration(rand.Float64() * float64(min(retryInitial<<min(attempt-1, 10), retryMax))) //nolint:gosec // jitter
		if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < delay {
			return err
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(delay):
		}
	}
}

func (u *Uploader) now() time.Time {
	if u.Now != nil {
		return u.Now()
	}
	return time.Now()
}
