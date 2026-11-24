package resolver

import (
	"context"
	"fmt"
	"net/netip"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zmap/dns"

	"github.com/lonetis/scantor/internal/resolver/resolvertest"
)

// mustRR parses a record of static test data (also inside fake server callbacks, which must not use t).
func mustRR(s string) dns.RR {
	r, err := dns.NewRR(s)
	if err != nil {
		panic(err)
	}
	return r
}

// referral builds a non-authoritative referral reply to q delegating zone to servers name servers
// (names of about nameLen characters below zone, each with an A record of glue) plus extra records.
func referral(q *dns.Msg, zone string, servers, nameLen int, glue netip.Addr, extra ...string) *dns.Msg {
	m := new(dns.Msg)
	m.SetReply(q)
	labels := []string{""}
	for left := nameLen - 7; left > 0; left -= 61 {
		labels = append(labels, strings.Repeat("n", min(left, 60)))
	}
	pad := strings.Join(labels, ".")
	for i := range servers {
		ns := fmt.Sprintf("ns%04d%s.%s", i, pad, zone)
		m.Ns = append(m.Ns, &dns.NS{Hdr: dns.RR_Header{Name: zone, Rrtype: dns.TypeNS, Class: dns.ClassINET, Ttl: 86400}, Ns: ns})
		m.Extra = append(m.Extra, &dns.A{Hdr: dns.RR_Header{Name: ns, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 86400}, A: glue.AsSlice()})
	}
	for _, s := range extra {
		m.Ns = append(m.Ns, mustRR(s))
	}
	return m
}

// referTo makes a fake server answer every question it is set for with a referral of servers name
// servers (glue at glue) for the question's name.
func referTo(servers func() int, glue netip.Addr) func(m *dns.Msg) {
	return func(m *dns.Msg) {
		q := &dns.Msg{Question: m.Question, MsgHdr: dns.MsgHdr{Id: m.Id}}
		r := referral(q, dns.CanonicalName(m.Question[0].Name), servers(), 40, glue)
		m.Rcode, m.Authoritative, m.Answer, m.Ns, m.Extra = dns.RcodeSuccess, false, nil, r.Ns, append(r.Extra, m.Extra...)
	}
}

func wireLen(t *testing.T, m *dns.Msg) int {
	t.Helper()
	m.Compress = true
	b, err := m.Pack()
	if err != nil {
		t.Fatal(err)
	}
	return len(b)
}

func TestSanitizeIterative(t *testing.T) {
	hop := question{name: "www.evil.test.", qtype: dns.TypeA}
	q := newQuery("www.evil.test", dns.TypeA)
	glue := netip.MustParseAddr("192.0.2.53")

	// A delegation of 100 servers with DS records and glue for other names: 13 NS records of the
	// delegation, the glue of the kept servers, no DS; the OPT record stays.
	big := referral(q, "www.evil.test.", 100, 10, glue, "www.evil.test. 86400 IN DS 1 8 2 abcd", "other.test. 86400 IN NS ns.other.test.")
	big.Extra = append(big.Extra, rr(t, "unrelated.test. 300 IN A 192.0.2.99"))
	big.SetEdns0(1232, false)
	out := sanitizeIterative(big, wireLen(t, big), hop)
	var nsCount, glueCount, opt int
	for _, r := range out.Ns {
		if r.Header().Rrtype != dns.TypeNS || r.Header().Name != "www.evil.test." {
			t.Errorf("kept authority record %s", r)
		}
		nsCount++
	}
	for _, r := range out.Extra {
		switch r.Header().Rrtype {
		case dns.TypeOPT:
			opt++
		case dns.TypeA:
			glueCount++
			if !strings.HasPrefix(r.Header().Name, "ns00") {
				t.Errorf("kept glue %s", r)
			}
		}
	}
	if nsCount != maxDelegationNS || glueCount != maxDelegationNS || opt != 1 || out.Rcode != dns.RcodeSuccess || out.Id != q.Id {
		t.Errorf("trimmed referral: %d NS, %d glue, %d OPT, rcode %d", nsCount, glueCount, opt, out.Rcode)
	}

	// Long names: the byte budget keeps fewer records.
	long := referral(q, "www.evil.test.", 13, 220, glue)
	out = sanitizeIterative(long, wireLen(t, long), hop)
	total := 0
	for _, r := range append(append([]dns.RR{}, out.Ns...), out.Extra...) {
		total += dns.Len(r)
	}
	if len(out.Ns) == 0 || len(out.Extra) >= len(out.Ns) || total > maxInfraRecordBytes {
		t.Errorf("long names: %d NS and %d glue kept, %d bytes", len(out.Ns), len(out.Extra), total)
	}

	// Above 16 KiB a referral becomes SERVFAIL.
	huge := referral(q, "www.evil.test.", 1100, 10, glue)
	if n := wireLen(t, huge); n <= maxReferralBytes {
		t.Fatalf("the huge referral has only %d bytes", n)
	}
	if out := sanitizeIterative(huge, wireLen(t, huge), hop); out.Rcode != dns.RcodeServerFailure || len(out.Ns)+len(out.Extra)+len(out.Answer) != 0 || out.Id != q.Id {
		t.Errorf("huge referral = %s with %d records", dns.RcodeToString[out.Rcode], len(out.Ns)+len(out.Extra))
	}

	// A small delegation passes unchanged.
	small := referral(q, "www.evil.test.", 4, 10, glue)
	if out := sanitizeIterative(small, wireLen(t, small), hop); out != small {
		t.Error("a small referral was rewritten")
	}

	// The authoritative answer to the hop question and error replies pass unchanged, whatever their size.
	aa := new(dns.Msg)
	aa.SetReply(q)
	aa.Authoritative = true
	for i := range 2000 {
		aa.Answer = append(aa.Answer, rr(t, fmt.Sprintf("www.evil.test. 300 IN A 10.%d.%d.%d", i/65536, i/256%256, i%256)))
	}
	if out := sanitizeIterative(aa, wireLen(t, aa), hop); out != aa {
		t.Error("the authoritative answer was rewritten")
	}
	nx := referral(q, "www.evil.test.", 100, 10, glue)
	nx.Rcode = dns.RcodeNameError
	if out := sanitizeIterative(nx, wireLen(t, nx), hop); out != nx {
		t.Error("an NXDOMAIN reply was rewritten")
	}

	// A non-authoritative answer to the hop question keeps its answers; its delegation is trimmed.
	naa := referral(q, "evil.test.", 40, 10, glue)
	naa.Answer = aa.Answer[:100]
	out = sanitizeIterative(naa, wireLen(t, naa), hop)
	if len(out.Answer) != 100 || len(out.Ns) > maxDelegationNS {
		t.Errorf("non-authoritative answer: %d answers, %d NS", len(out.Answer), len(out.Ns))
	}

	// A reply to a question zdns asks itself (a name server's address) keeps a few answers and one SOA.
	nsq := newQuery("ns1.evil.test", dns.TypeA)
	addr := new(dns.Msg)
	addr.SetReply(nsq)
	addr.Authoritative = true
	for i := range 300 {
		addr.Answer = append(addr.Answer, rr(t, fmt.Sprintf("ns1.evil.test. 300 IN A 192.0.2.%d", i%250+1)))
	}
	addr.Ns = []dns.RR{
		rr(t, "evil.test. 300 IN SOA ns.evil.test. h.evil.test. 1 3600 600 86400 300"),
		rr(t, "evil.test. 300 IN SOA ns.evil.test. h.evil.test. 2 3600 600 86400 300"),
	}
	out = sanitizeIterative(addr, wireLen(t, addr), hop)
	if len(out.Answer) != maxInfraAnswers || len(out.Ns) != 1 {
		t.Errorf("name server address reply: %d answers, %d authority records", len(out.Answer), len(out.Ns))
	}
}

// TestCaptureTrimsWhatZDNSReads exchanges queries of the iterative route over UDP and TCP with a server
// that answers huge referrals: the reader (zdns) gets the trimmed reply or SERVFAIL, the recorder the
// reply as sent.
func TestCaptureTrimsWhatZDNSReads(t *testing.T) {
	fake := fakeDNS(t, resolvertest.MustZone("evil.test."))
	glue := netip.MustParseAddr("192.0.2.53")
	fake.On("trim.evil.test", dns.TypeA, resolvertest.Behavior{Edit: referTo(func() int { return 90 }, glue)})
	fake.On("drop.evil.test", dns.TypeA, resolvertest.Behavior{Edit: referTo(func() int { return 1100 }, glue)})
	var n resolvertest.Network
	n.Add(netip.MustParseAddr("198.51.100.1"), fake)
	d := testDialer(t, &n)
	exchange := func(network, name string) (*dns.Msg, *recorder) {
		t.Helper()
		rec := newRecorder(question{name: dns.Fqdn(name), qtype: dns.TypeA}, true)
		ctx := withState(context.Background(), &lookupState{route: routeIterative, rec: rec})
		c, err := d.DialContext(ctx, network, nil, "198.51.100.1:53")
		if err != nil {
			t.Fatal(err)
		}
		conn := &dns.Conn{Conn: c, UDPSize: ednsSize}
		defer conn.Close()
		q := newQuery(name, dns.TypeA)
		q.SetEdns0(ednsSize, false)
		r, _, err := (&dns.Client{Net: network, Timeout: time.Second}).ExchangeWithConnContext(ctx, q, conn)
		if err != nil {
			t.Fatalf("%s %s: %v", network, name, err)
		}
		return r, rec
	}
	r, rec := exchange("tcp", "trim.evil.test")
	if len(r.Ns) != maxDelegationNS || len(r.Extra) != maxDelegationNS+1 {
		t.Errorf("TCP: zdns read %d NS and %d additional records", len(r.Ns), len(r.Extra))
	}
	if replies, _ := rec.received(); replies != 1 {
		t.Errorf("TCP: %d replies recorded", replies)
	}
	if r, _ := exchange("tcp", "drop.evil.test"); r.Rcode != dns.RcodeServerFailure || len(r.Ns) != 0 {
		t.Errorf("TCP: an oversized referral reached zdns as %s with %d NS", dns.RcodeToString[r.Rcode], len(r.Ns))
	}
	// Over UDP the referral is truncated by the server; whatever fits is trimmed too.
	if r, _ := exchange("udp", "trim.evil.test"); len(r.Ns) > maxDelegationNS {
		t.Errorf("UDP: zdns read %d NS", len(r.Ns))
	}
}

// TestHostileDelegationsKeepZDNSCacheSmall resolves names below a zone whose server answers every
// question with a non-authoritative referral of many name servers and their glue, the way a hostile
// zone would fill zdns' delegation cache (each lookup adds one delegation): what one such lookup
// leaves in memory stays within the memory budget of a delegation cache entry, and an oversized
// referral leaves nothing.
func TestHostileDelegationsKeepZDNSCacheSmall(t *testing.T) {
	n := &resolvertest.Network{}
	root := fakeDNS(t, resolvertest.MustZone(".",
		". 518400 IN NS a.root.test.",
		"test. 172800 IN NS ns1.test.", "ns1.test. 172800 IN A 198.51.100.2"))
	tld := fakeDNS(t, resolvertest.MustZone("test.", "evil 86400 IN NS ns.evil", "ns.evil 86400 IN A 198.51.100.3"))
	evil := fakeDNS(t, resolvertest.MustZone("evil.test."))
	leaf := fakeDNS(t, resolvertest.MustZone("evil.test."))
	leaf.On("", 0, resolvertest.Behavior{Edit: func(m *dns.Msg) {
		m.Rcode, m.Authoritative, m.Ns = dns.RcodeSuccess, true, nil
		m.Answer = []dns.RR{&dns.A{Hdr: dns.RR_Header{Name: m.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 300}, A: []byte{192, 0, 2, 7}}}
	}})
	var servers, nameLen atomic.Int32
	evil.On("", 0, resolvertest.Behavior{Edit: func(m *dns.Msg) {
		q := &dns.Msg{Question: m.Question, MsgHdr: dns.MsgHdr{Id: m.Id}}
		r := referral(q, dns.CanonicalName(m.Question[0].Name), int(servers.Load()), int(nameLen.Load()), netip.MustParseAddr("198.51.100.4"))
		m.Rcode, m.Authoritative, m.Answer, m.Ns, m.Extra = dns.RcodeSuccess, false, nil, r.Ns, append(r.Extra, m.Extra...)
	}})
	all := []*resolvertest.Server{root, tld, evil, leaf}
	for i, srv := range all {
		n.Add(netip.AddrFrom4([4]byte{198, 51, 100, byte(i + 1)}), srv)
	}
	cfg := testConfig(ModeIterative, "127.0.0.1:53")
	cfg.RootServers = []string{"198.51.100.1:53"}
	h := newHarness(t, cfg, n)
	// retained resolves lookups names under referrals of the given shape and returns the heap each
	// lookup left (the fake servers' query logs excluded).
	retained := func(prefix string, lookups, ns, length int, want int) float64 {
		t.Helper()
		servers.Store(int32(ns))     //nolint:gosec // small test values
		nameLen.Store(int32(length)) //nolint:gosec // small test values
		if res := h.lookup(routeIterative, prefix+"-warm.evil.test", dns.TypeA); res.rcode != want {
			t.Fatalf("%s: lookup = %s", prefix, dns.RcodeToString[res.rcode])
		}
		var before, after runtime.MemStats
		for _, s := range all {
			s.ResetLog()
		}
		runtime.GC()
		runtime.ReadMemStats(&before)
		for i := range lookups {
			h.lookup(routeIterative, fmt.Sprintf("%s%d.evil.test", prefix, i), dns.TypeA)
		}
		for _, s := range all {
			s.ResetLog()
		}
		runtime.GC()
		runtime.ReadMemStats(&after)
		per := (float64(after.HeapAlloc) - float64(before.HeapAlloc)) / float64(lookups)
		t.Logf("%s: %d servers, names of %d bytes: %.0f bytes retained per lookup", prefix, ns, length, per)
		return per
	}
	// 80 servers (glue included, about 14 KiB on the wire): zdns keeps 13 servers and their glue, one
	// delegation entry per lookup.
	if per := retained("typical", 150, 80, 40, dns.RcodeSuccess); per > delegationEntryBytes {
		t.Errorf("a hostile delegation leaves %.0f bytes in memory, want at most %d", per, delegationEntryBytes)
	}
	// Names as long as possible, as many as the byte budget of a trimmed reply keeps with their glue
	// (so every server has glue and the lookup adds one entry): the largest delegation entry.
	if per := retained("long", 100, 7, 220, dns.RcodeSuccess); per > delegationEntryBytes {
		t.Errorf("a delegation of long names leaves %.0f bytes in memory, want at most %d", per, delegationEntryBytes)
	}
	// Above 16 KiB the referral never reaches zdns: the lookup fails and leaves nothing.
	if per := retained("huge", 50, 1100, 10, dns.RcodeServerFailure); per > 4<<10 {
		t.Errorf("an oversized referral leaves %.0f bytes in memory", per)
	}
	runtime.KeepAlive(h)
}

func TestDelegationEntries(t *testing.T) {
	cases := map[int64]int{
		MinCacheBytes: minDelegationEntries,
		256 << 20:     minDelegationEntries,
		1 << 30:       65536,
		MaxCacheBytes: maxDelegationEntries,
	}
	for cacheBytes, want := range cases {
		if got := delegationEntries(cacheBytes); got != want {
			t.Errorf("delegationEntries(%d) = %d, want %d", cacheBytes, got, want)
		}
	}
}
