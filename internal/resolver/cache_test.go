package resolver

import (
	"fmt"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/zmap/dns"
)

func rr(t *testing.T, s string) dns.RR {
	t.Helper()
	r, err := dns.NewRR(s)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestEntryTTLRules(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	soa := "example.test. 3600 IN SOA ns.example.test. h.example.test. 1 3600 600 86400 120"
	cases := []struct {
		name      string
		res       result
		ttl       uint32
		cacheable bool
	}{
		{"positive: min of the answer section", result{qtype: dns.TypeA, answer: []dns.RR{
			rr(t, "www.example.test. 600 IN CNAME web.example.test."), rr(t, "web.example.test. 60 IN A 192.0.2.1"),
		}}, 60, true},
		{"positive capped at 1 h", result{qtype: dns.TypeA, answer: []dns.RR{rr(t, "a.test. 86400 IN A 192.0.2.1")}}, 3600, true},
		{"TTL 0 is not cached", result{qtype: dns.TypeA, answer: []dns.RR{rr(t, "a.test. 0 IN A 192.0.2.1")}}, 0, false},
		{"NXDOMAIN: SOA MINIMUM", result{qtype: dns.TypeA, rcode: dns.RcodeNameError, ns: []dns.RR{rr(t, soa)}}, 120, true},
		{"NXDOMAIN: the chain's TTL", result{qtype: dns.TypeA, rcode: dns.RcodeNameError,
			answer: []dns.RR{rr(t, "a.test. 30 IN CNAME b.test.")}, ns: []dns.RR{rr(t, soa)}}, 30, true},
		{"NODATA: SOA TTL", result{qtype: dns.TypeAAAA, ns: []dns.RR{
			rr(t, "example.test. 90 IN SOA ns.example.test. h.example.test. 1 3600 600 86400 86400"),
		}}, 90, true},
		{"negative capped at 15 min", result{qtype: dns.TypeA, rcode: dns.RcodeNameError, ns: []dns.RR{
			rr(t, "example.test. 86400 IN SOA ns.example.test. h.example.test. 1 3600 600 86400 86400"),
		}}, 900, true},
		{"negative without SOA: 5 s", result{qtype: dns.TypeA, rcode: dns.RcodeNameError}, 5, true},
		{"NODATA with an unrelated record", result{qtype: dns.TypeA, answer: []dns.RR{rr(t, "a.test. 300 IN CNAME b.test.")}}, 5, true},
		{"remote failure: 5 s", servfail(dns.TypeA, failRemote), 5, true},
		{"local failure: never", servfail(dns.TypeA, failLocal), 5, false},
	}
	for _, tc := range cases {
		e := newEntry(tc.res, now)
		if e.ttl != tc.ttl || e.cacheable != tc.cacheable {
			t.Errorf("%s: ttl %d cacheable %v, want %d %v", tc.name, e.ttl, e.cacheable, tc.ttl, tc.cacheable)
		}
	}
}

func TestEntryServesDecrementedTTLs(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	e := newEntry(result{qtype: dns.TypeA, rcode: dns.RcodeNameError,
		answer: []dns.RR{rr(t, "a.test. 300 IN CNAME b.test.")},
		ns:     []dns.RR{rr(t, "test. 3600 IN SOA ns.test. h.test. 1 3600 600 86400 200")},
	}, now)
	answer, ns := e.records(now.Add(50 * time.Second))
	// The SOA carries the negative TTL (min(300, 3600, 200) = 200), every record is decremented.
	if answer[0].Header().Ttl != 150 || ns[0].Header().Ttl != 150 {
		t.Errorf("TTLs after 50 s = %d, %d", answer[0].Header().Ttl, ns[0].Header().Ttl)
	}
	answer, _ = e.records(now.Add(time.Hour))
	if answer[0].Header().Ttl != 0 {
		t.Errorf("TTL after expiry = %d", answer[0].Header().Ttl)
	}
	// The stored records are copies: serving never changes them.
	answer[0].Header().Ttl = 9999
	if again, _ := e.records(now); again[0].Header().Ttl != 200 {
		t.Errorf("stored TTL changed to %d", again[0].Header().Ttl)
	}
}

func TestAnswerCacheExpiryAndNameLevelNXDOMAIN(t *testing.T) {
	c := newAnswerCache(MinCacheBytes)
	now := time.Unix(1_800_000_000, 0)
	pos := newEntry(result{qtype: dns.TypeA, answer: []dns.RR{rr(t, "a.test. 10 IN A 192.0.2.1")}}, now)
	c.store("a.test.", dns.TypeA, pos)
	if c.lookup("a.test.", dns.TypeA, now.Add(9*time.Second)) == nil {
		t.Error("fresh entry missing")
	}
	if c.lookup("a.test.", dns.TypeA, now.Add(10*time.Second)) != nil {
		t.Error("expired entry served")
	}
	if c.entries.Load() != 0 || c.bytes.Load() != 0 {
		t.Errorf("expired entry kept: %d entries, %d bytes", c.entries.Load(), c.bytes.Load())
	}
	// An NXDOMAIN applies to every type of the name (RFC 2308 §5)...
	nx := newEntry(result{qtype: dns.TypeA, rcode: dns.RcodeNameError, ns: []dns.RR{
		rr(t, "test. 300 IN SOA ns.test. h.test. 1 3600 600 86400 300"),
	}}, now)
	c.store("gone.test.", dns.TypeA, nx)
	if e := c.lookup("gone.test.", dns.TypeAAAA, now); e == nil || e.rcode != dns.RcodeNameError {
		t.Error("name-level NXDOMAIN not used for another type")
	}
	// ...but not when it ends a CNAME chain: the name itself exists.
	chained := newEntry(result{qtype: dns.TypeA, rcode: dns.RcodeNameError,
		answer: []dns.RR{rr(t, "alias.test. 300 IN CNAME gone.test.")},
		ns:     []dns.RR{rr(t, "test. 300 IN SOA ns.test. h.test. 1 3600 600 86400 300")},
	}, now)
	c.store("alias.test.", dns.TypeA, chained)
	if c.lookup("alias.test.", dns.TypeCNAME, now) != nil {
		t.Error("NXDOMAIN of a chain used for another type")
	}
	// Local failures are never stored.
	c.store("local.test.", dns.TypeA, newEntry(servfail(dns.TypeA, failLocal), now))
	if c.lookup("local.test.", dns.TypeA, now) != nil {
		t.Error("local failure cached")
	}
	c.store("remote.test.", dns.TypeA, newEntry(servfail(dns.TypeA, failRemote), now))
	if e := c.lookup("remote.test.", dns.TypeA, now.Add(4*time.Second)); e == nil || e.rcode != dns.RcodeServerFailure {
		t.Error("remote failure not cached for 5 s")
	}
}

func TestAnswerCacheIsByteBounded(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	// Answers above 16 KiB are served but not cached.
	var big []dns.RR
	for i := range 80 {
		big = append(big, rr(t, fmt.Sprintf("big.test. 300 IN TXT \"%03d%s\"", i, strings.Repeat("x", 250))))
	}
	if e := newEntry(result{qtype: dns.TypeTXT, answer: big}, now); e.cacheable || e.size <= maxEntryBytes {
		t.Errorf("an answer of %d bytes is cacheable", e.size)
	}
	c := newAnswerCache(MinCacheBytes)
	var keep string
	for i := range 40000 {
		name := fmt.Sprintf("n%d.test.", i)
		txt := fmt.Sprintf("%s 300 IN TXT \"%s\"", name, strings.Repeat("y", 500))
		c.store(name, dns.TypeTXT, newEntry(result{qtype: dns.TypeTXT, answer: []dns.RR{rr(t, txt)}}, now))
		if i == 5 {
			keep = name
		}
		if i > 5 {
			// Using an entry keeps it in the LRU.
			_ = c.lookup(keep, dns.TypeTXT, now)
		}
	}
	if b := c.bytes.Load(); b > MinCacheBytes || b < MinCacheBytes/2 {
		t.Errorf("cache holds %d bytes, bound %d", b, MinCacheBytes)
	}
	if c.lookup(keep, dns.TypeTXT, now) == nil {
		t.Error("the recently used entry was evicted")
	}
	if c.lookup("n0.test.", dns.TypeTXT, now) != nil {
		t.Error("the least recently used entry survived")
	}
	var sum int64
	for i := range c.shards {
		sum += c.shards[i].bytes
	}
	if sum != c.bytes.Load() {
		t.Errorf("shard bytes %d != total %d", sum, c.bytes.Load())
	}
}

// TestAnswerCacheAccountsItsHeap fills caches with answers of common and of memory-hungry shapes
// (records unpacked from the wire, as lookups produce them) and compares the heap they hold with the
// bytes the cache counts: the count never falls below the heap, so cacheBytes bounds the memory.
func TestAnswerCacheAccountsItsHeap(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	many := func(n int, f func(i int) string) []string {
		out := make([]string, n)
		for i := range out {
			out[i] = f(i)
		}
		return out
	}
	bitmap := strings.Join(many(2000, func(i int) string { return fmt.Sprintf("TYPE%d", i+1) }), " ")
	oneByte := strings.Join(many(250, func(i int) string { return fmt.Sprintf("%q", string(rune('a'+i%26))) }), " ")
	apl := strings.Join(many(40, func(i int) string { return fmt.Sprintf("1:10.%d.0.0/16", i) }), " ")
	shapes := []struct {
		name   string
		qtype  uint16
		rcode  int
		answer func(q string) []string
		ns     []string
	}{
		{"A", dns.TypeA, 0, func(q string) []string { return []string{q + " 300 IN A 192.0.2.1"} }, nil},
		{"8 A", dns.TypeA, 0, func(q string) []string {
			return many(8, func(i int) string { return fmt.Sprintf("%s 300 IN A 192.0.2.%d", q, i+1) })
		}, nil},
		{"CNAME chain", dns.TypeA, 0, func(q string) []string {
			return []string{q + " 300 IN CNAME " + q[:len(q)-1] + ".edgekey.net.", q[:len(q)-1] + ".edgekey.net. 300 IN CNAME e1.a.akamaiedge.net.",
				"e1.a.akamaiedge.net. 20 IN A 23.1.2.3", "e1.a.akamaiedge.net. 20 IN A 23.1.2.4"}
		}, nil},
		{"4 AAAA", dns.TypeAAAA, 0, func(q string) []string {
			return many(4, func(i int) string { return fmt.Sprintf("%s 300 IN AAAA 2001:db8::%d", q, i+1) })
		}, nil},
		{"MX", dns.TypeMX, 0, func(q string) []string {
			return many(5, func(i int) string { return fmt.Sprintf("%s 300 IN MX %d mx%d.mail.example.test.", q, i, i) })
		}, nil},
		{"TXT", dns.TypeTXT, 0, func(q string) []string {
			return []string{q + ` 300 IN TXT "` + strings.Repeat("y", 200) + `" "` + strings.Repeat("z", 250) + `"`}
		}, nil},
		{"NXDOMAIN", dns.TypeA, dns.RcodeNameError, func(string) []string { return nil },
			[]string{"example.test. 300 IN SOA ns1.example.test. hostmaster.example.test. 1 3600 600 86400 300"}},
		{"NSEC of 2000 types", dns.TypeNSEC, 0, func(q string) []string { return []string{q + " 300 IN NSEC next.example.test. " + bitmap} }, nil},
		{"TXT of one-byte strings", dns.TypeTXT, 0, func(q string) []string { return []string{q + " 300 IN TXT " + oneByte} }, nil},
		{"APL", dns.TypeAPL, 0, func(q string) []string { return []string{q + " 300 IN APL " + apl} }, nil},
	}
	for _, sh := range shapes {
		t.Run(sh.name, func(t *testing.T) {
			const n = 3000
			const q = "q.example.test."
			m := new(dns.Msg)
			m.SetQuestion(q, sh.qtype)
			m.Rcode = sh.rcode
			for _, s := range sh.answer(q) {
				m.Answer = append(m.Answer, rr(t, s))
			}
			for _, s := range sh.ns {
				m.Ns = append(m.Ns, rr(t, s))
			}
			m.Compress = true
			wire, err := m.Pack()
			if err != nil {
				t.Fatal(err)
			}
			c := newAnswerCache(MaxCacheBytes)
			var before, after runtime.MemStats
			runtime.GC()
			runtime.ReadMemStats(&before)
			// Unpack every answer from the wire, as the engine's records are; what the messages do not
			// share with the cache is garbage when the heap is measured.
			msgs := make([]*dns.Msg, n)
			for i := range n {
				msgs[i] = new(dns.Msg)
				if err := msgs[i].Unpack(wire); err != nil {
					t.Fatal(err)
				}
			}
			for i, m := range msgs {
				e := newEntry(result{qtype: sh.qtype, rcode: m.Rcode, answer: m.Answer, ns: m.Ns}, now)
				c.store(strings.ToLower(fmt.Sprintf("Q%d.example.test.", i)), sh.qtype, e)
			}
			clear(msgs) // the messages are garbage now; only what the cache shares with them stays
			runtime.GC()
			runtime.ReadMemStats(&after)
			heap := float64(after.HeapAlloc) - float64(before.HeapAlloc)
			counted := float64(c.bytes.Load())
			t.Logf("heap %.0f, counted %.0f bytes per answer (%.2f)", heap/n, counted/n, heap/counted)
			if heap > counted {
				t.Errorf("the cache holds %.0f bytes of heap per answer but counts %.0f", heap/n, counted/n)
			}
			if c.entries.Load() < n {
				t.Fatalf("%d entries cached", c.entries.Load())
			}
			runtime.KeepAlive(c)
		})
	}
}
