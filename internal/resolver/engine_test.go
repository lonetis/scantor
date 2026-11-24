package resolver

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
	"github.com/zmap/dns"
	"github.com/zmap/zdns/v2/src/zdns"

	"github.com/lonetis/scantor/internal/resolver/resolvertest"
)

func exampleZone() *resolvertest.Zone {
	return resolvertest.MustZone("example.test.",
		"@ 300 IN SOA ns.example.test. h.example.test. 1 3600 600 86400 120",
		"www 300 IN A 192.0.2.10",
		"@ 300 IN MX 10 mail",
		"mail 300 IN A 192.0.2.25",
		"alias 300 IN CNAME www",
		"_services._dns-sd._udp 300 IN PTR _http._tcp.example.test.",
	)
}

type recursiveSetup struct {
	h        *harness
	up1, up2 *resolvertest.Server
	net      *resolvertest.Network
}

// newRecursive builds a recursive resolver with two upstream servers serving zones.
func newRecursive(t *testing.T, zones ...*resolvertest.Zone) *recursiveSetup {
	t.Helper()
	if len(zones) == 0 {
		zones = []*resolvertest.Zone{rootNS(), exampleZone()}
	}
	r := &recursiveSetup{net: &resolvertest.Network{}}
	r.up1, r.up2 = fakeDNS(t, zones...), fakeDNS(t, zones...)
	r.net.Add(netip.MustParseAddr("198.51.100.1"), r.up1)
	r.net.Add(netip.MustParseAddr("198.51.100.2"), r.up2)
	cfg := testConfig(ModeRecursive, "127.0.0.1:53")
	cfg.Upstreams = []string{"198.51.100.1:53", "198.51.100.2:53"}
	r.h = newHarness(t, cfg, r.net)
	return r
}

func (r *recursiveSetup) count(name string, qtype uint16) int {
	return r.up1.Count(name, qtype) + r.up2.Count(name, qtype)
}

func TestRecursiveCopiesTheReplyVerbatim(t *testing.T) {
	r := newRecursive(t)
	res := r.h.lookup(routeRecursive, "alias.example.test", dns.TypeA)
	if res.rcode != dns.RcodeSuccess || res.fail != failNone || len(res.answer) != 2 || addrsOf(res.answer)[0] != "192.0.2.10" {
		t.Fatalf("alias A = %s %v", dns.RcodeToString[res.rcode], rrTexts(res.answer))
	}
	// NXDOMAIN with the upstream's SOA, after exactly one query: never retried at another server.
	res = r.h.lookup(routeRecursive, "nope.example.test", dns.TypeA)
	if res.rcode != dns.RcodeNameError || len(res.ns) != 1 || res.ns[0].Header().Rrtype != dns.TypeSOA {
		t.Errorf("NXDOMAIN = %s ns %v", dns.RcodeToString[res.rcode], rrTexts(res.ns))
	}
	if n := r.count("nope.example.test", dns.TypeA); n != 1 {
		t.Errorf("NXDOMAIN took %d queries", n)
	}
	// NODATA keeps the SOA too.
	res = r.h.lookup(routeRecursive, "www.example.test", dns.TypeAAAA)
	if res.rcode != dns.RcodeSuccess || len(res.answer) != 0 || len(res.ns) != 1 {
		t.Errorf("NODATA = %s %v %v", dns.RcodeToString[res.rcode], rrTexts(res.answer), rrTexts(res.ns))
	}
	// The upstream got the question with recursion desired.
	for _, q := range append(r.up1.Queries(), r.up2.Queries()...) {
		if !q.RD {
			t.Errorf("query without RD: %+v", q)
		}
	}
}

func TestZDNSCacheNeverAnswersAClientQuestion(t *testing.T) {
	// zdns caches the additional A of an MX answer under the MX question; a cached hit would answer
	// NOERROR without the MX.
	r := newRecursive(t)
	for range 2 {
		res := r.h.lookup(routeRecursive, "example.test", dns.TypeMX)
		if len(res.answer) != 1 || res.answer[0].Header().Rrtype != dns.TypeMX {
			t.Fatalf("MX = %s %v", dns.RcodeToString[res.rcode], rrTexts(res.answer))
		}
	}
	if n := r.count("example.test", dns.TypeMX); n != 2 {
		t.Errorf("MX queries = %d, want 2", n)
	}
}

func TestRecursiveRetriesOtherServers(t *testing.T) {
	r := newRecursive(t)
	r.up1.On("", 0, resolvertest.Behavior{Rcode: dns.RcodeServerFailure})
	r.up2.On("", 0, resolvertest.Behavior{Drop: true})
	// Both fail: two attempts over distinct servers (no third server), a remote failure.
	res := r.h.lookup(routeRecursive, "www.example.test", dns.TypeA)
	if res.rcode != dns.RcodeServerFailure || res.fail != failRemote {
		t.Errorf("both failing = %s fail %v", dns.RcodeToString[res.rcode], res.fail)
	}
	if r.up1.Count("www.example.test", dns.TypeA) != 1 || r.up2.Count("www.example.test", dns.TypeA) != 1 {
		t.Errorf("queries: up1 %d, up2 %d", r.up1.Count("www.example.test", dns.TypeA), r.up2.Count("www.example.test", dns.TypeA))
	}
	if r.h.s.stats.timeouts.Load() == 0 {
		t.Error("the dropped query is not counted as a timeout")
	}
	// One server answers: the lookup succeeds whichever server zdns tries first.
	r2 := newRecursive(t)
	r2.up1.On("", 0, resolvertest.Behavior{Drop: true})
	for range 4 {
		res := r2.h.lookup(routeRecursive, "www.example.test", dns.TypeA)
		if res.rcode != dns.RcodeSuccess || len(res.answer) != 1 {
			t.Errorf("one server answering = %s fail %v", dns.RcodeToString[res.rcode], res.fail)
		}
	}
}

func TestRecursiveRejectsReferralsAndTruncatedReplies(t *testing.T) {
	// A server that does not recurse answers with a referral: never an answer.
	r := newRecursive(t, resolvertest.MustZone(".", "test. 300 IN NS ns.test.", "ns.test. 300 IN A 192.0.2.1"))
	res := r.h.lookup(routeRecursive, "www.example.test", dns.TypeA)
	if res.rcode != dns.RcodeServerFailure || res.fail != failRemote {
		t.Errorf("referral = %s fail %v", dns.RcodeToString[res.rcode], res.fail)
	}
	// TC=1 replies are never final: with TCP blocked the lookup fails and is counted.
	r = newRecursive(t)
	for _, up := range []*resolvertest.Server{r.up1, r.up2} {
		up.On("", 0, resolvertest.Behavior{Net: "udp", Truncate: true})
		up.On("", 0, resolvertest.Behavior{Net: "tcp", Drop: true})
	}
	res = r.h.lookup(routeRecursive, "www.example.test", dns.TypeA)
	if res.rcode != dns.RcodeServerFailure || res.fail != failRemote || r.h.s.stats.tcpFallbackFail.Load() != 1 {
		t.Errorf("truncated only = %s fail %v, tcpFallbackFailures %d", dns.RcodeToString[res.rcode], res.fail, r.h.s.stats.tcpFallbackFail.Load())
	}
}

func TestPTRNamesZDNSWouldChange(t *testing.T) {
	zones := []*resolvertest.Zone{rootNS(), exampleZone(), resolvertest.MustZone("4.", "1.2.3 300 IN PTR literal.example.test.")}
	r := newRecursive(t, zones...)
	// DNS-SD browsing names fail zdns' name check: the resolver asks the upstream directly.
	res := r.h.lookup(routeRecursive, "_services._dns-sd._udp.example.test", dns.TypePTR)
	if res.rcode != dns.RcodeSuccess || len(res.answer) != 1 {
		t.Errorf("DNS-SD PTR = %s %v", dns.RcodeToString[res.rcode], rrTexts(res.answer))
	}
	// A name that parses as an IP address reaches the upstream unchanged, not as its reverse name.
	res = r.h.lookup(routeRecursive, "1.2.3.4", dns.TypePTR)
	if res.rcode != dns.RcodeSuccess || len(res.answer) != 1 {
		t.Errorf("IP-literal PTR = %s %v", dns.RcodeToString[res.rcode], rrTexts(res.answer))
	}
	if r.count("4.3.2.1.in-addr.arpa", dns.TypePTR) != 0 || r.count("1.2.3.4", dns.TypePTR) != 1 {
		t.Error("the PTR name was rewritten")
	}
	// Ordinary reverse names go through zdns.
	if !zdnsKeepsPTR("10.2.0.192.in-addr.arpa.") || zdnsKeepsPTR("b._dns-sd._udp.example.test.") || zdnsKeepsPTR("x.xn--p1ai.") {
		t.Error("zdnsKeepsPTR")
	}
}

func TestForwardWithoutARouteToIPv6(t *testing.T) {
	up := fakeDNS(t, rootNS(), exampleZone())
	n := &resolvertest.Network{}
	n.Add(netip.MustParseAddr("198.51.100.1"), up)
	cfg := testConfig(ModeRecursive, "127.0.0.1:53")
	cfg.Upstreams = []string{"[2001:db8::53]:53", "198.51.100.1:53"}
	h := newHarness(t, cfg, n)
	if err := h.s.engine.rebuild(true); err != nil {
		t.Fatal(err)
	}
	// Whichever server zdns picks first, the IPv4 server answers in the end.
	for range 10 {
		if res := h.lookup(routeRecursive, "www.example.test", dns.TypeA); res.rcode != dns.RcodeSuccess {
			t.Fatalf("mixed families = %s fail %v", dns.RcodeToString[res.rcode], res.fail)
		}
	}
	c, err := net.Dial("udp", "[2001:db8::53]:53")
	if err == nil {
		_ = c.Close()
		t.Skip("this host routes IPv6: zdns dials the IPv6 server")
	}
	// No route: zdns fails before it dials; the lookup fails locally and IPv6 is checked again.
	cfg.Upstreams = []string{"[2001:db8::53]:53"}
	h = newHarness(t, cfg, n)
	if err := h.s.engine.rebuild(true); err != nil {
		t.Fatal(err)
	}
	if res := h.lookup(routeRecursive, "www.example.test", dns.TypeA); res.rcode != dns.RcodeServerFailure || res.fail != failLocal {
		t.Errorf("IPv6 only without a route = %s fail %v", dns.RcodeToString[res.rcode], res.fail)
	}
	select {
	case <-h.s.ipv6Kick:
	default:
		t.Error("the IPv6 check was not requested")
	}
}

func TestRecursiveGuardRefusalIsLocal(t *testing.T) {
	cfg := testConfig(ModeRecursive, "127.0.0.1:53")
	cfg.Upstreams = []string{"10.9.9.9:53"} // private and not trusted
	rec := &resolvertest.Network{}
	h := newHarness(t, cfg, rec)
	res := h.lookup(routeRecursive, "www.example.test", dns.TypeA)
	if res.rcode != dns.RcodeServerFailure || res.fail != failLocal {
		t.Errorf("refused upstream = %s fail %v", dns.RcodeToString[res.rcode], res.fail)
	}
	if h.rec.dialled("10.9.9.9:53") {
		t.Error("an untrusted private upstream was dialled")
	}
}

func TestLocalRouteUsesTheHostNameservers(t *testing.T) {
	local := fakeDNS(t, resolvertest.MustZone("scantor.localhost.", "fixtures 300 IN A 172.17.0.1"))
	n := &resolvertest.Network{}
	n.Add(netip.MustParseAddr("198.51.100.53"), local)
	cfg := testConfig(ModeIterative, "127.0.0.1:53")
	h := newHarness(t, cfg, n, withResolvConf("# host\nsearch example\nnameserver 198.51.100.53\nnameserver fe80::1%eth0\n"))
	res := h.lookup(routeLocal, "fixtures.scantor.localhost", dns.TypeA)
	if got := addrsOf(res.answer); len(got) != 1 || got[0] != "172.17.0.1" {
		t.Errorf("local name = %s %v", dns.RcodeToString[res.rcode], got)
	}
	// Without host nameservers the local route answers SERVFAIL (a local cause).
	h2 := newHarness(t, cfg, n)
	if res := h2.lookup(routeLocal, "fixtures.scantor.localhost", dns.TypeA); res.rcode != dns.RcodeServerFailure || res.fail != failLocal {
		t.Errorf("no host nameservers = %s fail %v", dns.RcodeToString[res.rcode], res.fail)
	}
	if !strings.Contains(h2.logs.String(), "no usable host nameservers") {
		t.Error("no warning about the missing host nameservers")
	}
}

type iterativeSetup struct {
	h                                   *harness
	root, tld, example, other, evil, nx *resolvertest.Server
}

func newIterative(t *testing.T) *iterativeSetup {
	t.Helper()
	s := &iterativeSetup{}
	n := &resolvertest.Network{}
	s.root = fakeDNS(t, resolvertest.MustZone(".",
		". 518400 IN NS a.root.test.",
		"test. 172800 IN NS ns1.test.", "ns1.test. 172800 IN A 198.51.100.2"))
	s.tld = fakeDNS(t, resolvertest.MustZone("test.",
		"example 86400 IN NS ns.example", "ns.example 86400 IN A 198.51.100.3",
		"other 86400 IN NS ns.other", "ns.other 86400 IN A 198.51.100.4",
		"evil 86400 IN NS ns.evil", "ns.evil 86400 IN A 198.51.100.5",
		"dead 86400 IN NS ns.dead", "ns.dead 86400 IN A 198.51.100.6",
		"hostile 86400 IN NS ns1.hostile", "ns1.hostile 86400 IN A 169.254.169.254",
		"hostile 86400 IN NS ns2.hostile", "ns2.hostile 86400 IN A 10.0.0.1",
		"hostile 86400 IN NS ns3.hostile", "ns3.hostile 86400 IN A 127.0.0.53",
		"hostile 86400 IN NS ns4.hostile", "ns4.hostile 86400 IN A "+testOwnAddr.String(),
	))
	s.example = fakeDNS(t, resolvertest.MustZone("example.test.",
		"@ 300 IN SOA ns.example.test. h.example.test. 1 3600 600 86400 120",
		"www 300 IN CNAME web.other.test.",
		"chain 300 IN CNAME web",
		"web 300 IN A 192.0.2.10",
		"loop1 300 IN CNAME loop2.other.test.",
		"old 300 IN DNAME new.example.test.",
		"x.new 300 IN A 192.0.2.30",
		"@ 300 IN MX 10 mail",
		"mail 300 IN A 192.0.2.25",
		"broken 300 IN CNAME host.dead.test.",
	))
	s.other = fakeDNS(t, resolvertest.MustZone("other.test.",
		"web 300 IN A 192.0.2.20",
		"loop2 300 IN CNAME loop1.example.test.",
	))
	s.evil = fakeDNS(t, resolvertest.MustZone("evil.test.", "www 300 IN CNAME web.example.test."))
	s.nx = fakeDNS(t, resolvertest.MustZone("dead.test."))
	s.nx.On("", 0, resolvertest.Behavior{Drop: true})
	for i, srv := range []*resolvertest.Server{s.root, s.tld, s.example, s.other, s.evil, s.nx} {
		n.Add(netip.AddrFrom4([4]byte{198, 51, 100, byte(i + 1)}), srv)
	}
	cfg := testConfig(ModeIterative, "127.0.0.1:53")
	cfg.RootServers = []string{"198.51.100.1:53"}
	s.h = newHarness(t, cfg, n)
	return s
}

func TestIterativeChains(t *testing.T) {
	s := newIterative(t)
	cases := []struct {
		name  string
		qtype uint16
		rcode int
		types []uint16 // answer section
		addr  string   // the final address, if any
	}{
		{"www.example.test", dns.TypeA, dns.RcodeSuccess, []uint16{dns.TypeCNAME, dns.TypeA}, "192.0.2.20"},
		{"chain.example.test", dns.TypeA, dns.RcodeSuccess, []uint16{dns.TypeCNAME, dns.TypeA}, "192.0.2.10"},
		{"x.old.example.test", dns.TypeA, dns.RcodeSuccess, []uint16{dns.TypeDNAME, dns.TypeCNAME, dns.TypeA}, "192.0.2.30"},
		{"www.example.test", dns.TypeCNAME, dns.RcodeSuccess, []uint16{dns.TypeCNAME}, ""},
		{"nope.example.test", dns.TypeA, dns.RcodeNameError, nil, ""},
		{"web.example.test", dns.TypeAAAA, dns.RcodeSuccess, nil, ""},
		// Records the evil zone adds for web.example.test are never taken: example.test is asked.
		{"www.evil.test", dns.TypeA, dns.RcodeSuccess, []uint16{dns.TypeCNAME, dns.TypeA}, "192.0.2.10"},
	}
	s.evil.On("www.evil.test", dns.TypeA, resolvertest.Behavior{Edit: func(m *dns.Msg) {
		forged, _ := dns.NewRR("web.example.test. 300 IN A " + resolvertest.SpoofedAddress.String())
		m.Answer = append(m.Answer, forged)
	}})
	for _, tc := range cases {
		res := s.h.lookup(routeIterative, tc.name, tc.qtype)
		var types []uint16
		for _, rr := range res.answer {
			types = append(types, rr.Header().Rrtype)
		}
		if res.rcode != tc.rcode || !slices.Equal(types, tc.types) {
			t.Errorf("%s %s = %s %v", tc.name, dns.TypeToString[tc.qtype], dns.RcodeToString[res.rcode], rrTexts(res.answer))
			continue
		}
		if addrs := addrsOf(res.answer); tc.addr != "" && (len(addrs) != 1 || addrs[0] != tc.addr) {
			t.Errorf("%s %s addresses = %v", tc.name, dns.TypeToString[tc.qtype], addrs)
		}
		if tc.rcode == dns.RcodeNameError || len(tc.types) == 0 {
			if len(res.ns) != 1 || res.ns[0].Header().Rrtype != dns.TypeSOA {
				t.Errorf("%s %s negative answer without SOA: %v", tc.name, dns.TypeToString[tc.qtype], rrTexts(res.ns))
			}
		}
	}
	// The in-zone chain asked example.test twice (each hop once); NXDOMAIN took one query.
	if s.example.Count("chain.example.test", dns.TypeA) != 1 || s.example.Count("web.example.test", dns.TypeA) < 1 {
		t.Error("in-zone chain hops")
	}
	if n := s.example.Count("nope.example.test", dns.TypeA); n != 1 {
		t.Errorf("NXDOMAIN took %d queries at the authoritative server", n)
	}
	// Queries to authoritative servers never ask for recursion.
	for _, q := range s.example.Queries() {
		if q.RD {
			t.Errorf("iterative query with RD: %+v", q)
		}
	}
}

func TestIterativeFailuresAreNeverPartialAnswers(t *testing.T) {
	s := newIterative(t)
	// A loop across zones.
	if res := s.h.lookup(routeIterative, "loop1.example.test", dns.TypeA); res.rcode != dns.RcodeServerFailure || res.fail != failRemote {
		t.Errorf("CNAME loop = %s fail %v %v", dns.RcodeToString[res.rcode], res.fail, rrTexts(res.answer))
	}
	// A CNAME whose target's servers do not answer: SERVFAIL, never a dangling CNAME.
	if res := s.h.lookup(routeIterative, "broken.example.test", dns.TypeA); res.rcode != dns.RcodeServerFailure || len(res.answer) != 0 {
		t.Errorf("failed target = %s %v", dns.RcodeToString[res.rcode], rrTexts(res.answer))
	}
	// A DNAME without the synthesized CNAME: the resolver synthesizes it.
	s.example.On("y.old.example.test", dns.TypeA, resolvertest.Behavior{Edit: func(m *dns.Msg) { m.Answer = m.Answer[:1] }})
	res := s.h.lookup(routeIterative, "y.old.example.test", dns.TypeA)
	if res.rcode != dns.RcodeNameError || len(res.answer) != 2 || res.answer[1].(*dns.CNAME).Target != "y.new.example.test." {
		t.Errorf("synthesized CNAME = %s %v", dns.RcodeToString[res.rcode], rrTexts(res.answer))
	}
	// zdns' cache never answers: an MX asked twice is answered twice with the MX.
	for range 2 {
		res := s.h.lookup(routeIterative, "example.test", dns.TypeMX)
		if len(res.answer) != 1 || res.answer[0].Header().Rrtype != dns.TypeMX {
			t.Fatalf("MX = %s %v", dns.RcodeToString[res.rcode], rrTexts(res.answer))
		}
	}
	if n := s.example.Count("example.test", dns.TypeMX); n != 2 {
		t.Errorf("MX queries = %d", n)
	}
	// Delegations stay cached: the root and TLD servers are not asked again for the second MX.
	if n := s.root.Count("example.test", dns.TypeMX) + s.tld.Count("example.test", dns.TypeMX); n > 1 {
		t.Errorf("root and TLD queries for the MX = %d", n)
	}
	// zdns rejects or rewrites some PTR names; iterative mode answers SERVFAIL for them.
	if res := s.h.lookup(routeIterative, "_services._dns-sd._udp.example.test", dns.TypePTR); res.rcode != dns.RcodeServerFailure || res.fail != failLocal {
		t.Errorf("DNS-SD PTR = %s fail %v", dns.RcodeToString[res.rcode], res.fail)
	}
}

func TestHostileGlueIsNeverDialled(t *testing.T) {
	s := newIterative(t)
	res := s.h.lookup(routeIterative, "www.hostile.test", dns.TypeA)
	if res.rcode != dns.RcodeServerFailure || res.fail != failLocal {
		t.Errorf("hostile delegation = %s fail %v", dns.RcodeToString[res.rcode], res.fail)
	}
	for _, addr := range []string{"169.254.169.254:53", "10.0.0.1:53", "127.0.0.53:53", testOwnAddr.String() + ":53"} {
		if s.h.rec.dialled(addr) {
			t.Errorf("%s was dialled", addr)
		}
	}
	if !s.h.rec.dialled("198.51.100.2:53") {
		t.Error("the TLD server was not asked")
	}
}

func TestLogrusFatalIsRecovered(t *testing.T) {
	r := newRecursive(t)
	e := r.h.s.engine
	g := e.gen.Load()
	if !e.withResolver(g, func(*zdns.Resolver) { logrus.Fatal("name already has trailing dot") }) {
		t.Fatal("no panic reported")
	}
	if e.stats.panics.Load() != 1 || len(g.pool) != cap(g.pool) {
		t.Errorf("panics %d, pool %d/%d", e.stats.panics.Load(), len(g.pool), cap(g.pool))
	}
	// The process continues: the next lookup works.
	if res := r.h.lookup(routeRecursive, "www.example.test", dns.TypeA); res.rcode != dns.RcodeSuccess {
		t.Errorf("lookup after the recovery = %s", dns.RcodeToString[res.rcode])
	}
	// Any other panic is fatal.
	var got any
	e.fatal = func(p any) { got = p }
	if !e.withResolver(g, func(*zdns.Resolver) { panic("corrupt cache") }) || got != "corrupt cache" {
		t.Errorf("other panic: %v", got)
	}
	if e.stats.panics.Load() != 1 || len(g.pool) != cap(g.pool) {
		t.Errorf("after another panic: panics %d, pool %d/%d", e.stats.panics.Load(), len(g.pool), cap(g.pool))
	}
}

func TestZDNSInfoLogsOnlyAtDebug(t *testing.T) {
	const zdnsLine = "none of the default local addresses could connect"
	r := newRecursive(t)
	if res := r.h.lookup(routeRecursive, "www.example.test", dns.TypeA); res.rcode != dns.RcodeSuccess {
		t.Fatal(dns.RcodeToString[res.rcode])
	}
	if strings.Contains(r.h.logs.String(), zdnsLine) {
		t.Error("zdns logs a line per query at level info")
	}
	cfg := testConfig(ModeRecursive, "127.0.0.1:53")
	cfg.Upstreams = []string{"198.51.100.1:53"}
	cfg.LogLevel = "debug"
	h := newHarness(t, cfg, r.net)
	if res := h.lookup(routeRecursive, "www.example.test", dns.TypeA); res.rcode != dns.RcodeSuccess {
		t.Fatal(dns.RcodeToString[res.rcode])
	}
	if !strings.Contains(h.logs.String(), zdnsLine) || !strings.Contains(h.logs.String(), `"component":"zdns"`) {
		t.Error("zdns' records do not reach the log at level debug")
	}
}

// TestQueryBudgetBoundsAmplification resolves a name whose zone answers every question with a
// referral to 13 name servers without glue below the asked name, so every server name needs a lookup
// of its own that is referred the same way (NXNS): one client lookup sends at most maxLookupQueries
// queries, ends at once with SERVFAIL that is never cached, and counts in queryBudgetExceeded.
func TestQueryBudgetBoundsAmplification(t *testing.T) {
	n := &resolvertest.Network{}
	root := fakeDNS(t, resolvertest.MustZone(".",
		". 518400 IN NS a.root.test.",
		"test. 172800 IN NS ns1.test.", "ns1.test. 172800 IN A 198.51.100.2"))
	tld := fakeDNS(t, resolvertest.MustZone("test.", "victim 86400 IN NS ns.victim", "ns.victim 86400 IN A 198.51.100.3"))
	victim := fakeDNS(t, resolvertest.MustZone("victim.test."))
	victim.On("", 0, resolvertest.Behavior{Edit: func(m *dns.Msg) {
		name := dns.CanonicalName(m.Question[0].Name)
		m.Rcode, m.Authoritative, m.Answer, m.Ns = dns.RcodeSuccess, false, nil, nil
		for i := range 13 {
			m.Ns = append(m.Ns, &dns.NS{
				Hdr: dns.RR_Header{Name: name, Rrtype: dns.TypeNS, Class: dns.ClassINET, Ttl: 300},
				Ns:  fmt.Sprintf("n%d.%s", i, name),
			})
		}
	}})
	for i, srv := range []*resolvertest.Server{root, tld, victim} {
		n.Add(netip.AddrFrom4([4]byte{198, 51, 100, byte(i + 1)}), srv)
	}
	cfg := testConfig(ModeIterative, "127.0.0.1:53")
	cfg.RootServers = []string{"198.51.100.1:53"}
	h := newHarness(t, cfg, n)
	start := time.Now()
	res := h.lookup(routeIterative, "x.victim.test", dns.TypeA)
	if res.rcode != dns.RcodeServerFailure || res.fail != failLocal {
		t.Errorf("amplifying zone = %s fail %v", dns.RcodeToString[res.rcode], res.fail)
	}
	sent := len(root.Queries()) + len(tld.Queries()) + len(victim.Queries())
	if sent > maxLookupQueries {
		t.Errorf("one client lookup sent %d queries, budget %d", sent, maxLookupQueries)
	}
	if elapsed := time.Since(start); elapsed > h.s.t.iterativeBudget/2 {
		t.Errorf("the lookup ran for %v after its budget was spent", elapsed)
	}
	if got := h.s.stats.budgetExceeded.Load(); got != 1 {
		t.Errorf("queryBudgetExceeded = %d", got)
	}
}

// TestSelfChecksSkipRateLimits: with a per-server limit of 1 query per second that client lookups use
// up, the upstream check still reaches the upstream server.
func TestSelfChecksSkipRateLimits(t *testing.T) {
	r := newRecursive(t)
	cfg := testConfig(ModeRecursive, "127.0.0.1:53")
	cfg.Upstreams = []string{"198.51.100.1:53"}
	cfg.UpstreamQPS = 1
	h := newHarness(t, cfg, r.net)
	if res := h.lookup(routeRecursive, "www.example.test", dns.TypeA); res.rcode != dns.RcodeSuccess {
		t.Fatalf("lookup = %s", dns.RcodeToString[res.rcode])
	}
	if res := h.lookup(routeRecursive, "mail.example.test", dns.TypeA); res.fail != failLocal {
		t.Fatalf("a second lookup within the second was not rate-limited: %s", dns.RcodeToString[res.rcode])
	}
	if ok, code := h.s.engine.upstreamCheck(context.Background(), false); !ok {
		t.Errorf("upstream check under the rate limit failed: %s", code)
	}
}
