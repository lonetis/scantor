package resolvertest

import (
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/zmap/dns"
)

func start(t *testing.T, zones ...*Zone) *Server {
	t.Helper()
	s, err := Start("127.0.0.1:0", zones...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func ask(t *testing.T, s *Server, network, name string, qtype uint16, edns bool) *dns.Msg {
	t.Helper()
	m := new(dns.Msg)
	m.SetQuestion(dns.Fqdn(name), qtype)
	if edns {
		m.SetEdns0(1232, false)
	}
	c := &dns.Client{Net: network, Timeout: 2 * time.Second}
	r, _, err := c.Exchange(m, s.Addr().String())
	if err != nil {
		t.Fatalf("%s %s %s: %v", network, name, dns.TypeToString[qtype], err)
	}
	return r
}

func rrStrings(rrs []dns.RR) []string {
	out := make([]string, len(rrs))
	for i, rr := range rrs {
		out[i] = strings.Join(strings.Fields(rr.String()), " ")
	}
	return out
}

func TestZoneAnswers(t *testing.T) {
	root := MustZone(".", "test. 86400 IN NS ns.test.", "ns.test. 86400 IN A 198.51.100.2")
	ex := MustZone("example.test.",
		"@ 300 IN SOA ns.example.test. h.example.test. 1 3600 600 86400 60",
		"www 300 IN CNAME web",
		"web 60 IN A 192.0.2.10",
		"loop1 300 IN CNAME loop2",
		"loop2 300 IN CNAME loop1",
		"out 300 IN CNAME host.other.test.",
		"@ 300 IN MX 10 mail",
		"mail 300 IN A 192.0.2.25",
		"a.b 300 IN TXT \"deep\"",
		"old 300 IN DNAME new.example.test.",
		"x.new 300 IN A 192.0.2.30",
		"sub 300 IN NS ns.sub",
		"ns.sub 300 IN A 198.51.100.9",
	)
	s := start(t, root, ex)

	// Referral from the root, with glue and AA=0.
	r := ask(t, s, "udp", "www.example.test", dns.TypeA, true)
	if r.Rcode != dns.RcodeSuccess {
		t.Fatalf("rcode = %s", dns.RcodeToString[r.Rcode])
	}
	// example.test. is the longest zone: an authoritative in-zone chain.
	if !r.Authoritative || len(r.Answer) != 2 || r.Answer[1].(*dns.A).A.String() != "192.0.2.10" {
		t.Errorf("in-zone chain: %v", rrStrings(r.Answer))
	}
	r = ask(t, s, "udp", "foo.test", dns.TypeA, false)
	if r.Authoritative || len(r.Ns) != 1 || len(r.Extra) != 1 {
		t.Errorf("root referral: aa=%v ns=%v extra=%v", r.Authoritative, rrStrings(r.Ns), rrStrings(r.Extra))
	}
	// A cut inside the zone refers too.
	r = ask(t, s, "udp", "host.sub.example.test", dns.TypeA, false)
	if r.Authoritative || len(r.Ns) != 1 || r.Ns[0].(*dns.NS).Ns != "ns.sub.example.test." || len(r.Extra) != 1 {
		t.Errorf("zone cut: aa=%v ns=%v extra=%v", r.Authoritative, rrStrings(r.Ns), rrStrings(r.Extra))
	}
	// NXDOMAIN and NODATA carry the SOA; an empty non-terminal is NODATA.
	r = ask(t, s, "udp", "nope.example.test", dns.TypeA, false)
	if r.Rcode != dns.RcodeNameError || len(r.Ns) != 1 || r.Ns[0].Header().Rrtype != dns.TypeSOA {
		t.Errorf("NXDOMAIN: %s %v", dns.RcodeToString[r.Rcode], rrStrings(r.Ns))
	}
	r = ask(t, s, "udp", "web.example.test", dns.TypeAAAA, false)
	if r.Rcode != dns.RcodeSuccess || len(r.Answer) != 0 || len(r.Ns) != 1 {
		t.Errorf("NODATA: %s %v %v", dns.RcodeToString[r.Rcode], rrStrings(r.Answer), rrStrings(r.Ns))
	}
	r = ask(t, s, "udp", "b.example.test", dns.TypeTXT, false)
	if r.Rcode != dns.RcodeSuccess || len(r.Answer) != 0 {
		t.Errorf("empty non-terminal: %s %v", dns.RcodeToString[r.Rcode], rrStrings(r.Answer))
	}
	// A CNAME out of the zone stops; a loop ends.
	r = ask(t, s, "udp", "out.example.test", dns.TypeA, false)
	if len(r.Answer) != 1 || r.Answer[0].Header().Rrtype != dns.TypeCNAME {
		t.Errorf("cross-zone CNAME: %v", rrStrings(r.Answer))
	}
	r = ask(t, s, "udp", "loop1.example.test", dns.TypeA, false)
	if len(r.Answer) != 2 {
		t.Errorf("CNAME loop: %v", rrStrings(r.Answer))
	}
	// DNAME: the DNAME, the synthesized CNAME and the target.
	r = ask(t, s, "udp", "x.old.example.test", dns.TypeA, false)
	if len(r.Answer) != 3 || r.Answer[0].Header().Rrtype != dns.TypeDNAME || r.Answer[1].(*dns.CNAME).Target != "x.new.example.test." {
		t.Errorf("DNAME: %v", rrStrings(r.Answer))
	}
	// MX answers carry the address of the target.
	r = ask(t, s, "udp", "example.test", dns.TypeMX, false)
	if len(r.Answer) != 1 || len(r.Extra) != 1 || r.Extra[0].(*dns.A).A.String() != "192.0.2.25" {
		t.Errorf("MX additional: %v %v", rrStrings(r.Answer), rrStrings(r.Extra))
	}
	// Outside every zone: REFUSED.
	other := start(t, ex)
	if r := ask(t, other, "udp", "www.elsewhere.example", dns.TypeA, false); r.Rcode != dns.RcodeRefused {
		t.Errorf("outside the zones: %s", dns.RcodeToString[r.Rcode])
	}
}

func TestBehaviorsAndLog(t *testing.T) {
	z := MustZone("example.test.", "big 300 IN TXT \""+strings.Repeat("x", 200)+"\"", "big 300 IN TXT \""+strings.Repeat("y", 200)+"\"",
		"big 300 IN TXT \""+strings.Repeat("z", 200)+"\"", "a 300 IN A 192.0.2.1")
	s := start(t, z)
	// Without EDNS a large UDP answer is truncated; TCP carries it.
	if r := ask(t, s, "udp", "big.example.test", dns.TypeTXT, false); !r.Truncated {
		t.Error("UDP answer > 512 bytes not truncated")
	}
	if r := ask(t, s, "tcp", "big.example.test", dns.TypeTXT, false); r.Truncated || len(r.Answer) != 3 {
		t.Errorf("TCP answer: tc=%v %d records", r.Truncated, len(r.Answer))
	}
	s.On("a.example.test", dns.TypeA, Behavior{Truncate: true})
	if r := ask(t, s, "udp", "a.example.test", dns.TypeA, true); !r.Truncated || len(r.Answer) != 0 {
		t.Error("Truncate behavior")
	}
	if r := ask(t, s, "tcp", "a.example.test", dns.TypeA, true); r.Truncated || len(r.Answer) != 1 {
		t.Error("Truncate behavior over TCP")
	}
	s.On("a.example.test", dns.TypeAAAA, Behavior{Rcode: dns.RcodeServerFailure, Times: 1})
	if r := ask(t, s, "udp", "a.example.test", dns.TypeAAAA, false); r.Rcode != dns.RcodeServerFailure {
		t.Error("Rcode behavior")
	}
	if r := ask(t, s, "udp", "a.example.test", dns.TypeAAAA, false); r.Rcode != dns.RcodeSuccess {
		t.Error("Times: the behavior applied twice")
	}
	s.On("slow.example.test", 0, Behavior{Delay: 150 * time.Millisecond})
	begin := time.Now()
	_ = ask(t, s, "udp", "slow.example.test", dns.TypeA, false)
	if time.Since(begin) < 150*time.Millisecond {
		t.Error("Delay behavior")
	}
	s.On("gone.example.test", 0, Behavior{Drop: true})
	m := new(dns.Msg)
	m.SetQuestion("gone.example.test.", dns.TypeA)
	if _, _, err := (&dns.Client{Timeout: 200 * time.Millisecond}).Exchange(m, s.Addr().String()); err == nil {
		t.Error("Drop behavior answered")
	}
	if n := s.Count("A.Example.Test", dns.TypeA); n != 2 {
		t.Errorf("Count(a.example.test, A) = %d", n)
	}
	q := s.Queries()
	if len(q) == 0 || q[0].Net != "udp" || q[0].Name != "big.example.test." || !q[0].From.Addr().IsLoopback() {
		t.Errorf("query log: %+v", q)
	}
	s.ResetLog()
	if len(s.Queries()) != 0 {
		t.Error("ResetLog")
	}
}

func TestNetworkRewrite(t *testing.T) {
	s := start(t, MustZone("example.test."))
	var n Network
	n.Add(netip.MustParseAddr("198.51.100.1"), s)
	n.AddPort(netip.MustParseAddrPort("198.51.100.2:1053"), s)
	for in, want := range map[string]string{
		"198.51.100.1:53":   s.Addr().String(),
		"198.51.100.2:1053": s.Addr().String(),
		"198.51.100.2:53":   "127.0.0.1:9",
		"127.0.0.5:5353":    "127.0.0.5:5353",
		"not an address":    "not an address",
	} {
		if got := n.Rewrite("udp", in); got != want {
			t.Errorf("Rewrite(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNewZoneRejectsRecordsOutsideTheZone(t *testing.T) {
	if _, err := NewZone("example.test.", "www.other.test. 300 IN A 192.0.2.1"); err == nil {
		t.Error("record outside the zone accepted")
	}
	if _, err := NewZone("example.test.", "www 300 IN SOA a. b. 1 2 3 4 5"); err == nil {
		t.Error("SOA below the origin accepted")
	}
	if _, err := NewZone("example.test.", "www 300 IN BOGUS x"); err == nil {
		t.Error("malformed record accepted")
	}
}
