package resolver

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net"
	"net/netip"
	"runtime/debug"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/zmap/dns"

	"github.com/lonetis/scantor/internal/api"
)

// ErrPanic marks the end of Run after a panic the resolver cannot recover from: the process exits
// and the daemon starts the resolver again with clean state.
var ErrPanic = errors.New("resolver panic")

// Options configure Run.
type Options struct {
	Config Config
	// SpecHash is the resolver spec hash of the container (part of the probe answer and the stats).
	SpecHash string
	Logger   *slog.Logger
	// StatePath is the state file (StatePath when empty).
	StatePath string
	// ResolvConf holds the host nameservers (HostResolvConf when empty).
	ResolvConf string

	// Test hooks, unset in production.
	rewrite        func(network, address string) string
	timings        *timings
	interfaceAddrs func() ([]netip.Addr, error)
	conntrack      *[2]string
}

// timings are the durations of docs/nodes.md §6.11; tests shorten them.
type timings struct {
	clientDeadline     time.Duration
	forwardBudget      time.Duration
	iterativeBudget    time.Duration
	networkTimeout     time.Duration
	iterativeTimeout   time.Duration
	checkTimeout       time.Duration
	stateEvery         time.Duration
	upstreamCheckEvery time.Duration
	ipv6CheckEvery     time.Duration
	hostNSEvery        time.Duration
	ifaceEvery         time.Duration
	statsLogEvery      time.Duration
	limiterIdle        time.Duration
	bindRetry          time.Duration
	drainQuiet         time.Duration
	drainMax           time.Duration
	rateLimitWait      time.Duration
}

func defaultTimings() *timings {
	return &timings{
		// Under the 4 s Docker's embedded DNS waits for an answer.
		clientDeadline:     3 * time.Second,
		forwardBudget:      6 * time.Second,
		iterativeBudget:    15 * time.Second,
		networkTimeout:     2 * time.Second,
		iterativeTimeout:   4 * time.Second,
		checkTimeout:       2 * time.Second,
		stateEvery:         time.Second,
		upstreamCheckEvery: 30 * time.Second,
		ipv6CheckEvery:     10 * time.Minute,
		hostNSEvery:        time.Minute,
		ifaceEvery:         30 * time.Second,
		statsLogEvery:      time.Minute,
		limiterIdle:        time.Minute,
		bindRetry:          5 * time.Second,
		drainQuiet:         300 * time.Millisecond,
		drainMax:           3500 * time.Millisecond,
		rateLimitWait:      250 * time.Millisecond,
	}
}

// udpReadSize is the read buffer of a query datagram.
const udpReadSize = 4096

// server is one running resolver.
type server struct {
	s          *settings
	spec       string
	log        *slog.Logger
	t          *timings
	statePath  string
	resolvConf string
	ifaces     func() ([]netip.Addr, error)
	conntrack  [2]string
	startedAt  time.Time

	stats    *counters
	cache    *answerCache
	flights  *flights
	guard    *guard
	limiter  *limiter
	engine   *engine
	router   *router
	handover *handover

	ready       atomic.Bool
	bindErr     atomic.Pointer[string]
	upstreamOK  atomic.Bool
	upstreamErr atomic.Pointer[string]
	ipv6        atomic.Bool
	hostNS      atomic.Pointer[[]netip.AddrPort]
	noHostNS    atomic.Bool // warned that no host nameserver is usable
	// upstreamWarned and stateFailing keep repeated failures to one log line each.
	upstreamWarned atomic.Bool
	stateFailing   atomic.Bool
	have           atomic.Pointer[families]
	qps            atomic.Uint64 // math.Float64bits
	meter          rateMeter     // state loop only

	handlers atomic.Int64 // queries being answered
	// tcpConns is the client TCP listener (set once the resolver listens).
	tcpConns atomic.Pointer[tcpLimiter]
	runCtx   context.Context
	fatalCh  chan error
	ipv6Kick chan struct{}
}

// Run serves the resolver until ctx ends (SIGTERM), then drains (docs/nodes.md §6.11): new queries
// are steered to the other resolver on the same address, the open ones are answered, and the sockets
// close. A resolver that binds next to a serving one takes no query before its upstream check passes.
// Bind errors never end it; it retries. It returns an error wrapping ErrPanic after a panic it cannot
// recover from.
func Run(ctx context.Context, opts Options) error {
	s, err := newServer(opts)
	if err != nil {
		return err
	}
	return s.run(ctx)
}

func newServer(opts Options) (*server, error) {
	st, err := opts.Config.compile()
	if err != nil {
		return nil, err
	}
	log := opts.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	s := &server{
		s:          st,
		spec:       opts.SpecHash,
		log:        log,
		t:          opts.timings,
		statePath:  opts.StatePath,
		resolvConf: opts.ResolvConf,
		ifaces:     opts.interfaceAddrs,
		conntrack:  conntrackFiles,
		startedAt:  time.Now(),
		stats:      &counters{},
		fatalCh:    make(chan error, 1),
		ipv6Kick:   make(chan struct{}, 1),
	}
	if s.t == nil {
		s.t = defaultTimings()
	}
	if s.statePath == "" {
		s.statePath = StatePath
	}
	if s.resolvConf == "" {
		s.resolvConf = HostResolvConf
	}
	if s.ifaces == nil {
		s.ifaces = interfaceAddrs
	}
	if opts.conntrack != nil {
		s.conntrack = *opts.conntrack
	}
	level := bridgeLogrus(log, st.logLevel)
	s.cache = newAnswerCache(st.cacheBytes)
	s.flights = newFlights(st.maxLookups, s.stats)
	s.guard = newGuard(st)
	s.limiter = newLimiter(st.upstreamQPS, st.authoritativeQPS, s.t.rateLimitWait)
	s.router = &router{nodeID: st.nodeID, spec: s.spec, mode: st.mode, localNames: st.localNames, localDomains: st.localDomains}
	s.handover = &handover{log: log, addr: st.listen}
	empty := []netip.AddrPort{}
	s.hostNS.Store(&empty)
	s.have.Store(&families{v4: true})
	s.refreshInterfaces()
	s.refreshHostNameservers()
	s.engine = &engine{
		log:               log,
		stats:             s.stats,
		dialer:            &dialer{guard: s.guard, limits: s.limiter, timeout: s.t.networkTimeout, stats: s.stats, rewrite: opts.rewrite},
		t:                 s.t,
		mode:              st.mode,
		upstreams:         st.upstreams,
		roots:             st.roots,
		useHost:           st.useHost,
		maxLookups:        st.maxLookups,
		delegationEntries: delegationEntries(st.cacheBytes),
		logLevel:          level,
		hostNS:            func() []netip.AddrPort { return *s.hostNS.Load() },
		fatal:             s.fatal,
		preDial:           s.kickIPv6,
	}
	if err := s.engine.init(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *server) run(ctx context.Context) error {
	runCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	s.runCtx = runCtx
	var loops sync.WaitGroup
	defer func() {
		cancel()
		loops.Wait()
	}()
	s.writeState()
	loops.Go(func() { s.stateLoop(runCtx) })
	loops.Go(func() { s.checkLoop(runCtx) })
	loops.Go(func() { s.maintenanceLoop(runCtx) })

	udp, tcp, ok := s.bind(ctx)
	if !ok {
		return nil
	}
	// A replacement takes no query before its upstream check passes; any other resolver clears the
	// steering program a departed resolver may have left in the group (handover.go).
	s.handover.bound(udp, tcp, s.upstreamOK.Load)
	s.writeState()
	s.log.Info("node resolver listening", "listen", s.s.listen.String(), "mode", s.s.mode, "spec", s.spec)

	accept := func(dh dns.Header) dns.MsgAcceptAction {
		if dh.Bits&(1<<15) != 0 { // QR: never answer a response
			return dns.MsgIgnore
		}
		return dns.MsgAccept // everything else is checked by the handler, after the client check
	}
	conns := newTCPLimiter(tcp, s.allowed, s.stats)
	s.tcpConns.Store(conns)
	servers := []*dns.Server{
		{PacketConn: udp, Handler: s, MsgAcceptFunc: accept, UDPSize: udpReadSize},
		{
			Listener: conns, Handler: s, MsgAcceptFunc: accept,
			IdleTimeout: func() time.Duration { return tcpIdleTimeout }, ReadTimeout: tcpIdleTimeout,
			MaxTCPQueries: maxTCPQueriesPerConn,
		},
	}
	serveErr := make(chan error, len(servers))
	var serving sync.WaitGroup
	for _, srv := range servers {
		serving.Go(func() { serveErr <- srv.ActivateAndServe() })
	}
	closeAll := func() {
		_ = udp.Close()
		_ = tcp.Close()
	}
	select {
	case <-ctx.Done():
	case err := <-s.fatalCh:
		closeAll()
		return err
	case err := <-serveErr:
		closeAll()
		return fmt.Errorf("serve %s: %w", s.s.listen, err)
	}
	// Steer new queries to the other resolver of the address, answer the open ones, then close the
	// sockets directly: a socket that stays in the group without being read loses the queries the
	// kernel still hashes to it.
	s.handover.depart()
	if err := s.drain(); err != nil {
		closeAll()
		return err
	}
	closeAll()
	cancel()
	done := make(chan struct{})
	go func() {
		serving.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(s.t.drainMax):
	}
	s.log.Info("node resolver stopped", "queries", s.stats.queries.Load())
	return nil
}

// bind listens on the configured address (UDP and TCP, SO_REUSEPORT), retrying every bindRetry; the
// state file reports the error meanwhile. It returns false when ctx ended first.
func (s *server) bind(ctx context.Context) (*net.UDPConn, *net.TCPListener, bool) {
	lc := net.ListenConfig{Control: listenControl}
	addr := s.s.listen.String()
	for {
		s.handover.prepare()
		udp, tcp, err := listenPair(ctx, lc, addr)
		if err == nil {
			s.bindErr.Store(nil)
			s.ready.Store(true)
			return udp, tcp, true
		}
		code := bindErrorCode(err)
		if prev := s.bindErr.Swap(&code); prev == nil || *prev != code {
			s.log.Warn("cannot listen; retrying", "listen", addr, "error", err, "code", code)
		}
		t := time.NewTimer(s.t.bindRetry)
		select {
		case <-ctx.Done():
			t.Stop()
			return nil, nil, false
		case <-t.C:
		}
	}
}

func listenPair(ctx context.Context, lc net.ListenConfig, addr string) (*net.UDPConn, *net.TCPListener, error) {
	pc, err := lc.ListenPacket(ctx, "udp4", addr)
	if err != nil {
		return nil, nil, err
	}
	ln, err := lc.Listen(ctx, "tcp4", addr)
	if err != nil {
		_ = pc.Close()
		return nil, nil, err
	}
	return pc.(*net.UDPConn), ln.(*net.TCPListener), nil
}

// bindErrorCode maps a bind error to the error vocabulary of the node resolver.
func bindErrorCode(err error) string {
	switch {
	case errors.Is(err, syscall.EADDRINUSE):
		return api.ResolverErrBindInUse
	case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM):
		return api.ResolverErrBindDenied
	default: // EADDRNOTAVAIL: the address is not in this network namespace
		return api.ResolverErrBindUnavailable
	}
}

// drain waits until no query was in progress for drainQuiet, at most drainMax.
func (s *server) drain() error {
	start := time.Now()
	quietSince := start
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case err := <-s.fatalCh:
			return err
		case now := <-tick.C:
			if s.handlers.Load() > 0 {
				quietSince = now
			}
			if now.Sub(quietSince) >= s.t.drainQuiet || now.Sub(start) >= s.t.drainMax {
				return nil
			}
		}
	}
}

// fatal ends the process after a panic other than logrus' Fatal: shared zdns state (a cache shard
// lock) may be left inconsistent, so the resolver must not continue.
func (s *server) fatal(p any) {
	s.log.Error("node resolver panic", "panic", fmt.Sprint(p), "stack", string(debug.Stack()))
	select {
	case s.fatalCh <- fmt.Errorf("%w: %v", ErrPanic, p):
	default:
	}
}

func (s *server) kickIPv6() {
	select {
	case s.ipv6Kick <- struct{}{}:
	default:
	}
}

// ServeDNS answers one query (docs/nodes.md §6.11).
func (s *server) ServeDNS(w dns.ResponseWriter, req *dns.Msg) {
	s.handlers.Add(1)
	defer s.handlers.Add(-1)
	start := time.Now()
	s.stats.queries.Add(1)
	var client netip.Addr
	tcp := false
	switch a := w.RemoteAddr().(type) {
	case *net.UDPAddr:
		client = a.AddrPort().Addr().Unmap()
	case *net.TCPAddr:
		client, tcp = a.AddrPort().Addr().Unmap(), true
	}
	m := s.answer(client, req, start)
	s.reply(w, req, m, tcp)
}

// allowed reports whether client may query: the worker network's subnets and the listen address.
func (s *server) allowed(client netip.Addr) bool {
	return client == s.s.listen.Addr() || inPrefixes(client, s.s.clients)
}

// answer builds the reply to req without the EDNS and size handling of reply.
func (s *server) answer(client netip.Addr, req *dns.Msg, start time.Time) *dns.Msg {
	m := new(dns.Msg)
	m.SetReply(req)
	switch {
	case !s.allowed(client):
		m.Rcode = dns.RcodeRefused
		return m
	case req.Opcode != dns.OpcodeQuery:
		m.Rcode = dns.RcodeNotImplemented
		return m
	case len(req.Question) != 1 || countOPT(req) > 1:
		m.Rcode = dns.RcodeFormatError
		return m
	}
	if opt := req.IsEdns0(); opt != nil && opt.Version() != 0 {
		m.Rcode = dns.RcodeBadVers
		return m
	}
	q := req.Question[0]
	name := strings.ToLower(dns.Fqdn(q.Name))
	switch {
	case q.Qclass != dns.ClassINET, q.Qtype == dns.TypeAXFR, q.Qtype == dns.TypeIXFR,
		name == ".", strings.ContainsRune(name, '\\'), len(name)-1 > maxDomainNameBytes:
		m.Rcode = dns.RcodeRefused
		return m
	}
	rt, sp := s.router.route(name, q.Qtype)
	if rt == routeAnswer {
		m.Rcode, m.Answer = sp.rcode, sp.answer
		return m
	}
	if rt == routeLocal && len(*s.hostNS.Load()) == 0 {
		// No usable host nameserver: local names and local domains go to the mode's servers.
		rt = s.router.modeRoute()
	}
	if rt == routeIterative && q.Qtype == dns.TypeANY {
		// RFC 8482: no ANY walk through the authoritative servers.
		m.Answer = []dns.RR{&dns.HINFO{
			Hdr: dns.RR_Header{Name: name, Rrtype: dns.TypeHINFO, Class: dns.ClassINET, Ttl: localTTL},
			Cpu: "RFC8482",
		}}
		return m
	}
	if e := s.cache.lookup(name, q.Qtype, time.Now()); e != nil {
		s.stats.cacheHits.Add(1)
		fill(m, e, time.Now())
		return m
	}
	ctx, cancel := context.WithDeadline(s.runCtx, start.Add(s.t.clientDeadline))
	defer cancel()
	key := flightKey{name: name, qtype: q.Qtype}
	e, err := s.flights.do(ctx, s.runCtx, key, client, func(base context.Context) *entry {
		budget := s.t.forwardBudget
		if rt == routeIterative {
			budget = s.t.iterativeBudget
		}
		lctx, cancel := context.WithTimeout(base, budget)
		defer cancel()
		res := s.engine.lookup(lctx, rt, question{name: name, qtype: q.Qtype})
		e := newEntry(res, time.Now())
		s.cache.store(name, q.Qtype, e)
		return e
	})
	if err != nil {
		if errors.Is(err, errOverloaded) {
			s.stats.overloaded.Add(1)
		}
		m.Rcode = dns.RcodeServerFailure
		return m
	}
	fill(m, e, time.Now())
	return m
}

func countOPT(m *dns.Msg) int {
	n := 0
	for _, rr := range m.Extra {
		if rr.Header().Rrtype == dns.TypeOPT {
			n++
		}
	}
	return n
}

// fill copies an entry into the reply.
func fill(m *dns.Msg, e *entry, now time.Time) {
	m.Rcode = e.rcode
	m.Answer, m.Ns = e.records(now)
}

// reply sets the flags every reply carries (RA=1, AA=0, AD=0; CD echoed by SetReply), adds OPT to
// replies of EDNS queries and truncates UDP replies to the client's size (EDNS, at most 1232, or 512).
func (s *server) reply(w dns.ResponseWriter, req, m *dns.Msg, tcp bool) {
	m.RecursionAvailable = true
	m.Authoritative = false
	m.AuthenticatedData = false
	size := dns.MinMsgSize
	if opt := req.IsEdns0(); opt != nil {
		m.SetEdns0(ednsSize, false)
		size = int(min(max(opt.UDPSize(), dns.MinMsgSize), ednsSize))
	}
	if tcp {
		size = dns.MaxMsgSize
	}
	m.Truncate(size)
	if err := w.WriteMsg(m); err != nil {
		s.log.Debug("write reply", "error", err)
	}
	s.stats.countRcode(m.Rcode)
}

// snapshot returns the current stats.
func (s *server) snapshot(now time.Time) Stats {
	st := Stats{
		V:          1,
		Ready:      s.ready.Load(),
		Node:       s.s.nodeID,
		Spec:       s.spec,
		Mode:       s.s.mode,
		Listen:     s.s.listen.String(),
		UpstreamOK: s.upstreamOK.Load(),
		IPv6:       s.ipv6.Load(),
		StartedAt:  s.startedAt.UTC().Format(time.RFC3339Nano),
		At:         now.UTC().Format(time.RFC3339Nano),
	}
	if e := s.bindErr.Load(); e != nil {
		st.Error = *e
	}
	if e := s.upstreamErr.Load(); e != nil {
		st.UpstreamError = *e
	}
	hosts := *s.hostNS.Load()
	st.HostNameservers = make([]string, len(hosts))
	for i, ap := range hosts {
		st.HostNameservers[i] = ap.Addr().String()
	}
	s.stats.fill(&st)
	st.QPS = math.Float64frombits(s.qps.Load())
	st.CacheBytes = s.cache.bytes.Load()
	st.CacheEntries = s.cache.entries.Load()
	st.Conntrack = readConntrack(s.conntrack)
	return st
}

// writeState writes the state file; failures are logged when they start.
func (s *server) writeState() {
	now := time.Now()
	st := s.snapshot(now)
	if err := writeState(s.statePath, st); err != nil {
		if !s.stateFailing.Swap(true) {
			s.log.Warn("cannot write the state file: the healthcheck fails", "path", s.statePath, "error", err)
		}
		return
	}
	s.stateFailing.Store(false)
}

// stateLoop rewrites the state file every stateEvery and updates the query rate.
func (s *server) stateLoop(ctx context.Context) {
	tick := time.NewTicker(s.t.stateEvery)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-tick.C:
			qps := s.meter.observe(float64(now.UnixNano())/1e9, s.stats.queries.Load())
			s.qps.Store(math.Float64bits(qps))
			s.writeState()
		}
	}
}

// checkLoop runs the IPv6 check (at start, every ipv6CheckEvery and when a lookup found no route) and
// the upstream check (at start and every upstreamCheckEvery).
func (s *server) checkLoop(ctx context.Context) {
	s.checkIPv6(ctx)
	s.checkUpstreams(ctx)
	upstream := time.NewTicker(s.t.upstreamCheckEvery)
	defer upstream.Stop()
	ipv6 := time.NewTicker(s.t.ipv6CheckEvery)
	defer ipv6.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-upstream.C:
			s.checkUpstreams(ctx)
		case <-ipv6.C:
			s.checkIPv6(ctx)
		case <-s.ipv6Kick:
			if s.checkIPv6(ctx) {
				s.checkUpstreams(ctx)
			}
		}
	}
}

// checkIPv6 runs the IPv6 check and rebuilds the engine when the result changed; it reports a change.
func (s *server) checkIPv6(ctx context.Context) bool {
	ok := s.engine.ipv6Check(ctx)
	if ctx.Err() != nil || ok == s.ipv6.Load() {
		return false
	}
	if err := s.engine.rebuild(ok); err != nil {
		s.log.Error("cannot rebuild the lookup engine", "ipv6", ok, "error", err)
		return false
	}
	s.ipv6.Store(ok)
	if ok {
		s.log.Info("IPv6 servers answer: IPv6 enabled")
	} else {
		s.log.Info("IPv6 servers do not answer: IPv6 disabled")
	}
	return true
}

// checkUpstreams runs the upstream check and logs changes of its result.
func (s *server) checkUpstreams(ctx context.Context) {
	ok, code := s.engine.upstreamCheck(ctx, s.ipv6.Load())
	if ctx.Err() != nil {
		return
	}
	s.upstreamOK.Store(ok)
	if ok {
		s.upstreamErr.Store(nil)
		s.handover.release()
		if s.upstreamWarned.Swap(false) {
			s.log.Info("upstream check passes again", "mode", s.s.mode)
		}
		return
	}
	s.upstreamErr.Store(&code)
	if !s.upstreamWarned.Swap(true) {
		s.log.Warn("upstream check failed: no "+serversOf(s.s.mode)+" server answers", "mode", s.s.mode, "code", code)
	}
}

// maintenanceLoop refreshes the interface addresses and host nameservers, forgets idle rate limiters
// and logs the stats.
func (s *server) maintenanceLoop(ctx context.Context) {
	iface := time.NewTicker(s.t.ifaceEvery)
	defer iface.Stop()
	hosts := time.NewTicker(s.t.hostNSEvery)
	defer hosts.Stop()
	statsLog := time.NewTicker(s.t.statsLogEvery)
	defer statsLog.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-iface.C:
			s.refreshInterfaces()
			s.limiter.sweep(now, s.t.limiterIdle)
		case <-hosts.C:
			s.refreshHostNameservers()
		case now := <-statsLog.C:
			st := s.snapshot(now)
			s.log.Info("node resolver stats",
				"queries", st.Queries, "cacheHits", st.CacheHits, "lookups", st.Lookups, "inflight", st.Inflight,
				"qps", math.Round(st.QPS*10)/10, "servFail", st.Rcodes.ServFail, "nxDomain", st.Rcodes.NXDomain,
				"timeouts", st.Timeouts, "overloaded", st.Overloaded, "rateLimited", st.RateLimited,
				"cacheBytes", st.CacheBytes, "cacheEntries", st.CacheEntries, "upstreamOk", st.UpstreamOK, "ipv6", st.IPv6)
		}
	}
}

// refreshInterfaces re-reads the node's addresses for the server guard and the host nameservers.
func (s *server) refreshInterfaces() {
	addrs, err := s.ifaces()
	if err != nil {
		s.log.Warn("cannot read the interface addresses", "error", err)
		return
	}
	s.guard.setOwn(addrs)
	f := familiesOf(addrs)
	s.have.Store(&f)
}

// refreshHostNameservers re-reads the host nameservers; it warns when none remain.
func (s *server) refreshHostNameservers() {
	servers, err := readHostNameservers(s.resolvConf, *s.have.Load())
	if err != nil {
		s.log.Warn("cannot read the host nameservers", "path", s.resolvConf, "error", err)
		servers = []netip.AddrPort{}
	}
	// The resolver's own address is never a host nameserver: it would ask itself.
	servers = slices.DeleteFunc(servers, func(ap netip.AddrPort) bool { return ap == s.s.listen })
	s.hostNS.Store(&servers)
	s.guard.setHost(servers)
	if len(servers) > 0 {
		s.noHostNS.Store(false)
	} else if !s.noHostNS.Swap(true) {
		s.log.Warn("no usable host nameservers: local names (the master's hosts, local domains) are resolved through the "+
			serversOf(s.s.mode)+" servers", "path", s.resolvConf)
	}
}
