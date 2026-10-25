package api

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"time"
)

// Transport policy (docs/nodes.md §11, docs/security.md TLS-1…TLS-3):
//
//   - https:// and amqps:// are always allowed; TLS verification is always on, with the system roots
//     plus the PEM certificates of SCANTOR_CA_CERT. There is no skip-verify option.
//   - http:// and amqp:// are allowed only when every address the host resolves to is loopback
//     (127.0.0.0/8, ::1), RFC 1918, CGNAT (100.64.0.0/10) or IPv6 ULA (fc00::/7), or when
//     SCANTOR_ALLOW_INSECURE_TRANSPORT=true. The check runs in the dialer on the resolved and the actual
//     peer addresses, so DNS changes cannot bypass it.

var privateRanges = []netip.Prefix{
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("fc00::/7"),
}

// PlaintextAllowed reports whether plaintext transport to addr is allowed without
// SCANTOR_ALLOW_INSECURE_TRANSPORT: loopback, RFC 1918, CGNAT or IPv6 ULA.
func PlaintextAllowed(addr netip.Addr) bool {
	addr = addr.Unmap()
	for _, p := range privateRanges {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

// ErrPlaintextRefused is returned when a plaintext connection to a public address is refused.
var ErrPlaintextRefused = errors.New("plaintext transport to a public address is refused; use https/amqps or set SCANTOR_ALLOW_INSECURE_TRANSPORT=true")

// Policy is the transport policy of one component.
type Policy struct {
	// CACertPEM holds additional trusted CA certificates (SCANTOR_CA_CERT), appended to the system roots.
	CACertPEM string
	// AllowInsecure permits plaintext to public hosts (SCANTOR_ALLOW_INSECURE_TRANSPORT=true).
	AllowInsecure bool
	// EnforcePlaintext enables the plaintext check. The node daemon and the runtime set it; the CLI
	// does not (it talks to whatever SCANTOR_URL the user configured).
	EnforcePlaintext bool
	// Resolver resolves host names for the plaintext check; nil uses net.DefaultResolver.
	Resolver *net.Resolver
}

// TLSConfig returns a client TLS configuration with the system roots plus CACertPEM. Certificate
// verification is always enabled.
func (p Policy) TLSConfig() (*tls.Config, error) {
	roots, err := x509.SystemCertPool()
	if err != nil || roots == nil {
		roots = x509.NewCertPool()
	}
	if p.CACertPEM != "" {
		if !roots.AppendCertsFromPEM([]byte(p.CACertPEM)) {
			return nil, errors.New("SCANTOR_CA_CERT contains no valid PEM certificate")
		}
	}
	return &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}, nil
}

// Secure and plaintext URL schemes of the transport rule.
var (
	secureSchemes    = []string{"https", "amqps"}
	plaintextSchemes = []string{"http", "amqp"}
)

// CheckTransport applies the plaintext rule to rawURL before the first connection (the node daemon's
// start-up check of SCANTOR_URL, the runtime's check of the bootstrap AMQP URL): https:// and amqps://
// pass; http:// and amqp:// pass when the policy does not enforce the rule, allows insecure transport, or
// every address the host resolves to is private. A refusal wraps ErrPlaintextRefused. PlaintextDialer
// repeats the check on the actual peer address at connect time.
func (p Policy) CheckTransport(ctx context.Context, rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return errors.New("invalid URL")
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("invalid URL %s: missing host", u.Redacted())
	}
	switch {
	case slices.Contains(secureSchemes, u.Scheme):
		return nil
	case !slices.Contains(plaintextSchemes, u.Scheme):
		return fmt.Errorf("invalid URL %s: unsupported scheme %q", u.Redacted(), u.Scheme)
	case !p.EnforcePlaintext || p.AllowInsecure:
		return nil
	}
	addrs, err := p.resolve(ctx, host)
	if err != nil {
		return err
	}
	for _, a := range addrs {
		if !PlaintextAllowed(a) {
			return fmt.Errorf("%s (%s): %w", u.Redacted(), a, ErrPlaintextRefused)
		}
	}
	return nil
}

// resolve returns the addresses of host (an IP literal resolves to itself).
func (p Policy) resolve(ctx context.Context, host string) ([]netip.Addr, error) {
	if ip, err := netip.ParseAddr(host); err == nil {
		return []netip.Addr{ip}, nil
	}
	resolver := p.Resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	addrs, err := resolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, fmt.Errorf("resolve %s: %w", host, err)
	}
	if len(addrs) == 0 {
		return nil, fmt.Errorf("resolve %s: no addresses", host)
	}
	return addrs, nil
}

// DialFunc is the signature of net.Dialer.DialContext.
type DialFunc func(ctx context.Context, network, address string) (net.Conn, error)

// PlaintextDialer returns a dialer for plaintext connections (http://, amqp://) that refuses public
// addresses unless the policy allows them. With EnforcePlaintext unset or AllowInsecure set it dials
// without checks.
func (p Policy) PlaintextDialer(base *net.Dialer) DialFunc {
	if base == nil {
		base = &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	}
	if !p.EnforcePlaintext || p.AllowInsecure {
		return base.DialContext
	}
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		addrs, err := p.resolve(ctx, host)
		if err != nil {
			return nil, err
		}
		for _, a := range addrs {
			if !PlaintextAllowed(a) {
				return nil, fmt.Errorf("connect to %s (%s): %w", host, a, ErrPlaintextRefused)
			}
		}
		var lastErr error
		for _, a := range addrs {
			conn, err := base.DialContext(ctx, network, net.JoinHostPort(a.String(), port))
			if err != nil {
				lastErr = err
				continue
			}
			if err := checkPeer(conn); err != nil {
				_ = conn.Close()
				return nil, fmt.Errorf("connect to %s: %w", host, err)
			}
			return conn, nil
		}
		return nil, lastErr
	}
}

func checkPeer(conn net.Conn) error {
	tcp, ok := conn.RemoteAddr().(*net.TCPAddr)
	if !ok {
		return fmt.Errorf("unexpected peer address %v", conn.RemoteAddr())
	}
	ip, ok := netip.AddrFromSlice(tcp.IP)
	if !ok || !PlaintextAllowed(ip) {
		return ErrPlaintextRefused
	}
	return nil
}

// HTTPTransport returns a RoundTripper that applies the policy: https requests use TLS with the
// policy's roots, http requests use the plaintext dialer.
func (p Policy) HTTPTransport() (http.RoundTripper, error) {
	tlsConfig, err := p.TLSConfig()
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	secure := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           dialer.DialContext,
		TLSClientConfig:       tlsConfig,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          32,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	plain := &http.Transport{
		// No proxy for plaintext: the policy is about the actual peer address.
		DialContext:     p.PlaintextDialer(dialer),
		MaxIdleConns:    32,
		IdleConnTimeout: 90 * time.Second,
	}
	return &policyTransport{secure: secure, plain: plain}, nil
}

type policyTransport struct {
	secure *http.Transport
	plain  *http.Transport
}

func (t *policyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	switch req.URL.Scheme {
	case "https":
		return t.secure.RoundTrip(req)
	case "http":
		return t.plain.RoundTrip(req)
	default:
		return nil, fmt.Errorf("unsupported URL scheme %q", req.URL.Scheme)
	}
}

// CloseIdleConnections closes idle connections of both transports.
func (t *policyTransport) CloseIdleConnections() {
	t.secure.CloseIdleConnections()
	t.plain.CloseIdleConnections()
}

// HTTPClient returns an http.Client with the policy's transport. Redirects are not followed: the
// scantor APIs never redirect machine clients, and following a redirect could leak the Authorization
// header to another host.
func (p Policy) HTTPClient() (*http.Client, error) {
	rt, err := p.HTTPTransport()
	if err != nil {
		return nil, err
	}
	return &http.Client{
		Transport: rt,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}, nil
}
