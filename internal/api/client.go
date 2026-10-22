// Package api holds the wire types of every orchestrator route the Go roles use (/api/node/*,
// /api/runtime/*, the registry token payloads and the user API representations the CLI needs), a typed
// HTTP client, and the transport policy shared by the CLI, the node daemon and the runtime
// (docs/api.md, docs/nodes.md §11).
//
// The client authenticates as exactly one principal (user API key, node token or worker token), sends
// User-Agent and X-Scantor-Version on every request, decodes the error envelope into *Error (with a
// CLI exit class), supports long-polling (`wait`) and retries with jittered exponential backoff where
// the caller asks for it.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"github.com/lonetis/scantor/internal/keys"
	"github.com/lonetis/scantor/internal/redact"
	"github.com/lonetis/scantor/internal/version"
)

// PrincipalKind is the kind of credential a client presents.
type PrincipalKind int

// Principal kinds of the Go roles.
const (
	// PrincipalUser authenticates with a user API key (sk_scantor_…, the CLI's SCANTOR_TOKEN).
	PrincipalUser PrincipalKind = iota
	// PrincipalNode authenticates with a node token (snt_…).
	PrincipalNode
	// PrincipalWorker authenticates with a worker token (swt_<workerId>.<mac>).
	PrincipalWorker
)

func (k PrincipalKind) String() string {
	switch k {
	case PrincipalUser:
		return "user"
	case PrincipalNode:
		return "node"
	case PrincipalWorker:
		return "worker"
	default:
		return "unknown"
	}
}

// UserAgent returns the User-Agent of the principal kind: scantor-cli, scantor-node or scantor-runtime
// followed by the binary version.
func (k PrincipalKind) UserAgent() string {
	switch k {
	case PrincipalNode:
		return version.UserAgent("scantor-node")
	case PrincipalWorker:
		return version.UserAgent("scantor-runtime")
	default:
		return version.UserAgent("scantor-cli")
	}
}

// Credential is the principal a client authenticates as. All kinds are sent as
// `Authorization: Bearer <token>`.
type Credential struct {
	Kind  PrincipalKind
	Token string
}

// ErrNoToken is returned by user API calls that need a credential when none is configured.
var ErrNoToken = errors.New("no API token: set SCANTOR_TOKEN to an API key from \"CLI & MCP access\"")

func (c Credential) validate() error {
	switch c.Kind {
	case PrincipalUser:
		if c.Token != "" && !strings.HasPrefix(c.Token, "sk_scantor_") {
			return errors.New("SCANTOR_TOKEN must be a scantor API key (sk_scantor_…)")
		}
	case PrincipalNode:
		if !keys.ValidNodeToken(c.Token) {
			return errors.New("the node token must have the form snt_ followed by 43 base64url characters")
		}
	case PrincipalWorker:
		if _, _, ok := keys.ParseWorkerToken(c.Token); !ok {
			return errors.New("the worker token must have the form swt_<workerId>.<mac>")
		}
	default:
		return fmt.Errorf("unknown principal kind %d", c.Kind)
	}
	return nil
}

// DefaultTimeout is the per-attempt timeout of a request without an explicit Timeout.
const DefaultTimeout = 30 * time.Second

// longPollMargin is added to a long-poll's wait to obtain its request timeout.
const longPollMargin = 30 * time.Second

// maxJSONResponseBytes bounds decoded JSON responses.
const maxJSONResponseBytes = 256 << 20

// Options configure a Client.
type Options struct {
	// BaseURL is the orchestrator base URL (SCANTOR_URL), for example https://scantor.example.com.
	BaseURL string
	// Credential is the principal of every request.
	Credential Credential
	// Policy is the transport policy; ignored when HTTPClient is set.
	Policy Policy
	// HTTPClient overrides the client built from Policy (tests).
	HTTPClient *http.Client
	// UserAgent overrides the principal's default User-Agent.
	UserAgent string
	// Logger receives debug records of every request (method, path, status, duration); nil disables.
	Logger *slog.Logger
}

// Client is a typed client of the orchestrator API. It is safe for concurrent use.
type Client struct {
	base       *url.URL
	cred       Credential
	http       *http.Client
	userAgent  string
	logger     *slog.Logger
	instanceID atomic.Pointer[string]
}

// New returns a client for opts.
func New(opts Options) (*Client, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(opts.BaseURL), "/"))
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" {
		return nil, fmt.Errorf("invalid orchestrator URL %q: use http(s)://host[:port]", redact.String(opts.BaseURL))
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, errors.New("invalid orchestrator URL: user info, query and fragment are not allowed")
	}
	if err := opts.Credential.validate(); err != nil {
		return nil, err
	}
	httpClient := opts.HTTPClient
	if httpClient == nil {
		if httpClient, err = opts.Policy.HTTPClient(); err != nil {
			return nil, err
		}
	}
	ua := opts.UserAgent
	if ua == "" {
		ua = opts.Credential.Kind.UserAgent()
	}
	return &Client{base: base, cred: opts.Credential, http: httpClient, userAgent: ua, logger: opts.Logger}, nil
}

// BaseURL returns the orchestrator base URL without a trailing slash.
func (c *Client) BaseURL() string { return c.base.String() }

// HasToken reports whether the client has a credential.
func (c *Client) HasToken() bool { return c.cred.Token != "" }

// SetInstanceID sets the X-Scantor-Instance-Id header sent by node clients after hello.
func (c *Client) SetInstanceID(id string) { c.instanceID.Store(&id) }

// HTTPClient returns the underlying HTTP client (same transport policy), for example for presigned
// URLs, which must be called without the Authorization header.
func (c *Client) HTTPClient() *http.Client { return c.http }

// Request describes one API call.
type Request struct {
	Method string
	// Path is the absolute API path, for example "/api/scans/<id>"; path parameters must already be
	// escaped (see PathSegment).
	Path  string
	Query url.Values
	// Body is encoded as JSON when not nil.
	Body any
	// RawBody is streamed as is with ContentType; such requests are never retried.
	RawBody     io.Reader
	ContentType string
	Accept      string
	Header      http.Header
	// Timeout bounds one attempt (until the response body is read for Do); 0 means DefaultTimeout.
	Timeout time.Duration
	// Retry enables retries of temporary failures; nil means one attempt.
	Retry *RetryPolicy
}

// Response holds the metadata of a completed call.
type Response struct {
	Status    int
	Header    http.Header
	RequestID string
	// Wait is the Scantor-Wait header of long-polls: "settled", "timeout" or empty.
	Wait     string
	Sent     time.Time
	Received time.Time
}

// RTT returns the round-trip time of the call.
func (r *Response) RTT() time.Duration { return r.Received.Sub(r.Sent) }

// PathSegment escapes one path parameter.
func PathSegment(s string) string { return url.PathEscape(s) }

// Do performs req and decodes a JSON response into out (unless out is nil or the status is 204). Non-2xx
// responses become *Error. Temporary failures are retried according to req.Retry.
func (c *Client) Do(ctx context.Context, req Request, out any) (*Response, error) {
	var body []byte
	if req.Body != nil {
		if req.RawBody != nil {
			return nil, errors.New("request has both Body and RawBody")
		}
		b, err := marshalNoEscape(req.Body)
		if err != nil {
			return nil, fmt.Errorf("encode %s %s: %w", req.Method, req.Path, err)
		}
		body = b
	}
	retry := req.Retry
	if req.RawBody != nil {
		retry = nil
	}
	start := time.Now()
	for attempt := 1; ; attempt++ {
		resp, err := c.attempt(ctx, req, body, out)
		if err == nil {
			return resp, nil
		}
		if retry == nil || !retry.shouldRetry(err) || ctx.Err() != nil {
			return resp, err
		}
		delay := retry.Delay(attempt)
		if retry.MaxAttempts > 0 && attempt >= retry.MaxAttempts {
			return resp, err
		}
		if retry.MaxElapsed > 0 && time.Since(start)+delay > retry.MaxElapsed {
			return resp, err
		}
		c.debug("retrying", "method", req.Method, "path", req.Path, "attempt", attempt, "delay", delay, "err", err)
		select {
		case <-ctx.Done():
			return resp, err
		case <-time.After(delay):
		}
	}
}

func (c *Client) attempt(ctx context.Context, req Request, body []byte, out any) (*Response, error) {
	timeout := req.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	} else if req.RawBody != nil {
		reader = req.RawBody
	}
	httpResp, meta, err := c.send(ctx, req, reader, body != nil)
	if err != nil {
		return meta, err
	}
	defer drainClose(httpResp.Body)
	if out == nil || httpResp.StatusCode == http.StatusNoContent {
		return meta, nil
	}
	dec := json.NewDecoder(io.LimitReader(httpResp.Body, maxJSONResponseBytes))
	if err := dec.Decode(out); err != nil {
		return meta, fmt.Errorf("decode %s %s response: %w", req.Method, req.Path, err)
	}
	return meta, nil
}

// Open performs req and returns the raw response for streaming bodies (downloads, server-sent events).
// The caller must close the body. Non-2xx responses become *Error. Only ctx bounds the call; req.Timeout
// bounds the wait for the response headers.
func (c *Client) Open(ctx context.Context, req Request) (*http.Response, *Response, error) {
	var reader io.Reader
	jsonBody := false
	if req.Body != nil {
		b, err := marshalNoEscape(req.Body)
		if err != nil {
			return nil, nil, fmt.Errorf("encode %s %s: %w", req.Method, req.Path, err)
		}
		reader, jsonBody = bytes.NewReader(b), true
	} else if req.RawBody != nil {
		reader = req.RawBody
	}
	timeout := req.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	ctx, cancel := context.WithCancel(ctx)
	timer := time.AfterFunc(timeout, cancel)
	resp, meta, err := c.send(ctx, req, reader, jsonBody)
	if !timer.Stop() && err == nil {
		// The header timeout fired just as the response arrived; treat it as a timeout.
		drainClose(resp.Body)
		cancel()
		return nil, meta, fmt.Errorf("%s %s: %w", req.Method, req.Path, context.DeadlineExceeded)
	}
	if err != nil {
		cancel()
		return nil, meta, err
	}
	resp.Body = &cancelOnClose{ReadCloser: resp.Body, cancel: cancel}
	return resp, meta, nil
}

type cancelOnClose struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (c *cancelOnClose) Close() error {
	err := c.ReadCloser.Close()
	c.cancel()
	return err
}

// send executes one HTTP exchange and converts non-2xx responses into *Error (closing their body).
func (c *Client) send(ctx context.Context, req Request, body io.Reader, jsonBody bool) (*http.Response, *Response, error) {
	unescaped, err := url.PathUnescape(req.Path)
	if err != nil {
		return nil, nil, fmt.Errorf("build %s %s: invalid path: %w", req.Method, req.Path, err)
	}
	u := *c.base
	u.Path = c.base.Path + unescaped
	u.RawPath = c.base.EscapedPath() + req.Path
	if len(req.Query) > 0 {
		u.RawQuery = req.Query.Encode()
	}
	httpReq, err := http.NewRequestWithContext(ctx, req.Method, u.String(), body)
	if err != nil {
		return nil, nil, fmt.Errorf("build %s %s: %w", req.Method, req.Path, err)
	}
	for k, vs := range req.Header {
		for _, v := range vs {
			httpReq.Header.Add(k, v)
		}
	}
	httpReq.Header.Set("User-Agent", c.userAgent)
	httpReq.Header.Set(HeaderVersion, version.Version)
	if c.cred.Token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.cred.Token)
	}
	if id := c.instanceID.Load(); id != nil && c.cred.Kind == PrincipalNode {
		httpReq.Header.Set(HeaderInstanceID, *id)
	}
	switch {
	case req.ContentType != "":
		httpReq.Header.Set("Content-Type", req.ContentType)
	case jsonBody:
		httpReq.Header.Set("Content-Type", "application/json")
	}
	accept := req.Accept
	if accept == "" {
		accept = "application/json"
	}
	httpReq.Header.Set("Accept", accept)

	meta := &Response{Sent: time.Now()}
	resp, err := c.http.Do(httpReq)
	meta.Received = time.Now()
	if err != nil {
		c.debug("request failed", "method", req.Method, "path", req.Path, "err", err)
		return nil, meta, &NetworkError{Method: req.Method, Path: req.Path, Err: err}
	}
	meta.Status = resp.StatusCode
	meta.Header = resp.Header
	meta.RequestID = resp.Header.Get(HeaderRequestID)
	meta.Wait = resp.Header.Get(HeaderWait)
	c.debug("request", "method", req.Method, "path", req.Path, "status", resp.StatusCode, "duration", meta.RTT(), "requestId", meta.RequestID)
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBodyBytes))
		drainClose(resp.Body)
		return nil, meta, decodeError(resp.StatusCode, req.Method, req.Path, meta.RequestID, data)
	}
	return resp, meta, nil
}

func (c *Client) debug(msg string, args ...any) {
	if c.logger != nil {
		c.logger.Debug(msg, args...)
	}
}

func drainClose(r io.ReadCloser) {
	_, _ = io.Copy(io.Discard, io.LimitReader(r, 64<<10))
	_ = r.Close()
}

// NetworkError is a failure to reach the orchestrator (connection, TLS, timeout). Its exit class is
// platform (3).
type NetworkError struct {
	Method, Path string
	Err          error
}

func (e *NetworkError) Error() string {
	return fmt.Sprintf("%s %s: %s", e.Method, e.Path, redact.String(e.Err.Error()))
}

func (e *NetworkError) Unwrap() error { return e.Err }

// ExitClass returns the platform exit class.
func (e *NetworkError) ExitClass() int { return ExitPlatform }

// Jitter selects the randomisation of a backoff delay.
type Jitter int

// Jitter modes.
const (
	// JitterFull draws the delay uniformly from [0, d].
	JitterFull Jitter = iota
	// JitterNone uses d exactly.
	JitterNone
	// JitterPlusMinus20 draws the delay uniformly from [0.8 d, 1.2 d].
	JitterPlusMinus20
)

// RetryPolicy retries temporary failures with exponential backoff: the n-th delay (1-based) is
// min(Max, Initial × Factor^(n−1)) with Jitter applied.
type RetryPolicy struct {
	Initial time.Duration
	Max     time.Duration
	Factor  float64
	Jitter  Jitter
	// MaxAttempts bounds the number of attempts; 0 means unlimited.
	MaxAttempts int
	// MaxElapsed bounds the total time spent including delays; 0 means unlimited (ctx still applies).
	MaxElapsed time.Duration
	// RetryIf overrides the default decision (network errors and temporary *Error statuses).
	RetryIf func(error) bool
}

// RetryForever returns the policy of the bootstrap and scheduler routes: 1 s → 60 s, ×2, full jitter,
// until the context ends (docs/runtime.md §4.3).
func RetryForever() *RetryPolicy {
	return &RetryPolicy{Initial: time.Second, Max: 60 * time.Second, Factor: 2, Jitter: JitterFull}
}

// RetryWithin returns a 1 s → 30 s policy bounded by budget (presigned uploads within the holding
// budget, docs/runtime.md §8.10).
func RetryWithin(budget time.Duration) *RetryPolicy {
	return &RetryPolicy{Initial: time.Second, Max: 30 * time.Second, Factor: 2, Jitter: JitterFull, MaxElapsed: budget}
}

// RetryAttempts returns a policy of at most n attempts (1 s → 10 s).
func RetryAttempts(n int) *RetryPolicy {
	return &RetryPolicy{Initial: time.Second, Max: 10 * time.Second, Factor: 2, Jitter: JitterFull, MaxAttempts: n}
}

// Delay returns the delay before attempt+1, after the given (1-based) failed attempt.
func (p *RetryPolicy) Delay(attempt int) time.Duration {
	factor := p.Factor
	if factor < 1 {
		factor = 1
	}
	d := float64(p.Initial) * math.Pow(factor, float64(attempt-1))
	if p.Max > 0 && d > float64(p.Max) {
		d = float64(p.Max)
	}
	switch p.Jitter {
	case JitterFull:
		d *= rand.Float64() //nolint:gosec // backoff jitter needs no cryptographic randomness
	case JitterPlusMinus20:
		d *= 0.8 + 0.4*rand.Float64() //nolint:gosec // backoff jitter needs no cryptographic randomness
	}
	return time.Duration(d)
}

func (p *RetryPolicy) shouldRetry(err error) bool {
	if p.RetryIf != nil {
		return p.RetryIf(err)
	}
	return Temporary(err)
}

// Temporary reports whether err is a network failure or a temporary API error (408, 429, 5xx). A
// refused plaintext connection (ErrPlaintextRefused) is permanent: retrying cannot change the policy.
func Temporary(err error) bool {
	if errors.Is(err, context.Canceled) || errors.Is(err, ErrPlaintextRefused) {
		return false
	}
	var ne *NetworkError
	if errors.As(err, &ne) {
		return !errors.Is(ne.Err, context.Canceled)
	}
	if e, ok := AsError(err); ok {
		return e.Temporary()
	}
	return false
}

type nullValue struct{}

func (nullValue) MarshalJSON() ([]byte, error) { return []byte("null"), nil }

// marshalNoEscape encodes v as JSON without HTML escaping and without a trailing newline.
func marshalNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// waitTimeout returns the request timeout of a long-poll with the given wait in seconds.
func waitTimeout(wait int) time.Duration {
	if wait <= 0 {
		return DefaultTimeout
	}
	return time.Duration(wait)*time.Second + longPollMargin
}
