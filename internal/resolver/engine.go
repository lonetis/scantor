package resolver

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/netip"
	"regexp"
	"strings"
	"sync/atomic"

	"github.com/sirupsen/logrus"
	"github.com/zmap/dns"
	"github.com/zmap/zdns/v2/src/zdns"
	"golang.org/x/time/rate"
)

// zdns settings of the engines (docs/nodes.md §6.11).
const (
	// maxAttempts bounds the attempts of a recursive or local lookup (over distinct servers) and of
	// every hop of an iterative chain; zdns itself never retries (Retries 0).
	maxAttempts = 3
	// maxHops bounds the CNAME and DNAME chain of an iterative lookup.
	maxHops = 16
	// zdnsMaxDepth bounds zdns' delegation depth.
	zdnsMaxDepth = 10
	// Entries of zdns' cache, which only ever serves delegations and name server addresses: the
	// iterative engine relies on it and sizes it from the cache size (delegationEntries), the
	// recursive engine needs none.
	minDelegationEntries = 16384
	maxDelegationEntries = 262144
	recursiveZDNSEntries = 4096
	// ednsSize is the EDNS buffer size of every query the resolver sends and of its replies.
	ednsSize = 1232
)

// Placeholder servers satisfy zdns' validation for the server lists a mode never uses.
var (
	placeholderV4 = netip.MustParseAddrPort("192.0.2.1:53")
	placeholderV6 = netip.MustParseAddrPort("[2001:db8::1]:53")
)

// question is a normalized question: lowercase, fully qualified name, class IN.
type question struct {
	name  string
	qtype uint16
}

// zdnsQuestion is the question in zdns' form (no trailing dot, which zdns would turn into a Fatal).
func (q question) zdnsQuestion() zdns.Question {
	return zdns.Question{Name: strings.TrimSuffix(q.name, "."), Type: q.qtype, Class: dns.ClassINET}
}

// failure classifies an unanswered lookup for the cache.
type failure int

const (
	failNone failure = iota
	// failRemote: servers answered SERVFAIL, REFUSED, a referral or only truncated replies, or did not
	// answer in time. Cached for failureTTL.
	failRemote
	// failLocal: the guard or a rate limit refused every server, no server was usable, the lookup
	// spent its query budget, the resolver ran out of file descriptors, or a panic. Never cached.
	failLocal
)

// result is the outcome of a lookup.
type result struct {
	qtype  uint16
	rcode  int
	answer []dns.RR
	ns     []dns.RR
	fail   failure
}

func servfail(qtype uint16, f failure) result {
	return result{qtype: qtype, rcode: dns.RcodeServerFailure, fail: f}
}

// generation is a zdns configuration with its pool of resolvers. A change of the IPv6 check result
// builds a new one; lookups in progress finish with the generation they started with.
type generation struct {
	rc   *zdns.ResolverConfig
	pool chan *zdns.Resolver
	ipv6 bool
}

// engine runs the lookups of the local, recursive and iterative routes with zdns.
type engine struct {
	log        *slog.Logger
	stats      *counters
	dialer     *dialer
	t          *timings
	mode       string
	upstreams  []netip.AddrPort
	roots      []netip.AddrPort
	useHost    bool
	maxLookups int
	// delegationEntries bounds zdns' cache in the iterative mode.
	delegationEntries int
	logLevel          logrus.Level
	// hostNS returns the current host nameservers.
	hostNS func() []netip.AddrPort
	// fatal handles a panic that is not logrus' Fatal: the process ends.
	fatal func(any)
	// preDial runs when an attempt failed before any dial (zdns found no route to the server's
	// family); it re-checks IPv6.
	preDial func()

	zcache *zdns.Cache
	health zdns.NameServerHealthTracker
	zlimit zdns.NameServerRateLimiter
	gen    atomic.Pointer[generation]
}

// init creates the state shared by every generation and builds the first one (IPv6 off until the
// check passes).
func (e *engine) init() error {
	e.zcache = new(zdns.Cache)
	if e.mode == ModeIterative {
		e.zcache.Init(e.delegationEntries)
	} else {
		e.zcache.Init(recursiveZDNSEntries)
	}
	e.health = zdns.NewNameServerHealthTracker()
	e.zlimit = zdns.NewNameServerRateLimiter(rate.Inf, rate.Inf) // the dialer enforces the limits
	return e.rebuild(false)
}

// rebuild swaps in a generation for the given IPv6 availability.
func (e *engine) rebuild(ipv6 bool) error {
	g, err := e.build(ipv6)
	if err != nil {
		return err
	}
	e.gen.Store(g)
	return nil
}

func (e *engine) build(ipv6 bool) (*generation, error) {
	rc := &zdns.ResolverConfig{
		Cache:                 e.zcache,
		RateLimiter:           e.zlimit,
		LookupClient:          zdns.LookupClient{},
		Dialer:                e.dialer,
		NameServerHealth:      e.health,
		Retries:               0,
		LogLevel:              e.logLevel,
		TransportMode:         zdns.UDPOrTCP,
		IterationIPPreference: zdns.PreferIPv4,
		ShouldRecycleSockets:  false,
		IterativeTimeout:      e.t.iterativeTimeout,
		NetworkTimeout:        e.t.networkTimeout,
		Timeout:               e.t.iterativeBudget,
		MaxDepth:              zdnsMaxDepth,
		FollowCNAMEs:          false,
		DNSSecEnabled:         false,
	}
	var v4, v6 []netip.AddrPort
	if e.mode == ModeIterative {
		roots := e.roots
		if len(roots) == 0 {
			for _, ns := range zdns.RootServersV4 {
				roots = append(roots, addrPortOf(ns))
			}
			for _, ns := range zdns.RootServersV6 {
				roots = append(roots, addrPortOf(ns))
			}
		}
		v4, v6 = splitFamilies(roots)
	} else {
		servers := e.upstreams
		if e.useHost {
			servers = append(append([]netip.AddrPort(nil), servers...), e.hostNS()...)
		}
		v4, v6 = splitFamilies(servers)
	}
	useV4, useV6 := len(v4) > 0, len(v6) > 0 && ipv6
	switch {
	case useV4 && useV6:
		rc.IPVersionMode = zdns.IPv4OrIPv6
	case useV6 || (!useV4 && len(v6) > 0):
		// Only IPv6 servers: never let zdns fall back to the IANA IPv4 roots.
		rc.IPVersionMode = zdns.IPv6Only
	default:
		rc.IPVersionMode = zdns.IPv4Only
	}
	used := func(servers []netip.AddrPort, placeholder netip.AddrPort) []zdns.NameServer {
		if len(servers) == 0 {
			servers = []netip.AddrPort{placeholder}
		}
		out := make([]zdns.NameServer, len(servers))
		for i, ap := range servers {
			out[i] = nameServerOf(ap)
		}
		return out
	}
	placeholders := func(p netip.AddrPort) []zdns.NameServer { return []zdns.NameServer{nameServerOf(p)} }
	if e.mode == ModeIterative {
		rc.RootNameServersV4, rc.RootNameServersV6 = used(v4, placeholderV4), used(v6, placeholderV6)
		rc.ExternalNameServersV4, rc.ExternalNameServersV6 = placeholders(placeholderV4), placeholders(placeholderV6)
	} else {
		rc.ExternalNameServersV4, rc.ExternalNameServersV6 = used(v4, placeholderV4), used(v6, placeholderV6)
		rc.RootNameServersV4, rc.RootNameServersV6 = placeholders(placeholderV4), placeholders(placeholderV6)
	}
	if err := rc.Validate(); err != nil {
		return nil, fmt.Errorf("zdns configuration: %w", err)
	}
	g := &generation{rc: rc, pool: make(chan *zdns.Resolver, e.maxLookups), ipv6: ipv6}
	for range e.maxLookups {
		r, err := zdns.InitResolver(rc)
		if err != nil {
			return nil, fmt.Errorf("zdns resolver: %w", err)
		}
		g.pool <- r
	}
	return g, nil
}

func splitFamilies(servers []netip.AddrPort) (v4, v6 []netip.AddrPort) {
	for _, ap := range servers {
		if ap.Addr().Is4() {
			v4 = append(v4, ap)
		} else {
			v6 = append(v6, ap)
		}
	}
	return v4, v6
}

func nameServerOf(ap netip.AddrPort) zdns.NameServer {
	return zdns.NameServer{IP: net.IP(ap.Addr().AsSlice()), Port: ap.Port()}
}

func addrPortOf(ns zdns.NameServer) netip.AddrPort {
	a, _ := netip.AddrFromSlice(ns.IP)
	return netip.AddrPortFrom(a.Unmap(), ns.Port)
}

// withResolver runs fn with a resolver of g's pool. It recovers from logrus' Fatal (zdns reaches it
// with names from hostile zones), replaces the resolver and reports panicked; any other panic ends the
// process through fatal.
func (e *engine) withResolver(g *generation, fn func(*zdns.Resolver)) (panicked bool) {
	r := <-g.pool
	defer func() {
		if p := recover(); p != nil {
			panicked = true
			if p != fatalSentinel {
				e.fatal(p)
				g.pool <- r
				return
			}
			e.stats.panics.Add(1)
			e.log.Warn("zdns aborted a lookup; the resolver instance is replaced")
			if nr, err := zdns.InitResolver(g.rc); err == nil {
				r = nr
			}
		}
		g.pool <- r
	}()
	fn(r)
	return false
}

// purge removes a key from zdns' cache, which must never answer a client's question: a cached zdns
// result can lack records (the additional records of an MX answer are stored under the MX question)
// and keeps its original TTLs.
func (e *engine) purge(k zdns.CachedKey) {
	e.zcache.IterativeCache.Lock(k)
	e.zcache.IterativeCache.Delete(k)
	e.zcache.IterativeCache.Unlock(k)
}

// lookup resolves q on route rt within ctx (the lookup's time budget) and at most maxLookupQueries
// queries.
func (e *engine) lookup(ctx context.Context, rt route, q question) result {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	budget := newQueryBudget(maxLookupQueries, cancel)
	var res result
	switch rt {
	case routeLocal:
		res = e.forward(ctx, routeLocal, q, e.hostNS(), budget)
	case routeIterative:
		res = e.iterate(ctx, q, budget)
	default:
		res = e.forward(ctx, routeRecursive, q, e.upstreamServers(), budget)
	}
	if budget.exhausted() {
		e.stats.budgetExceeded.Add(1)
		return servfail(q.qtype, failLocal)
	}
	return res
}

// delegationEntries sizes zdns' cache in the iterative mode from the answer cache size: one entry per
// 16 KiB, at least minDelegationEntries and at most maxDelegationEntries. sanitizeIterative bounds an
// entry well below that (TestHostileDelegationsKeepZDNSCacheSmall), so the cache holds at most about
// cacheBytes, the second cacheBytes of the container's memory limit.
func delegationEntries(cacheBytes int64) int {
	return int(min(max(cacheBytes/delegationEntryBytes, minDelegationEntries), maxDelegationEntries))
}

// delegationEntryBytes is the memory budget of one entry of zdns' cache.
const delegationEntryBytes = 16 << 10

// upstreamServers returns the upstream servers in use: IPv6 servers only while the IPv6 check passes.
func (e *engine) upstreamServers() []netip.AddrPort {
	servers := e.upstreams
	if e.useHost {
		servers = append(append([]netip.AddrPort(nil), servers...), e.hostNS()...)
	}
	ipv6 := e.gen.Load().ipv6
	out := make([]netip.AddrPort, 0, len(servers))
	for _, ap := range servers {
		if ap.Addr().Is4() || ipv6 {
			out = append(out, ap)
		}
	}
	return out
}

// zdnsPTRName matches the names zdns accepts as PTR questions without rewriting them.
var zdnsPTRName = regexp.MustCompile(`^(?i)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$`)

// zdnsKeepsPTR reports whether zdns sends a PTR question for name unchanged: it rewrites names that
// parse as IP addresses (into the reverse name) and rejects names outside its LDH pattern (DNS-SD
// names, IDN TLDs).
func zdnsKeepsPTR(name string) bool {
	n := strings.TrimSuffix(name, ".")
	if _, err := dns.ReverseAddr(n); err == nil {
		return false
	}
	return zdnsPTRName.MatchString(n)
}

// attempt is the classification of one failed attempt.
type attempt struct {
	local, remote, timeout, truncated, dialled bool
}

// classify reads the dial outcomes and replies of an attempt that produced no acceptable reply.
func classify(rec *recorder, panicked bool, status zdns.Status) attempt {
	var a attempt
	if panicked {
		a.local = true
	}
	for _, d := range rec.outcomes() {
		switch d.cause {
		case dialRefused, dialRateLimited, dialBudget, dialNoResources:
			a.local = true
		case dialOK:
			a.dialled = true
		case dialFailed:
			a.dialled = true
			a.remote = true
		}
	}
	replies, truncated := rec.received()
	a.truncated = truncated
	if replies > 0 {
		a.remote = true
	}
	if status == zdns.StatusTimeout || status == zdns.StatusIterTimeout {
		a.timeout = true
	}
	if a.dialled && replies == 0 {
		a.remote, a.timeout = true, true // dialled and nothing came back in time
	}
	return a
}

// outcome folds the attempts of a failed lookup into its result: cached only when every attempt
// failed for a remote reason.
func (e *engine) outcome(qtype uint16, attempts []attempt) result {
	f := failRemote
	truncatedOnly, timedOut := len(attempts) > 0, false
	for _, a := range attempts {
		if a.local || !a.remote {
			f = failLocal
		}
		if !a.truncated {
			truncatedOnly = false
		}
		if a.timeout {
			timedOut = true
		}
	}
	if len(attempts) == 0 {
		f = failLocal
	}
	if truncatedOnly {
		e.stats.tcpFallbackFail.Add(1)
	}
	if timedOut {
		e.stats.timeouts.Add(1)
	}
	return servfail(qtype, f)
}

// forward resolves q through servers (upstream servers or host nameservers) with recursion desired:
// at most maxAttempts attempts over distinct servers, each one zdns query (or, for a PTR name zdns
// would rewrite or reject, a direct query). The answer is the first acceptable reply, copied as it is.
func (e *engine) forward(ctx context.Context, rt route, q question, servers []netip.AddrPort, budget *queryBudget) result {
	if len(servers) == 0 {
		return servfail(q.qtype, failLocal)
	}
	direct := q.qtype == dns.TypePTR && !zdnsKeepsPTR(q.name)
	rec := newRecorder(q, false)
	ctx = withState(ctx, &lookupState{route: rt, rec: rec, budget: budget})
	tried := make(map[netip.AddrPort]bool, len(servers))
	var attempts []attempt
	for range maxAttempts {
		if ctx.Err() != nil {
			break
		}
		left := make([]netip.AddrPort, 0, len(servers))
		for _, ap := range servers {
			if !tried[ap] {
				left = append(left, ap)
			}
		}
		if len(left) == 0 {
			break
		}
		rec.start(q)
		var status zdns.Status
		panicked := false
		if direct {
			server := left[rand.IntN(len(left))] //nolint:gosec // a server choice needs no cryptographic randomness
			if _, err := e.exchange(ctx, server, q, true); err != nil && isTimeout(err) {
				status = zdns.StatusTimeout
			}
		} else {
			status, panicked = e.zdnsForward(ctx, q, left)
		}
		if m := rec.accepted(); m != nil {
			return result{qtype: q.qtype, rcode: m.Rcode, answer: m.Answer, ns: m.Ns}
		}
		a := classify(rec, panicked, status)
		dials := rec.outcomes()
		for _, d := range dials {
			tried[d.server] = true
		}
		if len(dials) == 0 && !panicked {
			// zdns gave up before dialling: it found no route to the server's family, in practice
			// IPv6. The next attempt uses the IPv4 servers only, and IPv6 is checked again.
			a.local = true
			if e.preDial != nil {
				e.preDial()
			}
			v4, v6 := splitFamilies(left)
			exclude := left
			if len(v4) > 0 && len(v6) > 0 {
				exclude = v6
			}
			for _, ap := range exclude {
				tried[ap] = true
			}
		}
		attempts = append(attempts, a)
	}
	if budget.exhausted() {
		return servfail(q.qtype, failLocal)
	}
	return e.outcome(q.qtype, attempts)
}

// zdnsForward runs one zdns query of q against servers (zdns picks one, preferring responsive ones).
func (e *engine) zdnsForward(ctx context.Context, q question, servers []netip.AddrPort) (zdns.Status, bool) {
	g := e.gen.Load()
	zq := q.zdnsQuestion()
	ns := make([]zdns.NameServer, len(servers))
	for i, ap := range servers {
		ns[i] = nameServerOf(ap)
		e.purge(zdns.CachedKey{Question: zq, NameServer: ns[i].String()})
	}
	var status zdns.Status
	panicked := e.withResolver(g, func(r *zdns.Resolver) {
		_, _, status, _ = zdns.LookupClient{}.DoDstServersLookup(ctx, r, zq, ns, false)
	})
	for i := range ns {
		e.purge(zdns.CachedKey{Question: zq, NameServer: ns[i].String()})
	}
	return status, panicked
}

func sameQuestion(m *dns.Msg, q question) bool {
	return len(m.Question) == 1 && m.Question[0].Qtype == q.qtype && m.Question[0].Qclass == dns.ClassINET &&
		dns.CanonicalName(m.Question[0].Name) == q.name
}

// soaFor returns the first SOA of rrs owned by name or one of its ancestors ("" = any owner).
func soaFor(rrs []dns.RR, name string) *dns.SOA {
	for _, rr := range rrs {
		soa, ok := rr.(*dns.SOA)
		if !ok {
			continue
		}
		if name == "" || dns.IsSubDomain(dns.CanonicalName(soa.Hdr.Name), name) {
			return soa
		}
	}
	return nil
}

// iterate resolves q from the root servers. zdns resolves one name per hop without following CNAMEs;
// the engine follows CNAME and DNAME chains itself and takes from each hop's reply only the records
// owned by that hop's name, so records a server adds for other names are never answered.
func (e *engine) iterate(ctx context.Context, q question, budget *queryBudget) result {
	if q.qtype == dns.TypePTR && !zdnsKeepsPTR(q.name) {
		return servfail(q.qtype, failLocal) // zdns would rewrite or reject it (documented)
	}
	rec := newRecorder(q, true)
	ctx = withState(ctx, &lookupState{route: routeIterative, rec: rec, budget: budget})
	g := e.gen.Load()
	var chain []dns.RR
	seen := make(map[string]bool)
	name := q.name
	for range maxHops {
		if strings.ContainsRune(name, '\\') || seen[name] {
			return servfail(q.qtype, failRemote) // a loop, or a target zdns cannot express
		}
		seen[name] = true
		hop := question{name: name, qtype: q.qtype}
		zq := hop.zdnsQuestion()
		var m *dns.Msg
		var attempts []attempt
		for range maxAttempts {
			if ctx.Err() != nil {
				break
			}
			rec.start(hop)
			e.purge(zdns.CachedKey{Question: zq})
			var status zdns.Status
			panicked := e.withResolver(g, func(r *zdns.Resolver) {
				_, _, status, _ = r.IterativeLookup(ctx, &zq)
			})
			e.purge(zdns.CachedKey{Question: zq})
			if m = rec.accepted(); m != nil {
				break
			}
			attempts = append(attempts, classify(rec, panicked, status))
		}
		if m == nil {
			if budget.exhausted() {
				return servfail(q.qtype, failLocal)
			}
			return e.outcome(q.qtype, attempts)
		}
		var own []dns.RR
		var cname *dns.CNAME
		for _, rr := range m.Answer {
			if dns.CanonicalName(rr.Header().Name) != name {
				continue
			}
			if rr.Header().Rrtype == q.qtype {
				own = append(own, rr)
			} else if c, ok := rr.(*dns.CNAME); ok && cname == nil {
				cname = c
			}
		}
		dname, target := dnameFor(m.Answer, name)
		var dn []dns.RR
		if dname != nil {
			dn = []dns.RR{dname}
		}
		switch {
		case len(own) > 0:
			return result{qtype: q.qtype, rcode: dns.RcodeSuccess, answer: concat(chain, dn, own)}
		case cname != nil:
			chain = concat(chain, dn, []dns.RR{cname})
			name = dns.CanonicalName(cname.Target)
		case dname != nil:
			if _, ok := dns.IsDomainName(target); !ok {
				return servfail(q.qtype, failRemote) // the rewritten name is too long (YXDOMAIN)
			}
			synth := &dns.CNAME{
				Hdr:    dns.RR_Header{Name: name, Rrtype: dns.TypeCNAME, Class: dns.ClassINET, Ttl: dname.Hdr.Ttl},
				Target: target,
			}
			chain = concat(chain, dn, []dns.RR{synth})
			name = target
		case m.Rcode == dns.RcodeNameError:
			return result{qtype: q.qtype, rcode: dns.RcodeNameError, answer: chain, ns: soaRRs(m.Ns, name)}
		case m.Rcode == dns.RcodeSuccess && m.Authoritative:
			return result{qtype: q.qtype, rcode: dns.RcodeSuccess, answer: chain, ns: soaRRs(m.Ns, name)}
		default:
			return servfail(q.qtype, failRemote)
		}
	}
	return servfail(q.qtype, failRemote)
}

// dnameFor returns the DNAME of answer owned by the closest proper ancestor of name and the name it
// rewrites name to (on a label boundary).
func dnameFor(answer []dns.RR, name string) (*dns.DNAME, string) {
	var best *dns.DNAME
	var bestOwner string
	for _, rr := range answer {
		d, ok := rr.(*dns.DNAME)
		if !ok {
			continue
		}
		owner := dns.CanonicalName(d.Hdr.Name)
		if owner == name || !dns.IsSubDomain(owner, name) {
			continue
		}
		if best == nil || dns.CountLabel(owner) > dns.CountLabel(bestOwner) {
			best, bestOwner = d, owner
		}
	}
	if best == nil {
		return nil, ""
	}
	prefix := name
	if bestOwner != "." {
		prefix = strings.TrimSuffix(name, bestOwner)
	}
	return best, dns.CanonicalName(prefix + dns.CanonicalName(best.Target))
}

// soaRRs returns the SOA of a negative reply owned by name or an ancestor, as a section.
func soaRRs(ns []dns.RR, name string) []dns.RR {
	if soa := soaFor(ns, name); soa != nil {
		return []dns.RR{soa}
	}
	return nil
}

func concat(parts ...[]dns.RR) []dns.RR {
	n := 0
	for _, p := range parts {
		n += len(p)
	}
	out := make([]dns.RR, 0, n)
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

// exchange sends q to server through the dialer, over UDP and again over TCP when the reply is
// truncated, and returns the reply. The context carries the route.
func (e *engine) exchange(ctx context.Context, server netip.AddrPort, q question, rd bool) (*dns.Msg, error) {
	m := new(dns.Msg)
	m.SetQuestion(q.name, q.qtype)
	m.RecursionDesired = rd
	m.SetEdns0(ednsSize, false)
	resp, err := e.exchangeOver(ctx, "udp", server, m)
	if err == nil && resp.Truncated {
		return e.exchangeOver(ctx, "tcp", server, m)
	}
	return resp, err
}

func (e *engine) exchangeOver(ctx context.Context, network string, server netip.AddrPort, m *dns.Msg) (*dns.Msg, error) {
	c, err := e.dialer.DialContext(ctx, network, nil, server.String())
	if err != nil {
		return nil, err
	}
	conn := &dns.Conn{Conn: c, UDPSize: ednsSize}
	defer conn.Close()
	client := &dns.Client{Net: network, Timeout: e.t.networkTimeout}
	resp, _, err := client.ExchangeWithConnContext(ctx, m, conn)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout())
}
