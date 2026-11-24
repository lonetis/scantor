package resolver

import (
	"fmt"
	"net"
	"strings"

	"github.com/zmap/dns"
)

// BuiltinLocalDomains are the suffixes the resolver always resolves through the host nameservers, in
// every mode: names that only the host's own DNS knows (localhost subdomains, internal, home.arpa)
// and the reverse zones of private and link-local addresses (RFC 6303), whose public delegations
// answer nothing useful.
var BuiltinLocalDomains = []string{
	"localhost", "internal", "home.arpa",
	"10.in-addr.arpa",
	"16.172.in-addr.arpa", "17.172.in-addr.arpa", "18.172.in-addr.arpa", "19.172.in-addr.arpa",
	"20.172.in-addr.arpa", "21.172.in-addr.arpa", "22.172.in-addr.arpa", "23.172.in-addr.arpa",
	"24.172.in-addr.arpa", "25.172.in-addr.arpa", "26.172.in-addr.arpa", "27.172.in-addr.arpa",
	"28.172.in-addr.arpa", "29.172.in-addr.arpa", "30.172.in-addr.arpa", "31.172.in-addr.arpa",
	"168.192.in-addr.arpa", "254.169.in-addr.arpa",
	"d.f.ip6.arpa", "8.e.f.ip6.arpa", "9.e.f.ip6.arpa", "a.e.f.ip6.arpa", "b.e.f.ip6.arpa",
}

var builtinLocalFQDNs = func() []string {
	out := make([]string, len(BuiltinLocalDomains))
	for i, d := range BuiltinLocalDomains {
		out[i] = dns.Fqdn(d)
	}
	return out
}()

// route is where a question goes.
type route int

const (
	// routeAnswer: answered by the resolver itself (special names).
	routeAnswer route = iota + 1
	// routeLocal: the host nameservers.
	routeLocal
	// routeRecursive and routeIterative: the mode's engine.
	routeRecursive
	routeIterative
)

func (r route) String() string {
	switch r {
	case routeAnswer:
		return "answer"
	case routeLocal:
		return "local"
	case routeRecursive:
		return "recursive"
	case routeIterative:
		return "iterative"
	}
	return "unknown"
}

// localTTL is the TTL of the answers for localhost.
const localTTL = 3600

// router decides the route of a question (docs/nodes.md §6.11), in this order: the probe name, the
// never-forwarded special domains invalid. and onion., the exact name localhost., the master's
// endpoint hosts (exact), the built-in and configured local domains (suffix), then the mode's
// engine.
type router struct {
	nodeID       string
	spec         string
	mode         string
	localNames   map[string]bool
	localDomains []string
}

// special is a locally built answer.
type special struct {
	rcode  int
	answer []dns.RR
}

// route returns the route of the question (name is lowercase and fully qualified) and, for
// routeAnswer, the answer.
func (r *router) route(name string, qtype uint16) (route, *special) {
	switch {
	case name == ProbeName:
		if qtype != dns.TypeTXT {
			return routeAnswer, &special{rcode: dns.RcodeSuccess}
		}
		return routeAnswer, &special{rcode: dns.RcodeSuccess, answer: []dns.RR{&dns.TXT{
			Hdr: dns.RR_Header{Name: ProbeName, Rrtype: dns.TypeTXT, Class: dns.ClassINET},
			Txt: []string{ProbeAnswer(r.nodeID, r.spec)},
		}}}
	case inDomain(name, "invalid."), inDomain(name, "onion."):
		return routeAnswer, &special{rcode: dns.RcodeNameError}
	case name == "localhost.":
		hdr := dns.RR_Header{Name: name, Rrtype: qtype, Class: dns.ClassINET, Ttl: localTTL}
		switch qtype {
		case dns.TypeA:
			return routeAnswer, &special{rcode: dns.RcodeSuccess, answer: []dns.RR{&dns.A{Hdr: hdr, A: net.IPv4(127, 0, 0, 1).To4()}}}
		case dns.TypeAAAA:
			return routeAnswer, &special{rcode: dns.RcodeSuccess, answer: []dns.RR{&dns.AAAA{Hdr: hdr, AAAA: net.IPv6loopback}}}
		}
		return routeAnswer, &special{rcode: dns.RcodeSuccess}
	case r.localNames[name]:
		return routeLocal, nil
	}
	for _, d := range r.localDomains {
		if inDomain(name, d) {
			return routeLocal, nil
		}
	}
	return r.modeRoute(), nil
}

// modeRoute is the route of the mode's engine: every name that is not special or local, and local
// names while no host nameserver is usable.
func (r *router) modeRoute() route {
	if r.mode == ModeIterative {
		return routeIterative
	}
	return routeRecursive
}

// ProbeAnswer is the TXT string the resolver answers for ProbeName.
func ProbeAnswer(nodeID, spec string) string {
	return fmt.Sprintf("%s node=%s spec=%s", ProbeAnswerPrefix, nodeID, spec)
}

// inDomain reports whether name (lowercase FQDN) is domain or below it, on a label boundary.
func inDomain(name, domain string) bool {
	return name == domain || strings.HasSuffix(name, "."+domain)
}
