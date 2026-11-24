package resolver

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/time/rate"
)

// alwaysRefused are the ranges the resolver never sends a query to unless the address is a trusted
// server configured for the route of the lookup or a host nameserver (docs/nodes.md §6.11): private,
// loopback, link-local, shared, benchmark, multicast and reserved space and the NAT64 prefixes. A
// hostile delegation (glue 169.254.169.254, 10.x, 127.0.0.53, the node's own address) is therefore
// never dialled.
var alwaysRefused = func() []netip.Prefix {
	var out []netip.Prefix
	for _, p := range []string{
		"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
		"192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4",
		"::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8", "64:ff9b::/96", "64:ff9b:1::/48",
	} {
		out = append(out, netip.MustParsePrefix(p))
	}
	return out
}()

// AlwaysRefused reports whether addr lies in the ranges the resolver refuses as a server unless it is
// configured for the lookup's route and listed in Config.TrustedServers. The daemon and the
// orchestrator reject daemon-override servers in these ranges (only the node environment can
// configure them).
func AlwaysRefused(addr netip.Addr) bool { return inPrefixes(addr.Unmap(), alwaysRefused) }

func inPrefixes(a netip.Addr, ps []netip.Prefix) bool {
	for _, p := range ps {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// guard decides per route which servers a lookup may query.
type guard struct {
	deny      []netip.Prefix
	trusted   map[netip.AddrPort]bool
	upstreams map[netip.AddrPort]bool
	roots     map[netip.AddrPort]bool
	useHost   bool
	host      atomic.Pointer[map[netip.AddrPort]bool] // the current host nameservers
	own       atomic.Pointer[[]netip.Addr]            // the node's interface addresses
}

func newGuard(s *settings) *guard {
	g := &guard{
		deny:      s.deny,
		trusted:   s.trusted,
		upstreams: make(map[netip.AddrPort]bool, len(s.upstreams)),
		roots:     make(map[netip.AddrPort]bool, len(s.roots)),
		useHost:   s.useHost,
	}
	for _, ap := range s.upstreams {
		g.upstreams[ap] = true
	}
	for _, ap := range s.roots {
		g.roots[ap] = true
	}
	g.setHost(nil)
	g.setOwn(nil)
	return g
}

func (g *guard) setHost(servers []netip.AddrPort) {
	m := make(map[netip.AddrPort]bool, len(servers))
	for _, ap := range servers {
		m[ap] = true
	}
	g.host.Store(&m)
}

func (g *guard) setOwn(addrs []netip.Addr) { g.own.Store(&addrs) }

// allow reports whether a lookup of route rt may query ap (docs/nodes.md §6.11). The host nameservers,
// which the node operator configures, are always allowed on the routes that use them: the local route,
// and the recursive route with useHostNameservers. Any other server outside the refused ranges, the
// deny list and the node's own addresses is allowed on every route, whether configured or discovered
// (glue). Inside them, only a server configured for the route (an upstream server, or a root server of
// the iterative route at any layer) that the daemon listed as trusted is allowed: the environment's
// servers are trusted, a daemon override's never are.
func (g *guard) allow(rt route, ap netip.AddrPort) bool {
	a := ap.Addr().Unmap()
	ap = netip.AddrPortFrom(a, ap.Port())
	if (rt == routeLocal || (rt == routeRecursive && g.useHost)) && (*g.host.Load())[ap] {
		return true
	}
	if !inPrefixes(a, g.deny) && !g.isOwn(a) && !inPrefixes(a, alwaysRefused) {
		return true
	}
	switch rt {
	case routeRecursive:
		return g.upstreams[ap] && g.trusted[ap]
	case routeIterative:
		return g.roots[ap] && g.trusted[ap]
	}
	return false
}

// isOwn reports whether a is one of the node's interface addresses.
func (g *guard) isOwn(a netip.Addr) bool {
	for _, o := range *g.own.Load() {
		if o == a {
			return true
		}
	}
	return false
}

// limiter enforces the per-server query rates: UpstreamQPS for the upstream servers and host
// nameservers (local and recursive routes) and AuthoritativeQPS for every server of the iterative
// route. A query waits up to maxWait for a token and is refused after that.
type limiter struct {
	upstreamQPS, authoritativeQPS int
	maxWait                       time.Duration

	mu sync.Mutex
	m  map[limitKey]*limitEntry
}

type limitKey struct {
	authoritative bool
	addr          netip.Addr
}

type limitEntry struct {
	lim  *rate.Limiter
	last time.Time
}

func newLimiter(upstreamQPS, authoritativeQPS int, maxWait time.Duration) *limiter {
	return &limiter{upstreamQPS: upstreamQPS, authoritativeQPS: authoritativeQPS, maxWait: maxWait, m: make(map[limitKey]*limitEntry)}
}

// wait takes a token for one query to addr, waiting at most maxWait; false refuses the query.
func (l *limiter) wait(ctx context.Context, rt route, addr netip.Addr) bool {
	qps := l.upstreamQPS
	if rt == routeIterative {
		qps = l.authoritativeQPS
	}
	if qps <= 0 {
		return true
	}
	key := limitKey{authoritative: rt == routeIterative, addr: addr}
	now := time.Now()
	l.mu.Lock()
	e := l.m[key]
	if e == nil {
		e = &limitEntry{lim: rate.NewLimiter(rate.Limit(qps), max(1, qps/5))}
		l.m[key] = e
	}
	e.last = now
	r := e.lim.ReserveN(now, 1)
	l.mu.Unlock()
	if !r.OK() {
		return false
	}
	d := r.DelayFrom(now)
	if d == 0 {
		return true
	}
	if d > l.maxWait {
		r.CancelAt(now)
		return false
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		r.Cancel()
		return false
	}
}

// sweep forgets limiters idle for longer than idle (a full bucket equals a new one).
func (l *limiter) sweep(now time.Time, idle time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for k, e := range l.m {
		if now.Sub(e.last) > idle {
			delete(l.m, k)
		}
	}
}

// maxLookupQueries is the query budget of one client lookup: every query its attempts and hops send
// or try to send (the ones the guard or a rate limit refuses included), as unbound and BIND bound the
// queries of one recursion. A lookup that needs more ends with SERVFAIL (never cached), so one
// question cannot make the resolver send queries without end (NXNS-style amplification).
const maxLookupQueries = 64

// queryBudget is the query budget of one client lookup, shared by its attempts and hops.
type queryBudget struct {
	left  atomic.Int32
	spent atomic.Bool
	// cancel ends the lookup's context once the budget is spent: zdns gives up at once instead of
	// trying the remaining servers of every delegation it holds.
	cancel context.CancelFunc
}

func newQueryBudget(queries int, cancel context.CancelFunc) *queryBudget {
	b := &queryBudget{cancel: cancel}
	b.left.Store(int32(queries)) //nolint:gosec // a small constant
	return b
}

// take spends one query; false when none is left, which also ends the lookup. A nil budget (the
// self-checks) is unlimited.
func (b *queryBudget) take() bool {
	if b == nil {
		return true
	}
	if b.left.Add(-1) >= 0 {
		return true
	}
	if !b.spent.Swap(true) {
		b.cancel()
	}
	return false
}

// exhausted reports whether the lookup ran out of queries.
func (b *queryBudget) exhausted() bool { return b != nil && b.spent.Load() }

// lookupState travels with the context of a lookup to the dialer: the route that decides which
// servers the guard allows, the recorder of the attempt and the lookup's query budget.
type lookupState struct {
	route  route
	rec    *recorder
	budget *queryBudget
	// selfCheck marks the queries of the upstream and IPv6 checks: they skip the per-server rate
	// limits, which client lookups may hold at their maximum wait, so load never fails the checks.
	selfCheck bool
}

type stateKey struct{}

func withState(ctx context.Context, st *lookupState) context.Context {
	return context.WithValue(ctx, stateKey{}, st)
}

func stateOf(ctx context.Context) *lookupState {
	st, _ := ctx.Value(stateKey{}).(*lookupState)
	return st
}

var (
	errNoRoute     = errors.New("no lookup route on the dial context")
	errRefused     = errors.New("server refused by the resolver's server guard")
	errRateLimited = errors.New("server rate limit exceeded")
	errBudget      = errors.New("the lookup's query budget is spent")
)

// dialer is the zdns Dialer of the resolver: it counts, guards, rate-limits and captures every
// connection zdns opens (ResolverConfig.ShouldRecycleSockets is false, so every query dials). zdns
// sees a refused dial as a failed query: its server health tracker counts it, so while a server is
// throttled zdns prefers the route's other servers.
type dialer struct {
	guard   *guard
	limits  *limiter
	timeout time.Duration
	stats   *counters
	// rewrite maps the address of a dial (unit tests: fake servers on loopback ports); nil in
	// production. The guard and the rate limit see the original address.
	rewrite func(network, address string) string
}

// outOfResources reports whether a dial failed for lack of file descriptors or kernel memory: a local
// cause, never the server's.
func outOfResources(err error) bool {
	return errors.Is(err, syscall.EMFILE) || errors.Is(err, syscall.ENFILE) || errors.Is(err, syscall.ENOBUFS) ||
		errors.Is(err, syscall.ENOMEM)
}

// DialContext implements zdns.Dialer. The local address zdns picks is not bound: the kernel chooses
// the same source address from the route that zdns derived it from.
func (d *dialer) DialContext(ctx context.Context, network string, _ net.IP, address string) (net.Conn, error) {
	st := stateOf(ctx)
	if st == nil {
		return nil, errNoRoute
	}
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", address, err)
	}
	ap = netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port())
	if !st.budget.take() {
		st.rec.dialed(ap, dialBudget)
		return nil, fmt.Errorf("dial %s: %w", address, errBudget)
	}
	if !d.guard.allow(st.route, ap) {
		st.rec.dialed(ap, dialRefused)
		return nil, fmt.Errorf("dial %s: %w", address, errRefused)
	}
	if !st.selfCheck && !d.limits.wait(ctx, st.route, ap.Addr()) {
		d.stats.rateLimited.Add(1)
		st.rec.dialed(ap, dialRateLimited)
		return nil, fmt.Errorf("dial %s: %w", address, errRateLimited)
	}
	target := address
	if d.rewrite != nil {
		target = d.rewrite(network, address)
	}
	nd := net.Dialer{Timeout: d.timeout}
	c, err := nd.DialContext(ctx, network, target)
	if err != nil {
		cause := dialFailed
		if outOfResources(err) {
			cause = dialNoResources
		}
		st.rec.dialed(ap, cause)
		return nil, err
	}
	st.rec.dialed(ap, dialOK)
	if st.rec == nil {
		return c, nil
	}
	if u, ok := c.(*net.UDPConn); ok {
		return &udpCapture{UDPConn: u, rec: st.rec}, nil
	}
	return &tcpCapture{Conn: c, rec: st.rec}, nil
}
