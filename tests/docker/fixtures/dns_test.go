package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/zmap/dns"
)

// syncBuffer is a log sink the server's handler goroutines and the test share.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type testDNS struct {
	udp, tcp string
	log      *syncBuffer
}

// startTestDNS serves a zone on loopback sockets of free ports and stops it at the end of the test.
func startTestDNS(t *testing.T, origin string, lines []string) testDNS {
	t.Helper()
	z, err := newZone(origin, lines)
	if err != nil {
		t.Fatalf("newZone: %v", err)
	}
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen udp: %v", err)
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = pc.Close()
		t.Fatalf("listen tcp: %v", err)
	}
	out := &syncBuffer{}
	handler := &dnsHandler{zone: z, log: slog.New(slog.NewJSONHandler(out, nil))}
	servers := serveDNS(handler, pc, l)
	if err := servers.waitStarted(10 * time.Second); err != nil {
		t.Fatalf("the servers did not start: %v", err)
	}
	t.Cleanup(func() {
		if err := servers.shutdown(); err != nil {
			t.Errorf("shutdown: %v", err)
		}
	})
	return testDNS{udp: pc.LocalAddr().String(), tcp: l.Addr().String(), log: out}
}

func exchange(t *testing.T, network, addr string, m *dns.Msg) *dns.Msg {
	t.Helper()
	c := &dns.Client{Net: network, Timeout: 5 * time.Second}
	r, _, err := c.Exchange(m, addr)
	if err != nil {
		t.Fatalf("exchange %s %s: %v", network, addr, err)
	}
	return r
}

func query(name string, qtype uint16) *dns.Msg {
	m := new(dns.Msg)
	m.SetQuestion(name, qtype)
	return m
}

// rrStrings renders records without their TTLs for comparison.
func rrStrings(rrs []dns.RR) []string {
	out := make([]string, 0, len(rrs))
	for _, rr := range rrs {
		fields := strings.Fields(rr.String())
		out = append(out, strings.Join(append(fields[:1:1], fields[2:]...), " "))
	}
	return out
}

func TestFixturesDNSAnswersFromTheZone(t *testing.T) {
	srv := startTestDNS(t, ".", fixturesZone)
	soa := ". IN SOA ns.scantor.test. hostmaster.scantor.test. 1 3600 600 86400 30"
	tests := []struct {
		name      string
		qname     string
		qtype     uint16
		rcode     int
		answer    []string
		authority []string
	}{
		{name: "address", qname: "a.scantor.test.", qtype: dns.TypeA, rcode: dns.RcodeSuccess, answer: []string{"a.scantor.test. IN A 192.0.2.10"}},
		{name: "case-insensitive", qname: "A.Scantor.TEST.", qtype: dns.TypeA, rcode: dns.RcodeSuccess, answer: []string{"a.scantor.test. IN A 192.0.2.10"}},
		{name: "text", qname: "a.scantor.test.", qtype: dns.TypeTXT, rcode: dns.RcodeSuccess, answer: []string{`a.scantor.test. IN TXT "scantor fixtures"`}},
		{
			name:  "cname followed inside the zone",
			qname: "www.scantor.test.", qtype: dns.TypeA, rcode: dns.RcodeSuccess,
			answer: []string{"www.scantor.test. IN CNAME a.scantor.test.", "a.scantor.test. IN A 192.0.2.10"},
		},
		{
			name:  "chain of two cnames",
			qname: "alias.scantor.test.", qtype: dns.TypeA, rcode: dns.RcodeSuccess,
			answer: []string{"alias.scantor.test. IN CNAME www.scantor.test.", "www.scantor.test. IN CNAME a.scantor.test.", "a.scantor.test. IN A 192.0.2.10"},
		},
		{name: "cname itself", qname: "www.scantor.test.", qtype: dns.TypeCNAME, rcode: dns.RcodeSuccess, answer: []string{"www.scantor.test. IN CNAME a.scantor.test."}},
		{
			name:  "nodata at the end of a chain",
			qname: "www.scantor.test.", qtype: dns.TypeAAAA, rcode: dns.RcodeSuccess,
			answer: []string{"www.scantor.test. IN CNAME a.scantor.test."}, authority: []string{soa},
		},
		{name: "nodata", qname: "v6.scantor.test.", qtype: dns.TypeA, rcode: dns.RcodeSuccess, authority: []string{soa}},
		{name: "aaaa", qname: "v6.scantor.test.", qtype: dns.TypeAAAA, rcode: dns.RcodeSuccess, answer: []string{"v6.scantor.test. IN AAAA 2001:db8::10"}},
		{
			name:  "any",
			qname: "dual.scantor.test.", qtype: dns.TypeANY, rcode: dns.RcodeSuccess,
			answer: []string{"dual.scantor.test. IN A 192.0.2.11", "dual.scantor.test. IN AAAA 2001:db8::11"},
		},
		{name: "empty non-terminal", qname: "scantor.test.", qtype: dns.TypeA, rcode: dns.RcodeSuccess, authority: []string{soa}},
		{name: "nxdomain", qname: "missing.scantor.test.", qtype: dns.TypeA, rcode: dns.RcodeNameError, authority: []string{soa}},
		{name: "nxdomain elsewhere", qname: "site1.example.", qtype: dns.TypeA, rcode: dns.RcodeNameError, authority: []string{soa}},
		{name: "apex name servers", qname: ".", qtype: dns.TypeNS, rcode: dns.RcodeSuccess, answer: []string{". IN NS ns.scantor.test."}},
	}
	for _, tc := range tests {
		for _, network := range []string{"udp", "tcp"} {
			t.Run(tc.name+" over "+network, func(t *testing.T) {
				addr := srv.udp
				if network == "tcp" {
					addr = srv.tcp
				}
				r := exchange(t, network, addr, query(tc.qname, tc.qtype))
				if r.Rcode != tc.rcode {
					t.Fatalf("rcode %s, want %s", dns.RcodeToString[r.Rcode], dns.RcodeToString[tc.rcode])
				}
				if !r.Authoritative || r.RecursionAvailable || r.Truncated {
					t.Errorf("flags aa=%t ra=%t tc=%t, want an authoritative, untruncated answer without recursion", r.Authoritative, r.RecursionAvailable, r.Truncated)
				}
				if got := rrStrings(r.Answer); strings.Join(got, "\n") != strings.Join(tc.answer, "\n") {
					t.Errorf("answer\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(tc.answer, "\n"))
				}
				if got := rrStrings(r.Ns); strings.Join(got, "\n") != strings.Join(tc.authority, "\n") {
					t.Errorf("authority\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(tc.authority, "\n"))
				}
				for _, rr := range r.Ns {
					if soa, ok := rr.(*dns.SOA); ok && soa.Hdr.Ttl != 30 {
						t.Errorf("negative SOA TTL %d, want the negative TTL 30", soa.Hdr.Ttl)
					}
				}
				if len(r.Extra) != 0 {
					t.Errorf("additional section %v, want none (no EDNS in the query)", r.Extra)
				}
			})
		}
	}
}

func TestFixturesDNSRefusesWhatItDoesNotServe(t *testing.T) {
	srv := startTestDNS(t, ".", fixturesZone)

	chaos := query("a.scantor.test.", dns.TypeTXT)
	chaos.Question[0].Qclass = dns.ClassCHAOS
	transfer := query(".", dns.TypeAXFR)
	notify := query("scantor.test.", dns.TypeSOA)
	notify.Opcode = dns.OpcodeNotify
	tests := []struct {
		name  string
		msg   *dns.Msg
		rcode int
	}{
		{name: "another class", msg: chaos, rcode: dns.RcodeRefused},
		{name: "zone transfer", msg: transfer, rcode: dns.RcodeRefused},
		{name: "another opcode", msg: notify, rcode: dns.RcodeNotImplemented},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := exchange(t, "tcp", srv.tcp, tc.msg)
			if r.Rcode != tc.rcode {
				t.Fatalf("rcode %s, want %s", dns.RcodeToString[r.Rcode], dns.RcodeToString[tc.rcode])
			}
			if r.Authoritative || len(r.Answer) != 0 {
				t.Errorf("a refusal must carry no authoritative answer: %v", r)
			}
		})
	}
}

func TestFixturesDNSEDNS(t *testing.T) {
	srv := startTestDNS(t, ".", fixturesZone)

	m := query("a.scantor.test.", dns.TypeA)
	m.SetEdns0(4096, false)
	r := exchange(t, "udp", srv.udp, m)
	opt := r.IsEdns0()
	if opt == nil || opt.UDPSize() != dnsUDPSize || opt.Do() {
		t.Fatalf("OPT %v, want UDP size %d without DO", opt, dnsUDPSize)
	}
	if len(r.Answer) != 1 {
		t.Errorf("answer %v, want the address", r.Answer)
	}

	future := query("a.scantor.test.", dns.TypeA)
	future.SetEdns0(1232, false)
	future.IsEdns0().SetVersion(1)
	r = exchange(t, "udp", srv.udp, future)
	if r.Rcode != dns.RcodeBadVers || r.IsEdns0() == nil || len(r.Answer) != 0 {
		t.Errorf("rcode %d with OPT %v and %d answers, want BADVERS with an OPT and no answer", r.Rcode, r.IsEdns0(), len(r.Answer))
	}
}

func TestFixturesDNSTruncatesLargeUDPAnswers(t *testing.T) {
	lines := []string{". 300 IN SOA ns.big.test. hostmaster.big.test. 1 3600 600 86400 30"}
	for i := range 40 {
		lines = append(lines, fmt.Sprintf(`big.test. 300 IN TXT "record %02d %s"`, i, strings.Repeat("x", 40)))
	}
	srv := startTestDNS(t, ".", lines)

	udp := exchange(t, "udp", srv.udp, query("big.test.", dns.TypeTXT))
	if !udp.Truncated || len(udp.Answer) >= 40 {
		t.Errorf("udp answer with %d records and tc=%t, want a truncated answer that fits %d bytes", len(udp.Answer), udp.Truncated, dns.MinMsgSize)
	}
	tcp := exchange(t, "tcp", srv.tcp, query("big.test.", dns.TypeTXT))
	if tcp.Truncated || len(tcp.Answer) != 40 {
		t.Errorf("tcp answer with %d records and tc=%t, want all 40", len(tcp.Answer), tcp.Truncated)
	}
}

func TestFixturesDNSLogsEveryQuery(t *testing.T) {
	srv := startTestDNS(t, ".", fixturesZone)
	exchange(t, "udp", srv.udp, query("Missing.scantor.test.", dns.TypeAAAA))

	var entry struct {
		Msg     string `json:"msg"`
		Proto   string `json:"proto"`
		Remote  string `json:"remote"`
		Name    string `json:"name"`
		Type    string `json:"type"`
		Rcode   string `json:"rcode"`
		Answers *int   `json:"answers"`
	}
	// The handler logs after it wrote the reply, so the line can follow the answer by a moment.
	line := ""
	for deadline := time.Now().Add(5 * time.Second); line == "" && time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		line = strings.TrimSpace(srv.log.String())
	}
	if err := json.Unmarshal([]byte(line), &entry); err != nil {
		t.Fatalf("the query log is not one JSON line: %v\n%s", err, line)
	}
	if entry.Msg != "dns query" || entry.Proto != "udp" || entry.Name != "missing.scantor.test." || entry.Type != "AAAA" || entry.Rcode != "NXDOMAIN" {
		t.Errorf("unexpected query log entry %+v", entry)
	}
	if entry.Answers == nil || *entry.Answers != 0 || !strings.HasPrefix(entry.Remote, "127.0.0.1:") {
		t.Errorf("unexpected answers or remote in %s", line)
	}
}

func TestNewZoneRejectsBrokenZones(t *testing.T) {
	tests := []struct {
		name  string
		lines []string
		want  string
	}{
		{name: "no SOA", lines: []string{"a.test. 60 IN A 192.0.2.1"}, want: "no SOA"},
		{name: "two SOAs", lines: []string{". 60 IN SOA a. b. 1 1 1 1 1", ". 60 IN SOA a. b. 2 1 1 1 1"}, want: "exactly one SOA"},
		{name: "SOA below the origin", lines: []string{"x.test. 60 IN SOA a. b. 1 1 1 1 1"}, want: "exactly one SOA"},
		{name: "outside the origin", lines: []string{"test. 60 IN SOA a. b. 1 1 1 1 1", "other. 60 IN A 192.0.2.1"}, want: "outside the zone"},
		{name: "cname with other data", lines: []string{". 60 IN SOA a. b. 1 1 1 1 1", "x. 60 IN CNAME y.", "x. 60 IN A 192.0.2.1"}, want: "other records"},
		{name: "unparsable", lines: []string{". 60 IN SOA a. b. 1 1 1 1 1", "x. 60 IN A not-an-address"}, want: "zone record"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			origin := "."
			if strings.HasPrefix(tc.lines[0], "test.") {
				origin = "test."
			}
			if _, err := newZone(origin, tc.lines); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("newZone error %v, want one containing %q", err, tc.want)
			}
		})
	}
}
