package worker

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/templates/fetch"
)

// uploadTransport applies the platform transport rule (docs/runtime.md §4.2) to the scheduler's downloads of
// uploaded lists: their presigned GETs come from the orchestrator, like SCANTOR_URL and the AMQP URL. A
// plaintext request whose chain started at an upload URL's host, redirects included, dials through the policy's
// plaintext dialer, which checks the actual peer address; a refusal is a non-retryable platform error. Data
// sources keep the template download policy (docs/templates.md §7.2).
type uploadTransport struct {
	base  http.RoundTripper
	plain *http.Transport
	hosts map[string]bool // host[:port] of every upload URL
}

// withUploadRule returns base with the transport rule for the hosts of uploadURLs; base itself when the policy
// does not enforce the rule or there are no uploads.
func withUploadRule(base http.RoundTripper, policy api.Policy, uploadURLs []string) http.RoundTripper {
	hosts := map[string]bool{}
	for _, raw := range uploadURLs {
		if u, err := url.Parse(raw); err == nil && u.Host != "" {
			hosts[u.Host] = true
		}
	}
	if len(hosts) == 0 || !policy.EnforcePlaintext || policy.AllowInsecure {
		return base
	}
	dialer := &net.Dialer{Timeout: fetch.ConnectTimeout, KeepAlive: 30 * time.Second}
	return &uploadTransport{base: base, hosts: hosts, plain: &http.Transport{
		// No proxy: the rule is about the actual peer address.
		DialContext: policy.PlaintextDialer(dialer), MaxIdleConns: 8, IdleConnTimeout: 90 * time.Second,
	}}
}

func (t *uploadTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	origin := req
	for origin.Response != nil && origin.Response.Request != nil {
		origin = origin.Response.Request
	}
	if req.URL.Scheme != "http" || !t.hosts[origin.URL.Host] {
		return t.base.RoundTrip(req)
	}
	resp, err := t.plain.RoundTrip(req)
	if errors.Is(err, api.ErrPlaintextRefused) {
		// The message names the host only: the URL's query carries the signature.
		e := runtime.Platform(false, "the download of an uploaded list from %s is refused by the transport policy: %v", req.URL.Host, api.ErrPlaintextRefused)
		e.Err = api.ErrPlaintextRefused
		return nil, e
	}
	return resp, err
}

// CloseIdleConnections closes the idle connections of both transports.
func (t *uploadTransport) CloseIdleConnections() {
	if c, ok := t.base.(interface{ CloseIdleConnections() }); ok {
		c.CloseIdleConnections()
	}
	t.plain.CloseIdleConnections()
}
