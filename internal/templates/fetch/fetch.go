// Package fetch downloads template data (Tranco, CrUX, uploaded lists) with the fixed HTTP policy of
// docs/templates.md §7.2:
//
//   - User-Agent "scantor/<version> (+https://github.com/lonetis/scantor)", TLS verification always on
//     (SCANTOR_CA_CERT honoured through NewHTTPClient), no cookies, at most 5 redirects;
//   - 10 s to connect, 10 minutes per request (including the body);
//   - network errors, 5xx and 429 get 3 tries in total, 2 s and 4 s apart unless a Retry-After header
//     says otherwise (capped at 60 s); afterwards the error is a retryable platform error;
//   - 64 MiB per download and 256 MiB decoded; exceeding them is a non-retryable platform error;
//   - downloads are cached in Env.TmpDir keyed by URL for the lifetime of the process, so Resolve and
//     Stream download once.
//
// Content-Encoding gzip is decoded here (Accept-Encoding is set explicitly, so the raw transfer size is
// what the download cap counts), and gzip files (CrUX .csv.gz) are decompressed on request.
package fetch

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/templates/core"
)

// HTTP policy constants (docs/templates.md §7.2); they are fixed, not configurable.
const (
	ConnectTimeout   = 10 * time.Second
	RequestTimeout   = 10 * time.Minute
	MaxRedirects     = 5
	Attempts         = 3
	MaxRetryAfter    = 60 * time.Second
	MaxDownloadBytes = 64 << 20
	MaxDecodedBytes  = 256 << 20
	// maxTextBytes bounds small API responses (metadata JSON, list ids).
	maxTextBytes = 1 << 20
)

// retryDelays are the waits after failed tries 1 and 2. Tests of this package shorten them.
var retryDelays = []time.Duration{2 * time.Second, 4 * time.Second}

// NewHTTPClient returns a client with the §7.2 policy: TLS verification with the system roots plus
// caCertPEM (SCANTOR_CA_CERT), a 10 s connect timeout, no cookie jar and at most 5 redirects. The
// per-request timeout is applied by the functions of this package.
func NewHTTPClient(caCertPEM string) (*http.Client, error) {
	tlsConfig, err := api.Policy{CACertPEM: caCertPEM}.TLSConfig()
	if err != nil {
		return nil, err
	}
	return newClient(tlsConfig), nil
}

func newClient(tlsConfig *tls.Config) *http.Client {
	dialer := &net.Dialer{Timeout: ConnectTimeout, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           dialer.DialContext,
		TLSClientConfig:       tlsConfig,
		TLSHandshakeTimeout:   ConnectTimeout,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          8,
		IdleConnTimeout:       90 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(_ *http.Request, via []*http.Request) error {
			if len(via) > MaxRedirects {
				return fmt.Errorf("stopped after %d redirects", MaxRedirects)
			}
			return nil
		},
	}
}

var (
	defaultClientOnce sync.Once
	defaultClient     *http.Client
)

func client(env core.Env) *http.Client {
	if env.HTTP != nil {
		return env.HTTP
	}
	defaultClientOnce.Do(func() {
		// nil RootCAs = the system roots; components with SCANTOR_CA_CERT pass their own client.
		defaultClient = newClient(&tls.Config{MinVersion: tls.VersionTLS12})
	})
	return defaultClient
}

// Request describes one data request.
type Request struct {
	// URL is the absolute URL.
	URL string
	// Label names the resource in error messages instead of the URL. Set it for presigned URLs, whose
	// query carries a signature.
	Label string
	// Gunzip decompresses a gzip file body (for example a .csv.gz) after HTTP content decoding. A body
	// without the gzip magic bytes is taken as already decoded.
	Gunzip bool
	// MaxBytes caps the bytes received (0 = MaxDownloadBytes).
	MaxBytes int64
	// MaxDecoded caps the decoded bytes (0 = MaxDecodedBytes).
	MaxDecoded int64
	// Spacer, when set, spaces this request (and its retries) from other requests of the same Spacer.
	Spacer *Spacer
	// Final reports whether a 5xx or 429 response is an answer rather than a failure; such responses
	// are returned to the caller without retrying (for example Tranco's 503 "null" for a date without
	// a list).
	Final func(status int, body []byte) bool
}

func (r Request) target() string {
	if r.Label != "" {
		return r.Label
	}
	return r.URL
}

// StatusError is a final non-2xx response of Download: a 4xx other than 429, or a 5xx/429 that Final
// accepted.
type StatusError struct {
	Method     string
	Target     string
	StatusCode int
	Status     string
	Body       []byte // at most the first KiB
}

func (e *StatusError) Error() string { return fmt.Sprintf("%s %s: %s", e.Method, e.Target, e.Status) }

// Response is a small response of Text or Head.
type Response struct {
	StatusCode int
	Status     string
	Body       []byte
}

// retryable reports whether a status is retried: 5xx and 429.
func retryable(status int) bool { return status >= 500 || status == http.StatusTooManyRequests }

// attemptError is the outcome of one failed try.
type attemptError struct {
	err        error
	retry      bool
	retryAfter time.Duration // from Retry-After; 0 = default delay
}

// do runs the retry loop of one request. handle consumes a response with a retryable status only
// when final is true; it returns an attemptError to retry (network errors while reading the body).
func do(ctx context.Context, env core.Env, req Request, method string, handle func(*http.Response) *attemptError) error {
	var last *attemptError
	for try := 1; try <= Attempts; try++ {
		if try > 1 {
			delay := retryDelays[min(try-2, len(retryDelays)-1)]
			if last.retryAfter > 0 {
				delay = last.retryAfter
			}
			if err := sleep(ctx, delay); err != nil {
				return err
			}
		}
		release := func() {}
		if req.Spacer != nil {
			var err error
			if release, err = req.Spacer.Acquire(ctx); err != nil {
				return err
			}
		}
		last = attempt(ctx, env, req, method, handle)
		release()
		if last == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !last.retry {
			return last.err
		}
	}
	if e, ok := core.AsError(last.err); ok {
		return e
	}
	return core.Platformf(true, last.err, "%s", last.err.Error())
}

func attempt(ctx context.Context, env core.Env, req Request, method string, handle func(*http.Response) *attemptError) *attemptError {
	ctx, cancel := context.WithTimeout(ctx, RequestTimeout)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(ctx, method, req.URL, nil)
	if err != nil {
		return &attemptError{err: core.Platformf(false, err, "%s %s: invalid URL", method, req.target())}
	}
	ua := env.UserAgent
	if ua == "" {
		ua = core.DefaultUserAgent()
	}
	httpReq.Header.Set("User-Agent", ua)
	httpReq.Header.Set("Accept-Encoding", "gzip")
	resp, err := client(env).Do(httpReq)
	if err != nil {
		return &attemptError{err: fmt.Errorf("%s %s: %w", method, req.target(), unwrapURLError(err)), retry: true}
	}
	defer func() { _ = resp.Body.Close() }()
	if retryable(resp.StatusCode) {
		body := peekBody(resp)
		if req.Final == nil || !req.Final(resp.StatusCode, body) {
			return &attemptError{
				err:        fmt.Errorf("%s %s: %s", method, req.target(), resp.Status),
				retry:      true,
				retryAfter: parseRetryAfter(resp.Header.Get("Retry-After"), time.Now()),
			}
		}
		resp.Body = io.NopCloser(io.MultiReader(bytes.NewReader(body), resp.Body))
	}
	return handle(resp)
}

// unwrapURLError drops the method and URL that *url.Error repeats, so presigned URLs never reach
// messages.
func unwrapURLError(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) && ue.Err != nil {
		if ue.Timeout() {
			return fmt.Errorf("timeout: %w", ue.Err)
		}
		return ue.Err
	}
	return err
}

// peekBody reads up to 1 KiB of an error response for Final and StatusError.
func peekBody(resp *http.Response) []byte {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	return body
}

// parseRetryAfter parses delay-seconds or an HTTP date, capped at MaxRetryAfter; 0 when absent or
// invalid.
func parseRetryAfter(v string, now time.Time) time.Duration {
	if v == "" {
		return 0
	}
	var d time.Duration
	if secs, err := strconv.ParseInt(v, 10, 64); err == nil {
		if secs < 0 {
			return 0
		}
		if secs > int64(MaxRetryAfter/time.Second) {
			return MaxRetryAfter
		}
		d = time.Duration(secs) * time.Second
	} else if at, err := http.ParseTime(v); err == nil {
		d = at.Sub(now)
	} else {
		return 0
	}
	return max(0, min(d, MaxRetryAfter))
}

func sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Text fetches a small response (≤ 1 MiB decoded) with GET. Any non-2xx status that is not retried is
// returned as a Response for the caller to interpret; network errors and 5xx/429 responses that remain
// after the retries are retryable platform errors.
func Text(ctx context.Context, env core.Env, req Request) (*Response, error) {
	var out *Response
	err := do(ctx, env, req, http.MethodGet, func(resp *http.Response) *attemptError {
		body, err := decodeBody(resp.Body, resp.Header.Get("Content-Encoding"))
		if err != nil {
			return &attemptError{err: fmt.Errorf("GET %s: %w", req.target(), err), retry: true}
		}
		data, err := io.ReadAll(io.LimitReader(body, maxTextBytes+1))
		if err != nil {
			return &attemptError{err: fmt.Errorf("GET %s: %w", req.target(), unwrapURLError(err)), retry: true}
		}
		if len(data) > maxTextBytes {
			return &attemptError{err: core.Platformf(false, nil, "GET %s: the response exceeds %d bytes", req.target(), maxTextBytes)}
		}
		out = &Response{StatusCode: resp.StatusCode, Status: resp.Status, Body: data}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// Head sends a HEAD request and returns the final status; network errors and 5xx/429 responses that
// remain after the retries are retryable platform errors.
func Head(ctx context.Context, env core.Env, req Request) (*Response, error) {
	var out *Response
	err := do(ctx, env, req, http.MethodHead, func(resp *http.Response) *attemptError {
		out = &Response{StatusCode: resp.StatusCode, Status: resp.Status}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// Spacer spaces requests (Tranco asks for at most one /api/* request per second): one request at a
// time, each starting at least the interval after the previous one ended, so the upstream sees the
// spacing even with network latency. It is safe for concurrent use.
type Spacer struct {
	interval time.Duration
	slot     chan struct{}

	mu   sync.Mutex
	next time.Time
}

// NewSpacer returns a Spacer with the given interval.
func NewSpacer(interval time.Duration) *Spacer {
	return &Spacer{interval: interval, slot: make(chan struct{}, 1)}
}

// Acquire blocks until no other request of the Spacer is in flight and the interval has passed since
// the last one ended. The caller calls release when its request has ended.
func (s *Spacer) Acquire(ctx context.Context) (release func(), err error) {
	select {
	case s.slot <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	s.mu.Lock()
	wait := time.Until(s.next)
	s.mu.Unlock()
	if err := sleep(ctx, wait); err != nil {
		<-s.slot
		return nil, err
	}
	return func() {
		s.mu.Lock()
		s.next = time.Now().Add(s.interval)
		s.mu.Unlock()
		<-s.slot
	}, nil
}
