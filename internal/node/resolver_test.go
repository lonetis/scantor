package node

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"maps"
	"net/netip"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	dcontainer "github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/events"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
	"github.com/lonetis/scantor/internal/redact"
	"github.com/lonetis/scantor/internal/resolver"
)

// The gateway and subnet of scantor-workers, the first network the fake engine creates.
const (
	testGateway = "10.200.1.1"
	testSubnet  = "10.200.1.0/24"
)

// resolverEngine makes the fake engine behave like the scantor image for the node resolver: a started
// resolver passes its healthcheck with stats for its spec, and the probe container prints the answer of
// this node's resolver. Tests change both behaviours.
type resolverEngine struct {
	h  *harness
	mu sync.Mutex
	// health returns the healthcheck result of a resolver of spec right after its start.
	health func(spec string) (dcontainer.HealthStatus, int, string)
	// probe returns the probe container's output.
	probe  func() string
	probes int
}

// enableResolver turns the harness's daemon into one that runs the node resolver (mode recursive and a
// known own image) on the fake engine.
func enableResolver(h *harness) *resolverEngine {
	h.t.Helper()
	h.withSelf()
	r := &resolverEngine{h: h}
	r.health = func(spec string) (dcontainer.HealthStatus, int, string) {
		return dcontainer.Healthy, 0, statsLine(h.orch.nodeID, spec, true) + "\n"
	}
	r.probe = func() string { return probeLine(resolver.ProbeResult{OK: true, Node: h.orch.nodeID, MS: 2}) }
	h.docker.onStartPrefix["scantor-dns-"] = func(f *fakeDocker, c *fakeContainer) {
		r.mu.Lock()
		health := r.health
		r.mu.Unlock()
		status, code, out := health(c.config.Labels[container.LabelSpecHash])
		f.setHealth(c.name, status, code, out)
	}
	h.docker.onStartPrefix["scantor-dnsprobe-"] = func(f *fakeDocker, c *fakeContainer) {
		r.mu.Lock()
		r.probes++
		out := r.probe()
		r.mu.Unlock()
		f.mu.Lock()
		f.logs[c.name] = out
		f.mu.Unlock()
		f.exit(c.name, 0, false)
	}
	return r
}

func (r *resolverEngine) setHealth(f func(spec string) (dcontainer.HealthStatus, int, string)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.health = f
}

func (r *resolverEngine) setProbe(f func() string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.probe = f
}

func (r *resolverEngine) probeCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.probes
}

func statsLine(nodeID, spec string, upstreamOK bool) string {
	b, _ := json.Marshal(resolver.Stats{
		V: 1, Ready: true, Node: nodeID, Spec: spec, Mode: "recursive", Listen: testGateway + ":53", UpstreamOK: upstreamOK,
		Queries: 10, CacheHits: 5, Lookups: 5, Inflight: 1, Timeouts: 2, Rcodes: resolver.Rcodes{NoError: 7, ServFail: 1},
		QPS: 1.5, Conntrack: resolver.Conntrack{Count: 100, Max: 1000},
	})
	return string(b)
}

func probeLine(res resolver.ProbeResult) string {
	b, _ := json.Marshal(res)
	return "lookup resolver.scantor.invalid\n" + string(b) + "\n"
}

// resolverHarness returns a started daemon with the node resolver enabled.
func resolverHarness(t *testing.T, mutate func(*Config)) (*harness, *resolverEngine) {
	t.Helper()
	h := newHarness(t, func(c *Config) {
		c.Settings.DNS.Mode = api.ResolverModeRecursive
		if mutate != nil {
			mutate(c)
		}
	})
	h.orch.config.EndpointHosts = []string{"s3.scantor.example.com", "scantor.example.com"}
	return h, enableResolver(h)
}

// waitResolver waits until a status reports the resolver in state and returns that report.
func (h *harness) waitResolver(msg string, cond func(*api.NodeResolverReport) bool) api.NodeResolverReport {
	h.t.Helper()
	var got api.NodeResolverReport
	eventually(h.t, 5*time.Second, msg, func() bool {
		st := h.orch.lastStatus()
		if st != nil && st.Info.Resolver != nil && cond(st.Info.Resolver) {
			got = *st.Info.Resolver
			return true
		}
		return false
	})
	return got
}

func stateIs(state string) func(*api.NodeResolverReport) bool {
	return func(r *api.NodeResolverReport) bool { return r.State == state }
}

// resolverContainers returns snapshots of the resolver containers of the fake engine, by name.
func (f *fakeDocker) resolverContainers() map[string]*fakeContainer {
	f.mu.Lock()
	var ids []string
	for _, c := range f.containers {
		if strings.HasPrefix(c.name, "scantor-dns-") {
			ids = append(ids, c.id)
		}
	}
	f.mu.Unlock()
	out := map[string]*fakeContainer{}
	for _, id := range ids {
		if c := f.snapshot(id); c != nil {
			out[c.name] = c
		}
	}
	return out
}

// onlyResolver returns a snapshot of the only resolver container.
func (f *fakeDocker) onlyResolver(t *testing.T) *fakeContainer {
	t.Helper()
	all := f.resolverContainers()
	if len(all) != 1 {
		t.Fatalf("resolver containers = %v, want exactly one", slices.Sorted(maps.Keys(all)))
	}
	for _, c := range all {
		return c
	}
	return nil
}

// The node resolver runs from the daemon's own image, is probed through the worker network, and new
// workers resolve through it. The daemon leaves it running when it stops.
func TestResolverServesNewWorkers(t *testing.T) {
	h, r := resolverHarness(t, nil)
	h.start()
	rep := h.waitResolver("resolver ready", stateIs(api.ResolverReady))
	c := h.docker.onlyResolver(t)
	spec := c.config.Labels[container.LabelSpecHash]
	if c.name != resolverName(h.orch.nodeID, spec) || !validSpecHash(spec) || c.state.Status != dcontainer.StateRunning {
		t.Errorf("resolver container %s spec %s state %s", c.name, spec, c.state.Status)
	}
	wantStats := api.NodeResolverStats{Queries: 10, CacheHits: 5, Lookups: 5, Failures: 3, Inflight: 1, QPS: 1.5, ConntrackUsed: 0.1}
	if rep.Mode != api.ResolverModeRecursive || rep.Address != testGateway || rep.Spec != spec || rep.Error != nil || rep.Kept ||
		!rep.UpstreamOK || rep.Stats == nil || *rep.Stats != wantStats {
		t.Errorf("report = %+v stats %+v", rep, rep.Stats)
	}
	if r.probeCount() != 1 || h.docker.container("scantor-dnsprobe-"+h.orch.nodeID) != nil {
		t.Errorf("probes = %d; the probe container must be removed", r.probeCount())
	}
	// The resolver's configuration: the worker network, the master's hosts and the defaults.
	var cfg resolver.Config
	dec := json.NewDecoder(strings.NewReader(c.config.Cmd[6]))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		t.Fatal(err)
	}
	// The daemon's SCANTOR_URL (the fake orchestrator) has an IP literal, which is no local name.
	if cfg.NodeID != h.orch.nodeID || cfg.Listen != testGateway+":53" || !slices.Equal(cfg.Clients, []string{testSubnet}) ||
		!slices.Equal(cfg.Upstreams, []string{"1.1.1.1:53", "8.8.8.8:53"}) ||
		!slices.Equal(cfg.LocalNames, []string{"s3.scantor.example.com", "scantor.example.com"}) || !slices.Contains(cfg.LocalDomains, "internal") {
		t.Errorf("config = %+v", cfg)
	}
	if resolver.SpecHash(c.config.Image, cfg) != spec {
		t.Error("the spec hash label does not cover the image and the configuration")
	}

	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	w := h.docker.container(workerName(testWorker1))
	if !slices.Equal(w.host.DNS, []netip.Addr{netip.MustParseAddr(testGateway)}) {
		t.Errorf("worker Dns = %v, want the resolver", w.host.DNS)
	}
	h.orch.mu.Lock()
	hello := h.orch.hellos[0]
	h.orch.mu.Unlock()
	if hello.Info.Resolver != nil {
		t.Errorf("the first hello reported a resolver before the daemon knew it: %+v", hello.Info.Resolver)
	}
	if err := h.stop(); err != nil {
		t.Fatal(err)
	}
	if c := h.docker.onlyResolver(t); c.state.Status != dcontainer.StateRunning {
		t.Error("the resolver must keep running when the daemon stops")
	}
}

// A restarted daemon adopts the running resolver (same container) and probes it at once.
func TestResolverIsAdoptedByTheNextDaemon(t *testing.T) {
	h, r := resolverHarness(t, nil)
	h.start()
	h.waitResolver("resolver ready", stateIs(api.ResolverReady))
	first := h.docker.onlyResolver(t)
	if err := h.stop(); err != nil {
		t.Fatal(err)
	}
	probes := r.probeCount()
	statuses := h.orch.statusCount()
	d, err := New(Options{Config: h.d.cfg, Docker: h.docker, Logger: redact.NewLogger(h.logs, redact.FormatText, slog.LevelDebug)})
	if err != nil {
		t.Fatal(err)
	}
	d.t, d.statusFile, d.diskFree, d.mountinfo, d.binarySource = h.d.t, h.d.statusFile, h.d.diskFree, h.d.mountinfo, h.d.binarySource
	h.d = d
	h.start()
	eventually(t, 5*time.Second, "ready again", func() bool {
		st := h.orch.lastStatus()
		return h.orch.statusCount() > statuses && st.Info.Resolver != nil && st.Info.Resolver.State == api.ResolverReady
	})
	if c := h.docker.onlyResolver(t); c.id != first.id || c.starts != 1 {
		t.Error("the resolver was recreated or restarted instead of adopted")
	}
	if r.probeCount() <= probes {
		t.Error("the adopted resolver was not probed")
	}
}

// The resolver container spec of docs/nodes.md §6.11, field by field.
func TestResolverContainerSpec(t *testing.T) {
	cfg := resolver.Config{
		NodeID: testNodeID, Listen: "10.10.0.1:53", Clients: []string{"10.10.0.0/24"}, Mode: "recursive",
		Upstreams: []string{"1.1.1.1:53"}, RootServers: []string{}, LocalNames: []string{}, LocalDomains: []string{"internal"},
		DenyServers: []string{"169.254.0.0/16"}, TrustedServers: []string{}, CacheBytes: 256 << 20, MaxLookups: 1000,
		AuthoritativeQPS: 200, LogLevel: "info", LogFormat: "json",
	}.Normalize()
	hash := resolver.SpecHash("sha256:abc", cfg)
	want := &resolverSpec{mode: "recursive", image: "sha256:abc", cfg: cfg, hash: hash, name: resolverName(testNodeID, hash)}
	opts, err := resolverCreateOptions(want, testNodeID, hostInfo{cpus: 64}, "host")
	if err != nil {
		t.Fatal(err)
	}
	c, hc := opts.Config, opts.HostConfig
	if opts.Name != "scantor-dns-"+testNodeID+"-"+strings.TrimPrefix(hash, "sha256:")[:12] || c.Image != "sha256:abc" || c.User != "0:0" {
		t.Errorf("name %q image %q user %q", opts.Name, c.Image, c.User)
	}
	if !slices.Equal(c.Entrypoint, []string{"/usr/local/bin/scantor"}) || len(c.Cmd) != 7 ||
		!slices.Equal(c.Cmd[:6], []string{"node", "resolver", "serve", "--spec-hash", hash, "--config"}) {
		t.Errorf("command = %v %v", c.Entrypoint, c.Cmd)
	}
	var back resolver.Config
	dec := json.NewDecoder(strings.NewReader(c.Cmd[6]))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&back); err != nil || back.Listen != cfg.Listen || back.CacheBytes != cfg.CacheBytes {
		t.Errorf("--config %s: %v", c.Cmd[6], err)
	}
	if !slices.Equal(c.Env, []string{"GOMAXPROCS=16", "GOMEMLIMIT=1GiB"}) {
		t.Errorf("env = %v", c.Env)
	}
	wantLabels, _ := container.ManagedLabels(container.KindResolver, container.Identity{Node: testNodeID, SpecHash: hash})
	if !maps.Equal(c.Labels, wantLabels) || c.Labels["scantor.kind"] != "resolver" || c.Labels["traefik.enable"] != "false" {
		t.Errorf("labels = %v", c.Labels)
	}
	if c.StopTimeout == nil || *c.StopTimeout != 10 {
		t.Errorf("stop timeout = %v", c.StopTimeout)
	}
	if hcheck := c.Healthcheck; hcheck == nil || strings.Join(hcheck.Test, " ") != "CMD /usr/local/bin/scantor node resolver healthcheck" ||
		hcheck.Interval != 10*time.Second || hcheck.Timeout != 5*time.Second || hcheck.Retries != 3 || hcheck.StartPeriod != 30*time.Second || hcheck.StartInterval != time.Second {
		t.Errorf("healthcheck = %+v", c.Healthcheck)
	}
	switch {
	case string(hc.NetworkMode) != "host" || hc.UsernsMode != "":
		t.Errorf("network %q userns %q", hc.NetworkMode, hc.UsernsMode)
	case !slices.Equal(hc.CapDrop, []string{"ALL"}) || !slices.Equal(hc.CapAdd, []string{"NET_BIND_SERVICE"}) || hc.Privileged:
		t.Errorf("capabilities drop %v add %v privileged %v", hc.CapDrop, hc.CapAdd, hc.Privileged)
	case !slices.Equal(hc.SecurityOpt, []string{"no-new-privileges:true"}) || !hc.ReadonlyRootfs || len(hc.Tmpfs) != 1 || hc.Tmpfs["/run"] != "size=1m":
		t.Errorf("security %v read-only %v tmpfs %v", hc.SecurityOpt, hc.ReadonlyRootfs, hc.Tmpfs)
	case hc.PidsLimit == nil || *hc.PidsLimit != 1024 || hc.Memory != 1280<<20 || hc.MemorySwap != 1280<<20 || hc.NanoCPUs != 0:
		t.Errorf("limits pids %v memory %d/%d cpus %d", hc.PidsLimit, hc.Memory, hc.MemorySwap, hc.NanoCPUs)
	case len(hc.Ulimits) != 1 || hc.Ulimits[0].Name != "nofile" || hc.Ulimits[0].Soft != 65536 || hc.Ulimits[0].Hard != 65536:
		t.Errorf("ulimits %+v", hc.Ulimits)
	case hc.RestartPolicy.Name != dcontainer.RestartPolicyDisabled || hc.Init != nil:
		t.Errorf("restart %q init %v", hc.RestartPolicy.Name, hc.Init)
	case hc.LogConfig.Type != "local" || hc.LogConfig.Config["max-size"] != "10m" || hc.LogConfig.Config["max-file"] != "3":
		t.Errorf("log config %+v", hc.LogConfig)
	case len(hc.Mounts) != 0 || len(hc.Binds) != 0 || len(hc.PortBindings) != 0 || len(hc.DNS) != 0:
		t.Errorf("mounts %v binds %v ports %v dns %v", hc.Mounts, hc.Binds, hc.PortBindings, hc.DNS)
	}
	body := createBody(t, opts)
	if body["StopTimeout"] != float64(10) {
		t.Errorf("StopTimeout belongs to the container config: %v", body["StopTimeout"])
	}

	// Small hosts and large lookups: GOMAXPROCS follows the CPUs, nofile the lookups; user namespace
	// remapping needs the host's user namespace for a host-network container.
	want.cfg.MaxLookups = 20000
	opts, err = resolverCreateOptions(want, testNodeID, hostInfo{cpus: 2, userns: true}, "host")
	if err != nil {
		t.Fatal(err)
	}
	if opts.HostConfig.UsernsMode != "host" || opts.HostConfig.Ulimits[0].Soft != 81024 || opts.Config.Env[0] != "GOMAXPROCS=2" {
		t.Errorf("userns %q nofile %d env %v", opts.HostConfig.UsernsMode, opts.HostConfig.Ulimits[0].Soft, opts.Config.Env)
	}
}

// The probe container: the daemon's image on the worker network with the resolver as DNS server, as
// nobody, without capabilities, a one-shot without healthcheck.
func TestResolverProbeContainerSpec(t *testing.T) {
	f := &netFacts{name: "scantor-workers", gateway: netip.MustParseAddr("10.10.0.1"), subnets: []netip.Prefix{netip.MustParsePrefix("10.10.0.0/24")}}
	opts, err := probeCreateOptions("scantor-dnsprobe-"+testNodeID, "sha256:abc", testNodeID, f)
	if err != nil {
		t.Fatal(err)
	}
	c, hc := opts.Config, opts.HostConfig
	if opts.Name != "scantor-dnsprobe-"+testNodeID || c.Image != "sha256:abc" || c.User != "65534:65534" || !slices.Equal(c.Env, []string{"GOMAXPROCS=2"}) ||
		!slices.Equal(c.Entrypoint, []string{"/usr/local/bin/scantor"}) || !slices.Equal(c.Cmd, []string{"node", "resolver", "probe"}) {
		t.Errorf("config = %+v", c)
	}
	if c.Labels["scantor.kind"] != "resolverProbe" || c.Labels["scantor.node"] != testNodeID || c.Healthcheck == nil || !slices.Equal(c.Healthcheck.Test, []string{"NONE"}) {
		t.Errorf("labels %v healthcheck %+v", c.Labels, c.Healthcheck)
	}
	if string(hc.NetworkMode) != "scantor-workers" || !slices.Equal(hc.DNS, []netip.Addr{f.gateway}) || !slices.Equal(hc.CapDrop, []string{"ALL"}) || len(hc.CapAdd) != 0 ||
		!slices.Equal(hc.SecurityOpt, []string{"no-new-privileges:true"}) || !hc.ReadonlyRootfs || hc.PidsLimit == nil || *hc.PidsLimit != 128 ||
		hc.Memory != 64<<20 || hc.MemorySwap != 64<<20 || hc.RestartPolicy.Name != dcontainer.RestartPolicyDisabled {
		t.Errorf("host config = %+v", hc)
	}
	// The daemon reads the probe's result from its logs, whatever the engine's default log driver.
	if hc.LogConfig.Type != "local" || !maps.Equal(hc.LogConfig.Config, map[string]string{"max-size": "1m", "max-file": "1", "compress": "false"}) {
		t.Errorf("log config = %+v", hc.LogConfig)
	}
}

// newTestSession returns a session (not started) of a daemon on a fake engine, for direct tests of the
// manager's parts.
func newTestSession(t *testing.T, mutate func(*Config), hosts ...string) *session {
	t.Helper()
	cfg := Config{
		URL: "https://scantor.example.com", Token: testToken, DinD: DinDDisabled, LogFormat: redact.FormatText,
		EgressDeny: prefixes("169.254.0.0/16"), Overrides: OverrideAllowList{All: true}, Settings: testDaemonSettings(),
	}
	cfg.Settings.DNS.Mode = api.ResolverModeRecursive
	if mutate != nil {
		mutate(&cfg)
	}
	d, err := New(Options{Config: cfg, Docker: newFakeDocker(), Logger: redact.NewLogger(&syncBuffer{}, redact.FormatText, slog.LevelDebug)})
	if err != nil {
		t.Fatal(err)
	}
	d.t = testTimings()
	d.resolverImage = "sha256:abc"
	s := newSession(t.Context(), d, &api.NodeHelloResponse{
		Node:   api.NodeIdentity{ID: testNodeID},
		Config: api.NodeConfig{StatusIntervalMs: 200, EndpointHosts: hosts},
	})
	s.net.Store(&netFacts{name: "scantor-workers", gateway: netip.MustParseAddr("10.10.0.1"), subnets: []netip.Prefix{netip.MustParsePrefix("10.10.0.0/24")}})
	return s
}

// The spec hash depends on the content only: the order of the master's hosts and the daemon's log level
// never replace the resolver; a changed setting does. Every server of the environment is trusted, no
// override server is.
func TestResolverSpecHash(t *testing.T) {
	s := newTestSession(t, func(c *Config) { c.Settings.DNS.Upstreams = []string{"172.17.0.1", "1.1.1.1:53", "host"} }, "a.example", "b.example")
	other := newTestSession(t, func(c *Config) {
		c.Settings.DNS.Upstreams = []string{"host", "1.1.1.1", "172.17.0.1:53"}
		c.Settings.LogLevel = slog.LevelError
	}, "b.example", "A.Example.")
	w1, w2 := s.desiredResolver(), other.desiredResolver()
	if w1.hash == "" || w1.hash != w2.hash || w1.name != w2.name {
		t.Errorf("hashes %s / %s differ for the same content", w1.hash, w2.hash)
	}
	cfg := w1.cfg
	if !slices.Equal(cfg.LocalNames, []string{"a.example", "b.example", "scantor.example.com"}) || !cfg.UseHostNameservers ||
		!slices.Equal(cfg.Upstreams, []string{"1.1.1.1:53", "172.17.0.1:53"}) || !slices.Equal(cfg.TrustedServers, []string{"1.1.1.1:53", "172.17.0.1:53"}) ||
		!slices.Equal(cfg.DenyServers, []string{"169.254.0.0/16"}) || !slices.Equal(cfg.Clients, []string{"10.10.0.0/24"}) ||
		!slices.Contains(cfg.LocalDomains, "16.172.in-addr.arpa") || !slices.Contains(cfg.LocalDomains, "home.arpa") || cfg.Listen != "10.10.0.1:53" {
		t.Errorf("config = %+v", cfg)
	}
	// An override server is never trusted (the environment's stay), a changed setting changes the hash.
	s.d.applyOverrides(overrides(1, `{"dns": {"upstreams": ["9.9.9.9"], "maxLookups": 10}}`), s.log)
	w3 := s.desiredResolver()
	if w3.hash == w1.hash || !slices.Equal(w3.cfg.Upstreams, []string{"9.9.9.9:53"}) || w3.cfg.UseHostNameservers ||
		!slices.Equal(w3.cfg.TrustedServers, []string{"1.1.1.1:53", "172.17.0.1:53"}) || w3.cfg.MaxLookups != 10 {
		t.Errorf("after the override: hash %s upstreams %v trusted %v", w3.hash, w3.cfg.Upstreams, w3.cfg.TrustedServers)
	}
	// An IP literal in SCANTOR_URL is no local name.
	ip := newTestSession(t, func(c *Config) { c.URL = "http://10.0.0.5:3000" })
	if names := ip.desiredResolver().cfg.LocalNames; len(names) != 0 {
		t.Errorf("local names = %v", names)
	}
}

// Every upstream and root server of the environment is trusted for its route, whatever its address
// (loopback, private, link-local, inside the deny list); the host keyword is no server. They stay
// trusted while an override switches the mode or replaces the servers, whose own servers never are.
func TestResolverTrustsEveryEnvironmentServer(t *testing.T) {
	s := newTestSession(t, func(c *Config) {
		c.Settings.DNS.Upstreams = []string{"host", "169.254.169.253", "127.0.0.53:5353", "9.9.9.9"}
		c.Settings.DNS.RootServers = []string{"10.0.0.1:1053", "[fd00::53]:53"}
	})
	trusted := []string{"10.0.0.1:1053", "127.0.0.53:5353", "169.254.169.253:53", "9.9.9.9:53", "[fd00::53]:53"}
	cfg := s.resolverConfig(s.d.settings().settings.DNS, s.net.Load())
	if !slices.Equal(cfg.TrustedServers, trusted) || !cfg.UseHostNameservers ||
		!slices.Equal(cfg.Upstreams, []string{"127.0.0.53:5353", "169.254.169.253:53", "9.9.9.9:53"}) {
		t.Errorf("upstreams %v trusted %v", cfg.Upstreams, cfg.TrustedServers)
	}
	s.d.applyOverrides(overrides(1, `{"dns": {"mode": "iterative", "upstreams": ["1.0.0.1"], "rootServers": ["192.0.2.53"]}}`), s.log)
	if e := s.d.settings(); len(e.rejected) != 0 {
		t.Fatalf("rejected = %v", e.rejected)
	}
	cfg = s.resolverConfig(s.d.settings().settings.DNS, s.net.Load())
	if !slices.Equal(cfg.TrustedServers, trusted) || !slices.Equal(cfg.Upstreams, []string{"1.0.0.1:53"}) || !slices.Equal(cfg.RootServers, []string{"192.0.2.53:53"}) {
		t.Errorf("after the override: upstreams %v roots %v trusted %v", cfg.Upstreams, cfg.RootServers, cfg.TrustedServers)
	}
}

// resolverDetailPattern is the alphabet and length of a resolver detail the orchestrator stores.
var resolverDetailPattern = regexp.MustCompile(`^[A-Za-z0-9 .:,;/\[\]()=%+_-]{0,256}$`)

// The daemon never creates a resolver for a configuration the resolver refuses: the state is failed with
// createFailed and the reason as detail, and workers use Docker's DNS without waiting.
func TestResolverInvalidConfiguration(t *testing.T) {
	h, _ := resolverHarness(t, nil)
	h.orch.config.EndpointHosts = []string{"bad host.example", "scantor.example.com"}
	h.start()
	rep := h.waitResolver("failed", stateIs(api.ResolverFailed))
	if rep.Error == nil || *rep.Error != api.ResolverErrCreateFailed || rep.Address != "" ||
		!strings.Contains(rep.Detail, "localNames: invalid domain name bad host.example") || !resolverDetailPattern.MatchString(rep.Detail) {
		t.Errorf("report = %+v", rep)
	}
	if !h.logContains("configuration is invalid") || !h.logContains(`invalid domain name \"bad host.example\"`) {
		t.Error("the invalid configuration was not logged with its error and a hint")
	}
	start := time.Now()
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	if time.Since(start) > time.Second || len(h.docker.container(workerName(testWorker1)).host.DNS) != 0 {
		t.Error("a worker waited for a resolver that cannot run, or got its address")
	}
	if n := h.docker.namedCount("create", "scantor-dns-"); n != 0 {
		t.Errorf("%d resolver containers created for an invalid configuration", n)
	}
}

// A report detail keeps the orchestrator's alphabet and length: line breaks become "; ", quotes go.
func TestReportDetail(t *testing.T) {
	got := reportDetail("resolver config: upstreams: server \"[fe80::1]:53\": link-local addresses are not supported\n" +
		"localNames: invalid domain name \"a b\"\n\tdenyServers: at most 256 entries")
	want := "resolver config: upstreams: server [fe80::1]:53: link-local addresses are not supported; localNames: invalid domain name a b; denyServers: at most 256 entries"
	if got != want {
		t.Errorf("detail =\n%q\nwant\n%q", got, want)
	}
	for _, msg := range []string{strings.Repeat("x", 300), "é<>{}\"'`\x00\x7f" + strings.Repeat("ab; ", 100)} {
		if d := reportDetail(msg); !resolverDetailPattern.MatchString(d) {
			t.Errorf("detail %q of %q", d, msg)
		}
	}
	err := resolver.Config{NodeID: testNodeID, Listen: "10.10.0.1:53", Mode: "recursive", Upstreams: []string{"1.1.1.1:53"},
		LocalNames: []string{`a"b`}, CacheBytes: 1, MaxLookups: 1}.Validate()
	if err == nil || !resolverDetailPattern.MatchString(reportDetail(err.Error())) {
		t.Errorf("Validate: %v → %q", err, reportDetail(fmt.Sprint(err)))
	}
}

// Workers get the resolver only while it is ready on the current worker network; while it is starting
// they wait at most until the settle time, otherwise they keep Docker's DNS.
func TestWorkerDNSChoice(t *testing.T) {
	s := newTestSession(t, nil)
	gw := netip.MustParseAddr("10.10.0.1")
	publish := func(state string, gateway netip.Addr) {
		s.d.resolver.Store(&resolverReport{report: api.NodeResolverReport{State: state}, gateway: gateway})
	}
	s.d.rm.settle(time.Now().Add(time.Hour))
	if dns, wait := s.workerDNS(); dns != nil || wait <= 0 || wait > s.d.t.resolverPoll {
		t.Errorf("no report yet: %v %s, want a short wait", dns, wait)
	}
	publish(api.ResolverStarting, netip.Addr{})
	if dns, wait := s.workerDNS(); dns != nil || wait <= 0 {
		t.Errorf("starting: %v %s, want a wait", dns, wait)
	}
	publish(api.ResolverReady, gw)
	if dns, wait := s.workerDNS(); !slices.Equal(dns, []netip.Addr{gw}) || wait != 0 {
		t.Errorf("ready: %v %s", dns, wait)
	}
	publish(api.ResolverReady, netip.MustParseAddr("10.20.0.1")) // the network was recreated meanwhile
	if dns, wait := s.workerDNS(); dns != nil || wait != 0 {
		t.Errorf("ready on another gateway: %v %s", dns, wait)
	}
	for _, state := range []string{api.ResolverDegraded, api.ResolverUnreachable, api.ResolverFailed} {
		publish(state, gw)
		if dns, wait := s.workerDNS(); dns != nil || wait != 0 {
			t.Errorf("%s: %v %s", state, dns, wait)
		}
	}
	publish(api.ResolverStarting, gw)
	s.d.rm.settle(time.Now().Add(-time.Second))
	if dns, wait := s.workerDNS(); dns != nil || wait != 0 {
		t.Errorf("starting after the settle time: %v %s", dns, wait)
	}
	publish(api.ResolverReady, gw)
	s.purged.Store(true)
	if dns, _ := s.workerDNS(); dns != nil {
		t.Error("purged: the resolver goes away")
	}
	s.purged.Store(false)
	s.d.applyOverrides(overrides(1, `{"dns": {"mode": "disabled"}}`), s.log)
	if dns, wait := s.workerDNS(); dns != nil || wait != 0 {
		t.Errorf("disabled: %v %s", dns, wait)
	}
}

// A dns override replaces the resolver blue/green: the new one must be healthy before the old one is
// stopped (with its drain grace) and removed, the state stays ready throughout, and the new one is probed.
func TestResolverReplacementIsBlueGreen(t *testing.T) {
	h, r := resolverHarness(t, nil)
	h.d.t.resolverHealthWait = 5 * time.Second
	h.start()
	h.waitResolver("resolver ready", stateIs(api.ResolverReady))
	old := h.docker.onlyResolver(t)
	oldRef := h.docker.container(old.id)
	probes := r.probeCount()
	r.setHealth(func(string) (dcontainer.HealthStatus, int, string) { return dcontainer.Starting, 1, "starting\n" })
	h.orch.setOverrides(1, `{"dns": {"maxLookups": 500}}`)
	var fresh *fakeContainer
	eventually(t, 5*time.Second, "new resolver created", func() bool {
		for name, c := range h.docker.resolverContainers() {
			if name != old.name {
				fresh = c
				return true
			}
		}
		return false
	})
	time.Sleep(200 * time.Millisecond)
	if c := h.docker.snapshot(old.id); c == nil || c.state.Status != dcontainer.StateRunning {
		t.Fatal("the old resolver was stopped before the new one was healthy")
	}
	if st := h.orch.lastStatus(); st.Info.Resolver.State != api.ResolverReady || st.Info.Resolver.Spec != old.config.Labels[container.LabelSpecHash] {
		t.Errorf("during the replacement: %+v", st.Info.Resolver)
	}
	spec := fresh.config.Labels[container.LabelSpecHash]
	h.docker.setHealth(fresh.name, dcontainer.Healthy, 0, statsLine(h.orch.nodeID, spec, true))
	h.waitResolver("the new resolver serves", func(r *api.NodeResolverReport) bool { return r.State == api.ResolverReady && r.Spec == spec })
	eventually(t, 5*time.Second, "old resolver removed", func() bool { return h.docker.container(old.id) == nil })
	if args := h.docker.stopArgsOf(oldRef); !slices.Equal(args, []int{10}) {
		t.Errorf("old resolver stop timeouts = %v, want [10]", args)
	}
	eventually(t, 5*time.Second, "probe after the replacement", func() bool { return r.probeCount() > probes })
}

// A replacement that does not become healthy is removed while the old resolver keeps serving; the spec
// backs off and is retried, and succeeds once it is healthy.
func TestResolverFailedReplacementKeepsTheOldOne(t *testing.T) {
	h, r := resolverHarness(t, nil)
	var mu sync.Mutex
	var creates []time.Time
	h.docker.createErr = func(opts client.ContainerCreateOptions) error {
		if strings.HasPrefix(opts.Name, "scantor-dns-") {
			mu.Lock()
			creates = append(creates, time.Now())
			mu.Unlock()
		}
		return nil
	}
	h.start()
	h.waitResolver("resolver ready", stateIs(api.ResolverReady))
	old := h.docker.onlyResolver(t)
	var replacements []*fakeContainer // guarded by mu
	r.setHealth(func(spec string) (dcontainer.HealthStatus, int, string) {
		h.docker.mu.Lock()
		for _, c := range h.docker.containers {
			if c.config.Labels[container.LabelSpecHash] == spec {
				mu.Lock()
				replacements = append(replacements, c)
				mu.Unlock()
			}
		}
		h.docker.mu.Unlock()
		return dcontainer.Unhealthy, 1, statsLine(h.orch.nodeID, spec, false) + "\nno upstream server answers\n"
	})
	h.orch.setOverrides(1, `{"dns": {"upstreams": ["9.9.9.9"]}}`)
	rep := h.waitResolver("failed replacement reported", func(r *api.NodeResolverReport) bool { return r.Error != nil })
	// The report is the old resolver's: it serves, its upstream servers answer.
	if rep.State != api.ResolverReady || *rep.Error != api.ResolverErrUpstreamUnreachable || rep.Spec != old.config.Labels[container.LabelSpecHash] || !rep.UpstreamOK {
		t.Errorf("report = %+v", rep)
	}
	// The failed replacement may already answer queries: it is stopped with the drain grace first.
	var first *fakeContainer
	eventually(t, 5*time.Second, "the failed replacement removed", func() bool {
		mu.Lock() // the hooks take mu inside h.docker.mu: never call h.docker while holding it
		if len(replacements) > 0 {
			first = replacements[0]
		}
		mu.Unlock()
		return first != nil && h.docker.container(first.id) == nil
	})
	if args := h.docker.stopArgsOf(first); !slices.Equal(args, []int{10}) {
		t.Errorf("failed replacement stop timeouts = %v, want [10]", args)
	}
	eventually(t, 5*time.Second, "three attempts", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(creates) >= 4
	})
	mu.Lock()
	gaps := []time.Duration{creates[2].Sub(creates[1]), creates[3].Sub(creates[2])}
	mu.Unlock()
	if gaps[0] < 90*time.Millisecond || gaps[1] < 180*time.Millisecond {
		t.Errorf("retry gaps %v, want the backoff to grow from 100 ms", gaps)
	}
	if c := h.docker.snapshot(old.id); c == nil || c.state.Status != dcontainer.StateRunning || len(h.docker.resolverContainers()) > 2 {
		t.Fatal("the old resolver must keep serving")
	}
	r.setHealth(func(spec string) (dcontainer.HealthStatus, int, string) {
		return dcontainer.Healthy, 0, statsLine(h.orch.nodeID, spec, true)
	})
	h.waitResolver("the replacement succeeded", func(r *api.NodeResolverReport) bool {
		return r.State == api.ResolverReady && r.Error == nil && r.Spec != old.config.Labels[container.LabelSpecHash]
	})
	eventually(t, 5*time.Second, "old resolver removed", func() bool { return h.docker.container(old.id) == nil })
}

// A replacement that exits before it is healthy is removed as well; the old resolver keeps serving.
func TestResolverExitedReplacementKeepsTheOldOne(t *testing.T) {
	h, r := resolverHarness(t, nil)
	h.start()
	h.waitResolver("resolver ready", stateIs(api.ResolverReady))
	old := h.docker.onlyResolver(t)
	r.setHealth(func(spec string) (dcontainer.HealthStatus, int, string) {
		h.docker.mu.Lock()
		defer h.docker.mu.Unlock()
		for _, c := range h.docker.containers {
			if c.config.Labels[container.LabelSpecHash] == spec {
				h.docker.exitLocked(c, 3, false)
			}
		}
		return dcontainer.Starting, 1, ""
	})
	h.orch.setOverrides(1, `{"dns": {"cacheSizeBytes": 33554432}}`)
	rep := h.waitResolver("failed replacement reported", func(r *api.NodeResolverReport) bool { return r.Error != nil })
	if rep.State != api.ResolverReady || *rep.Error != api.ResolverErrCrashLoop || rep.Detail != "exit code 3" || rep.Spec != old.config.Labels[container.LabelSpecHash] {
		t.Errorf("report = %+v", rep)
	}
	eventually(t, 5*time.Second, "the exited replacement removed", func() bool { return len(h.docker.resolverContainers()) == 1 })
	if c := h.docker.snapshot(old.id); c == nil || c.state.Status != dcontainer.StateRunning {
		t.Fatal("the old resolver must keep serving")
	}
}

// Mode disabled keeps the resolver while worker containers of this node exist (their DNS cannot change)
// and removes it when none is left; new workers use Docker's DNS.
func TestResolverDisabledKeepsItForExistingWorkers(t *testing.T) {
	h, _ := resolverHarness(t, nil)
	h.start()
	h.waitResolver("resolver ready", stateIs(api.ResolverReady))
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	c := h.docker.container(h.docker.onlyResolver(t).id)
	h.orch.setOverrides(1, `{"dns": {"mode": "disabled"}}`)
	rep := h.waitResolver("disabled, kept", func(r *api.NodeResolverReport) bool { return r.State == api.ResolverDisabled && r.Kept })
	if rep.Mode != api.ResolverModeDisabled || rep.Address != testGateway || rep.Error != nil {
		t.Errorf("report = %+v", rep)
	}
	h.orch.setDesired(testAssignment(testWorker1), testAssignment(testWorker2))
	h.waitWorkerState(testWorker2, api.NodeWorkerRunning)
	if w := h.docker.container(workerName(testWorker2)); len(w.host.DNS) != 0 {
		t.Errorf("a worker created in mode disabled got Dns %v", w.host.DNS)
	}
	if h.docker.container(c.id) == nil {
		t.Fatal("the resolver was removed while workers use it")
	}
	h.orch.setDesired()
	h.waitResolver("disabled, removed", func(r *api.NodeResolverReport) bool { return r.State == api.ResolverDisabled && !r.Kept })
	eventually(t, 5*time.Second, "resolver removed", func() bool { return h.docker.container(c.id) == nil })
	if args := h.docker.stopArgsOf(c); !slices.Equal(args, []int{10}) {
		t.Errorf("stop timeouts = %v", args)
	}
}

// A resolver kept for existing workers in mode disabled is started again after an exit with the restart
// backoff: one that keeps exiting is not started on every die event, and it is never recreated.
func TestResolverKeptForWorkersRestartsWithBackoff(t *testing.T) {
	h, r := resolverHarness(t, nil)
	h.start()
	h.waitResolver("resolver ready", stateIs(api.ResolverReady))
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	c := h.docker.onlyResolver(t)
	h.orch.setOverrides(1, `{"dns": {"mode": "disabled"}}`)
	h.waitResolver("disabled, kept", func(r *api.NodeResolverReport) bool { return r.State == api.ResolverDisabled && r.Kept })

	r.setHealth(func(string) (dcontainer.HealthStatus, int, string) {
		h.docker.mu.Lock()
		defer h.docker.mu.Unlock()
		h.docker.exitLocked(h.docker.findContainer(c.id), 2, false)
		return dcontainer.Starting, 1, ""
	})
	h.docker.exit(c.name, 2, false)
	eventually(t, 5*time.Second, "started again", func() bool { return h.docker.snapshot(c.id).starts >= 3 })
	time.Sleep(time.Second)
	// The restart backoff grows from 50 ms to 200 ms: about seven starts in a second, where a start per
	// die event would be hundreds.
	if starts := h.docker.snapshot(c.id).starts; starts > 14 {
		t.Errorf("the crashing kept resolver was started %d times", starts)
	}
	if !h.logContains("the resolver kept for existing workers exited") {
		t.Error("the exits were not logged")
	}

	// Once it runs and is healthy again, its backoff is reset.
	r.setHealth(func(spec string) (dcontainer.HealthStatus, int, string) {
		return dcontainer.Healthy, 0, statsLine(h.orch.nodeID, spec, true)
	})
	eventually(t, 5*time.Second, "running again", func() bool {
		h.docker.mu.Lock()
		defer h.docker.mu.Unlock()
		cc := h.docker.findContainer(c.id)
		return cc != nil && cc.state.Status == dcontainer.StateRunning && cc.health != nil && cc.health.Status == dcontainer.Healthy
	})
	if n := h.docker.namedCount("create", "scantor-dns-"); n != 1 {
		t.Errorf("%d resolvers created; the kept one must be started in place", n)
	}
	h.waitResolver("disabled, kept", func(r *api.NodeResolverReport) bool {
		return r.State == api.ResolverDisabled && r.Kept && r.Address == testGateway
	})
}

// The switch to disabled waits for a worker create that already chose the resolver (dnsMu), and then
// counts that worker, so the resolver stays.
func TestResolverDisableWaitsForACreateInFlight(t *testing.T) {
	h, _ := resolverHarness(t, nil)
	creating, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	h.docker.beforeCreate = func(opts client.ContainerCreateOptions) {
		if opts.Name == workerName(testWorker1) {
			once.Do(func() {
				close(creating)
				<-release
			})
		}
	}
	h.start()
	h.waitResolver("resolver ready", stateIs(api.ResolverReady))
	c := h.docker.onlyResolver(t)
	h.orch.setDesired(testAssignment(testWorker1))
	<-creating
	h.orch.setOverrides(1, `{"dns": {"mode": "disabled"}}`)
	time.Sleep(300 * time.Millisecond)
	if st := h.orch.lastStatus(); st.Info.Resolver.State != api.ResolverReady {
		t.Errorf("the manager went disabled during a create that chose the resolver: %+v", st.Info.Resolver)
	}
	close(release)
	h.waitResolver("disabled, kept", func(r *api.NodeResolverReport) bool { return r.State == api.ResolverDisabled && r.Kept })
	if w := h.docker.container(workerName(testWorker1)); w == nil || !slices.Equal(w.host.DNS, []netip.Addr{netip.MustParseAddr(testGateway)}) {
		t.Fatal("the worker was not created with the resolver")
	}
	if h.docker.container(c.id) == nil {
		t.Error("the resolver of a new worker was removed")
	}
}

// Unauthorized mode creates no resolver or probe container, and its purge removes the resolver once
// the workers are gone.
func TestResolverIsPurgedInUnauthorizedMode(t *testing.T) {
	h, r := resolverHarness(t, nil)
	h.d.t.probeEvery = 50 * time.Millisecond
	h.orch.config.OfflineAfterMs = 400
	h.start()
	h.waitResolver("resolver ready", stateIs(api.ResolverReady))
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	c := h.docker.onlyResolver(t)
	h.orch.mu.Lock()
	h.orch.token = "snt_rotatedrotatedrotatedrotatedrotatedrotate"
	h.orch.mu.Unlock()
	eventually(t, 5*time.Second, "unauthorized mode", func() bool { return h.logContains("not creating containers") })
	time.Sleep(100 * time.Millisecond) // a probe that started before may still finish
	probes := r.probeCount()
	eventually(t, 5*time.Second, "workers removed", func() bool { return h.docker.container(workerName(testWorker1)) == nil })
	eventually(t, 5*time.Second, "resolver removed", func() bool { return h.docker.container(c.id) == nil })
	time.Sleep(200 * time.Millisecond)
	if r.probeCount() != probes || len(h.docker.resolverContainers()) != 0 {
		t.Errorf("probes %d → %d, resolvers %d after the purge", probes, r.probeCount(), len(h.docker.resolverContainers()))
	}
}

// A running resolver of another node on the same gateway is reported and never touched; this node runs
// none, and its workers use Docker's DNS.
func TestResolverOfAnotherNodeIsNotTouched(t *testing.T) {
	h, _ := resolverHarness(t, nil)
	const otherNode = "11111111-2222-4333-8444-555555555555"
	hash := "sha256:" + strings.Repeat("ab", 32)
	labels, _ := container.ManagedLabels(container.KindResolver, container.Identity{Node: otherNode, SpecHash: hash})
	foreign := h.docker.addContainer(resolverName(otherNode, hash), labels, dcontainer.StateRunning)
	foreign.config.Cmd = []string{"node", "resolver", "serve", "--spec-hash", hash, "--config", `{"listen":"` + testGateway + `:53"}`}
	h.start()
	rep := h.waitResolver("foreign resolver reported", stateIs(api.ResolverFailed))
	if rep.Error == nil || *rep.Error != api.ResolverErrForeignResolver || rep.Detail != testGateway+":53" {
		t.Errorf("report = %+v", rep)
	}
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	if w := h.docker.container(workerName(testWorker1)); len(w.host.DNS) != 0 {
		t.Errorf("worker Dns = %v", w.host.DNS)
	}
	if h.docker.namedCount("create", "scantor-dns-") != 0 || h.docker.namedCount("stop", "scantor-dns-") != 0 || h.docker.namedCount("remove", "scantor-dns-") != 0 {
		t.Error("a resolver was created, or the foreign one touched")
	}
	if !h.logContains("the resolver of another node") {
		t.Error("the foreign resolver was not logged")
	}
}

// Without its own image the daemon cannot run the resolver; workers do not wait for it.
func TestResolverWithoutTheDaemonImage(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.Settings.DNS.Mode = api.ResolverModeRecursive })
	h.start()
	rep := h.waitResolver("failed", stateIs(api.ResolverFailed))
	if rep.Error == nil || *rep.Error != api.ResolverErrNoImage {
		t.Errorf("report = %+v", rep)
	}
	start := time.Now()
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	if time.Since(start) > time.Second || len(h.docker.container(workerName(testWorker1)).host.DNS) != 0 {
		t.Error("a worker waited for a resolver that cannot run, or got its address")
	}
}

// The probe: one failed lookup keeps the state; the second in a row makes it unreachable (with the path
// in the detail), a successful probe makes it ready again, and a probe that cannot run changes nothing,
// not even after the last result's validity.
func TestResolverProbeFailures(t *testing.T) {
	h, r := resolverHarness(t, nil)
	h.d.t.probeEvery = 100 * time.Millisecond
	h.d.t.probeRetry = 100 * time.Millisecond
	h.d.t.probeValid = 400 * time.Millisecond
	h.start()
	h.waitResolver("resolver ready", stateIs(api.ResolverReady))

	calls := 0 // guarded by r.mu, which the probe hook holds
	r.setProbe(func() string {
		calls++
		if calls == 1 {
			return probeLine(resolver.ProbeResult{Error: "timeout"})
		}
		return probeLine(resolver.ProbeResult{OK: true, Node: h.orch.nodeID})
	})
	eventually(t, 5*time.Second, "a failed and two good probes", func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		return calls >= 3
	})
	h.orch.mu.Lock()
	for _, st := range h.orch.statuses {
		if st.Info.Resolver != nil && st.Info.Resolver.State == api.ResolverUnreachable {
			t.Error("a single failed probe made the resolver unreachable")
		}
	}
	h.orch.mu.Unlock()

	// Probes that cannot run change nothing, also once the last good probe is older than probeValid.
	r.setProbe(func() string { return "exec failed\n" })
	eventually(t, 5*time.Second, "probe error logged", func() bool { return h.logContains("the probe could not run") })
	statuses := h.orch.statusCount()
	time.Sleep(h.d.t.probeValid + 300*time.Millisecond)
	if st := h.orch.lastStatus(); st.Info.Resolver.State != api.ResolverReady || st.Info.Resolver.Error != nil {
		t.Errorf("a probe that cannot run changed the state: %+v", st.Info.Resolver)
	}
	h.orch.mu.Lock()
	for _, st := range h.orch.statuses[statuses:] {
		if st.Info.Resolver != nil && st.Info.Resolver.State != api.ResolverReady {
			t.Errorf("state %s while the probe could not run", st.Info.Resolver.State)
		}
	}
	h.orch.mu.Unlock()

	r.setProbe(func() string { return probeLine(resolver.ProbeResult{Error: "servfail"}) })
	rep := h.waitResolver("unreachable", stateIs(api.ResolverUnreachable))
	if rep.Error == nil || *rep.Error != api.ResolverErrProbeFailed || rep.Detail != testGateway+":53 from "+testSubnet {
		t.Errorf("report = %+v", rep)
	}
	if !h.logContains("ufw allow from " + testSubnet + " to " + testGateway + " port 53") {
		t.Error("no firewall hint")
	}
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	if w := h.docker.container(workerName(testWorker1)); len(w.host.DNS) != 0 {
		t.Errorf("a worker got an unreachable resolver: %v", w.host.DNS)
	}

	r.setProbe(func() string {
		return probeLine(resolver.ProbeResult{OK: true, Node: "11111111-2222-4333-8444-555555555555"})
	})
	rep = h.waitResolver("foreign answer", stateIs(api.ResolverFailed))
	if rep.Error == nil || *rep.Error != api.ResolverErrForeignResolver {
		t.Errorf("report = %+v", rep)
	}
	r.setProbe(func() string { return probeLine(resolver.ProbeResult{OK: true, Node: h.orch.nodeID}) })
	h.waitResolver("ready again", func(r *api.NodeResolverReport) bool { return r.State == api.ResolverReady && r.Error == nil })
}

// A resolver that exited is started again on its die event; one that keeps exiting is a crash loop.
func TestResolverIsStartedAgainAfterAnExit(t *testing.T) {
	h, r := resolverHarness(t, nil)
	h.start()
	h.waitResolver("resolver ready", stateIs(api.ResolverReady))
	c := h.docker.onlyResolver(t)
	h.docker.exit(c.name, 137, false)
	eventually(t, 5*time.Second, "started again", func() bool {
		cc := h.docker.snapshot(c.id)
		return cc != nil && cc.starts == 2 && cc.state.Status == dcontainer.StateRunning
	})
	h.waitResolver("ready", stateIs(api.ResolverReady))

	r.setHealth(func(string) (dcontainer.HealthStatus, int, string) {
		h.docker.mu.Lock()
		defer h.docker.mu.Unlock()
		h.docker.exitLocked(h.docker.findContainer(c.id), 2, false)
		return dcontainer.Starting, 1, ""
	})
	h.docker.exit(c.name, 2, false)
	rep := h.waitResolver("crash loop", stateIs(api.ResolverFailed))
	if rep.Error == nil || *rep.Error != api.ResolverErrCrashLoop || rep.Detail != "exit code 2" {
		t.Errorf("report = %+v", rep)
	}
	if h.docker.container(c.id) == nil || h.docker.namedCount("create", "scantor-dns-") != 1 {
		t.Error("an exited resolver must be started in place")
	}
}

// A resolver that stays unhealthy for another reason than its upstream servers is restarted after three
// passes; one whose upstream servers do not answer is degraded and left alone.
func TestResolverUnhealthy(t *testing.T) {
	h, _ := resolverHarness(t, nil)
	h.start()
	h.waitResolver("resolver ready", stateIs(api.ResolverReady))
	c := h.docker.onlyResolver(t)
	spec := c.config.Labels[container.LabelSpecHash]

	failing := strings.Replace(statsLine(h.orch.nodeID, spec, false), `"queries":10`, `"queries":99`, 1)
	h.docker.setHealth(c.name, dcontainer.Unhealthy, 1, failing+"\nno upstream server answers (upstreamUnreachable)\n")
	rep := h.waitResolver("degraded", stateIs(api.ResolverDegraded))
	// upstreamOk and the counters come from the failing check, not from the last passing one.
	if rep.Error == nil || *rep.Error != api.ResolverErrUpstreamUnreachable || rep.UpstreamOK || rep.Stats == nil || rep.Stats.Queries != 99 {
		t.Errorf("report = %+v stats %+v", rep, rep.Stats)
	}
	time.Sleep(500 * time.Millisecond)
	if n := h.docker.namedCount("restart", "scantor-dns-"); n != 0 {
		t.Errorf("a degraded resolver was restarted %d times", n)
	}
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	if w := h.docker.container(workerName(testWorker1)); len(w.host.DNS) != 0 {
		t.Errorf("a worker got a degraded resolver: %v", w.host.DNS)
	}

	// A hung resolver: the healthcheck prints the stale stats of its state file, then the error.
	h.docker.setHealth(c.name, dcontainer.Unhealthy, 1, statsLine(h.orch.nodeID, spec, true)+"\nthe state file is 31s old\n")
	eventually(t, 5*time.Second, "restarted", func() bool { return h.docker.namedCount("restart", "scantor-dns-") == 1 })
	h.waitResolver("ready after the restart", stateIs(api.ResolverReady))
	if cc := h.docker.snapshot(c.id); cc == nil || !slices.Equal(cc.stopArgs, []int{2}) {
		t.Error("the unhealthy resolver must be restarted in place with a 2 s grace")
	}
}

// A bind error is reported with its address, and the resolver is not restarted for it (it retries its bind
// itself).
func TestResolverBindError(t *testing.T) {
	h, r := resolverHarness(t, nil)
	h.docker.rootless = true
	r.setHealth(func(spec string) (dcontainer.HealthStatus, int, string) {
		b, _ := json.Marshal(resolver.Stats{V: 1, Node: h.orch.nodeID, Spec: spec, Error: api.ResolverErrBindUnavailable})
		return dcontainer.Unhealthy, 1, string(b)
	})
	h.start()
	rep := h.waitResolver("failed", stateIs(api.ResolverFailed))
	if rep.Error == nil || *rep.Error != api.ResolverErrBindUnavailable || rep.Detail != testGateway+":53" {
		t.Errorf("report = %+v", rep)
	}
	if !h.logContains("DOCKERD_ROOTLESS_ROOTLESSKIT_DETACH_NETNS=false") {
		t.Error("no hint for rootless Docker")
	}
	time.Sleep(300 * time.Millisecond)
	if h.docker.namedCount("restart", "scantor-dns-") != 0 {
		t.Error("a resolver with a bind error was restarted")
	}
}

// The stats come from the newest health check whose output starts with stats of the container's spec,
// whatever its exit code (a failing check prints them too); an unhealthy resolver is classified from
// them, or from the newest output without such stats.
func TestResolverHealthOutput(t *testing.T) {
	spec := "sha256:" + strings.Repeat("cd", 32)
	ok := func(out string) *dcontainer.HealthcheckResult {
		return &dcontainer.HealthcheckResult{ExitCode: 0, Output: out}
	}
	bad := func(out string) *dcontainer.HealthcheckResult {
		return &dcontainer.HealthcheckResult{ExitCode: 1, Output: out}
	}
	c := &resolverContainer{spec: spec, listen: netip.MustParseAddr("10.10.0.1"), healthLog: []*dcontainer.HealthcheckResult{
		ok(statsLine(testNodeID, spec, true)), ok(strings.Replace(statsLine(testNodeID, spec, true), `"queries":10`, `"queries":42`, 1) + "\nnoise on stderr\n"), bad("timeout"),
	}}
	if st := newestStatsOf(c); st == nil || st.Queries != 42 || !st.UpstreamOK {
		t.Errorf("stats = %+v, want the newest check with stats", st)
	}
	c.healthLog = append(c.healthLog, ok(statsLine(testNodeID, "sha256:other", true)))
	if st := newestStatsOf(c); st == nil || st.Spec != spec || st.Queries != 42 {
		t.Errorf("stats = %+v; the stats of another spec must be skipped", st)
	}
	// A failing check's stats are the newest: the upstream servers stopped answering.
	failing := strings.Replace(statsLine(testNodeID, spec, false), `"queries":10`, `"queries":50`, 1)
	c.healthLog = append(c.healthLog, bad(failing+"\nno upstream server answers (upstreamUnreachable)\n"), bad("timeout"))
	if st := newestStatsOf(c); st == nil || st.UpstreamOK || st.Queries != 50 {
		t.Errorf("stats = %+v, want those of the newest failing check", st)
	}
	if code, _ := resolverHealthError(c); code != api.ResolverErrUpstreamUnreachable {
		t.Errorf("a timeout after a failing upstream check: %s, want %s", code, api.ResolverErrUpstreamUnreachable)
	}
	for _, log := range [][]*dcontainer.HealthcheckResult{{ok("...")}, {ok(statsLine(testNodeID, "sha256:other", true))}, nil} {
		c.healthLog = log
		if st := newestStatsOf(c); st != nil {
			t.Errorf("stats %+v from a log without stats of the spec", st)
		}
	}
	for out, want := range map[string]string{
		statsLine(testNodeID, spec, false): api.ResolverErrUpstreamUnreachable,
		statsLine(testNodeID, spec, true):  api.ResolverErrUnhealthy,
		"error: bindInUse\n":               api.ResolverErrBindInUse,
		"OCI runtime exec failed":          api.ResolverErrUnhealthy,
	} {
		c.healthLog = []*dcontainer.HealthcheckResult{bad(out)}
		if code, _ := resolverHealthError(c); code != want {
			t.Errorf("%q: %s, want %s", out, code, want)
		}
	}
	c.healthLog = []*dcontainer.HealthcheckResult{bad("bindDenied")}
	if code, detail := resolverHealthError(c); code != api.ResolverErrBindDenied || detail != "10.10.0.1:53" {
		t.Errorf("bind error %s %s", code, detail)
	}
}

// Every event of a resolver of this node wakes the manager, health status changes included, except the
// exec events of its healthcheck.
func TestResolverEvents(t *testing.T) {
	labels := map[string]string{container.LabelKind: string(container.KindResolver), container.LabelNode: testNodeID}
	for action, want := range map[events.Action]bool{
		events.ActionDie: true, events.ActionStart: true, events.ActionDestroy: true, "health_status: unhealthy": true,
		"exec_start: /usr/local/bin/scantor node resolver healthcheck": false, "exec_die": false,
	} {
		if got := resolverEvent(labels, action, testNodeID); got != want {
			t.Errorf("%s: %v, want %v", action, got, want)
		}
	}
	if resolverEvent(labels, events.ActionDie, "other") || resolverEvent(map[string]string{container.LabelKind: "worker", container.LabelNode: testNodeID}, events.ActionDie, testNodeID) {
		t.Error("events of other nodes or kinds woke the manager")
	}
}

// The resolver listens on the IPv4 gateway of the worker network and answers its subnets.
func TestNetFacts(t *testing.T) {
	n := network.Inspect{Network: network.Network{IPAM: network.IPAM{Config: []network.IPAMConfig{
		{Subnet: netip.MustParsePrefix("fd00:1::/64"), Gateway: netip.MustParseAddr("fd00:1::1")},
		{Subnet: netip.MustParsePrefix("10.10.0.0/24"), Gateway: netip.MustParseAddr("10.10.0.1")},
	}}}}
	f := netFactsOf("scantor-workers", n)
	if f == nil || f.gateway.String() != "10.10.0.1" || len(f.subnets) != 2 || f.name != "scantor-workers" {
		t.Fatalf("facts = %+v", f)
	}
	if !f.equal(netFactsOf("scantor-workers", n)) || f.equal(nil) || !(*netFacts)(nil).equal(nil) {
		t.Error("equal")
	}
	if netFactsOf("x", network.Inspect{}) != nil {
		t.Error("a network without IPv4 gateway has no facts")
	}
}

// Leftover probe containers of an interrupted run are removed; a foreign container with the probe's name
// stops the probe without being touched (the one-shot helper of the egress helper).
func TestResolverProbeOneShot(t *testing.T) {
	s := newTestSession(t, nil)
	docker := s.d.docker.(*fakeDocker)
	img := docker.addImage("scantor:dev")
	docker.addNetwork(network.Network{Name: "scantor-workers", Driver: "bridge"})
	labels, _ := container.ManagedLabels(container.KindResolverProbe, container.Identity{Node: testNodeID})
	leftover := docker.addContainer("scantor-dnsprobe-"+testNodeID, labels, dcontainer.StateExited)
	docker.onStartPrefix["scantor-dnsprobe-"] = func(f *fakeDocker, c *fakeContainer) {
		f.mu.Lock()
		f.logs[c.name] = probeLine(resolver.ProbeResult{OK: true, Node: testNodeID, Spec: "sha256:x"})
		f.mu.Unlock()
		f.exit(c.name, 0, false)
	}
	res, err := s.probeResolver(img.id, s.net.Load())
	if err != nil || !res.OK || res.Node != testNodeID || res.Spec != "sha256:x" {
		t.Fatalf("probe = %+v, %v", res, err)
	}
	if docker.container(leftover.id) != nil || docker.container("scantor-dnsprobe-"+testNodeID) != nil {
		t.Error("the probe containers were not removed")
	}
	foreign := docker.addContainer("scantor-dnsprobe-"+testNodeID, map[string]string{"app": "x"}, dcontainer.StateRunning)
	if _, err := s.probeResolver(img.id, s.net.Load()); err == nil || !strings.Contains(err.Error(), "foreign") || !strings.Contains(err.Error(), "resolver probe") {
		t.Errorf("err = %v", err)
	}
	if docker.container(foreign.id) == nil {
		t.Error("a foreign container was removed")
	}
	docker.mu.Lock()
	delete(docker.containers, foreign.id)
	docker.logs = map[string]string{}
	docker.mu.Unlock()
	docker.onStartPrefix["scantor-dnsprobe-"] = func(f *fakeDocker, c *fakeContainer) { f.exit(c.name, 1, false) }
	if _, err := s.probeResolver(img.id, s.net.Load()); err == nil || !strings.Contains(err.Error(), "resolver probe printed no result") {
		t.Errorf("a probe without output: %v", err)
	}
}

// The resolver report survives sessions of the same process and is what hello reports.
func TestHelloReportsTheResolver(t *testing.T) {
	h, _ := resolverHarness(t, nil)
	h.start()
	h.waitResolver("resolver ready", stateIs(api.ResolverReady))
	hellos := h.orch.helloCount()
	h.orch.fail("status", fakeFailure{status: 401, code: "unauthorized", times: 1})
	eventually(t, 5*time.Second, "hello again", func() bool { return h.orch.helloCount() > hellos })
	h.orch.mu.Lock()
	hello := h.orch.hellos[len(h.orch.hellos)-1]
	h.orch.mu.Unlock()
	if hello.Info.Resolver == nil || hello.Info.Resolver.State != api.ResolverReady || hello.DaemonConfig == nil {
		t.Errorf("hello resolver %+v daemonConfig %v", hello.Info.Resolver, hello.DaemonConfig != nil)
	}
}
