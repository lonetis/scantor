package node

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"net/netip"
	"slices"
	"strings"
	"testing"
	"time"

	dcontainer "github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/container"
)

// fakeIptables simulates iptables binaries and their -restore counterparts: chains per binary, with
// DOCKER-USER present for the binaries listed in withDockerUser.
type fakeIptables struct {
	withDockerUser []string
	chains         map[string]map[string][]string // binary → chain → rules
	failRestore    bool
	calls          []string
}

func newFakeIptables(withDockerUser ...string) *fakeIptables {
	f := &fakeIptables{withDockerUser: withDockerUser, chains: map[string]map[string][]string{}}
	for _, b := range withDockerUser {
		f.chains[b] = map[string][]string{dockerUserChain: {"-j RETURN"}}
	}
	return f
}

func (f *fakeIptables) run(_ context.Context, stdin, name string, args ...string) (string, error) {
	f.calls = append(f.calls, strings.TrimSpace(name+" "+strings.Join(args, " ")))
	if len(args) == 0 || args[0] != "-w" {
		return "", errors.New("missing -w")
	}
	args = args[1:]
	if binary, ok := strings.CutSuffix(name, "-restore"); ok {
		return f.restore(binary, stdin, args)
	}
	if stdin != "" {
		return "", fmt.Errorf("unexpected stdin for %s", name)
	}
	chains, ok := f.chains[name]
	if !ok {
		return "iptables: No chain/target/match by that name.", errors.New("exit status 1")
	}
	switch args[0] {
	case "-n":
		if _, ok := chains[args[2]]; !ok {
			return "No chain/target/match by that name.", errors.New("exit status 1")
		}
		return "Chain " + args[2], nil
	case "-S":
		rules, ok := chains[args[1]]
		if !ok {
			return "iptables: No chain/target/match by that name.", errors.New("exit status 1")
		}
		out := "# Warning: iptables-legacy tables present, use iptables-legacy to see them\n-N " + args[1] + "\n"
		for _, r := range rules {
			out += "-A " + args[1] + " " + r + "\n"
		}
		return out, nil
	case "-C":
		if !slices.Contains(chains[args[1]], strings.Join(args[2:], " ")) {
			return "Bad rule", errors.New("exit status 1")
		}
	case "-I":
		chains[args[1]] = append([]string{strings.Join(args[3:], " ")}, chains[args[1]]...)
	default:
		return "", fmt.Errorf("unexpected %v", args)
	}
	return "", nil
}

// restore applies an iptables-restore --noflush input to the filter table as one transaction: a
// declared chain is created or emptied, the -A lines are appended, and nothing changes on an error.
func (f *fakeIptables) restore(binary, input string, args []string) (string, error) {
	if !slices.Equal(args, []string{"--noflush"}) {
		return "", fmt.Errorf("unexpected restore arguments %v", args)
	}
	if f.failRestore {
		return binary + "-restore v1.8.13 (nf_tables): unknown option \"--reject-with\"\nError occurred at line: 3", errors.New("exit status 2")
	}
	chains, ok := f.chains[binary]
	if !ok {
		return "", errors.New("exit status 1")
	}
	next := maps.Clone(chains)
	lines := strings.Split(strings.TrimSuffix(input, "\n"), "\n")
	if len(lines) < 2 || lines[0] != "*filter" || lines[len(lines)-1] != "COMMIT" {
		return "", fmt.Errorf("malformed restore input %q", input)
	}
	for _, line := range lines[1 : len(lines)-1] {
		switch {
		case strings.HasPrefix(line, ":"):
			chain, rest, _ := strings.Cut(line[1:], " ")
			if rest != "- [0:0]" {
				return "", fmt.Errorf("unexpected chain line %q", line)
			}
			next[chain] = []string{}
		case strings.HasPrefix(line, "-A "):
			chain, rule, _ := strings.Cut(strings.TrimPrefix(line, "-A "), " ")
			if _, ok := next[chain]; !ok {
				return "iptables-restore: line 2 failed", errors.New("exit status 1")
			}
			next[chain] = append(next[chain], rule)
		default:
			return "", fmt.Errorf("unexpected restore line %q", line)
		}
	}
	f.chains[binary] = next
	return "", nil
}

// restores returns the -restore calls made so far.
func (f *fakeIptables) restores() []string {
	var out []string
	for _, c := range f.calls {
		if strings.Contains(c, "-restore ") {
			out = append(out, c)
		}
	}
	return out
}

func prefixes(s ...string) []netip.Prefix {
	var out []netip.Prefix
	for _, p := range s {
		out = append(out, netip.MustParsePrefix(p))
	}
	return out
}

func TestEgressApplyNft(t *testing.T) {
	ipt := newFakeIptables("iptables-nft", "ip6tables-nft")
	deny := prefixes("169.254.0.0/16", "fd00:ec2::254/128", "100.100.100.200/32")
	res := EgressApply(t.Context(), deny, ipt.run)
	if !res.Applied || res.Families["ipv4"] != "iptables-nft" || res.Families["ipv6"] != "ip6tables-nft" || len(res.Errors) != 0 {
		t.Fatalf("result = %+v", res)
	}
	want4 := []string{"-d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited", "-d 100.100.100.200/32 -j REJECT --reject-with icmp-admin-prohibited"}
	if got := ipt.chains["iptables-nft"][EgressChain]; !slices.Equal(got, want4) {
		t.Errorf("ipv4 chain = %q", got)
	}
	if got := ipt.chains["ip6tables-nft"][EgressChain]; !slices.Equal(got, []string{"-d fd00:ec2::254/128 -j REJECT --reject-with icmp6-adm-prohibited"}) {
		t.Errorf("ipv6 chain = %q", got)
	}
	if got := ipt.chains["iptables-nft"][dockerUserChain]; !slices.Equal(got, []string{"-j " + EgressChain, "-j RETURN"}) {
		t.Errorf("DOCKER-USER = %q, want the jump first", got)
	}
	// The chain is filled before the jump to it is inserted.
	restoreAt := slices.Index(ipt.calls, "iptables-nft-restore -w --noflush")
	jumpAt := slices.Index(ipt.calls, "iptables-nft -w -I DOCKER-USER 1 -j SCANTOR-EGRESS")
	if restoreAt < 0 || jumpAt < restoreAt {
		t.Errorf("calls = %q, want the restore before the jump", ipt.calls)
	}
	// Re-applying an intact chain writes nothing and does not duplicate the jump.
	ipt.calls = nil
	res = EgressApply(t.Context(), deny, ipt.run)
	if !res.Applied || len(ipt.chains["iptables-nft"][EgressChain]) != 2 || len(ipt.chains["iptables-nft"][dockerUserChain]) != 2 {
		t.Errorf("second run: %+v %v", res, ipt.chains)
	}
	if r := ipt.restores(); len(r) != 0 {
		t.Errorf("an intact chain was rewritten: %q", r)
	}
}

// The chain is never flushed on its own: a re-apply that has to change it (a firewall tool edited it,
// or the deny list changed) replaces its rules in a single restore transaction, so DOCKER-USER never
// jumps to an empty chain.
func TestEgressApplyReplacesTheChainAtomically(t *testing.T) {
	ipt := newFakeIptables("iptables-nft")
	if res := EgressApply(t.Context(), prefixes("169.254.0.0/16", "100.100.100.200/32"), ipt.run); !res.Applied {
		t.Fatalf("first run = %+v", res)
	}
	ipt.chains["iptables-nft"][EgressChain] = []string{"-d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited"}
	ipt.calls = nil
	if res := EgressApply(t.Context(), prefixes("169.254.0.0/16", "100.100.100.200/32"), ipt.run); !res.Applied {
		t.Fatalf("repair = %+v", res)
	}
	want := []string{"-d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited", "-d 100.100.100.200/32 -j REJECT --reject-with icmp-admin-prohibited"}
	if got := ipt.chains["iptables-nft"][EgressChain]; !slices.Equal(got, want) {
		t.Errorf("repaired chain = %q", got)
	}
	if r := ipt.restores(); len(r) != 1 {
		t.Errorf("restores = %q, want exactly one", r)
	}
	for _, c := range ipt.calls {
		if strings.Contains(c, " -F") || strings.Contains(c, " -N") || strings.Contains(c, " -A") {
			t.Errorf("the chain was changed outside the restore transaction: %s", c)
		}
	}
	if n := len(ipt.chains["iptables-nft"][dockerUserChain]); n != 2 {
		t.Errorf("DOCKER-USER has %d rules, want the jump once plus RETURN", n)
	}
}

func TestEgressApplyBackendDetection(t *testing.T) {
	// Docker on iptables-legacy: the nft binary has no DOCKER-USER chain, legacy has.
	ipt := newFakeIptables("iptables-legacy")
	res := EgressApply(t.Context(), prefixes("169.254.0.0/16"), ipt.run)
	if !res.Applied || res.Families["ipv4"] != "iptables-legacy" || ipt.chains["iptables-legacy"][EgressChain] == nil {
		t.Errorf("legacy: %+v", res)
	}
	if _, touched := ipt.chains["iptables-nft"]; touched {
		t.Error("the nft backend was modified")
	}
	// No DOCKER-USER for IPv6 (IPv6 disabled in Docker): the IPv4 rules apply, the result is not applied.
	ipt = newFakeIptables("iptables-nft")
	res = EgressApply(t.Context(), prefixes("169.254.0.0/16", "fd00:ec2::254/128"), ipt.run)
	if res.Applied || res.Families["ipv4"] != "iptables-nft" || res.Families["ipv6"] != "DOCKER-USER chain not found" || len(res.Errors) != 1 {
		t.Errorf("ipv6 missing: %+v", res)
	}
	// Families without CIDRs are not touched.
	ipt = newFakeIptables("iptables-nft")
	res = EgressApply(t.Context(), prefixes("169.254.0.0/16"), ipt.run)
	if _, ok := res.Families["ipv6"]; ok || !res.Applied {
		t.Errorf("ipv4 only: %+v", res)
	}
	for _, c := range ipt.calls {
		if strings.HasPrefix(c, "ip6tables") {
			t.Errorf("ip6tables called without IPv6 CIDRs: %s", c)
		}
	}
}

func TestEgressApplyReportsCommandErrors(t *testing.T) {
	ipt := newFakeIptables("iptables-nft")
	ipt.failRestore = true
	res := EgressApply(t.Context(), prefixes("169.254.0.0/16"), ipt.run)
	if res.Applied || len(res.Errors) != 1 || !strings.Contains(res.Errors[0], "iptables-nft-restore --noflush") || !strings.Contains(res.Errors[0], "reject-with") {
		t.Errorf("result = %+v", res)
	}
	// A failed transaction leaves no jump to a missing or partial chain.
	if got := ipt.chains["iptables-nft"][dockerUserChain]; !slices.Equal(got, []string{"-j RETURN"}) {
		t.Errorf("DOCKER-USER = %q", got)
	}
}

// The helper container of docs/nodes.md §9: the daemon's own image, host network, only NET_ADMIN and
// NET_RAW, read-only rootfs with a tmpfs /run, the xtables lock bound when the host has it, managed
// labels of kind egressHelper, removed after the run.
func TestEgressHelperContainer(t *testing.T) {
	docker := newFakeDocker()
	img := docker.addImage("ghcr.io/lonetis/scantor:1.4.0")
	var created []client.ContainerCreateOptions
	docker.createErr = func(opts client.ContainerCreateOptions) error {
		created = append(created, opts)
		if len(created) == 1 {
			return errors.New("Error response from daemon: invalid mount config for type \"bind\": bind source path does not exist: /run/xtables.lock")
		}
		return nil
	}
	docker.onStart = func(f *fakeDocker, c *fakeContainer) {
		f.mu.Lock()
		f.logs[c.name] = "warning: something\n{\"applied\":true,\"families\":{\"ipv4\":\"iptables-nft\"},\"errors\":[]}\n"
		f.mu.Unlock()
		f.exit(c.name, 0, false)
	}
	h := egressHelper{docker: docker, nodeID: testNodeID, imageID: img.id, deny: prefixes("169.254.0.0/16", "fd00:ec2::254/128"), timeout: 5 * time.Second, networkMode: "host"}
	res, err := h.run(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !res.Applied || res.Families["ipv4"] != "iptables-nft" {
		t.Errorf("result = %+v", res)
	}
	if len(created) != 2 {
		t.Fatalf("creates = %d, want a retry without the lock bind", len(created))
	}
	first, second := created[0], created[1]
	if len(first.HostConfig.Mounts) != 1 || first.HostConfig.Mounts[0] != (mount.Mount{Type: mount.TypeBind, Source: "/run/xtables.lock", Target: "/run/xtables.lock"}) {
		t.Errorf("first attempt mounts = %+v", first.HostConfig.Mounts)
	}
	if len(second.HostConfig.Mounts) != 0 {
		t.Errorf("retry mounts = %+v", second.HostConfig.Mounts)
	}
	cfg, hc := second.Config, second.HostConfig
	if second.Name != "scantor-netpol-"+testNodeID || cfg.Image != img.id || cfg.User != "0:0" {
		t.Errorf("name %q image %q user %q", second.Name, cfg.Image, cfg.User)
	}
	if !slices.Equal(cfg.Entrypoint, []string{"/usr/local/bin/scantor"}) || !slices.Equal(cfg.Cmd, []string{"node", "egress-apply", "--deny", "169.254.0.0/16,fd00:ec2::254/128"}) {
		t.Errorf("command = %v %v", cfg.Entrypoint, cfg.Cmd)
	}
	if cfg.Labels["scantor.kind"] != "egressHelper" || cfg.Labels["scantor.node"] != testNodeID || cfg.Labels["traefik.enable"] != "false" {
		t.Errorf("labels = %v", cfg.Labels)
	}
	if string(hc.NetworkMode) != "host" || !slices.Equal(hc.CapDrop, []string{"ALL"}) || !slices.Equal(hc.CapAdd, []string{"NET_ADMIN", "NET_RAW"}) ||
		!slices.Equal(hc.SecurityOpt, []string{"no-new-privileges:true"}) || !hc.ReadonlyRootfs || hc.Tmpfs["/run"] != "size=1m" || hc.Privileged {
		t.Errorf("host config = %+v", hc)
	}
	if docker.container("scantor-netpol-"+testNodeID) != nil {
		t.Error("the helper container was not removed")
	}
}

func TestEgressHelperFailures(t *testing.T) {
	docker := newFakeDocker()
	img := docker.addImage("scantor:dev")
	h := egressHelper{docker: docker, nodeID: testNodeID, imageID: img.id, deny: prefixes("169.254.0.0/16"), timeout: 5 * time.Second, networkMode: "host"}

	// A foreign container with the helper's name is never removed; the run fails.
	foreign := docker.addContainer("scantor-netpol-"+testNodeID, map[string]string{"app": "x"}, dcontainer.StateRunning)
	if _, err := h.run(t.Context()); err == nil || !strings.Contains(err.Error(), "foreign") {
		t.Errorf("err = %v", err)
	}
	if docker.container(foreign.id) == nil {
		t.Fatal("the foreign container was removed")
	}
	docker.mu.Lock()
	delete(docker.containers, foreign.id)
	docker.mu.Unlock()

	// A leftover helper of this node is removed first.
	labels, err := container.ManagedLabels(container.KindEgressHelper, container.Identity{Node: testNodeID})
	if err != nil {
		t.Fatal(err)
	}
	leftover := docker.addContainer("scantor-netpol-"+testNodeID, labels, dcontainer.StateExited)
	docker.onStart = func(f *fakeDocker, c *fakeContainer) {
		f.mu.Lock()
		f.logs[c.name] = "exec failed\n"
		f.mu.Unlock()
		f.exit(c.name, 1, false)
	}
	if _, err := h.run(t.Context()); err == nil || !strings.Contains(err.Error(), "printed no result") {
		t.Errorf("err = %v", err)
	}
	if docker.container(leftover.id) != nil {
		t.Error("the leftover helper was not removed")
	}
}

// The daemon applies the deny list after hello, reports egressDenyApplied and skips the helper when it
// does not know its own image.
func TestEgressLoopReportsTheResult(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.EgressDeny = prefixes("169.254.0.0/16") })
	self := h.docker.addContainer("scantor-node", nil, dcontainer.StateRunning)
	img := h.docker.addImage("scantor:dev")
	self.imageID = img.id
	self.config.Hostname = shortID(self.id)
	h.d.mountinfo = writeMountinfo(t, self.id)
	h.docker.onStart = func(f *fakeDocker, c *fakeContainer) {
		if !strings.HasPrefix(c.name, "scantor-netpol-") {
			return
		}
		f.mu.Lock()
		f.logs[c.name] = "{\"applied\":true,\"families\":{\"ipv4\":\"iptables-nft\"},\"errors\":[]}\n"
		f.mu.Unlock()
		f.exit(c.name, 0, false)
	}
	h.start()
	eventually(t, 5*time.Second, "egressDenyApplied", func() bool {
		st := h.orch.lastStatus()
		return st != nil && st.Info.EgressDenyApplied
	})

	skipped := newHarness(t, func(c *Config) { c.EgressDeny = prefixes("169.254.0.0/16") })
	skipped.start()
	eventually(t, 5*time.Second, "skip logged", func() bool { return skipped.logContains("egress helper is skipped") })
	if st := skipped.orch.lastStatus(); st != nil && st.Info.EgressDenyApplied {
		t.Error("egressDenyApplied without a helper run")
	}
}
