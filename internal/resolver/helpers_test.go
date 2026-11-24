package resolver

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/zmap/dns"

	"github.com/lonetis/scantor/internal/resolver/resolvertest"
)

// Tests never use the internet: fake servers listen on loopback ports, and the dialer's rewrite hook
// maps the public addresses (documentation ranges) that configurations, root hints and glue give them.

const (
	testNodeID = "2d9e1f6a-0b7c-4c3e-9f1a-5b6c7d8e9f00"
	testSpec   = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

// testOwnAddr is the node's own (non-loopback) interface address in tests.
var testOwnAddr = netip.MustParseAddr("203.0.113.250")

func testTimings() *timings {
	return &timings{
		clientDeadline:     1500 * time.Millisecond,
		forwardBudget:      1200 * time.Millisecond,
		iterativeBudget:    3 * time.Second,
		networkTimeout:     300 * time.Millisecond,
		iterativeTimeout:   900 * time.Millisecond,
		checkTimeout:       500 * time.Millisecond,
		stateEvery:         50 * time.Millisecond,
		upstreamCheckEvery: 150 * time.Millisecond,
		ipv6CheckEvery:     time.Hour,
		hostNSEvery:        time.Hour,
		ifaceEvery:         time.Hour,
		statsLogEvery:      time.Hour,
		limiterIdle:        time.Minute,
		bindRetry:          100 * time.Millisecond,
		drainQuiet:         100 * time.Millisecond,
		drainMax:           time.Second,
		rateLimitWait:      250 * time.Millisecond,
	}
}

// testConfig is a valid configuration of mode listening on listen.
func testConfig(mode, listen string) Config {
	return Config{
		NodeID:           testNodeID,
		Listen:           listen,
		Clients:          []string{"127.0.0.0/8"},
		Mode:             mode,
		CacheBytes:       MinCacheBytes,
		MaxLookups:       8,
		AuthoritativeQPS: 0,
		LogLevel:         "info",
		LogFormat:        "json",
	}
}

// fakeDNS starts a fake authoritative server on a loopback port.
func fakeDNS(t *testing.T, zones ...*resolvertest.Zone) *resolvertest.Server {
	t.Helper()
	s, err := resolvertest.Start("127.0.0.1:0", zones...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// rootNS is the root zone data an upstream needs to pass the upstream check (". NS").
func rootNS() *resolvertest.Zone {
	return resolvertest.MustZone(".", ". 518400 IN NS a.root.test.")
}

// recorded wraps a network's rewrite hook and logs every address it is asked for.
type recorded struct {
	net *resolvertest.Network
	mu  sync.Mutex
	got []string
}

func (r *recorded) rewrite(network, address string) string {
	r.mu.Lock()
	r.got = append(r.got, address)
	r.mu.Unlock()
	return r.net.Rewrite(network, address)
}

func (r *recorded) dialled(address string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, a := range r.got {
		if a == address {
			return true
		}
	}
	return false
}

// syncBuffer is a log sink safe for concurrent writes.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

type harness struct {
	t     *testing.T
	s     *server
	rec   *recorded
	logs  *syncBuffer
	state string
}

type harnessOption func(*testing.T, *Options)

// withResolvConf gives the server a resolv.conf with content.
func withResolvConf(content string) harnessOption {
	return func(t *testing.T, o *Options) {
		path := filepath.Join(t.TempDir(), "resolv.conf")
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		o.ResolvConf = path
	}
}

// withOptions edits the options.
func withOptions(edit func(*Options)) harnessOption {
	return func(_ *testing.T, o *Options) { edit(o) }
}

// newHarness builds (without running) a server for cfg whose dials go to the servers of n.
func newHarness(t *testing.T, cfg Config, n *resolvertest.Network, opts ...harnessOption) *harness {
	t.Helper()
	h := &harness{t: t, rec: &recorded{net: n}, logs: &syncBuffer{}}
	h.state = filepath.Join(t.TempDir(), "state.json")
	level := slog.LevelInfo
	if cfg.LogLevel == "debug" {
		level = slog.LevelDebug
	}
	empty := filepath.Join(t.TempDir(), "resolv.conf")
	if err := os.WriteFile(empty, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	o := Options{
		Config:     cfg,
		SpecHash:   testSpec,
		Logger:     slog.New(slog.NewJSONHandler(h.logs, &slog.HandlerOptions{Level: level})),
		StatePath:  h.state,
		ResolvConf: empty,
		rewrite:    h.rec.rewrite,
		timings:    testTimings(),
		interfaceAddrs: func() ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("127.0.0.1"), testOwnAddr}, nil
		},
		conntrack: &[2]string{filepath.Join(t.TempDir(), "count"), filepath.Join(t.TempDir(), "max")},
	}
	for _, opt := range opts {
		opt(t, &o)
	}
	s, err := newServer(o)
	if err != nil {
		t.Fatal(err)
	}
	s.runCtx = context.Background()
	h.s = s
	return h
}

// lookup runs one lookup of the engine on route rt.
func (h *harness) lookup(rt route, name string, qtype uint16) result {
	h.t.Helper()
	budget := h.s.t.forwardBudget
	if rt == routeIterative {
		budget = h.s.t.iterativeBudget
	}
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()
	return h.s.engine.lookup(ctx, rt, question{name: dns.Fqdn(strings.ToLower(name)), qtype: qtype})
}

// freeAddr returns a loopback address whose port is free for UDP and TCP.
func freeAddr(t *testing.T) string {
	t.Helper()
	for range 20 {
		pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		addr := pc.LocalAddr().String()
		ln, err := net.Listen("tcp4", addr)
		_ = pc.Close()
		if err == nil {
			_ = ln.Close()
			return addr
		}
	}
	t.Fatal("no free port")
	return ""
}

// running is a resolver served by Run.
type running struct {
	addr   string
	cancel context.CancelFunc
	done   chan error
}

// run serves h's server on a free loopback port until the test ends.
func (h *harness) run() *running {
	h.t.Helper()
	r := &running{addr: h.s.s.listen.String(), done: make(chan error, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	r.cancel = cancel
	go func() { r.done <- h.s.run(ctx) }()
	h.t.Cleanup(func() {
		cancel()
		select {
		case err := <-r.done:
			if err != nil {
				h.t.Errorf("Run = %v", err)
			}
		case <-time.After(5 * time.Second):
			h.t.Error("the resolver did not stop")
		}
	})
	eventually(h.t, 3*time.Second, func() bool { return h.s.ready.Load() })
	return r
}

// eventually polls cond until it holds or timeout passes.
func eventually(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// query sends one query to addr over network.
func query(t *testing.T, network, addr string, m *dns.Msg) *dns.Msg {
	t.Helper()
	r, err := exchangeErr(network, addr, m)
	if err != nil {
		t.Fatalf("query %s %s: %v", network, m.Question[0].Name, err)
	}
	return r
}

func exchangeErr(network, addr string, m *dns.Msg) (*dns.Msg, error) {
	c := &dns.Client{Net: network, Timeout: 3 * time.Second, UDPSize: 65535}
	r, _, err := c.Exchange(m, addr)
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, errors.New("no reply")
	}
	return r, nil
}

func newQuery(name string, qtype uint16) *dns.Msg {
	m := new(dns.Msg)
	m.SetQuestion(dns.Fqdn(name), qtype)
	return m
}

func rrTexts(rrs []dns.RR) []string {
	out := make([]string, len(rrs))
	for i, rr := range rrs {
		out[i] = strings.Join(strings.Fields(rr.String()), " ")
	}
	return out
}

func addrsOf(rrs []dns.RR) []string {
	var out []string
	for _, rr := range rrs {
		switch v := rr.(type) {
		case *dns.A:
			out = append(out, v.A.String())
		case *dns.AAAA:
			out = append(out, v.AAAA.String())
		}
	}
	return out
}
