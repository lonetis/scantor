package resolver

import (
	"testing"

	"github.com/zmap/dns"
)

func TestRouterPrecedence(t *testing.T) {
	cfg := testConfig(ModeRecursive, "127.0.0.1:53")
	cfg.Upstreams = []string{"198.51.100.53:53"}
	cfg.LocalNames = []string{"scantor.localhost", "amqp.scantor.example.com"}
	cfg.LocalDomains = []string{"corp.example", "invalid"}
	s, err := cfg.compile()
	if err != nil {
		t.Fatal(err)
	}
	r := &router{nodeID: testNodeID, spec: testSpec, mode: s.mode, localNames: s.localNames, localDomains: s.localDomains}
	cases := []struct {
		name  string
		qtype uint16
		want  route
		rcode int
		n     int // answer records of routeAnswer
	}{
		{ProbeName, dns.TypeTXT, routeAnswer, dns.RcodeSuccess, 1},
		{ProbeName, dns.TypeA, routeAnswer, dns.RcodeSuccess, 0},
		{"other.scantor.invalid.", dns.TypeTXT, routeAnswer, dns.RcodeNameError, 0},
		{"invalid.", dns.TypeA, routeAnswer, dns.RcodeNameError, 0},
		// localDomains cannot route invalid. or onion. away from NXDOMAIN.
		{"x.invalid.", dns.TypeA, routeAnswer, dns.RcodeNameError, 0},
		{"abc.onion.", dns.TypeA, routeAnswer, dns.RcodeNameError, 0},
		{"localhost.", dns.TypeA, routeAnswer, dns.RcodeSuccess, 1},
		{"localhost.", dns.TypeAAAA, routeAnswer, dns.RcodeSuccess, 1},
		{"localhost.", dns.TypeMX, routeAnswer, dns.RcodeSuccess, 0},
		// Below localhost. nothing is answered locally: the master's hosts of the test stack live there.
		{"scantor.localhost.", dns.TypeA, routeLocal, 0, 0},
		{"fixtures.scantor.localhost.", dns.TypeA, routeLocal, 0, 0},
		{"amqp.scantor.example.com.", dns.TypeA, routeLocal, 0, 0},
		// localNames match exactly; their parents and siblings use the engine.
		{"scantor.example.com.", dns.TypeA, routeRecursive, 0, 0},
		{"x.amqp.scantor.example.com.", dns.TypeA, routeRecursive, 0, 0},
		{"host.docker.internal.", dns.TypeA, routeLocal, 0, 0},
		{"printer.home.arpa.", dns.TypeA, routeLocal, 0, 0},
		{"4.3.2.10.in-addr.arpa.", dns.TypePTR, routeLocal, 0, 0},
		{"1.0.17.172.in-addr.arpa.", dns.TypePTR, routeLocal, 0, 0},
		{"1.0.32.172.in-addr.arpa.", dns.TypePTR, routeRecursive, 0, 0},
		{"1.0.168.192.in-addr.arpa.", dns.TypePTR, routeLocal, 0, 0},
		{"8.e.f.ip6.arpa.", dns.TypePTR, routeLocal, 0, 0},
		{"a.d.f.ip6.arpa.", dns.TypePTR, routeLocal, 0, 0},
		{"host.corp.example.", dns.TypeA, routeLocal, 0, 0},
		{"corp.example.", dns.TypeA, routeLocal, 0, 0},
		// Label boundary: notcorp.example is not below corp.example.
		{"notcorp.example.", dns.TypeA, routeRecursive, 0, 0},
		{"www.example.com.", dns.TypeA, routeRecursive, 0, 0},
	}
	for _, tc := range cases {
		got, sp := r.route(tc.name, tc.qtype)
		if got != tc.want {
			t.Errorf("route(%s %s) = %v, want %v", tc.name, dns.TypeToString[tc.qtype], got, tc.want)
			continue
		}
		if got != routeAnswer {
			continue
		}
		if sp.rcode != tc.rcode || len(sp.answer) != tc.n {
			t.Errorf("answer(%s %s) = %s with %d records", tc.name, dns.TypeToString[tc.qtype], dns.RcodeToString[sp.rcode], len(sp.answer))
		}
	}
	_, sp := r.route(ProbeName, dns.TypeTXT)
	if txt := sp.answer[0].(*dns.TXT).Txt; len(txt) != 1 || txt[0] != "scantor-resolver node="+testNodeID+" spec="+testSpec {
		t.Errorf("probe answer = %q", txt)
	}
	r.mode = ModeIterative
	if got, _ := r.route("www.example.com.", dns.TypeA); got != routeIterative {
		t.Errorf("iterative mode route = %v", got)
	}
}
