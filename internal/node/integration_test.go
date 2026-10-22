//go:build integration

package node

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/moby/moby/api/pkg/stdcopy"
	dcontainer "github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/jsonstream"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
	"github.com/lonetis/scantor/internal/redact"
	"github.com/lonetis/scantor/internal/version"
)

// Integration tests against the real Docker daemon (just test-go-integration). Images, networks and
// helper containers they create are named <name-prefix>* and removed in t.Cleanup. Worker and egress
// helper containers carry their fixed names (scantor-w-<workerId>, scantor-netpol-<nodeId>, docs/nodes.md)
// with random ids, and are removed in t.Cleanup as well.

const integrationBase = "alpine:3.24"

var namePrefix = flag.String("name-prefix", "scantor-test-", "prefix of the images, networks and containers the integration tests create")

// fakeRuntime stands in for the injected runtime: it reports its arguments and the environment it sees,
// then idles until SIGTERM (forwarded by docker-init).
const fakeRuntime = `#!/bin/sh
echo "fake runtime: $* uid=$(id -u) dind=${SCANTOR_DIND:-0}"
trap 'echo "fake runtime: SIGTERM"; exit 0' TERM
while :; do sleep 1 & wait $!; done
`

func integrationClient(t *testing.T) *client.Client {
	t.Helper()
	c, err := container.NewClient(version.UserAgent("scantor-test"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	ctx := t.Context()
	if _, err := c.Ping(ctx, client.PingOptions{}); err != nil {
		t.Skipf("no Docker daemon: %v", err)
	}
	if _, err := c.ImageInspect(ctx, integrationBase); err != nil {
		if err := container.Pull(ctx, c, integrationBase, container.PullOptions{}); err != nil {
			t.Fatalf("pull %s: %v", integrationBase, err)
		}
	}
	return c
}

// buildImage builds an image from a Dockerfile and extra context files with the classic builder and
// removes the tag in t.Cleanup.
func buildImage(t *testing.T, c *client.Client, tag, dockerfile string, files map[string][]byte) {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	add := func(name string, mode int64, data []byte) {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: mode, Size: int64(len(data))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	add("Dockerfile", 0o644, []byte(dockerfile))
	for name, data := range files {
		add(name, 0o755, data)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	resp, err := c.ImageBuild(t.Context(), &buf, client.ImageBuildOptions{Tags: []string{tag}, Remove: true, ForceRemove: true, Labels: map[string]string{"scantor.test": "true"}})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	t.Cleanup(func() {
		_, _ = c.ImageRemove(context.Background(), tag, client.ImageRemoveOptions{Force: true, PruneChildren: true})
	})
	dec := json.NewDecoder(resp.Body)
	var out strings.Builder
	for {
		var msg jsonstream.Message
		if err := dec.Decode(&msg); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		out.WriteString(msg.Stream)
		if msg.Error != nil {
			t.Fatalf("build %s: %s\n%s", tag, msg.Error.Message, out.String())
		}
	}
}

// execIn runs a command in a running container and returns its output and exit code.
func execIn(t *testing.T, c *client.Client, id string, cmd ...string) (string, int) {
	t.Helper()
	ctx := t.Context()
	ex, err := c.ExecCreate(ctx, id, client.ExecCreateOptions{Cmd: cmd, AttachStdout: true, AttachStderr: true})
	if err != nil {
		t.Fatal(err)
	}
	att, err := c.ExecAttach(ctx, ex.ID, client.ExecAttachOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer att.Close()
	var out bytes.Buffer
	if _, err := stdcopy.StdCopy(&out, &out, att.Reader); err != nil {
		t.Fatal(err)
	}
	insp, err := c.ExecInspect(ctx, ex.ID, client.ExecInspectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return out.String(), insp.ExitCode
}

func containerLogs(t *testing.T, c *client.Client, id string) string {
	t.Helper()
	rc, err := c.ContainerLogs(t.Context(), id, client.ContainerLogsOptions{ShowStdout: true, ShowStderr: true})
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	var out bytes.Buffer
	if _, err := stdcopy.StdCopy(&out, &out, rc); err != nil {
		t.Fatal(err)
	}
	return out.String()
}

// integrationDaemon is a daemon on the real engine against a fake orchestrator.
type integrationDaemon struct {
	d      *Daemon
	logs   *syncBuffer
	cancel context.CancelFunc
	done   chan error
}

func startIntegrationDaemon(t *testing.T, docker *client.Client, orch *fakeOrchestrator, network string) *integrationDaemon {
	t.Helper()
	logs := &syncBuffer{}
	cfg := Config{
		URL: orch.srv.URL, Token: testToken, DinD: DinDDisabled,
		PidsLimit: 4096, ShmSize: 256 << 20, Nofile: 65536, LogMaxSize: 20 << 20, LogMaxFiles: 3,
		ImageRetention: 24 * time.Hour, PullTimeout: time.Minute,
		LogLevel: slog.LevelDebug, LogFormat: redact.FormatText,
	}
	d, err := New(Options{Config: cfg, Docker: docker, Logger: redact.NewLogger(logs, redact.FormatText, slog.LevelDebug)})
	if err != nil {
		t.Fatal(err)
	}
	d.t = testTimings()
	d.t.crashBase = 200 * time.Millisecond
	d.statusFile = filepath.Join(t.TempDir(), "scantor-node.status")
	d.mountinfo = filepath.Join(t.TempDir(), "no-mountinfo")
	d.workerNetwork = network
	d.binarySource = func(context.Context) (*container.Binary, error) { return container.NewBinary([]byte(fakeRuntime)), nil }
	ctx, cancel := context.WithCancel(context.Background())
	id := &integrationDaemon{d: d, logs: logs, cancel: cancel, done: make(chan error, 1)}
	go func() { id.done <- d.Run(ctx) }()
	t.Cleanup(func() {
		id.stop(t)
		if t.Failed() || testing.Verbose() {
			t.Logf("daemon log:\n%s", logs.String())
		}
	})
	return id
}

func (id *integrationDaemon) stop(t *testing.T) {
	t.Helper()
	if id.cancel == nil {
		return
	}
	id.cancel()
	id.cancel = nil
	select {
	case err := <-id.done:
		if err != nil {
			t.Errorf("Run returned %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the daemon did not stop within 30 s")
	}
}

func waitStatus(t *testing.T, orch *fakeOrchestrator, workerID, msg string, cond func(*api.NodeWorkerStatus) bool) api.NodeWorkerStatus {
	t.Helper()
	var got api.NodeWorkerStatus
	eventually(t, 60*time.Second, msg, func() bool {
		w := orch.workerStatus(workerID)
		if w != nil && cond(w) {
			got = *w
			return true
		}
		return false
	})
	return got
}

func inspectWorker(t *testing.T, c *client.Client, workerID string) dcontainer.InspectResponse {
	t.Helper()
	res, err := c.ContainerInspect(t.Context(), workerName(workerID), client.ContainerInspectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return res.Container
}

func trimCap(caps []string) []string {
	out := make([]string, len(caps))
	for i, c := range caps {
		out[i] = strings.TrimPrefix(c, "CAP_")
	}
	slices.Sort(out)
	return out
}

// TestWorkerLifecycle runs workers on the real engine: create with the full container spec, live
// resize, crash and restart in place, an on-demand log tail, adoption by a restarted daemon, recreation
// on a spec change and removal.
func TestWorkerLifecycle(t *testing.T) {
	docker := integrationClient(t)
	ctx := t.Context()
	registryHost := *namePrefix + "registry.test"
	taskID := uuid.NewString()
	repo := registryHost + "/tasks/" + taskID
	// The image claims to belong to the compose stack and enables Traefik; the run-time labels must win.
	buildImage(t, docker, repo+":it", "FROM "+integrationBase+"\nLABEL traefik.enable=true traefik.http.routers.x.rule=Host(`evil`) com.docker.compose.project=scantor com.docker.compose.service=orchestrator scantor.managed=false scantor.kind=editor\n", nil)
	img, err := docker.ImageInspect(ctx, repo+":it")
	if err != nil {
		t.Fatal(err)
	}
	ref := ""
	for _, d := range img.RepoDigests {
		if strings.HasPrefix(d, repo+"@sha256:") {
			ref = d
		}
	}
	if ref == "" {
		t.Skipf("the image store keeps no digest for local images (%v); this test needs the containerd image store", img.RepoDigests)
	}

	network := *namePrefix + "workers-" + uuid.NewString()[:8]
	orch := newFakeOrchestrator(t, testToken)
	orch.nodeID = uuid.NewString()
	orch.config.Registry.Host = registryHost
	orch.config.DrainGraceMs = 2000
	workerID := uuid.NewString()
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = docker.ContainerRemove(bg, workerName(workerID), client.ContainerRemoveOptions{Force: true, RemoveVolumes: true})
		_, _ = docker.NetworkRemove(bg, network, client.NetworkRemoveOptions{})
	})

	a := testAssignment(workerID)
	a.Image = ref
	a.Processes = 2
	a.Resources = api.AssignmentResources{NanoCPUs: 1e9, MemoryBytes: 2*64<<20 + 256<<20}
	orch.setDesired(a)
	d1 := startIntegrationDaemon(t, docker, orch, network)

	// Create: the worker runs with the documented container spec.
	st := waitStatus(t, orch, workerID, "worker running", func(w *api.NodeWorkerStatus) bool { return w.State == api.NodeWorkerRunning })
	ctr := inspectWorker(t, docker, workerID)
	if st.ContainerID != shortID(ctr.ID) || st.Applied == nil || st.Applied.Processes != 2 {
		t.Errorf("status = %+v", st)
	}
	wantLabels, err := container.ManagedLabels(container.KindWorker, container.Identity{Worker: workerID, Scan: testScanID, User: testUserID, Node: orch.nodeID, SpecHash: a.SpecHash})
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range wantLabels {
		if ctr.Config.Labels[k] != v {
			t.Errorf("label %s = %q, want %q (run-time labels override image labels)", k, ctr.Config.Labels[k], v)
		}
	}
	if !slices.Equal(ctr.Config.Entrypoint, []string{"/scantor/scantor", "runtime", "worker"}) || len(ctr.Config.Cmd) != 0 {
		t.Errorf("entrypoint %v cmd %v", ctr.Config.Entrypoint, ctr.Config.Cmd)
	}
	for _, e := range []string{"SCANTOR_URL=" + a.Env["SCANTOR_URL"], "SCANTOR_WORKER_TOKEN=" + a.Env["SCANTOR_WORKER_TOKEN"]} {
		if !slices.Contains(ctr.Config.Env, e) {
			t.Errorf("env %q missing from %q", e, ctr.Config.Env)
		}
	}
	if ctr.Config.StopSignal != "SIGTERM" || ctr.Config.StopTimeout == nil || *ctr.Config.StopTimeout != 7 {
		t.Errorf("stop signal %q timeout %v", ctr.Config.StopSignal, ctr.Config.StopTimeout)
	}
	hc := ctr.HostConfig
	switch {
	case hc.Init == nil || !*hc.Init, hc.RestartPolicy.Name != dcontainer.RestartPolicyDisabled, string(hc.NetworkMode) != network:
		t.Errorf("init %v restart %q network %q", hc.Init, hc.RestartPolicy.Name, hc.NetworkMode)
	case !slices.Equal(trimCap(hc.CapDrop), []string{"ALL"}) || !slices.Equal(trimCap(hc.CapAdd), []string{"NET_BIND_SERVICE", "NET_RAW"}):
		t.Errorf("capabilities drop %v add %v", hc.CapDrop, hc.CapAdd)
	case !slices.Equal(hc.SecurityOpt, []string{"no-new-privileges:true"}) || hc.Privileged || hc.ReadonlyRootfs:
		t.Errorf("security %v privileged %v read-only %v", hc.SecurityOpt, hc.Privileged, hc.ReadonlyRootfs)
	case hc.PidsLimit == nil || *hc.PidsLimit != 4096 || hc.Memory != a.Resources.MemoryBytes || hc.MemorySwap != a.Resources.MemoryBytes || hc.NanoCPUs != a.Resources.NanoCPUs || hc.ShmSize != 256<<20:
		t.Errorf("limits pids %v memory %d/%d cpus %d shm %d", hc.PidsLimit, hc.Memory, hc.MemorySwap, hc.NanoCPUs, hc.ShmSize)
	case len(hc.Ulimits) != 1 || hc.Ulimits[0].Name != "nofile" || hc.Ulimits[0].Soft != 65536 || hc.Ulimits[0].Hard != 65536:
		t.Errorf("ulimits %+v", hc.Ulimits)
	case hc.LogConfig.Type != "local" || hc.LogConfig.Config["max-size"] != "20m" || hc.LogConfig.Config["max-file"] != "3":
		t.Errorf("log rotation %+v", hc.LogConfig)
	case len(hc.Tmpfs) != 0 || len(hc.Mounts) != 0 || len(hc.Binds) != 0 || len(ctr.Mounts) != 0 || len(hc.PortBindings) != 0:
		t.Errorf("mounts %v %v %v %v ports %v", hc.Tmpfs, hc.Mounts, hc.Binds, ctr.Mounts, hc.PortBindings)
	}
	if nets := ctr.NetworkSettings.Networks; len(nets) != 1 || nets[network] == nil {
		t.Errorf("networks = %v, want exactly %s", nets, network)
	}
	// Inside: the bounding set holds only the two capabilities, no-new-privileges is on, nofile is
	// fixed, and /tmp is the disk-backed writable layer.
	status, _ := execIn(t, docker, ctr.ID, "cat", "/proc/self/status")
	if !strings.Contains(status, "CapBnd:\t0000000000002400") || !strings.Contains(status, "NoNewPrivs:\t1") {
		t.Errorf("process status:\n%s", status)
	}
	if limits, _ := execIn(t, docker, ctr.ID, "cat", "/proc/self/limits"); !strings.Contains(limits, "Max open files            65536                65536") {
		t.Errorf("limits:\n%s", limits)
	}
	if mounts, _ := execIn(t, docker, ctr.ID, "cat", "/proc/mounts"); strings.Contains(mounts, " /tmp ") {
		t.Errorf("/tmp is a separate mount:\n%s", mounts)
	}
	if _, code := execIn(t, docker, ctr.ID, "test", "-x", "/scantor/scantor"); code != 0 {
		t.Error("the runtime was not injected at /scantor/scantor")
	}
	eventually(t, 10*time.Second, "runtime output", func() bool {
		return strings.Contains(containerLogs(t, docker, ctr.ID), "fake runtime: runtime worker uid=0 dind=0")
	})
	netw, err := docker.NetworkInspect(ctx, network, client.NetworkInspectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if netw.Network.Driver != "bridge" || netw.Network.Options["com.docker.network.bridge.enable_icc"] != "false" || netw.Network.Labels["scantor.kind"] != "network" || netw.Network.EnableIPv6 {
		t.Errorf("worker network = %+v", netw.Network)
	}

	// Live resize: one ContainerUpdate, same container.
	a.Processes = 3
	a.Resources = api.AssignmentResources{NanoCPUs: 15e8, MemoryBytes: 3*64<<20 + 256<<20}
	orch.setDesired(a)
	waitStatus(t, orch, workerID, "resized", func(w *api.NodeWorkerStatus) bool { return w.Applied != nil && w.Applied.Processes == 3 })
	resized := inspectWorker(t, docker, workerID)
	if resized.ID != ctr.ID || resized.HostConfig.Memory != a.Resources.MemoryBytes || resized.HostConfig.MemorySwap != a.Resources.MemoryBytes || resized.HostConfig.NanoCPUs != a.Resources.NanoCPUs {
		t.Errorf("after resize: id %s memory %d/%d cpus %d", shortID(resized.ID), resized.HostConfig.Memory, resized.HostConfig.MemorySwap, resized.HostConfig.NanoCPUs)
	}

	// Crash: the exit is reported with its code and log tail, then the container restarts in place.
	if _, err := docker.ContainerKill(ctx, ctr.ID, client.ContainerKillOptions{Signal: "KILL"}); err != nil {
		t.Fatal(err)
	}
	crashed := waitStatus(t, orch, workerID, "backoff after the crash", func(w *api.NodeWorkerStatus) bool {
		return w.State == api.NodeWorkerBackoff && w.LastExit != nil
	})
	if crashed.LastExit.ExitCode != 137 || crashed.LastExit.OOMKilled || !strings.Contains(crashed.LastExit.LogTail, "fake runtime") || crashed.NextRestartAt == nil {
		t.Errorf("crash entry = %+v", crashed)
	}
	waitStatus(t, orch, workerID, "restarted", func(w *api.NodeWorkerStatus) bool {
		return w.State == api.NodeWorkerRunning && w.Restarts != nil && *w.Restarts == 1
	})
	if again := inspectWorker(t, docker, workerID); again.ID != ctr.ID {
		t.Error("the crashed container was recreated instead of restarted in place")
	}

	// On-demand log tail.
	requestID := uuid.NewString()
	orch.addLogRequest(api.LogRequest{RequestID: requestID, WorkerID: workerID, TailBytes: 4096})
	eventually(t, 30*time.Second, "log upload", func() bool {
		orch.mu.Lock()
		defer orch.mu.Unlock()
		return len(orch.logs[workerID]) > 0
	})
	orch.mu.Lock()
	upload := orch.logs[workerID][0]
	orch.mu.Unlock()
	if upload.RequestID != requestID || !strings.Contains(upload.Text, "fake runtime") || upload.Bytes != len(upload.Text) {
		t.Errorf("log upload = %+v", upload)
	}

	// Adoption: the daemon stops, the worker keeps running, the next daemon adopts it.
	d1.stop(t)
	before := inspectWorker(t, docker, workerID)
	if !before.State.Running {
		t.Fatal("the worker stopped with the daemon")
	}
	hellos := orch.helloCount()
	startIntegrationDaemon(t, docker, orch, network)
	eventually(t, 30*time.Second, "second hello", func() bool { return orch.helloCount() > hellos })
	orch.mu.Lock()
	hello := orch.hellos[len(orch.hellos)-1]
	orch.mu.Unlock()
	if !slices.ContainsFunc(hello.Containers, func(c api.NodeContainer) bool {
		return c.WorkerID == workerID && c.SpecHash == a.SpecHash && c.ContainerID == shortID(ctr.ID) && c.State == "running"
	}) {
		t.Errorf("hello containers = %+v", hello.Containers)
	}
	statuses := orch.statusCount()
	eventually(t, 30*time.Second, "adopted", func() bool {
		w := orch.workerStatus(workerID)
		return orch.statusCount() > statuses+1 && w != nil && w.State == api.NodeWorkerRunning && w.Applied != nil
	})
	if after := inspectWorker(t, docker, workerID); after.ID != before.ID || after.State.StartedAt != before.State.StartedAt {
		t.Error("the adopted worker was recreated or restarted")
	}

	// A spec change recreates the container.
	a.SpecHash = "sha256:" + strings.Repeat("ab", 32)
	orch.setDesired(a)
	eventually(t, 60*time.Second, "recreated", func() bool {
		res, err := docker.ContainerInspect(ctx, workerName(workerID), client.ContainerInspectOptions{})
		return err == nil && res.Container.ID != ctr.ID && res.Container.State.Running && res.Container.Config.Labels[container.LabelSpecHash] == a.SpecHash
	})

	// Removal: stopped with the drain grace and removed.
	orch.setDesired()
	waitStatus(t, orch, workerID, "removed", func(w *api.NodeWorkerStatus) bool { return w.State == api.NodeWorkerRemoved })
	if _, err := docker.ContainerInspect(ctx, workerName(workerID), client.ContainerInspectOptions{}); !container.IsNotFound(err) {
		t.Errorf("the worker container still exists: %v", err)
	}
}

// buildLinuxBinary cross-compiles the scantor binary for the engine's architecture.
func buildLinuxBinary(t *testing.T, arch string) []byte {
	t.Helper()
	out := filepath.Join(t.TempDir(), "scantor")
	cmd := exec.CommandContext(t.Context(), "go", "build", "-trimpath", "-o", out, "../../cmd/scantor")
	cmd.Env = append(os.Environ(), "GOOS=linux", "GOARCH="+arch, "CGO_ENABLED=0")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, output)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// TestEgressHelperAppliesRules runs the real egress helper (an image with the scantor binary and both
// iptables backends, like the scantor image) against the network namespace of a scratch container in
// which a DOCKER-USER chain was created, so the host's firewall is never touched.
func TestEgressHelperAppliesRules(t *testing.T) {
	docker := integrationClient(t)
	ctx := t.Context()
	_, arch, err := container.DaemonPlatform(ctx, docker)
	if err != nil {
		t.Fatal(err)
	}
	tag := *namePrefix + "egress:" + uuid.NewString()[:8]
	buildImage(t, docker, tag, "FROM "+integrationBase+"\nRUN apk add --no-cache iptables iptables-legacy\nCOPY scantor /usr/local/bin/scantor\n",
		map[string][]byte{"scantor": buildLinuxBinary(t, arch)})
	img, err := docker.ImageInspect(ctx, tag)
	if err != nil {
		t.Fatal(err)
	}

	netns, err := docker.ContainerCreate(ctx, client.ContainerCreateOptions{
		Name: *namePrefix + "netns-" + uuid.NewString()[:8],
		Config: &dcontainer.Config{
			Image: tag, Entrypoint: []string{"/bin/sh", "-c"}, Cmd: []string{"iptables-nft -w -N DOCKER-USER && exec sleep 600"},
			Labels: map[string]string{"scantor.test": "true"},
		},
		HostConfig: &dcontainer.HostConfig{NetworkMode: "none", CapAdd: []string{"NET_ADMIN"}, Init: boolPtr(true)},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = docker.ContainerRemove(context.Background(), netns.ID, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true})
	})
	if _, err := docker.ContainerStart(ctx, netns.ID, client.ContainerStartOptions{}); err != nil {
		t.Fatal(err)
	}
	eventually(t, 10*time.Second, "DOCKER-USER chain in the scratch namespace", func() bool {
		_, code := execIn(t, docker, netns.ID, "iptables-nft", "-w", "-n", "-L", "DOCKER-USER")
		return code == 0
	})

	nodeID := uuid.NewString()
	helperName := container.Name(container.KindEgressHelper, nodeID)
	t.Cleanup(func() {
		_, _ = docker.ContainerRemove(context.Background(), helperName, client.ContainerRemoveOptions{Force: true})
	})
	h := egressHelper{
		docker: docker, nodeID: nodeID, imageID: img.ID, deny: prefixes("169.254.0.0/16", "100.100.100.200/32", "fd00:ec2::254/128"),
		timeout: time.Minute, networkMode: "container:" + netns.ID,
	}

	// IPv6 has no DOCKER-USER chain yet: IPv4 is applied, the result is not.
	res, err := h.run(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if res.Applied || res.Families["ipv4"] != "iptables-nft" || res.Families["ipv6"] != "DOCKER-USER chain not found" {
		t.Errorf("first run = %+v", res)
	}
	if _, err := docker.ContainerInspect(ctx, helperName, client.ContainerInspectOptions{}); !container.IsNotFound(err) {
		t.Errorf("the helper container was not removed: %v", err)
	}
	rules, _ := execIn(t, docker, netns.ID, "iptables-nft", "-w", "-S")
	for _, want := range []string{
		"-A DOCKER-USER -j SCANTOR-EGRESS",
		"-A SCANTOR-EGRESS -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited",
		"-A SCANTOR-EGRESS -d 100.100.100.200/32 -j REJECT --reject-with icmp-admin-prohibited",
	} {
		if !strings.Contains(rules, want) {
			t.Errorf("rule %q missing:\n%s", want, rules)
		}
	}

	// With the IPv6 chain, both families apply; re-applying keeps a single jump and rebuilds the chain.
	if out, code := execIn(t, docker, netns.ID, "ip6tables-nft", "-w", "-N", "DOCKER-USER"); code != 0 {
		t.Fatalf("ip6tables-nft -N DOCKER-USER: %s", out)
	}
	res, err = h.run(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Applied || res.Families["ipv6"] != "ip6tables-nft" || len(res.Errors) != 0 {
		t.Errorf("second run = %+v", res)
	}
	rules, _ = execIn(t, docker, netns.ID, "iptables-nft", "-w", "-S")
	if n := strings.Count(rules, "-A DOCKER-USER -j SCANTOR-EGRESS"); n != 1 {
		t.Errorf("DOCKER-USER jumps = %d, want 1:\n%s", n, rules)
	}
	if n := strings.Count(rules, "-A SCANTOR-EGRESS"); n != 2 {
		t.Errorf("SCANTOR-EGRESS rules = %d, want 2:\n%s", n, rules)
	}
	rules6, _ := execIn(t, docker, netns.ID, "ip6tables-nft", "-w", "-S")
	if !strings.Contains(rules6, "-A SCANTOR-EGRESS -d fd00:ec2::254/128 -j REJECT --reject-with icmp6-adm-prohibited") || !strings.Contains(rules6, "-A DOCKER-USER -j SCANTOR-EGRESS") {
		t.Errorf("ipv6 rules:\n%s", rules6)
	}
}

func boolPtr(b bool) *bool { return &b }
