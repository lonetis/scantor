package node

import (
	"context"
	"encoding/json"
	"fmt"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	dcontainer "github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
	"github.com/lonetis/scantor/internal/envconf"
	"github.com/lonetis/scantor/internal/resolver"
)

// The node resolver (docs/nodes.md §6.11): every node runs one DNS server for its workers, a container of
// kind resolver that the daemon runs from its own image on the host network, bound to port 53 of the
// worker network's gateway. New workers get that address as their only DNS server (HostConfig.Dns) while
// the resolver is ready; Docker's embedded DNS of each worker forwards every name it does not know itself
// to it.
//
// One goroutine per session, the manager (resolverLoop), does all Docker I/O for the resolver: it creates
// the resolver of the desired spec, replaces it blue/green when the spec changes (the new one must be
// healthy before the old one is stopped; both share the address with SO_REUSEPORT), starts it again when
// it exited, restarts it when it stays unhealthy, probes it from the worker network with a one-shot probe
// container, and publishes an immutable report that hello, status and the actors' DNS choice only load.
// The daemon leaves the resolver running when it stops, like its workers.

// resolverStopSeconds is the stop grace of a replaced or removed resolver, which steers new queries to
// the newer resolver and drains its own within a few seconds.
const resolverStopSeconds = 10

// resolverRestartSeconds is the stop grace when the manager restarts an unhealthy resolver.
const resolverRestartSeconds = 2

// resolverUnhealthyPasses is how many passes in a row the resolver must be unhealthy (for another reason
// than its upstream servers) before the manager restarts it.
const resolverUnhealthyPasses = 3

// resolverCrashLoop is the number of failures in a row of one resolver spec from which the state is
// failed with crashLoop.
const resolverCrashLoop = 3

// probeFailuresUnreachable is the number of failed probes in a row that make the resolver unreachable.
const probeFailuresUnreachable = 2

// builtinLocalDomains are resolved through the host nameservers in every mode (docs/nodes.md §6.11): names
// that only the node's own network knows (host.docker.internal, home networks) and the reverse zones of
// private addresses.
var builtinLocalDomains = func() []string {
	d := []string{
		"localhost", "internal", "home.arpa", "10.in-addr.arpa", "168.192.in-addr.arpa", "254.169.in-addr.arpa",
		"d.f.ip6.arpa", "8.e.f.ip6.arpa", "9.e.f.ip6.arpa", "a.e.f.ip6.arpa", "b.e.f.ip6.arpa",
	}
	for i := 16; i <= 31; i++ {
		d = append(d, strconv.Itoa(i)+".172.in-addr.arpa")
	}
	return d
}()

// netFacts are the addresses of the worker network: the resolver listens on its IPv4 gateway and answers
// clients of its subnets.
type netFacts struct {
	name    string
	gateway netip.Addr
	subnets []netip.Prefix
}

// netFactsOf returns the facts of the worker network name, or nil when it has no IPv4 gateway.
func netFactsOf(name string, n network.Inspect) *netFacts {
	f := &netFacts{name: name}
	for _, c := range n.IPAM.Config {
		if c.Subnet.IsValid() {
			f.subnets = append(f.subnets, c.Subnet.Masked())
		}
		if gw := c.Gateway.Unmap(); gw.Is4() && !f.gateway.IsValid() {
			f.gateway = gw
		}
	}
	if !f.gateway.IsValid() {
		return nil
	}
	slices.SortFunc(f.subnets, func(a, b netip.Prefix) int { return strings.Compare(a.String(), b.String()) })
	return f
}

func (f *netFacts) equal(o *netFacts) bool {
	if f == nil || o == nil {
		return f == o
	}
	return f.name == o.name && f.gateway == o.gateway && slices.Equal(f.subnets, o.subnets)
}

// resolverReport is the published state of the node resolver. It lives on the daemon, so it survives
// sessions of the same process, and it is never changed after it was stored.
type resolverReport struct {
	report api.NodeResolverReport
	// gateway is the address new workers get while the state is ready.
	gateway netip.Addr
}

// resolverReportAPI returns a copy of the published report for hello and status (nil before the first).
func (d *Daemon) resolverReportAPI() *api.NodeResolverReport {
	r := d.resolver.Load()
	if r == nil {
		return nil
	}
	rep := r.report
	return &rep
}

// resolverManager is the manager's state that survives sessions of the same process. Apart from settleBy,
// which actors read, only the manager goroutine uses it; sessions never overlap.
type resolverManager struct {
	// settleBy (unix nanoseconds) is when new workers stop waiting for a resolver that is starting.
	settleBy atomic.Int64

	nextProbe     time.Time
	probeOK       time.Time
	probeGateway  netip.Addr
	probeFailures int
	probeErrors   int
	probeErr      string
	unreachable   bool
	// foreignNode is the node whose resolver answered the probe instead of this node's.
	foreignNode string
	backoff     map[string]*resolverBackoff
	// unhealthy counts the passes in a row in which the resolver of spec unhealthySpec was unhealthy.
	unhealthy     int
	unhealthySpec string
	// stats are the last valid stats of the container statsID.
	stats   *resolver.Stats
	statsID string
	ignored map[string]bool
	warned  string
}

// resolverBackoff delays the next attempt for one resolver spec after a failure.
type resolverBackoff struct {
	n       int
	retryAt time.Time
	code    string
	detail  string
}

func newResolverManager() *resolverManager {
	return &resolverManager{backoff: map[string]*resolverBackoff{}, ignored: map[string]bool{}}
}

// settle lets new workers wait until now + resolverSettle for the resolver.
func (m *resolverManager) settle(until time.Time) { m.settleBy.Store(until.UnixNano()) }

func (m *resolverManager) backoffOf(spec string) *resolverBackoff {
	b := m.backoff[spec]
	if b == nil {
		b = &resolverBackoff{}
		m.backoff[spec] = b
	}
	return b
}

// fail records a failure of spec and schedules the next attempt after min(base × 2^(n−1), maxDelay).
func (m *resolverManager) fail(spec string, now time.Time, base, maxDelay time.Duration, code, detail string) {
	b := m.backoffOf(spec)
	b.n++
	b.retryAt = now.Add(expBackoff(base, maxDelay, b.n))
	b.code, b.detail = code, detail
}

// resolverSpec is the resolver the node should run now.
type resolverSpec struct {
	mode string
	// disabled: no resolver (mode disabled, or the purge of unauthorized mode).
	disabled bool
	// problem is an error code when no resolver can run (noNetwork, noImage, createFailed for an invalid
	// configuration) and problemDetail its detail; configErr is the configuration's validation error.
	problem       string
	problemDetail string
	configErr     error
	facts         *netFacts
	image         string
	cfg           resolver.Config
	hash          string
	name          string
}

func (w *resolverSpec) gateway() netip.Addr {
	if w.facts == nil {
		return netip.Addr{}
	}
	return w.facts.gateway
}

// resolverContainer is a resolver container found on the engine.
type resolverContainer struct {
	id, name, node, spec string
	status               dcontainer.ContainerState
	health               dcontainer.HealthStatus
	healthLog            []*dcontainer.HealthcheckResult
	exitCode             int
	startedAt            time.Time
	// listen is the address of its --config.
	listen netip.Addr
}

func (c *resolverContainer) running() bool { return c != nil && c.status == dcontainer.StateRunning }

func (c *resolverContainer) healthy() bool { return c.running() && c.health == dcontainer.Healthy }

// resolverName returns the container name of a resolver: scantor-dns-<nodeId>-<first 12 hex of the hash>.
func resolverName(nodeID, specHash string) string {
	hex := strings.TrimPrefix(specHash, "sha256:")
	if len(hex) > 12 {
		hex = hex[:12]
	}
	return container.Name(container.KindResolver, nodeID+"-"+hex)
}

// validSpecHash reports whether s has the form of resolver.SpecHash ("sha256:" + 64 hex digits).
func validSpecHash(s string) bool {
	hex, ok := strings.CutPrefix(s, "sha256:")
	if !ok || len(hex) != 64 {
		return false
	}
	for _, r := range hex {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

// resolverImageID is the image of the resolver and probe containers: the daemon's own image.
func (d *Daemon) resolverImageID() string {
	switch {
	case d.resolverImage != "":
		return d.resolverImage
	case d.self != nil:
		return d.self.imageID
	default:
		return ""
	}
}

// kickResolver asks the manager for a pass (non-blocking).
func (s *session) kickResolver() {
	select {
	case s.resolverCh <- struct{}{}:
	default:
	}
}

// setNetFacts stores the worker network's facts and wakes the manager when they changed.
func (s *session) setNetFacts(f *netFacts) {
	if old := s.net.Load(); old.equal(f) {
		return
	}
	s.net.Store(f)
	s.kickResolver()
}

// resolverLoop runs the manager for the session: a pass at once (which probes an adopted resolver), on
// every kick and when the previous pass asks for the next.
func (s *session) resolverLoop() {
	s.d.rm.nextProbe = s.d.now()
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-s.stopCtx.Done():
			return
		case <-s.resolverCh:
		case <-timer.C:
		}
		resetTimer(timer, s.resolverPass())
	}
}

// resolverPass is one level-triggered pass of the manager; it returns the delay of the next one.
func (s *session) resolverPass() time.Duration {
	want := s.desiredResolver()
	own, foreign, err := s.listResolvers()
	if err != nil {
		if s.stopCtx.Err() == nil {
			s.log.Warn("node resolver: cannot list the resolver containers", "err", err)
		}
		return s.nextResolverPass(want)
	}
	switch {
	case want.disabled:
		s.resolverDisabled(want, own)
		return s.nextResolverPass(want)
	case want.problem != "":
		s.publishResolver(want, nil, want.problem, want.problemDetail, false)
		return s.nextResolverPass(want)
	}
	if f := foreignAt(foreign, want.gateway()); f != nil {
		s.warnOnce("foreign:"+f.id, "node resolver: the resolver of another node on this Docker engine serves this node's worker network; "+
			"this node runs none until it is removed", "container", f.name, "otherNodeId", f.node, "address", resolverAddress(want.gateway()))
		s.publishResolver(want, nil, api.ResolverErrForeignResolver, resolverAddress(want.gateway()), false)
		return s.nextResolverPass(want)
	}
	// Only the desired spec's backoff matters; a spec that is desired again later starts afresh.
	for spec := range s.d.rm.backoff {
		if spec != want.hash {
			delete(s.d.rm.backoff, spec)
		}
	}
	cur, others := splitResolvers(own, want.hash)
	cur, code, detail := s.ensureResolver(want, cur)
	cur = s.awaitResolverHealth(cur)
	serving, jcode, jdetail := s.judgeResolver(want, cur, others)
	switch {
	case jcode != "":
		code, detail = jcode, jdetail
	case cur.healthy():
		code, detail = "", ""
	}
	s.probeIfDue(want, serving)
	s.publishResolver(want, serving, code, detail, false)
	return s.nextResolverPass(want)
}

// nextResolverPass returns the delay of the next pass: the status interval (fresh stats) or
// resolverEvery, earlier when a probe or a retry is due.
func (s *session) nextResolverPass(want *resolverSpec) time.Duration {
	next := s.d.t.resolverEvery
	if every := time.Duration(s.config.StatusIntervalMs) * time.Millisecond; every > 0 && every < next {
		next = every
	}
	now := s.d.now()
	due := []time.Time{s.d.rm.nextProbe}
	if want.disabled {
		for _, b := range s.d.rm.backoff { // the resolvers kept for existing workers
			due = append(due, b.retryAt)
		}
	} else if b := s.d.rm.backoff[want.hash]; b != nil {
		due = append(due, b.retryAt)
	}
	for _, at := range due {
		if until := at.Sub(now); until > 0 && until < next {
			next = until
		}
	}
	return next
}

// desiredResolver computes the resolver of the current settings and worker network.
func (s *session) desiredResolver() *resolverSpec {
	dns := s.d.settings().settings.DNS
	want := &resolverSpec{mode: dns.Mode, facts: s.net.Load()}
	switch {
	case dns.Mode == api.ResolverModeDisabled || s.purged.Load():
		want.disabled = true
		return want
	case want.facts == nil:
		want.problem = api.ResolverErrNoNetwork
		return want
	}
	if want.image = s.d.resolverImageID(); want.image == "" {
		want.problem = api.ResolverErrNoImage
		return want
	}
	want.cfg = s.resolverConfig(dns, want.facts)
	// The resolver process exits at once with a configuration it refuses; a container is never created
	// for one.
	if err := want.cfg.Validate(); err != nil {
		want.problem, want.problemDetail, want.configErr = api.ResolverErrCreateFailed, reportDetail(err.Error()), err
		return want
	}
	want.hash = resolver.SpecHash(want.image, want.cfg)
	want.name = resolverName(s.node.ID, want.hash)
	return want
}

// resolverConfig builds the resolver's configuration (--config): the effective DNS settings, the master's
// host names and the built-in local suffixes for the host nameservers, the egress deny list, and the
// environment's servers that the resolver must trust.
func (s *session) resolverConfig(dns DNSSettings, f *netFacts) resolver.Config {
	cfg := resolver.Config{
		NodeID:           s.node.ID,
		Listen:           resolverAddress(f.gateway),
		Clients:          []string{},
		Mode:             dns.Mode,
		Upstreams:        []string{},
		RootServers:      normalizedServers(dns.RootServers),
		LocalNames:       s.localNames(),
		LocalDomains:     append(slices.Clone(builtinLocalDomains), dns.LocalDomains...),
		DenyServers:      []string{},
		TrustedServers:   []string{},
		CacheBytes:       dns.CacheSize,
		MaxLookups:       dns.MaxLookups,
		UpstreamQPS:      dns.UpstreamQPS,
		AuthoritativeQPS: dns.AuthoritativeQPS,
		LogLevel:         levelName(s.d.cfg.Settings.LogLevel),
		LogFormat:        s.d.cfg.LogFormat,
	}
	for _, p := range f.subnets {
		cfg.Clients = append(cfg.Clients, p.String())
	}
	for _, u := range dns.Upstreams {
		if u == UpstreamHost {
			cfg.UseHostNameservers = true
			continue
		}
		cfg.Upstreams = append(cfg.Upstreams, normalizedServers([]string{u})...)
	}
	for _, p := range s.d.cfg.EgressDeny {
		cfg.DenyServers = append(cfg.DenyServers, p.String())
	}
	// The operator chose the environment's servers: the resolver queries each of them for its route
	// whatever its address (loopback, private, inside the deny list, the node's own). Override servers are
	// never trusted; the daemon refuses those it could not query (checkOverrideServers).
	env := s.d.cfg.Settings.DNS
	cfg.TrustedServers = normalizedServers(append(slices.Clone(env.Upstreams), env.RootServers...))
	return cfg.Normalize()
}

// localNames are the host names of the master that workers reach: the hello's endpoint hosts and the host
// of the daemon's own SCANTOR_URL (IP literals are not names).
func (s *session) localNames() []string {
	names := slices.Clone(s.config.EndpointHosts)
	if u, err := url.Parse(s.d.cfg.URL); err == nil {
		if host := u.Hostname(); host != "" {
			if _, err := netip.ParseAddr(host); err != nil {
				names = append(names, host)
			}
		}
	}
	if names == nil {
		return []string{}
	}
	return names
}

// normalizedServers renders servers (already validated) as ip:port; the host keyword is skipped.
func normalizedServers(servers []string) []string {
	out := []string{}
	for _, s := range servers {
		if ap, err := ParseDNSServer(s); err == nil {
			out = append(out, ap.String())
		}
	}
	return out
}

// resolverAddress is the listen address of a resolver on gateway gw.
func resolverAddress(gw netip.Addr) string {
	if !gw.IsValid() {
		return ""
	}
	return netip.AddrPortFrom(gw, 53).String()
}

// listResolvers lists the resolver containers of this node (own) and of other nodes (foreign) on the
// engine. A container is a resolver only with the managed labels of kind resolver, a node, a spec hash,
// and the name that both determine; anything else is ignored and logged once.
func (s *session) listResolvers() (own, foreign []*resolverContainer, err error) {
	filters := client.Filters{}
	filters.Add("label", container.LabelManaged+"=true", container.LabelKind+"="+string(container.KindResolver))
	filters.Add("name", container.NamePrefix(container.KindResolver))
	res, err := s.d.docker.ContainerList(s.opCtx, client.ContainerListOptions{All: true, Filters: filters})
	if err != nil {
		return nil, nil, fmt.Errorf("list resolver containers: %w", err)
	}
	for _, item := range res.Items {
		name := ""
		if len(item.Names) > 0 {
			name = strings.TrimPrefix(item.Names[0], "/")
		}
		node, spec := item.Labels[container.LabelNode], item.Labels[container.LabelSpecHash]
		if !container.IsManaged(container.KindResolver, name, item.Labels) || node == "" || !validSpecHash(spec) || name != resolverName(node, spec) {
			if !s.d.rm.ignored[item.ID] {
				s.d.rm.ignored[item.ID] = true
				s.log.Warn("node resolver: ignoring a container that is not a resolver of a node", "container", shortID(item.ID), "name", name)
			}
			continue
		}
		c, err := s.inspectResolver(item.ID)
		if err != nil {
			if container.IsNotFound(err) {
				continue
			}
			return nil, nil, err
		}
		if c.node == s.node.ID {
			own = append(own, c)
		} else {
			foreign = append(foreign, c)
		}
	}
	slices.SortFunc(own, func(a, b *resolverContainer) int { return strings.Compare(a.name, b.name) })
	return own, foreign, nil
}

// inspectResolver reads the state of a resolver container.
func (s *session) inspectResolver(id string) (*resolverContainer, error) {
	res, err := s.d.docker.ContainerInspect(s.opCtx, id, client.ContainerInspectOptions{})
	if err != nil {
		return nil, err
	}
	ctr := res.Container
	c := &resolverContainer{id: ctr.ID, name: trimSlash(ctr.Name)}
	if ctr.Config != nil {
		c.node, c.spec = ctr.Config.Labels[container.LabelNode], ctr.Config.Labels[container.LabelSpecHash]
		c.listen = listenOf(ctr.Config.Cmd)
	}
	if st := ctr.State; st != nil {
		c.status, c.exitCode = st.Status, st.ExitCode
		if t, err := time.Parse(time.RFC3339Nano, st.StartedAt); err == nil {
			c.startedAt = t
		}
		if st.Health != nil {
			c.health, c.healthLog = st.Health.Status, st.Health.Log
		}
	}
	return c, nil
}

// listenOf returns the listen address of a resolver command line (--config <json>).
func listenOf(cmd []string) netip.Addr {
	for i, arg := range cmd {
		if arg != "--config" || i+1 >= len(cmd) {
			continue
		}
		var cfg struct {
			Listen string `json:"listen"`
		}
		if json.Unmarshal([]byte(cmd[i+1]), &cfg) != nil {
			return netip.Addr{}
		}
		ap, err := netip.ParseAddrPort(cfg.Listen)
		if err != nil {
			return netip.Addr{}
		}
		return ap.Addr()
	}
	return netip.Addr{}
}

// foreignAt returns a running resolver of another node that listens on gw.
func foreignAt(foreign []*resolverContainer, gw netip.Addr) *resolverContainer {
	for _, c := range foreign {
		if c.running() && c.listen == gw {
			return c
		}
	}
	return nil
}

// splitResolvers returns the resolver of spec and the others.
func splitResolvers(own []*resolverContainer, spec string) (cur *resolverContainer, others []*resolverContainer) {
	for _, c := range own {
		if c.spec == spec {
			cur = c
		} else {
			others = append(others, c)
		}
	}
	return cur, others
}

// ensureResolver makes sure the resolver of the desired spec exists and runs: it creates a missing one
// and starts one that is not running, both after the backoff of earlier failures. It returns the error
// code (and detail) of a failure.
func (s *session) ensureResolver(want *resolverSpec, cur *resolverContainer) (*resolverContainer, string, string) {
	m, t := s.d.rm, s.d.t
	now := s.d.now()
	b := m.backoffOf(want.hash)
	switch {
	case cur.running():
		return cur, "", ""
	case now.Before(b.retryAt):
		return cur, b.code, b.detail
	case !s.mayCreate():
		return cur, "", ""
	case cur == nil:
		m.settle(now.Add(t.resolverSettle))
		c, err := s.createResolver(want)
		if err != nil {
			if s.stopCtx.Err() != nil {
				return nil, "", ""
			}
			s.log.Warn("node resolver: cannot create the resolver container", "container", want.name, "err", err)
			m.fail(want.hash, now, t.resolverBackoffBase, t.resolverBackoffMax, api.ResolverErrCreateFailed, "")
			return nil, api.ResolverErrCreateFailed, ""
		}
		s.log.Info("node resolver created", "container", want.name, "mode", want.mode, "address", resolverAddress(want.gateway()))
		return c, "", ""
	case cur.status == dcontainer.StateDead:
		// A dead container cannot be started; the next pass creates it again.
		s.removeResolver(cur, 0)
		return nil, "", ""
	}
	// Created, or exited: an exit counts as a failure of this spec, with a shorter backoff, and only
	// repeated exits are reported (crashLoop).
	code, detail := "", ""
	if cur.status == dcontainer.StateExited {
		m.fail(want.hash, now, t.resolverRestartBase, t.resolverRestartMax, api.ResolverErrCrashLoop, "exit code "+strconv.Itoa(cur.exitCode))
		if b.n >= resolverCrashLoop {
			code, detail = b.code, b.detail
		} else {
			b.code, b.detail = "", ""
		}
		s.log.Warn("node resolver: the resolver exited; starting it again", "container", cur.name, "exitCode", cur.exitCode, "failures", b.n)
	}
	if _, err := s.d.docker.ContainerStart(s.opCtx, cur.id, client.ContainerStartOptions{}); err != nil {
		if s.stopCtx.Err() == nil {
			s.log.Warn("node resolver: cannot start the resolver container", "container", cur.name, "err", err)
			m.fail(want.hash, now, t.resolverBackoffBase, t.resolverBackoffMax, api.ResolverErrCreateFailed, "")
		}
		return cur, api.ResolverErrCreateFailed, ""
	}
	if c, err := s.inspectResolver(cur.id); err == nil {
		cur = c
	}
	return cur, code, detail
}

// createResolver creates and starts the resolver of want.
func (s *session) createResolver(want *resolverSpec) (*resolverContainer, error) {
	opts, err := resolverCreateOptions(want, s.node.ID, s.d.host, s.d.resolverNetworkMode())
	if err != nil {
		return nil, err
	}
	res, err := s.d.docker.ContainerCreate(s.opCtx, opts)
	if err != nil {
		return nil, err
	}
	if _, err := s.d.docker.ContainerStart(s.opCtx, res.ID, client.ContainerStartOptions{}); err != nil {
		rmCtx, cancel := context.WithTimeout(context.WithoutCancel(s.opCtx), 30*time.Second)
		defer cancel()
		_, _ = s.d.docker.ContainerRemove(rmCtx, res.ID, client.ContainerRemoveOptions{Force: true})
		return nil, fmt.Errorf("start: %w", err)
	}
	return s.inspectResolver(res.ID)
}

func (d *Daemon) resolverNetworkMode() string {
	if d.resolverNetwork != "" {
		return d.resolverNetwork
	}
	return container.NetworkHost
}

// awaitResolverHealth waits until a started resolver is healthy, unhealthy or gone, at most until
// resolverHealthWait after its start.
func (s *session) awaitResolverHealth(c *resolverContainer) *resolverContainer {
	if !c.running() || c.health != dcontainer.Starting {
		return c
	}
	deadline := c.startedAt.Add(s.d.t.resolverHealthWait)
	for c.running() && c.health == dcontainer.Starting && s.d.now().Before(deadline) {
		if !sleep(s.stopCtx, s.d.t.resolverPoll) {
			return c
		}
		next, err := s.inspectResolver(c.id)
		switch {
		case container.IsNotFound(err):
			return nil
		case err != nil:
			return c
		}
		c = next
	}
	return c
}

// judgeResolver decides which resolver serves and what is wrong with the current one. A healthy current
// resolver completes a replacement (the others are removed). One that is unhealthy, or not healthy within
// resolverHealthWait, is a failed replacement while an older resolver still serves: it is removed and
// its spec backs off. Without an older one it keeps serving as well as it can: degraded when its upstream
// servers do not answer, and restarted after resolverUnhealthyPasses passes for any other reason.
func (s *session) judgeResolver(want *resolverSpec, cur *resolverContainer, others []*resolverContainer) (*resolverContainer, string, string) {
	m, t := s.d.rm, s.d.t
	now := s.d.now()
	var old *resolverContainer
	for _, c := range others {
		if c.healthy() && c.listen == want.gateway() {
			old = c
			break
		}
	}
	switch {
	case cur != nil && cur.status == dcontainer.StateExited && old != nil:
		// The replacement exited before it became healthy (started by this pass or an earlier one).
		detail := "exit code " + strconv.Itoa(cur.exitCode)
		s.log.Warn("node resolver: the new resolver exited; keeping the running one", "container", cur.name, "exitCode", cur.exitCode)
		s.removeResolver(cur, 0)
		m.fail(want.hash, now, t.resolverBackoffBase, t.resolverBackoffMax, api.ResolverErrCrashLoop, detail)
		return old, api.ResolverErrCrashLoop, detail
	case !cur.running():
		return old, "", ""
	case cur.healthy():
		if b := m.backoffOf(want.hash); b.n > 0 {
			*b = resolverBackoff{}
		}
		m.unhealthy = 0
		if len(others) > 0 {
			for _, c := range others {
				s.removeResolver(c, resolverStopSeconds)
			}
			s.log.Info("node resolver replaced", "container", cur.name, "replaced", len(others))
			m.nextProbe = now
		}
		return cur, "", ""
	}
	code, detail := resolverHealthError(cur)
	if old != nil {
		// The new resolver may already answer a share of the queries (it binds the address with the old
		// one): it is stopped with the drain grace, like a replaced resolver, before it is removed.
		s.log.Warn("node resolver: the new resolver did not become healthy; keeping the running one", "container", cur.name, "error", code)
		s.removeResolver(cur, resolverStopSeconds)
		m.fail(want.hash, now, t.resolverBackoffBase, t.resolverBackoffMax, code, detail)
		return old, code, detail
	}
	if cur.health == dcontainer.Starting {
		return cur, "", "" // within its start period
	}
	switch code {
	case api.ResolverErrUpstreamUnreachable, api.ResolverErrBindInUse, api.ResolverErrBindUnavailable, api.ResolverErrBindDenied:
		// A restart fixes neither: the resolver retries its bind and its upstream check by itself.
		m.unhealthy = 0
		return cur, code, detail
	}
	if m.unhealthySpec != cur.spec {
		m.unhealthy, m.unhealthySpec = 0, cur.spec
	}
	m.unhealthy++
	if b := m.backoffOf(want.hash); m.unhealthy >= resolverUnhealthyPasses && !now.Before(b.retryAt) && s.mayCreate() {
		timeout := resolverRestartSeconds
		if _, err := s.d.docker.ContainerRestart(s.opCtx, cur.id, client.ContainerRestartOptions{Timeout: &timeout}); err != nil {
			s.log.Warn("node resolver: cannot restart the unhealthy resolver", "container", cur.name, "err", err)
		} else {
			s.log.Warn("node resolver: restarted the unhealthy resolver", "container", cur.name)
		}
		m.fail(want.hash, now, t.resolverRestartBase, t.resolverRestartMax, api.ResolverErrUnhealthy, "")
		m.unhealthy = 0
	}
	return cur, api.ResolverErrUnhealthy, ""
}

// resolverHealthError classifies an unhealthy resolver from the newest health check whose output holds
// its stats (newestStatsOf): they name a bind error or failing upstream servers; otherwise it is
// unhealthy. Without such a check the newest output is searched for those codes.
func resolverHealthError(c *resolverContainer) (code, detail string) {
	if st := newestStatsOf(c); st != nil {
		switch {
		case isBindError(st.Error):
			return st.Error, resolverAddress(c.listen)
		case !st.UpstreamOK:
			return api.ResolverErrUpstreamUnreachable, ""
		}
		return api.ResolverErrUnhealthy, ""
	}
	if n := len(c.healthLog); n > 0 && c.healthLog[n-1] != nil {
		out := c.healthLog[n-1].Output
		for _, code := range []string{api.ResolverErrBindInUse, api.ResolverErrBindUnavailable, api.ResolverErrBindDenied, api.ResolverErrUpstreamUnreachable} {
			if strings.Contains(out, code) {
				if isBindError(code) {
					return code, resolverAddress(c.listen)
				}
				return code, ""
			}
		}
	}
	return api.ResolverErrUnhealthy, ""
}

func isBindError(code string) bool {
	return code == api.ResolverErrBindInUse || code == api.ResolverErrBindUnavailable || code == api.ResolverErrBindDenied
}

// parseResolverStats parses the first line of a health check output as the resolver's stats and accepts
// them only for the resolver of spec.
func parseResolverStats(output, spec string) (*resolver.Stats, bool) {
	line, _, _ := strings.Cut(output, "\n")
	var st resolver.Stats
	if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &st); err != nil || st.Spec != spec {
		return nil, false
	}
	return &st, true
}

// newestStatsOf returns the stats of the newest health check of c whose output starts with stats of c's
// spec, whatever its exit code: a failing check prints them too, so upstreamOk, ipv6 and the errors are
// current also while the resolver is unhealthy. It is nil when Docker's health log (the last five checks)
// holds no such output, for example while every check times out.
func newestStatsOf(c *resolverContainer) *resolver.Stats {
	for i := len(c.healthLog) - 1; i >= 0; i-- {
		if e := c.healthLog[i]; e != nil {
			if st, ok := parseResolverStats(e.Output, c.spec); ok {
				return st
			}
		}
	}
	return nil
}

// removeResolver stops a resolver with the given grace (it drains its queries) and removes it.
func (s *session) removeResolver(c *resolverContainer, graceSeconds int) {
	if c.running() && graceSeconds > 0 {
		stopCtx, cancel := context.WithTimeout(s.opCtx, time.Duration(graceSeconds)*time.Second+30*time.Second)
		_, err := s.d.docker.ContainerStop(stopCtx, c.id, client.ContainerStopOptions{Timeout: &graceSeconds})
		cancel()
		if err != nil && !container.IsNotFound(err) {
			s.log.Warn("node resolver: stopping a resolver failed; removing it with force", "container", c.name, "err", err)
		}
	}
	if _, err := s.d.docker.ContainerRemove(s.opCtx, c.id, client.ContainerRemoveOptions{Force: true}); err != nil && !container.IsNotFound(err) {
		s.log.Warn("node resolver: cannot remove a resolver", "container", c.name, "err", err)
		return
	}
	s.log.Info("node resolver removed", "container", c.name)
}

// resolverDisabled handles mode disabled and the purge of unauthorized mode: the resolvers of this node
// stay while any worker container of this node exists (their DNS cannot change), and are removed once
// none is left. The manager publishes disabled under dnsMu, so no actor gives a new worker the resolver
// from then on, and it counts the workers under the same lock, so it sees every worker created before.
func (s *session) resolverDisabled(want *resolverSpec, own []*resolverContainer) {
	s.d.dnsMu.Lock()
	keep := false
	if len(own) > 0 {
		keep = s.workerCount.Load() > 0
		if !keep {
			n, err := s.countWorkerContainers()
			if err != nil && s.stopCtx.Err() == nil {
				s.log.Warn("node resolver: cannot count the workers; keeping the resolver", "err", err)
			}
			keep = err != nil || n > 0
		}
	}
	var serving *resolverContainer
	for _, c := range own {
		if c.running() && (serving == nil || c.listen == want.gateway()) {
			serving = c
		}
	}
	if !keep {
		serving = nil
	}
	s.publishResolver(want, serving, "", "", keep)
	s.d.dnsMu.Unlock()
	// Only the kept resolvers' backoff matters.
	m := s.d.rm
	for spec := range m.backoff {
		if !keep || !slices.ContainsFunc(own, func(c *resolverContainer) bool { return c.spec == spec }) {
			delete(m.backoff, spec)
		}
	}
	switch {
	case !keep:
		for _, c := range own {
			s.removeResolver(c, resolverStopSeconds)
		}
	case serving == nil && s.mayCreate():
		// A dead container cannot be started; prefer the one on the current gateway.
		var stopped *resolverContainer
		for _, c := range own {
			if c.status != dcontainer.StateDead && (stopped == nil || c.listen == want.gateway()) {
				stopped = c
			}
		}
		if stopped != nil {
			s.startKeptResolver(stopped)
		} else {
			s.warnOnce("kept-dead:"+own[0].id, "node resolver: the resolver kept for existing workers is dead and cannot be started; "+
				"those workers cannot resolve names until they are recreated", "container", own[0].name)
		}
	case serving.healthy():
		delete(m.backoff, serving.spec)
	}
}

// startKeptResolver starts the stopped resolver kept for existing workers in mode disabled, with the
// backoff of ensureResolver: an exit counts as a failure of its spec (restart backoff), a failed start
// too (backoff), and the start waits until the spec's retry time, for which nextResolverPass schedules a
// pass. Its die event alone never starts it again before that.
func (s *session) startKeptResolver(c *resolverContainer) {
	m, t := s.d.rm, s.d.t
	now := s.d.now()
	b := m.backoffOf(c.spec)
	if now.Before(b.retryAt) {
		return
	}
	if c.status == dcontainer.StateExited {
		m.fail(c.spec, now, t.resolverRestartBase, t.resolverRestartMax, api.ResolverErrCrashLoop, "exit code "+strconv.Itoa(c.exitCode))
		s.log.Warn("node resolver: the resolver kept for existing workers exited; starting it again", "container", c.name, "exitCode", c.exitCode, "failures", b.n)
	}
	if _, err := s.d.docker.ContainerStart(s.opCtx, c.id, client.ContainerStartOptions{}); err != nil && s.stopCtx.Err() == nil {
		s.log.Warn("node resolver: cannot start the resolver kept for existing workers", "container", c.name, "err", err)
		m.fail(c.spec, now, t.resolverBackoffBase, t.resolverBackoffMax, api.ResolverErrCreateFailed, "")
	}
}

// countWorkerContainers counts the worker containers of this node (all states).
func (s *session) countWorkerContainers() (int, error) {
	found, err := listWorkerContainers(s.opCtx, s.d.docker)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, c := range found {
		if c.nodeID == s.node.ID {
			n++
		}
	}
	return n, nil
}

// probeIfDue runs the probe when it is due and a healthy resolver serves the current gateway. A probe
// whose lookup fails is repeated after probeRetry; the second failure in a row makes the resolver
// unreachable, probed again every probeUnreachableEvery. A probe that cannot run (create, start, wait or
// its output fail) is logged and retried with a backoff and changes nothing: probeErrors counts those
// since the last probe that completed a lookup, and while it is not zero the last result stays valid
// (resolverState).
func (s *session) probeIfDue(want *resolverSpec, serving *resolverContainer) {
	m, t := s.d.rm, s.d.t
	if !serving.healthy() || serving.listen != want.gateway() || s.d.now().Before(m.nextProbe) || !s.mayCreate() {
		return
	}
	res, err := s.probeResolver(want.image, want.facts)
	now := s.d.now()
	switch {
	case err != nil:
		if s.stopCtx.Err() != nil {
			return
		}
		m.probeErrors++
		m.nextProbe = now.Add(expBackoff(t.probeRetry, t.probeUnreachableEvery, m.probeErrors))
		if msg := err.Error(); msg != m.probeErr {
			m.probeErr = msg
			s.log.Warn("node resolver: the probe could not run; retrying", "err", err)
		} else {
			s.log.Debug("node resolver: the probe could not run; retrying", "err", err)
		}
	case res.OK && res.Node == s.node.ID:
		m.probeErrors, m.probeErr, m.probeFailures = 0, "", 0
		m.unreachable, m.foreignNode = false, ""
		m.probeOK, m.probeGateway = now, want.gateway()
		m.nextProbe = now.Add(t.probeEvery)
		s.log.Debug("node resolver: probe answered", "spec", res.Spec, "ms", res.MS)
	case res.OK:
		m.probeErrors, m.probeErr = 0, ""
		m.foreignNode = res.Node
		m.nextProbe = now.Add(t.probeUnreachableEvery)
		s.warnOnce("probe-foreign:"+res.Node, "node resolver: the probe was answered by the resolver of another node on this Docker engine",
			"otherNodeId", res.Node, "address", resolverAddress(want.gateway()))
	default:
		m.probeErrors, m.probeErr = 0, ""
		m.probeFailures++
		if m.probeFailures >= probeFailuresUnreachable {
			m.unreachable = true
			m.nextProbe = now.Add(t.probeUnreachableEvery)
		} else {
			m.nextProbe = now.Add(t.probeRetry)
		}
		s.log.Debug("node resolver: the probe failed", "error", res.Error, "failures", m.probeFailures)
	}
}

// publishResolver stores the report of the state the pass found. A change of state, error, kept or
// address is logged, requests a status report, and wakes the actors that wait for the resolver.
func (s *session) publishResolver(want *resolverSpec, serving *resolverContainer, code, detail string, kept bool) {
	m := s.d.rm
	now := s.d.now()
	state := s.resolverState(want, serving, &code, &detail)
	rep := api.NodeResolverReport{Mode: want.mode, State: state, Kept: kept}
	var gw netip.Addr
	if serving != nil {
		gw = serving.listen
		rep.Address, rep.Spec = gw.String(), serving.spec
		// The newest stats of the serving resolver, also those of a failing check; while its health log
		// holds none, the last ones seen stay.
		if st := newestStatsOf(serving); st != nil {
			m.stats, m.statsID = st, serving.id
		} else if m.statsID != serving.id {
			m.stats, m.statsID = nil, ""
		}
		if m.stats != nil {
			rep.IPv6, rep.UpstreamOK = m.stats.IPv6, m.stats.UpstreamOK
			conntrack := 0.0
			if m.stats.Conntrack.Max > 0 {
				conntrack = float64(m.stats.Conntrack.Count) / float64(m.stats.Conntrack.Max)
			}
			rep.Stats = &api.NodeResolverStats{
				Queries: m.stats.Queries, CacheHits: m.stats.CacheHits, Lookups: m.stats.Lookups, Failures: m.stats.Failures(),
				Inflight: m.stats.Inflight, QPS: m.stats.QPS, ConntrackUsed: conntrack,
			}
		}
	}
	if code != "" {
		rep.Error, rep.Detail = &code, detail
	}
	prev := s.d.resolver.Load()
	changed := prev == nil || prev.report.State != state || !sameError(prev.report.Error, rep.Error) || prev.report.Kept != kept || prev.report.Address != rep.Address
	if changed {
		rep.Since = api.NewTime(now)
	} else {
		rep.Since = prev.report.Since
	}
	s.d.resolver.Store(&resolverReport{report: rep, gateway: gw})
	if !changed {
		return
	}
	s.logResolverState(want, rep)
	s.statusChanged()
	if state != api.ResolverStarting {
		for _, a := range s.actorList() {
			a.kick()
		}
	}
}

// resolverState derives the state from the serving resolver, the error found and the probe; it may
// replace code and detail with the probe's findings.
func (s *session) resolverState(want *resolverSpec, serving *resolverContainer, code, detail *string) string {
	m := s.d.rm
	switch {
	case want.disabled:
		return api.ResolverDisabled
	case m.foreignNode != "" && serving.healthy():
		*code, *detail = api.ResolverErrForeignResolver, resolverAddress(want.gateway())
		return api.ResolverFailed
	case serving == nil || !serving.running():
		if *code != "" {
			return api.ResolverFailed
		}
		return api.ResolverStarting
	case serving.healthy():
		switch {
		case m.unreachable:
			*code, *detail = api.ResolverErrProbeFailed, s.probeDetail(want)
			return api.ResolverUnreachable
		case !m.probeOK.IsZero() && m.probeGateway == want.gateway() && (s.d.now().Sub(m.probeOK) <= s.d.t.probeValid || m.probeErrors > 0):
			// A successful probe stays valid for probeValid, and as long as every probe since then
			// could not run: only a lookup result changes the state.
			return api.ResolverReady
		}
		return api.ResolverStarting
	case *code == api.ResolverErrUpstreamUnreachable:
		return api.ResolverDegraded
	case *code != "":
		return api.ResolverFailed
	}
	return api.ResolverStarting
}

// probeDetail names the path a failed probe took: "<gateway>:53 from <subnet>".
func (s *session) probeDetail(want *resolverSpec) string {
	if want.facts == nil || len(want.facts.subnets) == 0 {
		return resolverAddress(want.gateway())
	}
	return resolverAddress(want.gateway()) + " from " + want.facts.subnets[0].String()
}

// maxReportDetail bounds the detail of the resolver report (the orchestrator stores at most 256
// characters of [A-Za-z0-9 .:,;/[]()=%+_-]).
const maxReportDetail = 256

// reportDetail turns an error message into a report detail: line breaks become "; ", characters outside
// the detail's alphabet (quotes) are dropped, and it is cut to maxReportDetail characters.
func reportDetail(msg string) string {
	var b strings.Builder
	for _, r := range strings.Join(strings.Fields(strings.ReplaceAll(msg, "\n", " ; ")), " ") {
		if r < 0x80 && (r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune(" .:,;/[]()=%+_-", r)) {
			b.WriteRune(r)
		}
	}
	out := strings.ReplaceAll(b.String(), " ;", ";")
	if len(out) > maxReportDetail {
		out = out[:maxReportDetail]
	}
	return strings.Trim(out, " ;")
}

func sameError(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// logResolverState logs a state change, with a hint for the failures an operator can fix.
func (s *session) logResolverState(want *resolverSpec, rep api.NodeResolverReport) {
	args := []any{"state", rep.State, "mode", rep.Mode}
	if rep.Address != "" {
		args = append(args, "address", rep.Address)
	}
	if rep.Kept {
		args = append(args, "kept", true)
	}
	if rep.Error == nil {
		s.log.Info("node resolver state changed", args...)
		return
	}
	args = append(args, "error", *rep.Error)
	if rep.Detail != "" {
		args = append(args, "detail", rep.Detail)
	}
	if want.configErr != nil {
		args = append(args, "err", want.configErr.Error())
	}
	if hint := s.resolverHint(want, *rep.Error); hint != "" {
		args = append(args, "hint", hint)
	}
	if rep.State == api.ResolverReady {
		s.log.Warn("node resolver: the replacement failed; the running resolver keeps serving", args...)
		return
	}
	s.log.Warn("node resolver state changed; new workers use Docker's DNS", args...)
}

func (s *session) resolverHint(want *resolverSpec, code string) string {
	switch code {
	case api.ResolverErrNoImage:
		return "the daemon does not know its own container image (self-inspection failed); run it as a container of this Docker engine"
	case api.ResolverErrNoNetwork:
		return "the worker network is missing, unusable or has no IPv4 gateway"
	case api.ResolverErrBindUnavailable:
		if s.d.host.rootless {
			return "rootless Docker with RootlessKit --detach-netns hides the worker network from host-network containers; " +
				"set DOCKERD_ROOTLESS_ROOTLESSKIT_DETACH_NETNS=false for the Docker daemon"
		}
		return "the worker network's gateway is not an address of the host's network namespace"
	case api.ResolverErrBindInUse:
		return "another process holds port 53 on all addresses of the host (for example dnsmasq without bind-interfaces); " +
			"let it bind only the addresses it serves"
	case api.ResolverErrBindDenied:
		return "the resolver may not bind port 53 (a security policy of the host denies NET_BIND_SERVICE)"
	case api.ResolverErrUpstreamUnreachable:
		return "no upstream or root server answers: allow outbound DNS (UDP and TCP port 53) to them, " +
			"or set SCANTOR_NODE_DNS_UPSTREAMS=host to use the host nameservers"
	case api.ResolverErrProbeFailed:
		if want.facts != nil && len(want.facts.subnets) > 0 {
			return fmt.Sprintf("a host firewall drops DNS from the worker network to the resolver: allow UDP and TCP from %s to %s port 53 "+
				"(ufw allow from %s to %s port 53)", want.facts.subnets[0], want.gateway(), want.facts.subnets[0], want.gateway())
		}
		return "a host firewall drops DNS from the worker network to the resolver"
	case api.ResolverErrForeignResolver:
		return "the resolver of another node runs on this Docker engine: remove it with docker rm -f (label scantor.kind=resolver)"
	case api.ResolverErrCreateFailed:
		if want.configErr != nil {
			return "the node resolver's configuration is invalid (see err): check SCANTOR_NODE_DNS_*, SCANTOR_NODE_EGRESS_DENY " +
				"and the node's dns daemon overrides"
		}
		return ""
	case api.ResolverErrCrashLoop:
		return "the resolver keeps exiting; see docker logs " + want.name
	case api.ResolverErrUnhealthy:
		return "see the health log of " + want.name + " (docker inspect)"
	}
	return ""
}

// warnOnce logs a warning once per key until another key is warned about.
func (s *session) warnOnce(key, msg string, args ...any) {
	if s.d.rm.warned == key {
		return
	}
	s.d.rm.warned = key
	s.log.Warn(msg, args...)
}

// resolverCreateOptions is the container spec of the resolver (docs/nodes.md §6.11): the daemon's own
// image, host network, root without capabilities except binding port 53, a read-only root file system
// with a tmpfs for its state file, memory for twice the answer cache plus 768 MiB (GOMEMLIMIT at 80 %),
// GOMAXPROCS of at most 16, and no restart policy: the manager restarts it.
func resolverCreateOptions(want *resolverSpec, nodeID string, host hostInfo, networkMode string) (client.ContainerCreateOptions, error) {
	labels, err := container.ManagedLabels(container.KindResolver, container.Identity{Node: nodeID, SpecHash: want.hash})
	if err != nil {
		return client.ContainerCreateOptions{}, err
	}
	cfg, err := json.Marshal(want.cfg)
	if err != nil {
		return client.ContainerCreateOptions{}, fmt.Errorf("resolver config: %w", err)
	}
	memory := 2*want.cfg.CacheBytes + 768*envconf.MiB
	pids := int64(1024)
	nofile := max(int64(65536), 4*int64(want.cfg.MaxLookups)+1024)
	stop := resolverStopSeconds
	hc := &dcontainer.HostConfig{
		NetworkMode:    dcontainer.NetworkMode(networkMode),
		CapDrop:        []string{"ALL"},
		CapAdd:         []string{"NET_BIND_SERVICE"},
		SecurityOpt:    []string{"no-new-privileges:true"},
		ReadonlyRootfs: true,
		Tmpfs:          map[string]string{"/run": "size=1m"},
		RestartPolicy:  dcontainer.RestartPolicy{Name: dcontainer.RestartPolicyDisabled},
		LogConfig:      dcontainer.LogConfig{Type: "local", Config: map[string]string{"max-size": "10m", "max-file": "3"}},
		Resources: dcontainer.Resources{
			Memory:     memory,
			MemorySwap: memory,
			PidsLimit:  &pids,
			Ulimits:    []*dcontainer.Ulimit{{Name: "nofile", Soft: nofile, Hard: nofile}},
		},
	}
	if host.userns {
		// User namespace remapping refuses host-network containers that do not share the host's user
		// namespace.
		hc.UsernsMode = "host"
	}
	return client.ContainerCreateOptions{
		Name: want.name,
		Config: &dcontainer.Config{
			Image:      want.image,
			Entrypoint: []string{container.ImageBinaryPath},
			Cmd:        []string{"node", "resolver", "serve", "--spec-hash", want.hash, "--config", string(cfg)},
			User:       "0:0",
			Env: []string{
				"GOMAXPROCS=" + strconv.Itoa(min(max(host.cpus, 1), 16)),
				"GOMEMLIMIT=" + envconf.FormatByteSize(memory/10*8),
			},
			Labels:      labels,
			StopTimeout: &stop,
			Healthcheck: container.ResolverHealthcheck(),
		},
		HostConfig: hc,
	}, nil
}

// The probe (docs/nodes.md §6.11): a one-shot container on the worker network with the resolver as its
// DNS server looks up resolver.scantor.invalid TXT through Docker's embedded DNS, the path every worker's
// lookups take.

// probeResolver runs the probe once.
func (s *session) probeResolver(image string, f *netFacts) (resolver.ProbeResult, error) {
	probe := oneShot{docker: s.d.docker, kind: container.KindResolverProbe, nodeID: s.node.ID, timeout: s.d.t.probeTimeout, what: "resolver probe"}
	stdout, stderr, err := probe.run(s.stopCtx, func(ctx context.Context, name string) (string, error) {
		opts, err := probeCreateOptions(name, image, s.node.ID, f)
		if err != nil {
			return "", err
		}
		res, err := s.d.docker.ContainerCreate(ctx, opts)
		return res.ID, err
	})
	if err != nil {
		return resolver.ProbeResult{}, err
	}
	var res resolver.ProbeResult
	if err := json.Unmarshal([]byte(lastLine(stdout)), &res); err != nil {
		return resolver.ProbeResult{}, fmt.Errorf("resolver probe printed no result: %s", truncateUTF8(strings.TrimSpace(stdout+" "+stderr), 512))
	}
	return res, nil
}

// probeCreateOptions is the spec of the probe container. It logs with the local driver whatever the
// engine's default, so its result can be read (container.OneShotLogConfig).
func probeCreateOptions(name, image, nodeID string, f *netFacts) (client.ContainerCreateOptions, error) {
	labels, err := container.ManagedLabels(container.KindResolverProbe, container.Identity{Node: nodeID})
	if err != nil {
		return client.ContainerCreateOptions{}, err
	}
	pids := int64(128)
	memory := 64 * envconf.MiB
	return client.ContainerCreateOptions{
		Name: name,
		Config: &dcontainer.Config{
			Image:       image,
			Entrypoint:  []string{container.ImageBinaryPath},
			Cmd:         []string{"node", "resolver", "probe"},
			User:        "65534:65534",
			Env:         []string{"GOMAXPROCS=2"},
			Labels:      labels,
			Healthcheck: &dcontainer.HealthConfig{Test: []string{"NONE"}},
		},
		HostConfig: &dcontainer.HostConfig{
			NetworkMode:    dcontainer.NetworkMode(f.name),
			DNS:            []netip.Addr{f.gateway},
			CapDrop:        []string{"ALL"},
			SecurityOpt:    []string{"no-new-privileges:true"},
			ReadonlyRootfs: true,
			RestartPolicy:  dcontainer.RestartPolicy{Name: dcontainer.RestartPolicyDisabled},
			LogConfig:      container.OneShotLogConfig(),
			Resources:      dcontainer.Resources{Memory: memory, MemorySwap: memory, PidsLimit: &pids},
		},
	}, nil
}

// Worker DNS (docs/nodes.md §6.11).

// workerDNS returns the DNS servers of a worker container that is about to be created or started: the
// resolver's address while it is ready on the current worker network, nothing (Docker's DNS) otherwise.
// While the resolver is starting within the settle window, it returns how long to wait instead. The
// choice is fixed for the container's life: Docker cannot change it. Callers that create a container hold
// dnsMu for reading from here through ContainerCreate.
func (s *session) workerDNS() ([]netip.Addr, time.Duration) {
	if s.d.settings().settings.DNS.Mode == api.ResolverModeDisabled || s.purged.Load() {
		return nil, 0
	}
	rep, f := s.d.resolver.Load(), s.net.Load()
	if rep != nil && rep.report.State == api.ResolverReady && f != nil && rep.gateway == f.gateway {
		return []netip.Addr{f.gateway}, 0
	}
	now := s.d.now()
	if settleBy := time.Unix(0, s.d.rm.settleBy.Load()); (rep == nil || rep.report.State == api.ResolverStarting) && now.Before(settleBy) {
		return nil, min(settleBy.Sub(now), s.d.t.resolverPoll)
	}
	state := "unknown"
	if rep != nil {
		state = rep.report.State
		if rep.report.Error != nil {
			state += "/" + *rep.report.Error
		}
	}
	if prev := s.dnsWarned.Swap(&state); prev == nil || *prev != state {
		s.log.Warn("new workers use Docker's DNS: the node resolver is not ready", "resolverState", state)
	}
	return nil, 0
}
