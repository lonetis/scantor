//go:build integration

package node

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/moby/moby/api/pkg/stdcopy"
	dcontainer "github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
)

// fakeUpstreamAddress is the A record of fakeUpstreamName on the fake upstream server.
const (
	fakeUpstreamName    = "example.scantor.test."
	fakeUpstreamAddress = "192.0.2.10"
)

// startFakeUpstream serves a minimal recursive DNS server on a loopback UDP port of the test process (the
// Docker host's network namespace under just test-go-integration): ". NS" for the resolver's upstream
// check, an A record for fakeUpstreamName, NODATA for its other types, NXDOMAIN for everything else.
func startFakeUpstream(t *testing.T) string {
	t.Helper()
	conn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	go func() {
		buf := make([]byte, 4096)
		for {
			n, addr, err := conn.ReadFrom(buf)
			if err != nil {
				return
			}
			if reply, ok := fakeUpstreamReply(buf[:n]); ok {
				_, _ = conn.WriteTo(reply, addr)
			}
		}
	}()
	return conn.LocalAddr().String()
}

// fakeUpstreamReply answers one query (RFC 1035 wire format; the query's OPT record is ignored).
func fakeUpstreamReply(q []byte) ([]byte, bool) {
	if len(q) < 12 || binary.BigEndian.Uint16(q[4:6]) != 1 {
		return nil, false
	}
	name, end, ok := readName(q, 12)
	if !ok || end+4 > len(q) {
		return nil, false
	}
	qtype := binary.BigEndian.Uint16(q[end : end+2])
	question := q[12 : end+4]
	const typeA, typeNS = 1, 2
	rcode := uint16(3) // NXDOMAIN
	var answer []byte
	switch {
	case name == "." && qtype == typeNS:
		rcode, answer = 0, rr(typeNS, encodeName("a.root-servers.net."))
	case strings.EqualFold(name, fakeUpstreamName) && qtype == typeA:
		rcode, answer = 0, rr(typeA, netip.MustParseAddr(fakeUpstreamAddress).AsSlice())
	case strings.EqualFold(name, fakeUpstreamName):
		rcode = 0
	}
	reply := make([]byte, 12, 12+len(question)+len(answer))
	copy(reply[0:2], q[0:2])
	flags := uint16(0x8000|0x0080) | binary.BigEndian.Uint16(q[2:4])&0x0100 | rcode // QR, RA, RD copied
	binary.BigEndian.PutUint16(reply[2:4], flags)
	binary.BigEndian.PutUint16(reply[4:6], 1)
	if answer != nil {
		binary.BigEndian.PutUint16(reply[6:8], 1)
	}
	reply = append(reply, question...)
	return append(reply, answer...), true
}

// rr returns an IN record with TTL 300 owned by the question name (a pointer to offset 12).
func rr(rtype uint16, rdata []byte) []byte {
	out := []byte{0xc0, 12}
	out = binary.BigEndian.AppendUint16(out, rtype)
	out = binary.BigEndian.AppendUint16(out, 1)
	out = binary.BigEndian.AppendUint32(out, 300)
	out = binary.BigEndian.AppendUint16(out, uint16(len(rdata))) //nolint:gosec // short test data
	return append(out, rdata...)
}

func readName(msg []byte, off int) (string, int, bool) {
	var labels []string
	for off < len(msg) {
		l := int(msg[off])
		if l == 0 {
			return strings.Join(labels, ".") + ".", off + 1, true
		}
		if l > 63 || off+1+l > len(msg) {
			return "", 0, false
		}
		labels = append(labels, string(msg[off+1:off+1+l]))
		off += 1 + l
	}
	return "", 0, false
}

func encodeName(name string) []byte {
	var out []byte
	for _, label := range strings.Split(strings.TrimSuffix(name, "."), ".") {
		out = append(out, byte(len(label)))
		out = append(out, label...)
	}
	return append(out, 0)
}

// The fake upstream answers like a recursive server (checked with Go's own resolver, no Docker needed).
func TestFakeUpstreamAnswers(t *testing.T) {
	addr := startFakeUpstream(t)
	r := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "udp", addr)
	}}
	addrs, err := r.LookupHost(t.Context(), strings.TrimSuffix(fakeUpstreamName, "."))
	if err != nil || len(addrs) != 1 || addrs[0] != fakeUpstreamAddress {
		t.Errorf("LookupHost = %v, %v", addrs, err)
	}
	ns, err := r.LookupNS(t.Context(), ".")
	if err != nil || len(ns) != 1 || ns[0].Host != "a.root-servers.net." {
		t.Errorf("LookupNS(.) = %v, %v", ns, err)
	}
	var dnsErr *net.DNSError
	if _, err := r.LookupHost(t.Context(), "missing.scantor.test"); !errors.As(err, &dnsErr) || !dnsErr.IsNotFound {
		t.Errorf("LookupHost(missing) = %v, want NXDOMAIN", err)
	}
}

// runClient runs a one-shot container of image on network whose DNS server is gw (the path of a worker)
// and returns its output. It may run on another goroutine than the test, so it returns errors.
func runClient(t *testing.T, docker *client.Client, image, network string, gw netip.Addr, timeout time.Duration, cmd ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(t.Context()), timeout)
	defer cancel()
	res, err := docker.ContainerCreate(ctx, client.ContainerCreateOptions{
		Name:       *namePrefix + "dns-client-" + uuid.NewString()[:8],
		Config:     &dcontainer.Config{Image: image, Entrypoint: []string{"/bin/sh", "-c"}, Cmd: []string{strings.Join(cmd, " ")}, Labels: map[string]string{"scantor.test": "true"}},
		HostConfig: &dcontainer.HostConfig{NetworkMode: dcontainer.NetworkMode(network), DNS: []netip.Addr{gw}},
	})
	if err != nil {
		return "", err
	}
	defer func() {
		_, _ = docker.ContainerRemove(context.Background(), res.ID, client.ContainerRemoveOptions{Force: true})
	}()
	wait := docker.ContainerWait(ctx, res.ID, client.ContainerWaitOptions{Condition: dcontainer.WaitConditionNextExit})
	if _, err := docker.ContainerStart(ctx, res.ID, client.ContainerStartOptions{}); err != nil {
		return "", err
	}
	select {
	case err := <-wait.Error:
		return "", err
	case <-wait.Result:
	}
	rc, err := docker.ContainerLogs(ctx, res.ID, client.ContainerLogsOptions{ShowStdout: true, ShowStderr: true})
	if err != nil {
		return "", err
	}
	defer rc.Close()
	var out strings.Builder
	if _, err := stdcopy.StdCopy(&out, &out, rc); err != nil {
		return "", err
	}
	return out.String(), nil
}

// TestNodeResolverServesTheWorkerNetwork runs the real node resolver (the scantor binary in a test
// image) for a daemon on the real engine: it binds port 53 of a scantor-test-* bridge network's gateway in
// the host network, passes its healthcheck and the probe, answers containers on the network that use it
// as their DNS server through Docker's embedded DNS, and a dns override replaces it blue/green while a
// client keeps resolving, without a failed lookup.
func TestNodeResolverServesTheWorkerNetwork(t *testing.T) {
	docker := integrationClient(t)
	ctx := t.Context()
	_, arch, err := container.DaemonPlatform(ctx, docker)
	if err != nil {
		t.Fatal(err)
	}
	tag := *namePrefix + "resolver:" + uuid.NewString()[:8]
	buildImage(t, docker, tag, "FROM "+integrationBase+"\nCOPY scantor /usr/local/bin/scantor\n", map[string][]byte{"scantor": buildLinuxBinary(t, arch)})
	img, err := docker.ImageInspect(ctx, tag)
	if err != nil {
		t.Fatal(err)
	}
	upstream := startFakeUpstream(t)

	network := *namePrefix + "workers-" + uuid.NewString()[:8]
	orch := newFakeOrchestrator(t, testToken)
	orch.nodeID = uuid.NewString()
	t.Cleanup(func() {
		bg := context.Background()
		filters := client.Filters{}
		filters.Add("label", container.LabelNode+"="+orch.nodeID)
		if res, err := docker.ContainerList(bg, client.ContainerListOptions{All: true, Filters: filters}); err == nil {
			for _, c := range res.Items {
				_, _ = docker.ContainerRemove(bg, c.ID, client.ContainerRemoveOptions{Force: true})
			}
		}
		_, _ = docker.NetworkRemove(bg, network, client.NetworkRemoveOptions{})
	})
	startIntegrationDaemonWith(t, docker, orch, network, func(c *Config) {
		c.Settings.DNS.Mode = api.ResolverModeRecursive
		c.Settings.DNS.Upstreams = []string{upstream}
	}, func(d *Daemon) {
		d.resolverImage = img.ID
		real := defaultTimings()
		d.t.resolverHealthWait, d.t.resolverSettle, d.t.probeTimeout = real.resolverHealthWait, real.resolverSettle, real.probeTimeout
		d.t.resolverBackoffBase, d.t.resolverRestartBase = time.Second, time.Second
	})

	ready := func(msg string, cond func(*api.NodeResolverReport) bool) api.NodeResolverReport {
		t.Helper()
		var got api.NodeResolverReport
		eventually(t, 90*time.Second, msg, func() bool {
			st := orch.lastStatus()
			if st != nil && st.Info.Resolver != nil && cond(st.Info.Resolver) {
				got = *st.Info.Resolver
				return true
			}
			return false
		})
		return got
	}
	rep := ready("resolver ready", func(r *api.NodeResolverReport) bool { return r.State == api.ResolverReady })
	netw, err := docker.NetworkInspect(ctx, network, client.NetworkInspectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	facts := netFactsOf(network, netw.Network)
	if facts == nil || rep.Address != facts.gateway.String() {
		t.Fatalf("report address %q, network facts %+v", rep.Address, facts)
	}
	// The stats come from the real health output.
	if !rep.UpstreamOK || rep.Stats == nil || !validSpecHash(rep.Spec) {
		t.Errorf("report = %+v", rep)
	}
	ctr, err := docker.ContainerInspect(ctx, resolverName(orch.nodeID, rep.Spec), client.ContainerInspectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if string(ctr.Container.HostConfig.NetworkMode) != "host" || ctr.Container.State.Health == nil || ctr.Container.State.Health.Status != dcontainer.Healthy {
		t.Errorf("resolver container network %q health %+v", ctr.Container.HostConfig.NetworkMode, ctr.Container.State.Health)
	}

	// A container on the worker network resolves through the resolver: its own probe name and a name of
	// the upstream server.
	out, err := runClient(t, docker, tag, network, facts.gateway, time.Minute,
		"nslookup -type=TXT resolver.scantor.invalid && nslookup -type=A", strings.TrimSuffix(fakeUpstreamName, "."))
	if err != nil || !strings.Contains(out, "scantor-resolver node="+orch.nodeID) || !strings.Contains(out, fakeUpstreamAddress) {
		t.Fatalf("lookups through the resolver (%v):\n%s", err, out)
	}

	// Blue/green: a client resolves in a loop while a dns override replaces the resolver.
	type loopResult struct {
		out string
		err error
	}
	loopDone := make(chan loopResult, 1)
	go func() {
		out, err := runClient(t, docker, tag, network, facts.gateway, 3*time.Minute,
			`end=$(( $(date +%s) + 25 )); n=0; f=0; while [ "$(date +%s)" -lt "$end" ]; do`,
			`nslookup -type=A`, strings.TrimSuffix(fakeUpstreamName, "."), `>/dev/null 2>&1 || f=$((f+1)); n=$((n+1)); done;`,
			`echo "lookups=$n failures=$f"`)
		loopDone <- loopResult{out, err}
	}()
	time.Sleep(3 * time.Second)
	orch.setOverrides(1, `{"dns": {"maxLookups": 500}}`)
	ready("the replacement serves", func(r *api.NodeResolverReport) bool { return r.State == api.ResolverReady && r.Spec != rep.Spec })
	eventually(t, 60*time.Second, "old resolver removed", func() bool {
		_, err := docker.ContainerInspect(ctx, resolverName(orch.nodeID, rep.Spec), client.ContainerInspectOptions{})
		return container.IsNotFound(err)
	})
	var loop loopResult
	select {
	case loop = <-loopDone:
	case <-time.After(3 * time.Minute):
		t.Fatal("the lookup loop did not end")
	}
	m := regexp.MustCompile(`lookups=(\d+) failures=(\d+)`).FindStringSubmatch(loop.out)
	if loop.err != nil || m == nil {
		t.Fatalf("lookup loop (%v):\n%s", loop.err, loop.out)
	}
	lookups, _ := strconv.Atoi(m[1])
	if lookups < 10 || m[2] != "0" {
		t.Errorf("blue/green replacement: %s lookups, %s failed", m[1], m[2])
	}
}
