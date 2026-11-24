package resolver

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/netip"
	"syscall"
	"testing"
	"time"

	"github.com/zmap/dns"
	"github.com/zmap/zdns/v2/src/zdns"

	"github.com/lonetis/scantor/internal/resolver/resolvertest"
)

func TestGuardScopesExceptionsByRoute(t *testing.T) {
	cfg := testConfig(ModeRecursive, "10.10.0.1:53")
	cfg.Upstreams = []string{"10.1.1.1:53", "10.2.2.2:53", "1.1.1.1:53", "100.100.100.200:53", "198.51.100.7:53", "198.51.100.7:5353", "203.0.113.53:53"}
	cfg.RootServers = []string{"172.17.0.1:1053", "172.18.0.1:53"}
	cfg.DenyServers = []string{"100.100.100.200/32", "169.254.0.0/16", "203.0.113.0/24"}
	cfg.TrustedServers = []string{"10.1.1.1:53", "172.17.0.1:1053", "100.100.100.200:53", "198.51.100.7:53"}
	s, err := cfg.compile()
	if err != nil {
		t.Fatal(err)
	}
	g := newGuard(s)
	g.setHost([]netip.AddrPort{netip.MustParseAddrPort("127.0.0.53:53"), netip.MustParseAddrPort("169.254.1.1:53")})
	g.setOwn([]netip.Addr{netip.MustParseAddr("198.51.100.7")})
	ap := netip.MustParseAddrPort
	cases := []struct {
		rt   route
		addr string
		want bool
	}{
		// Public servers: every route.
		{routeIterative, "192.0.2.53:53", true},
		{routeRecursive, "1.1.1.1:53", true},
		{routeIterative, "[2001:db8::53]:53", true},
		// Refused ranges, whatever the route: hostile glue never reaches them.
		{routeIterative, "169.254.169.254:53", false},
		{routeIterative, "10.0.0.1:53", false},
		{routeIterative, "127.0.0.53:53", false},
		{routeIterative, "[::1]:53", false},
		{routeIterative, "[fd00::1]:53", false},
		{routeIterative, "[64:ff9b::a00:1]:53", false},
		{routeIterative, "[::ffff:10.0.0.1]:53", false},
		// The deny list and the node's own address.
		{routeIterative, "203.0.113.9:53", false},
		{routeIterative, "198.51.100.7:53", false},
		// Host nameservers: always on the local route, also link-local and inside the deny list (a
		// cloud's metadata DNS server); never on the other routes.
		{routeLocal, "127.0.0.53:53", true},
		{routeLocal, "169.254.1.1:53", true},
		{routeRecursive, "127.0.0.53:53", false},
		{routeIterative, "169.254.1.1:53", false},
		{routeLocal, "127.0.0.53:5353", false},
		// Upstream servers in refused ranges: the recursive route, only when trusted.
		{routeRecursive, "10.1.1.1:53", true},
		{routeRecursive, "10.2.2.2:53", false},
		{routeLocal, "10.1.1.1:53", false},
		{routeIterative, "10.1.1.1:53", false},
		// Trust lifts the deny list and the own-address rule for an environment-configured server
		// (D1); an untrusted (override) server there is refused although configured.
		{routeRecursive, "100.100.100.200:53", true},
		{routeRecursive, "198.51.100.7:53", true},
		{routeRecursive, "198.51.100.7:5353", false},
		{routeRecursive, "203.0.113.53:53", false},
		{routeIterative, "198.51.100.7:53", false},
		// Root servers: the iterative route, by address and port.
		{routeIterative, "172.17.0.1:1053", true},
		{routeIterative, "172.17.0.1:53", false},
		{routeIterative, "172.18.0.1:53", false},
		{routeRecursive, "172.17.0.1:1053", false},
	}
	for _, tc := range cases {
		if got := g.allow(tc.rt, ap(tc.addr)); got != tc.want {
			t.Errorf("allow(%v, %s) = %v, want %v", tc.rt, tc.addr, got, tc.want)
		}
	}
	// With useHostNameservers the host nameservers are upstream servers too, whatever their address.
	g.useHost = true
	if !g.allow(routeRecursive, ap("127.0.0.53:53")) || !g.allow(routeRecursive, ap("169.254.1.1:53")) {
		t.Error("host nameserver as upstream refused")
	}
	if g.allow(routeIterative, ap("127.0.0.53:53")) {
		t.Error("host nameserver allowed for the iterative route")
	}
	if AlwaysRefused(netip.MustParseAddr("1.1.1.1")) || !AlwaysRefused(netip.MustParseAddr("::ffff:172.17.0.1")) {
		t.Error("AlwaysRefused")
	}
}

func TestLimiterRefusesBeyondTheWait(t *testing.T) {
	l := newLimiter(1, 0, 250*time.Millisecond)
	addr := netip.MustParseAddr("192.0.2.1")
	if !l.wait(context.Background(), routeRecursive, addr) {
		t.Fatal("first query refused")
	}
	start := time.Now()
	if l.wait(context.Background(), routeLocal, addr) {
		t.Error("second query within a second allowed at 1 qps")
	}
	if time.Since(start) > 100*time.Millisecond {
		t.Error("the refusal waited")
	}
	// Other servers and the iterative route (no limit here) are not affected.
	if !l.wait(context.Background(), routeRecursive, netip.MustParseAddr("192.0.2.2")) || !l.wait(context.Background(), routeIterative, addr) {
		t.Error("an unrelated query was refused")
	}
	// A wait within maxWait passes: 20 qps, burst 4.
	l = newLimiter(20, 20, 250*time.Millisecond)
	for range 4 {
		if !l.wait(context.Background(), routeIterative, addr) {
			t.Fatal("burst refused")
		}
	}
	start = time.Now()
	if !l.wait(context.Background(), routeIterative, addr) || time.Since(start) < 20*time.Millisecond {
		t.Errorf("a query beyond the burst did not wait (%v)", time.Since(start))
	}
	l.sweep(time.Now().Add(2*time.Minute), time.Minute)
	if len(l.m) != 0 {
		t.Errorf("%d idle limiters kept", len(l.m))
	}
}

// testDialer is a dialer with every server allowed and the rewrite of n.
func testDialer(t *testing.T, n *resolvertest.Network) *dialer {
	t.Helper()
	cfg := testConfig(ModeRecursive, "127.0.0.1:53")
	cfg.Upstreams = []string{"198.51.100.1:53"}
	s, err := cfg.compile()
	if err != nil {
		t.Fatal(err)
	}
	return &dialer{guard: newGuard(s), limits: newLimiter(0, 0, time.Second), timeout: time.Second, stats: &counters{}, rewrite: n.Rewrite}
}

func exchangeVia(t *testing.T, d *dialer, rec *recorder, network, server string, q *dns.Msg) (*dns.Msg, error) {
	t.Helper()
	ctx := withState(context.Background(), &lookupState{route: routeRecursive, rec: rec})
	c, err := d.DialContext(ctx, network, nil, server)
	if err != nil {
		return nil, err
	}
	conn := &dns.Conn{Conn: c, UDPSize: 1232}
	defer conn.Close()
	r, _, err := (&dns.Client{Net: network, Timeout: time.Second}).ExchangeWithConnContext(ctx, q, conn)
	return r, err
}

// forwardRecorder records a recursive-route attempt for name A.
func forwardRecorder(name string) *recorder {
	return newRecorder(question{name: dns.Fqdn(name), qtype: dns.TypeA}, false)
}

func TestCaptureKeepsDatagramFramingAndIgnoresForgedReplies(t *testing.T) {
	fake := fakeDNS(t, resolvertest.MustZone("example.test.", "www 300 IN A 192.0.2.10"))
	var n resolvertest.Network
	n.Add(netip.MustParseAddr("198.51.100.1"), fake)
	d := testDialer(t, &n)
	rec := forwardRecorder("www.example.test")
	ctx := withState(context.Background(), &lookupState{route: routeRecursive, rec: rec})
	c, err := d.DialContext(ctx, "udp", nil, "198.51.100.1:53")
	if err != nil {
		t.Fatal(err)
	}
	// zmap/dns picks datagram framing only for a net.PacketConn.
	if _, ok := c.(net.PacketConn); !ok {
		t.Fatal("the UDP wrapper is not a net.PacketConn")
	}
	_ = c.Close()
	fake.On("www.example.test", dns.TypeA, resolvertest.Behavior{Spoof: true})
	r, err := exchangeVia(t, d, rec, "udp", "198.51.100.1:53", newQuery("www.example.test", dns.TypeA))
	if err != nil {
		t.Fatal(err)
	}
	if got := addrsOf(r.Answer); len(got) != 1 || got[0] != "192.0.2.10" {
		t.Errorf("answer = %v", got)
	}
	if m := rec.accepted(); m == nil || addrsOf(m.Answer)[0] != "192.0.2.10" {
		t.Errorf("recorded reply: %v", m)
	}
	if replies, _ := rec.received(); replies != 1 {
		t.Errorf("recorded %d replies", replies)
	}
	if out := rec.outcomes(); len(out) != 2 || out[1].cause != dialOK || out[1].server != netip.MustParseAddrPort("198.51.100.1:53") {
		t.Errorf("dial outcomes = %+v", out)
	}
	// A reply with the right ID but another question is never recorded.
	rec = forwardRecorder("other.example.test")
	fake.On("other.example.test", dns.TypeA, resolvertest.Behavior{Edit: func(m *dns.Msg) { m.Question[0].Name = "evil.example.test." }})
	if _, err := exchangeVia(t, d, rec, "udp", "198.51.100.1:53", newQuery("other.example.test", dns.TypeA)); err != nil {
		t.Fatal(err)
	}
	if replies, _ := rec.received(); replies != 0 || rec.accepted() != nil {
		t.Error("a reply to another question was recorded")
	}
	// TCP: frames are reassembled.
	rec = forwardRecorder("www.example.test")
	if _, err := exchangeVia(t, d, rec, "tcp", "198.51.100.1:53", newQuery("www.example.test", dns.TypeA)); err != nil {
		t.Fatal(err)
	}
	if replies, _ := rec.received(); replies != 1 || rec.accepted() == nil {
		t.Errorf("recorded %d TCP replies", replies)
	}
}

// chunkConn reads its data in chunks of one byte.
type chunkConn struct {
	net.Conn
	r       io.Reader
	written bytes.Buffer
}

func (c *chunkConn) Read(b []byte) (int, error) { return c.r.Read(b[:1]) }

func (c *chunkConn) Write(b []byte) (int, error) { return c.written.Write(b) }

func TestTCPCaptureReassemblesSplitFrames(t *testing.T) {
	q := newQuery("a.test", dns.TypeA)
	qb, err := q.Pack()
	if err != nil {
		t.Fatal(err)
	}
	reply := new(dns.Msg)
	reply.SetReply(q)
	reply.Answer = []dns.RR{rr(t, "a.test. 60 IN A 192.0.2.1")}
	rb, err := reply.Pack()
	if err != nil {
		t.Fatal(err)
	}
	var stream bytes.Buffer
	for range 2 {
		_ = binary.Write(&stream, binary.BigEndian, uint16(len(rb)))
		stream.Write(rb)
	}
	rec := forwardRecorder("a.test")
	c := &tcpCapture{Conn: &chunkConn{r: &stream}, rec: rec}
	frame := append(binary.BigEndian.AppendUint16(nil, uint16(len(qb))), qb...)
	if _, err := c.Write(frame[:3]); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Write(frame[3:]); err != nil {
		t.Fatal(err)
	}
	var got bytes.Buffer
	buf := make([]byte, 512)
	for {
		n, err := c.Read(buf)
		got.Write(buf[:n])
		if err != nil {
			break
		}
	}
	if replies, _ := rec.received(); replies != 2 || rec.accepted() == nil {
		t.Errorf("recorded %d replies from one-byte reads", replies)
	}
	// The reader gets the stream unchanged (the recursive route never rewrites a reply).
	want := append(binary.BigEndian.AppendUint16(nil, uint16(len(rb))), rb...)
	if !bytes.Equal(got.Bytes(), append(want, want...)) {
		t.Errorf("the reader got %d bytes, want the %d of two frames", got.Len(), 2*len(want))
	}
}

func TestDialerGuardsAndRateLimits(t *testing.T) {
	fake := fakeDNS(t, resolvertest.MustZone("example.test."))
	var n resolvertest.Network
	n.Add(netip.MustParseAddr("198.51.100.1"), fake)
	d := testDialer(t, &n)
	rec := newRecorder(question{name: "example.test.", qtype: dns.TypeA}, true)
	ctx := withState(context.Background(), &lookupState{route: routeIterative, rec: rec})
	if _, err := d.DialContext(ctx, "udp", nil, "169.254.169.254:53"); !errors.Is(err, errRefused) {
		t.Errorf("metadata address: %v", err)
	}
	if _, err := d.DialContext(context.Background(), "udp", nil, "198.51.100.1:53"); !errors.Is(err, errNoRoute) {
		t.Errorf("dial without a route: %v", err)
	}
	d.limits = newLimiter(0, 1, 50*time.Millisecond)
	c, err := d.DialContext(ctx, "udp", nil, "198.51.100.1:53")
	if err != nil {
		t.Fatal(err)
	}
	_ = c.Close()
	if _, err := d.DialContext(ctx, "udp", nil, "198.51.100.1:53"); !errors.Is(err, errRateLimited) {
		t.Errorf("second dial at 1 qps: %v", err)
	}
	if d.stats.rateLimited.Load() != 1 {
		t.Errorf("rateLimited = %d", d.stats.rateLimited.Load())
	}
	causes := []dialCause{}
	for _, o := range rec.outcomes() {
		causes = append(causes, o.cause)
	}
	if len(causes) != 3 || causes[0] != dialRefused || causes[1] != dialOK || causes[2] != dialRateLimited {
		t.Errorf("outcomes = %v", causes)
	}
	// The self-checks pass the guard but no rate limit.
	check := withState(context.Background(), &lookupState{route: routeIterative, selfCheck: true})
	if c, err := d.DialContext(check, "udp", nil, "198.51.100.1:53"); err != nil {
		t.Errorf("self-check dial under the rate limit: %v", err)
	} else {
		_ = c.Close()
	}
	if _, err := d.DialContext(check, "udp", nil, "10.0.0.1:53"); !errors.Is(err, errRefused) {
		t.Errorf("self-check dial to a refused server: %v", err)
	}
}

func TestDialerSpendsTheQueryBudget(t *testing.T) {
	fake := fakeDNS(t, resolvertest.MustZone("example.test."))
	var n resolvertest.Network
	n.Add(netip.MustParseAddr("198.51.100.1"), fake)
	d := testDialer(t, &n)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	budget := newQueryBudget(2, cancel)
	rec := newRecorder(question{name: "example.test.", qtype: dns.TypeA}, true)
	ctx = withState(ctx, &lookupState{route: routeIterative, rec: rec, budget: budget})
	// A refused dial counts like a sent query.
	if _, err := d.DialContext(ctx, "udp", nil, "10.0.0.1:53"); !errors.Is(err, errRefused) {
		t.Fatalf("first dial: %v", err)
	}
	c, err := d.DialContext(ctx, "udp", nil, "198.51.100.1:53")
	if err != nil {
		t.Fatal(err)
	}
	_ = c.Close()
	if budget.exhausted() || ctx.Err() != nil {
		t.Fatal("the budget ended early")
	}
	if _, err := d.DialContext(ctx, "udp", nil, "198.51.100.1:53"); !errors.Is(err, errBudget) {
		t.Errorf("third dial: %v", err)
	}
	if !budget.exhausted() || ctx.Err() == nil {
		t.Error("a spent budget did not end the lookup")
	}
	if out := rec.outcomes(); len(out) != 3 || out[2].cause != dialBudget {
		t.Errorf("outcomes = %+v", out)
	}
	if a := classify(rec, false, zdns.StatusError); !a.local {
		t.Error("a spent budget is not a local failure")
	}
	if !outOfResources(&net.OpError{Op: "dial", Err: syscall.EMFILE}) || outOfResources(syscall.ECONNREFUSED) {
		t.Error("outOfResources")
	}
}
