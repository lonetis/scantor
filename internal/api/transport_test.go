package api

import (
	"context"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestPlaintextAllowed(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1":         true,
		"127.255.0.9":       true,
		"::1":               true,
		"10.1.2.3":          true,
		"172.16.0.1":        true,
		"172.31.255.255":    true,
		"192.168.1.10":      true,
		"100.64.0.1":        true, // CGNAT (Tailscale, WireGuard overlays)
		"100.127.255.254":   true,
		"fd7a:115c:a1e0::1": true, // ULA (Tailscale IPv6)
		"fc00::1":           true,
		"::ffff:10.0.0.1":   true, // IPv4-mapped private
		"8.8.8.8":           false,
		"172.32.0.1":        false,
		"100.128.0.1":       false,
		"100.63.255.255":    false,
		"169.254.169.254":   false, // link-local metadata is not private transport
		"192.0.2.1":         false,
		"2001:db8::1":       false,
		"fe80::1":           false,
		"::ffff:8.8.8.8":    false,
		"0.0.0.0":           false,
	}
	for in, want := range cases {
		if got := PlaintextAllowed(netip.MustParseAddr(in)); got != want {
			t.Errorf("PlaintextAllowed(%s) = %v, want %v", in, got, want)
		}
	}
}

func TestPlaintextDialer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") }))
	defer srv.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))

	enforced := Policy{EnforcePlaintext: true}.PlaintextDialer(nil)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for _, host := range []string{"127.0.0.1", "localhost"} {
		conn, err := enforced(ctx, "tcp", net.JoinHostPort(host, port))
		if err != nil {
			t.Fatalf("dial %s: %v", host, err)
		}
		_ = conn.Close()
	}
	if _, err := enforced(ctx, "tcp", "192.0.2.1:80"); !errors.Is(err, ErrPlaintextRefused) {
		t.Fatalf("public address not refused: %v", err)
	}

	// SCANTOR_ALLOW_INSECURE_TRANSPORT=true skips the check (the dial itself then fails or times out).
	insecure := Policy{EnforcePlaintext: true, AllowInsecure: true}.PlaintextDialer(&net.Dialer{Timeout: 50 * time.Millisecond})
	short, cancelShort := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancelShort()
	if _, err := insecure(short, "tcp", "192.0.2.1:80"); errors.Is(err, ErrPlaintextRefused) {
		t.Fatalf("insecure policy still refused: %v", err)
	}
}

func TestHTTPTransportPolicy(t *testing.T) {
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "plain") }))
	defer plain.Close()
	client, err := Policy{EnforcePlaintext: true}.HTTPClient()
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Get(plain.URL)
	if err != nil {
		t.Fatalf("loopback plaintext refused: %v", err)
	}
	_ = resp.Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://192.0.2.1/", nil)
	if _, err := client.Do(req); err == nil || !errors.Is(err, ErrPlaintextRefused) {
		t.Fatalf("public plaintext not refused: %v", err)
	}
}

func TestCustomCA(t *testing.T) {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "tls") }))
	srv.Config.ErrorLog = log.New(io.Discard, "", 0) // the untrusted handshake below is expected to fail
	srv.StartTLS()
	defer srv.Close()
	caPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}))

	without, err := Policy{}.HTTPClient()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := without.Get(srv.URL); err == nil {
		t.Fatal("untrusted certificate accepted")
	}

	with, err := Policy{CACertPEM: caPEM}.HTTPClient()
	if err != nil {
		t.Fatal(err)
	}
	resp, err := with.Get(srv.URL)
	if err != nil {
		t.Fatalf("SCANTOR_CA_CERT not trusted: %v", err)
	}
	_ = resp.Body.Close()

	if _, err := (Policy{CACertPEM: "not a certificate"}).TLSConfig(); err == nil {
		t.Fatal("invalid PEM accepted")
	}
}

func TestNoRedirects(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://elsewhere.example.com/", http.StatusFound)
	}))
	defer srv.Close()
	client, _ := Policy{}.HTTPClient()
	resp, err := client.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("redirect followed: %d", resp.StatusCode)
	}
}

func TestCheckTransport(t *testing.T) {
	ctx := context.Background()
	enforced := Policy{EnforcePlaintext: true}
	for raw, refused := range map[string]bool{
		"https://scantor.example.com":       false,
		"amqps://amqp.example.com:443/x":    false,
		"http://127.0.0.1:3000":             false,
		"http://localhost:3000":             false,
		"http://10.0.0.5:3000":              false,
		"amqp://100.64.1.2:5672":            false,
		"http://[fd7a:115c:a1e0::1]:3000":   false,
		"http://192.0.2.1:3000":             true,
		"amqp://user:secret@192.0.2.1:5672": true,
	} {
		err := enforced.CheckTransport(ctx, raw)
		if got := errors.Is(err, ErrPlaintextRefused); got != refused {
			t.Errorf("CheckTransport(%s) = %v, want refused=%v", raw, err, refused)
		}
		if err != nil && strings.Contains(err.Error(), "secret") {
			t.Errorf("CheckTransport(%s) leaks the password: %v", raw, err)
		}
	}
	for _, p := range []Policy{{}, {EnforcePlaintext: true, AllowInsecure: true}} {
		if err := p.CheckTransport(ctx, "http://192.0.2.1:3000"); err != nil {
			t.Errorf("policy %+v refused plaintext: %v", p, err)
		}
	}
	for _, raw := range []string{"ftp://example.com", "http://", "::"} {
		if err := enforced.CheckTransport(ctx, raw); err == nil || errors.Is(err, ErrPlaintextRefused) {
			t.Errorf("CheckTransport(%s) = %v, want an invalid URL error", raw, err)
		}
	}
	// A refusal is permanent, so retry policies stop at once.
	if Temporary(&NetworkError{Method: "GET", Path: "/api/runtime/bootstrap", Err: fmt.Errorf("dial: %w", ErrPlaintextRefused)}) {
		t.Error("a refused plaintext connection is reported as temporary")
	}
}
