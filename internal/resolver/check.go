package resolver

import (
	"context"
	"math/rand/v2"
	"net/netip"

	"github.com/zmap/dns"
	"github.com/zmap/zdns/v2/src/zdns"

	"github.com/lonetis/scantor/internal/api"
)

// Self-checks (docs/nodes.md §6.11). The upstream check asks the servers the mode resolves through
// for ". NS": the Docker healthcheck fails while it fails, so a resolver whose servers do not answer
// never replaces a working one and workers keep Docker's DNS. The IPv6 check decides whether the
// mode's IPv6 servers are used at all: a route to them does not prove that IPv6 traffic gets through.

// rootQuestion is the question of both checks.
var rootQuestion = question{name: ".", qtype: dns.TypeNS}

const (
	upstreamCheckServers = 3
	ipv6CheckServers     = 2
)

// modeServers returns the servers the mode resolves through and the route of their queries:
// the upstream servers (with the host nameservers when configured), or the root servers.
func (e *engine) modeServers() ([]netip.AddrPort, route) {
	if e.mode == ModeIterative {
		if len(e.roots) > 0 {
			return e.roots, routeIterative
		}
		var roots []netip.AddrPort
		for _, ns := range zdns.RootServersV4 {
			roots = append(roots, addrPortOf(ns))
		}
		for _, ns := range zdns.RootServersV6 {
			roots = append(roots, addrPortOf(ns))
		}
		return roots, routeIterative
	}
	servers := e.upstreams
	if e.useHost {
		servers = append(append([]netip.AddrPort(nil), servers...), e.hostNS()...)
	}
	return servers, routeRecursive
}

// upstreamCheck asks up to three of the mode's servers (IPv6 ones only while IPv6 works) for ". NS"
// at once: recursion desired for upstream servers, not for root servers. One NOERROR reply passes;
// otherwise it returns the error code.
func (e *engine) upstreamCheck(ctx context.Context, ipv6 bool) (bool, string) {
	servers, rt := e.modeServers()
	usable := make([]netip.AddrPort, 0, len(servers))
	for _, ap := range servers {
		if ap.Addr().Is4() || ipv6 {
			usable = append(usable, ap)
		}
	}
	ok := e.askAny(ctx, rt, pick(usable, upstreamCheckServers), func(m *dns.Msg) bool { return m.Rcode == dns.RcodeSuccess })
	if !ok {
		return false, api.ResolverErrUpstreamUnreachable
	}
	return true, ""
}

// ipv6Check asks up to two of the mode's IPv6 servers for ". NS"; any reply passes. Without IPv6
// servers it fails (IPv6 stays unused).
func (e *engine) ipv6Check(ctx context.Context) bool {
	servers, rt := e.modeServers()
	var v6 []netip.AddrPort
	for _, ap := range servers {
		if ap.Addr().Is6() {
			v6 = append(v6, ap)
		}
	}
	return e.askAny(ctx, rt, pick(v6, ipv6CheckServers), func(*dns.Msg) bool { return true })
}

// askAny sends rootQuestion to every server at once and reports whether one reply passes ok. The
// checks pass the server guard like every query, but no rate limit.
func (e *engine) askAny(ctx context.Context, rt route, servers []netip.AddrPort, ok func(*dns.Msg) bool) bool {
	if len(servers) == 0 {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, e.t.checkTimeout)
	defer cancel()
	ctx = withState(ctx, &lookupState{route: rt, selfCheck: true})
	results := make(chan bool, len(servers))
	for _, ap := range servers {
		go func() {
			m, err := e.exchange(ctx, ap, rootQuestion, rt != routeIterative)
			results <- err == nil && ok(m)
		}()
	}
	for range servers {
		if <-results {
			return true
		}
	}
	return false
}

// pick returns up to n distinct servers in random order.
func pick(servers []netip.AddrPort, n int) []netip.AddrPort {
	out := append([]netip.AddrPort(nil), servers...)
	rand.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] }) //nolint:gosec // a server choice needs no cryptographic randomness
	return out[:min(n, len(out))]
}
