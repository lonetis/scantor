package resolver

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/netip"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/zmap/dns"
	"github.com/zmap/zdns/v2/src/zdns"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/resolver/resolvertest"
)

// tweaks adjust the configuration and timings of a test resolver.
type tweaks struct {
	config  func(*Config)
	timings func(*timings)
}

// newRunning starts a recursive resolver on a free loopback port with upstreams serving zones.
func newRunning(t *testing.T, tw tweaks, zones ...*resolvertest.Zone) (*recursiveSetup, *running) {
	t.Helper()
	if len(zones) == 0 {
		zones = []*resolvertest.Zone{rootNS(), exampleZone()}
	}
	r := &recursiveSetup{net: &resolvertest.Network{}}
	r.up1, r.up2 = fakeDNS(t, zones...), fakeDNS(t, zones...)
	r.net.Add(netip.MustParseAddr("198.51.100.1"), r.up1)
	r.net.Add(netip.MustParseAddr("198.51.100.2"), r.up2)
	cfg := testConfig(ModeRecursive, freeAddr(t))
	cfg.Upstreams = []string{"198.51.100.1:53", "198.51.100.2:53"}
	if tw.config != nil {
		tw.config(&cfg)
	}
	var opts []harnessOption
	if tw.timings != nil {
		opts = append(opts, withOptions(func(o *Options) { tw.timings(o.timings) }))
	}
	r.h = newHarness(t, cfg, r.net, opts...)
	return r, r.h.run()
}

func TestServerAnswersFromTheCache(t *testing.T) {
	r, srv := newRunning(t, tweaks{})
	reply := query(t, "udp", srv.addr, newQuery("WwW.Example.TEST", dns.TypeA))
	if reply.Rcode != dns.RcodeSuccess || !reply.RecursionAvailable || reply.Authoritative || len(reply.Answer) != 1 {
		t.Fatalf("reply = %v", reply)
	}
	// The question is echoed as asked (0x20).
	if reply.Question[0].Name != "WwW.Example.TEST." {
		t.Errorf("question = %s", reply.Question[0].Name)
	}
	for range 3 {
		if again := query(t, "udp", srv.addr, newQuery("www.example.test", dns.TypeA)); len(again.Answer) != 1 {
			t.Fatalf("cached reply = %v", again)
		}
	}
	if n := r.count("www.example.test", dns.TypeA); n != 1 {
		t.Errorf("upstream queries = %d", n)
	}
	if hits := r.h.s.stats.cacheHits.Load(); hits != 3 {
		t.Errorf("cache hits = %d", hits)
	}
	// TCP gets the same answer.
	if tcp := query(t, "tcp", srv.addr, newQuery("www.example.test", dns.TypeA)); len(tcp.Answer) != 1 {
		t.Errorf("TCP reply = %v", tcp)
	}
	// A name-level NXDOMAIN answers the other types of a name without a lookup.
	if nx := query(t, "udp", srv.addr, newQuery("gone.example.test", dns.TypeA)); nx.Rcode != dns.RcodeNameError {
		t.Fatalf("NXDOMAIN = %v", nx)
	}
	if nx := query(t, "udp", srv.addr, newQuery("gone.example.test", dns.TypeAAAA)); nx.Rcode != dns.RcodeNameError || len(nx.Ns) != 1 {
		t.Errorf("AAAA of an NXDOMAIN name = %v", nx)
	}
	if n := r.count("gone.example.test", 0); n != 1 {
		t.Errorf("upstream queries for the NXDOMAIN name = %d", n)
	}
}

func TestRequestValidation(t *testing.T) {
	_, srv := newRunning(t, tweaks{config: func(c *Config) { c.LocalNames = []string{"scantor.localhost"} }})
	msg := func(edit func(*dns.Msg)) *dns.Msg {
		m := newQuery("www.example.test", dns.TypeA)
		edit(m)
		return m
	}
	cases := []struct {
		name  string
		m     *dns.Msg
		rcode int
	}{
		{"opcode STATUS", msg(func(m *dns.Msg) { m.Opcode = dns.OpcodeStatus }), dns.RcodeNotImplemented},
		{"opcode NOTIFY", msg(func(m *dns.Msg) { m.Opcode = dns.OpcodeNotify }), dns.RcodeNotImplemented},
		{"no question", msg(func(m *dns.Msg) { m.Question = nil }), dns.RcodeFormatError},
		{"two questions", msg(func(m *dns.Msg) { m.Question = append(m.Question, m.Question[0]) }), dns.RcodeFormatError},
		{"two OPT records", msg(func(m *dns.Msg) { m.SetEdns0(1232, false); m.Extra = append(m.Extra, m.Extra[0]) }), dns.RcodeFormatError},
		{"EDNS version 1", msg(func(m *dns.Msg) { m.SetEdns0(1232, false); m.IsEdns0().SetVersion(1) }), dns.RcodeBadVers},
		{"class CH", msg(func(m *dns.Msg) { m.Question[0].Qclass = dns.ClassCHAOS }), dns.RcodeRefused},
		{"AXFR", newQuery("example.test", dns.TypeAXFR), dns.RcodeRefused},
		{"IXFR", newQuery("example.test", dns.TypeIXFR), dns.RcodeRefused},
		{"the root", newQuery(".", dns.TypeNS), dns.RcodeRefused},
		{"an escaped name", newQuery(`a\.b.example.test.`, dns.TypeA), dns.RcodeRefused},
		{"the probe name", newQuery(ProbeName, dns.TypeTXT), dns.RcodeSuccess},
		{"localhost", newQuery("localhost", dns.TypeA), dns.RcodeSuccess},
		{"below invalid.", newQuery("x.invalid", dns.TypeA), dns.RcodeNameError},
		{"below onion.", newQuery("x.onion", dns.TypeA), dns.RcodeNameError},
		{"ANY is forwarded in recursive mode", newQuery("www.example.test", dns.TypeANY), dns.RcodeSuccess},
		// No host nameserver in this test: the master's hosts go to the upstream servers, whose root
		// zone has no such name.
		{"a local name", newQuery("scantor.localhost", dns.TypeA), dns.RcodeNameError},
	}
	for _, tc := range cases {
		reply := query(t, "udp", srv.addr, tc.m)
		if reply.Rcode != tc.rcode {
			t.Errorf("%s: rcode %s, want %s", tc.name, dns.RcodeToString[reply.Rcode], dns.RcodeToString[tc.rcode])
		}
		if !reply.RecursionAvailable || reply.Authoritative || reply.AuthenticatedData {
			t.Errorf("%s: flags ra=%v aa=%v ad=%v", tc.name, reply.RecursionAvailable, reply.Authoritative, reply.AuthenticatedData)
		}
	}
	probe := query(t, "udp", srv.addr, newQuery(ProbeName, dns.TypeTXT))
	if txt := probe.Answer[0].(*dns.TXT).Txt[0]; txt != ProbeAnswer(testNodeID, testSpec) {
		t.Errorf("probe answer = %q", txt)
	}
	if local := query(t, "udp", srv.addr, newQuery("localhost", dns.TypeA)); addrsOf(local.Answer)[0] != "127.0.0.1" {
		t.Errorf("localhost = %v", local.Answer)
	}
	if bad := query(t, "udp", srv.addr, msg(func(m *dns.Msg) { m.SetEdns0(1232, false); m.IsEdns0().SetVersion(1) })); bad.IsEdns0() == nil {
		t.Error("BADVERS without OPT")
	}
	// The CD bit is echoed.
	if cd := query(t, "udp", srv.addr, msg(func(m *dns.Msg) { m.CheckingDisabled = true })); !cd.CheckingDisabled {
		t.Error("CD not echoed")
	}
}

func TestIterativeAnswersANYLocally(t *testing.T) {
	s := newIterative(t)
	s.h.s.s.listen = netip.MustParseAddrPort(freeAddr(t))
	srv := s.h.run()
	reply := query(t, "udp", srv.addr, newQuery("www.example.test", dns.TypeANY))
	if len(reply.Answer) != 1 || reply.Answer[0].(*dns.HINFO).Cpu != "RFC8482" {
		t.Errorf("ANY = %v", reply.Answer)
	}
	if s.example.Count("www.example.test", dns.TypeANY) != 0 {
		t.Error("ANY reached the authoritative server")
	}
}

// fakeWriter records the reply of a handler call.
type fakeWriter struct {
	remote net.Addr
	reply  *dns.Msg
}

func (w *fakeWriter) LocalAddr() net.Addr       { return &net.UDPAddr{IP: net.IPv4(10, 10, 0, 1), Port: 53} }
func (w *fakeWriter) RemoteAddr() net.Addr      { return w.remote }
func (w *fakeWriter) WriteMsg(m *dns.Msg) error { w.reply = m; return nil }
func (w *fakeWriter) Write([]byte) (int, error) { return 0, errors.New("not supported") }
func (w *fakeWriter) Close() error              { return nil }
func (w *fakeWriter) TsigStatus() error         { return nil }
func (w *fakeWriter) TsigTimersOnly(bool)       {}
func (w *fakeWriter) Hijack()                   {}

func TestClientACL(t *testing.T) {
	cfg := testConfig(ModeRecursive, "10.10.0.1:53")
	cfg.Clients = []string{"10.10.0.0/24"}
	cfg.Upstreams = []string{"198.51.100.1:53"}
	h := newHarness(t, cfg, &resolvertest.Network{})
	for addr, want := range map[string]int{
		"10.10.0.7":        dns.RcodeSuccess,
		"10.10.0.1":        dns.RcodeSuccess, // the listen address
		"10.10.1.7":        dns.RcodeRefused,
		"172.17.0.2":       dns.RcodeRefused,
		"::ffff:10.10.0.9": dns.RcodeSuccess,
	} {
		w := &fakeWriter{remote: &net.UDPAddr{IP: net.ParseIP(addr), Port: 40000}}
		h.s.ServeDNS(w, newQuery(ProbeName, dns.TypeTXT))
		if w.reply == nil || w.reply.Rcode != want {
			t.Errorf("client %s: %v", addr, w.reply)
		}
	}
	// Non-clients are refused before anything else is checked.
	w := &fakeWriter{remote: &net.TCPAddr{IP: net.ParseIP("192.0.2.1"), Port: 40000}}
	m := newQuery("www.example.test", dns.TypeA)
	m.Opcode = dns.OpcodeUpdate
	h.s.ServeDNS(w, m)
	if w.reply.Rcode != dns.RcodeRefused {
		t.Errorf("non-client with a bad opcode: %s", dns.RcodeToString[w.reply.Rcode])
	}
	if q := h.s.stats.queries.Load(); q != 6 || h.s.stats.refused.Load() != 3 {
		t.Errorf("queries %d, refused %d", q, h.s.stats.refused.Load())
	}
}

func TestEDNSAndTruncation(t *testing.T) {
	var records []string
	for i := range 8 {
		records = append(records, "big 300 IN TXT \""+strings.Repeat(string(rune('a'+i)), 200)+"\"")
	}
	zone := resolvertest.MustZone("example.test.", append(records, "www 300 IN A 192.0.2.10")...)
	_, srv := newRunning(t, tweaks{}, rootNS(), zone)
	withEDNS := func(size uint16, do bool) *dns.Msg {
		m := newQuery("big.example.test", dns.TypeTXT)
		m.SetEdns0(size, do)
		return m
	}
	// The resolver itself fetched the answer over TCP; clients get it truncated to their size.
	plain := query(t, "udp", srv.addr, newQuery("big.example.test", dns.TypeTXT))
	plain.Compress = true
	if !plain.Truncated || plain.IsEdns0() != nil || plain.Len() > dns.MinMsgSize {
		t.Errorf("UDP without EDNS: tc=%v opt=%v len=%d", plain.Truncated, plain.IsEdns0() != nil, plain.Len())
	}
	large := query(t, "udp", srv.addr, withEDNS(4096, true))
	large.Compress = true
	opt := large.IsEdns0()
	if !large.Truncated || opt == nil || opt.UDPSize() != ednsSize || opt.Do() || large.Len() > ednsSize {
		t.Errorf("UDP with EDNS 4096: tc=%v opt=%v len=%d", large.Truncated, opt, large.Len())
	}
	tcp := query(t, "tcp", srv.addr, withEDNS(1232, false))
	if tcp.Truncated || len(tcp.Answer) != 8 {
		t.Errorf("TCP: tc=%v %d records", tcp.Truncated, len(tcp.Answer))
	}
	small := query(t, "udp", srv.addr, func() *dns.Msg { m := newQuery("www.example.test", dns.TypeA); m.SetEdns0(1232, false); return m }())
	if small.Truncated || len(small.Answer) != 1 || small.IsEdns0() == nil {
		t.Errorf("small answer with EDNS: %v", small)
	}
}

func TestClientDeadlineAndDetachedLookup(t *testing.T) {
	r, srv := newRunning(t, tweaks{timings: func(tm *timings) {
		tm.clientDeadline = 200 * time.Millisecond
		tm.networkTimeout = time.Second
		tm.forwardBudget = 2 * time.Second
	}})
	for _, up := range []*resolvertest.Server{r.up1, r.up2} {
		up.On("www.example.test", dns.TypeA, resolvertest.Behavior{Delay: 500 * time.Millisecond})
	}
	start := time.Now()
	reply := query(t, "udp", srv.addr, newQuery("www.example.test", dns.TypeA))
	if reply.Rcode != dns.RcodeServerFailure || time.Since(start) > time.Second {
		t.Errorf("past the client deadline: %s after %v", dns.RcodeToString[reply.Rcode], time.Since(start))
	}
	// The lookup went on without its client and filled the cache.
	eventually(t, 3*time.Second, func() bool { return r.h.s.cache.lookup("www.example.test.", dns.TypeA, time.Now()) != nil })
	if again := query(t, "udp", srv.addr, newQuery("www.example.test", dns.TypeA)); again.Rcode != dns.RcodeSuccess || len(again.Answer) != 1 {
		t.Errorf("after the lookup finished: %v", again)
	}
}

func TestStateFileAndHealthcheck(t *testing.T) {
	r, srv := newRunning(t, tweaks{})
	_ = query(t, "udp", srv.addr, newQuery("www.example.test", dns.TypeA))
	// The state file is rewritten every stateEvery: wait for one that counts the query.
	eventually(t, 3*time.Second, func() bool {
		line, err := Healthcheck(r.h.state, time.Now())
		var st Stats
		return err == nil && json.Unmarshal(line, &st) == nil && st.Queries > 0
	})
	line, err := Healthcheck(r.h.state, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	var st Stats
	if err := json.Unmarshal(line, &st); err != nil || strings.Contains(string(line), "\n") {
		t.Fatalf("health output %q: %v", line, err)
	}
	if st.V != 1 || !st.Ready || !st.UpstreamOK || st.Node != testNodeID || st.Spec != testSpec || st.Mode != ModeRecursive ||
		st.Listen != srv.addr || st.Queries < 1 || st.Lookups < 1 || st.Rcodes.NoError < 1 || st.CacheEntries < 1 {
		t.Errorf("stats = %+v", st)
	}
	if len(line) >= 4096 {
		t.Errorf("health output of %d bytes", len(line))
	}
	// No upstream answers: the upstream check and the healthcheck fail.
	for _, up := range []*resolvertest.Server{r.up1, r.up2} {
		up.On("", 0, resolvertest.Behavior{Drop: true})
	}
	eventually(t, 3*time.Second, func() bool {
		_, err := Healthcheck(r.h.state, time.Now())
		return err != nil
	})
	line, err = Healthcheck(r.h.state, time.Now())
	if err == nil || !strings.Contains(err.Error(), "no upstream server answers") || line == nil {
		t.Errorf("healthcheck with dead upstreams: %v", err)
	}
	if err := json.Unmarshal(line, &st); err != nil || st.UpstreamOK || st.UpstreamError != api.ResolverErrUpstreamUnreachable {
		t.Errorf("stats with dead upstreams: %+v", st)
	}
	// Repeated failures of the check are logged once.
	time.Sleep(4 * r.h.s.t.upstreamCheckEvery)
	if n := strings.Count(r.h.logs.String(), "upstream check failed"); n != 1 {
		t.Errorf("the failing upstream check was logged %d times", n)
	}
}

func TestBindErrorsAreRetried(t *testing.T) {
	addr := freeAddr(t)
	// Another socket holds the port without SO_REUSEPORT.
	holder, err := net.ListenPacket("udp4", addr)
	if err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(ModeRecursive, addr)
	cfg.Upstreams = []string{"198.51.100.1:53"}
	up := fakeDNS(t, rootNS())
	n := &resolvertest.Network{}
	n.Add(netip.MustParseAddr("198.51.100.1"), up)
	h := newHarness(t, cfg, n)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.s.run(ctx) }()
	eventually(t, 3*time.Second, func() bool {
		line, err := Healthcheck(h.state, time.Now())
		var st Stats
		return err != nil && line != nil && json.Unmarshal(line, &st) == nil && st.Error == api.ResolverErrBindInUse && !st.Ready
	})
	_ = holder.Close()
	eventually(t, 3*time.Second, func() bool { return h.s.ready.Load() })
	eventually(t, 3*time.Second, func() bool { _, err := Healthcheck(h.state, time.Now()); return err == nil })
	cancel()
	if err := <-done; err != nil {
		t.Errorf("Run = %v", err)
	}
	// An address the host does not have never binds; Run still ends cleanly.
	cfg.Listen = "192.0.2.1:5353"
	h = newHarness(t, cfg, n)
	ctx, cancel = context.WithCancel(context.Background())
	go func() { done <- h.s.run(ctx) }()
	eventually(t, 3*time.Second, func() bool {
		data, err := os.ReadFile(h.state)
		var st Stats
		return err == nil && json.Unmarshal(data, &st) == nil && st.Error == api.ResolverErrBindUnavailable
	})
	cancel()
	if err := <-done; err != nil {
		t.Errorf("Run without a bind = %v", err)
	}
}

func TestDrainAnswersOpenQueriesThenCloses(t *testing.T) {
	r, srv := newRunning(t, tweaks{timings: func(tm *timings) {
		tm.networkTimeout = time.Second
		tm.forwardBudget = 2 * time.Second
		tm.drainMax = 2 * time.Second
	}})
	for _, up := range []*resolvertest.Server{r.up1, r.up2} {
		up.On("www.example.test", dns.TypeA, resolvertest.Behavior{Delay: 400 * time.Millisecond})
	}
	answered := make(chan *dns.Msg, 1)
	go func() {
		reply, err := exchangeErr("udp", srv.addr, newQuery("www.example.test", dns.TypeA))
		if err != nil {
			t.Error(err)
		}
		answered <- reply
	}()
	eventually(t, time.Second, func() bool { return r.h.s.handlers.Load() > 0 })
	srv.cancel()
	// Queries arriving during the drain are still answered.
	if reply, err := exchangeErr("udp", srv.addr, newQuery(ProbeName, dns.TypeTXT)); err != nil || reply.Rcode != dns.RcodeSuccess {
		t.Errorf("query during the drain: %v %v", reply, err)
	}
	if reply := <-answered; reply == nil || reply.Rcode != dns.RcodeSuccess || len(reply.Answer) != 1 {
		t.Errorf("open query: %v", reply)
	}
	select {
	case err := <-srv.done:
		if err != nil {
			t.Errorf("Run = %v", err)
		}
		srv.done <- nil // for the cleanup
	case <-time.After(3 * time.Second):
		t.Fatal("the drain did not end")
	}
	// The sockets are closed: the address binds again.
	pc, err := net.ListenPacket("udp4", srv.addr)
	if err != nil {
		t.Fatalf("the UDP socket is still bound: %v", err)
	}
	_ = pc.Close()
}

func TestUnrecoverablePanicEndsRun(t *testing.T) {
	r, srv := newRunning(t, tweaks{})
	r.h.s.fatal("corrupt shard")
	select {
	case err := <-srv.done:
		if !errors.Is(err, ErrPanic) {
			t.Errorf("Run = %v", err)
		}
		srv.done <- nil
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not end")
	}
	if !strings.Contains(r.h.logs.String(), "corrupt shard") {
		t.Error("the panic was not logged")
	}
}

func TestChecks(t *testing.T) {
	// IPv6 servers are used only while one answers.
	v6 := fakeDNS(t, rootNS(), exampleZone())
	n := &resolvertest.Network{}
	n.AddPort(netip.MustParseAddrPort("[2001:db8::53]:53"), v6)
	cfg := testConfig(ModeRecursive, "127.0.0.1:53")
	cfg.Upstreams = []string{"[2001:db8::53]:53", "[2001:db8::54]:53"}
	h := newHarness(t, cfg, n)
	ctx := context.Background()
	if len(h.s.engine.upstreamServers()) != 0 {
		t.Error("IPv6 upstream servers used before the IPv6 check")
	}
	// Only IPv6 servers and IPv6 unchecked: the upstream check fails.
	if ok, code := h.s.engine.upstreamCheck(ctx, false); ok || code != api.ResolverErrUpstreamUnreachable {
		t.Errorf("upstream check without IPv6 = %v %s", ok, code)
	}
	if !h.s.checkIPv6(ctx) || !h.s.ipv6.Load() || len(h.s.engine.upstreamServers()) != 2 {
		t.Fatalf("IPv6 check: ipv6=%v servers=%v", h.s.ipv6.Load(), h.s.engine.upstreamServers())
	}
	if ok, _ := h.s.engine.upstreamCheck(ctx, true); !ok {
		t.Error("upstream check with IPv6 failed")
	}
	v6.On("", 0, resolvertest.Behavior{Drop: true})
	if !h.s.checkIPv6(ctx) || h.s.ipv6.Load() {
		t.Error("IPv6 still on after its servers stopped answering")
	}
	// Iterative mode asks the root servers without recursion desired.
	root := fakeDNS(t, rootNS())
	n.Add(netip.MustParseAddr("198.51.100.1"), root)
	cfg = testConfig(ModeIterative, "127.0.0.1:53")
	cfg.RootServers = []string{"198.51.100.1:53"}
	h = newHarness(t, cfg, n)
	if ok, _ := h.s.engine.upstreamCheck(ctx, false); !ok {
		t.Error("root check failed")
	}
	if q := root.Queries(); len(q) != 1 || q[0].RD || q[0].Name != "." || q[0].Type != dns.TypeNS {
		t.Errorf("root check queries = %+v", q)
	}
	// Custom IPv4 roots: no IPv6 roots exist, so the IPv6 check fails without asking anyone.
	if h.s.checkIPv6(ctx) || h.s.engine.gen.Load().rc.IPVersionMode != zdns.IPv4Only {
		t.Errorf("custom IPv4 roots: ipv6 %v mode %v", h.s.ipv6.Load(), h.s.engine.gen.Load().rc.IPVersionMode)
	}
}

// TestLocalNamesWithoutHostNameservers: the master's hosts and local domains go to the host
// nameservers, also to a link-local one inside the deny list (GCE's metadata server); without a usable
// host nameserver they go to the mode's servers instead of failing.
func TestLocalNamesWithoutHostNameservers(t *testing.T) {
	up := fakeDNS(t, rootNS(), exampleZone())
	host := fakeDNS(t, resolvertest.MustZone("example.test.", "www 300 IN A 192.0.2.99"))
	n := &resolvertest.Network{}
	n.Add(netip.MustParseAddr("198.51.100.1"), up)
	n.Add(netip.MustParseAddr("169.254.169.254"), host)
	start := func(resolvConf string) string {
		cfg := testConfig(ModeRecursive, freeAddr(t))
		cfg.Upstreams = []string{"198.51.100.1:53"}
		cfg.LocalNames = []string{"www.example.test"}
		cfg.DenyServers = []string{"169.254.0.0/16"}
		h := newHarness(t, cfg, n, withResolvConf(resolvConf))
		return h.run().addr
	}
	addr := start("nameserver 169.254.169.254\nnameserver fe80::1%eth0\n")
	if r := query(t, "udp", addr, newQuery("www.example.test", dns.TypeA)); len(addrsOf(r.Answer)) != 1 || addrsOf(r.Answer)[0] != "192.0.2.99" {
		t.Errorf("through the link-local host nameserver: %s %v", dns.RcodeToString[r.Rcode], rrTexts(r.Answer))
	}
	if up.Count("www.example.test", dns.TypeA) != 0 {
		t.Error("a local name reached the upstream server")
	}
	addr = start("nameserver fe80::1%eth0\n")
	if r := query(t, "udp", addr, newQuery("www.example.test", dns.TypeA)); len(addrsOf(r.Answer)) != 1 || addrsOf(r.Answer)[0] != "192.0.2.10" {
		t.Errorf("without a usable host nameserver: %s %v", dns.RcodeToString[r.Rcode], rrTexts(r.Answer))
	}
	if up.Count("www.example.test", dns.TypeA) != 1 {
		t.Error("the local name did not go to the upstream server")
	}
	// The resolver's own address is never one of its host nameservers.
	cfg := testConfig(ModeRecursive, "127.0.0.1:53")
	cfg.Upstreams = []string{"198.51.100.1:53"}
	h := newHarness(t, cfg, n, withResolvConf("nameserver 127.0.0.1\nnameserver 127.0.0.53\n"))
	if got := *h.s.hostNS.Load(); len(got) != 1 || got[0] != netip.MustParseAddrPort("127.0.0.53:53") {
		t.Errorf("host nameservers = %v", got)
	}
}
