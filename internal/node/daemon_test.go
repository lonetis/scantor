package node

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	dcontainer "github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
	"github.com/lonetis/scantor/internal/version"
)

func TestHelloReportsHostAndAdoptionCandidates(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.MaxWorkers = 0 })
	labels, _ := container.ManagedLabels(container.KindWorker, container.Identity{Worker: testWorker1, Scan: testScanID, User: testUserID, Node: h.orch.nodeID, SpecHash: "sha256:aa"})
	h.docker.addContainer(workerName(testWorker1), labels, dcontainer.StateRunning)
	h.start()
	eventually(t, 5*time.Second, "hello", func() bool { return h.orch.helloCount() > 0 })
	h.orch.mu.Lock()
	hello := h.orch.hellos[0]
	hdr := h.orch.helloHeaders[0]
	h.orch.mu.Unlock()
	if !strings.HasPrefix(hello.InstanceID, h.docker.engineID+":") || len(hello.InstanceID) != len(h.docker.engineID)+9 {
		t.Errorf("instanceId = %q, want <engine id>:<8 hex>", hello.InstanceID)
	}
	if hello.Version != version.Version || hdr.Get(api.HeaderVersion) != version.Version {
		t.Errorf("version = %q / header %q", hello.Version, hdr.Get(api.HeaderVersion))
	}
	info := hello.Info
	if info.OS != "linux" || info.Arch != "arm64" || info.CPUs != 8 || info.MaxWorkers != 8 || info.DinDMode != DinDDisabled || info.Hostname != "fake-host" || info.DockerVersion != "29.9.1" {
		t.Errorf("unexpected hello info %+v", info)
	}
	if info.DiskFreeBytes != 100<<30 {
		t.Errorf("diskFreeBytes = %d", info.DiskFreeBytes)
	}
	if len(hello.Containers) != 1 || hello.Containers[0].WorkerID != testWorker1 || hello.Containers[0].SpecHash != "sha256:aa" || hello.Containers[0].State != "running" {
		t.Errorf("containers = %+v", hello.Containers)
	}
	// Later requests carry the instance id.
	eventually(t, 5*time.Second, "assignments call", func() bool {
		h.orch.mu.Lock()
		defer h.orch.mu.Unlock()
		return len(h.orch.instanceIDs) > 0
	})
	h.orch.mu.Lock()
	gotID := h.orch.instanceIDs[0]
	h.orch.mu.Unlock()
	if gotID != hello.InstanceID {
		t.Errorf("X-Scantor-Instance-Id = %q, want %q", gotID, hello.InstanceID)
	}
}

func TestCreatesStartsAndReportsWorker(t *testing.T) {
	ca := testCACert(t)
	h := newHarness(t, func(c *Config) { c.CACert = ca; c.AllowInsecure = true })
	h.start()
	a := testAssignment(testWorker1)
	h.orch.setDesired(a)
	st := h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	if st.Applied == nil || *st.Applied != (api.AppliedLimits{Processes: 2, NanoCPUs: 2e9, MemoryBytes: 1_342_177_280}) {
		t.Errorf("applied = %+v", st.Applied)
	}
	if st.ContainerID == "" || len(st.ContainerID) != 12 || st.Restarts == nil || *st.Restarts != 0 || st.StartedAt == nil {
		t.Errorf("unexpected running entry %+v", st)
	}
	c := h.docker.container(workerName(testWorker1))
	if c == nil {
		t.Fatal("container scantor-w-<workerId> not created")
	}
	if _, ok := c.files["/scantor/scantor"]; !ok {
		t.Error("the runtime binary was not injected at /scantor/scantor")
	}
	if got := c.config.Labels[container.LabelNode]; got != h.orch.nodeID {
		t.Errorf("scantor.node = %q", got)
	}
	if c.config.Labels[container.LabelSpecHash] != a.SpecHash || c.config.Labels["traefik.enable"] != "false" {
		t.Errorf("labels = %v", c.config.Labels)
	}
	wantEnv := []string{
		"SCANTOR_URL=https://scantor.example.com",
		"SCANTOR_WORKER_TOKEN=" + a.Env["SCANTOR_WORKER_TOKEN"],
		"SCANTOR_CA_CERT=" + ca,
		"SCANTOR_ALLOW_INSECURE_TRANSPORT=true",
	}
	if strings.Join(c.config.Env, "|") != strings.Join(wantEnv, "|") {
		t.Errorf("env = %q", c.config.Env)
	}
	if string(c.host.NetworkMode) != container.NetworkWorkers {
		t.Errorf("network = %s", c.host.NetworkMode)
	}
	if h.docker.callCount("network create scantor-workers") == 0 {
		t.Error("the remote node did not create scantor-workers")
	}
	if h.docker.callCount("pull ") != 0 {
		t.Error("a present image must not be pulled")
	}
	// The status file is written after successful reports.
	eventually(t, 5*time.Second, "healthcheck passes", func() bool { return Healthcheck(h.d.statusFile, time.Now()) == nil })
}

func TestPullsMissingImageWithNodeCredential(t *testing.T) {
	h := newHarness(t, nil)
	h.docker.mu.Lock()
	for id := range h.docker.images {
		delete(h.docker.images, id)
	}
	h.docker.mu.Unlock()
	h.start()
	a := testAssignment(testWorker1)
	base := "ghcr.io/lonetis/scantor-base-js@sha256:" + strings.Repeat("0", 64)
	a.BaseImage = &base
	h.orch.setDesired(a)
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	h.docker.mu.Lock()
	auth := h.docker.pullAuth[a.Image]
	baseAuth, basePulled := h.docker.pullAuth[base]
	h.docker.mu.Unlock()
	if !basePulled || baseAuth != "" {
		t.Errorf("the base image must be pulled anonymously first (pulled=%v auth=%q)", basePulled, baseAuth)
	}
	// MC-8: base64url WITH padding of {"username","password","serveraddress"}.
	raw, err := base64.URLEncoding.DecodeString(auth)
	if err != nil {
		t.Fatalf("X-Registry-Auth is not padded base64url: %v (%q)", err, auth)
	}
	var cfg map[string]string
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg["username"] != "node" || cfg["password"] != testToken || cfg["serveraddress"] != "registry.example.com" {
		t.Errorf("auth config = %v", cfg)
	}
}

func TestPullFailureIsRetriedWithBackoff(t *testing.T) {
	h := newHarness(t, nil)
	h.docker.mu.Lock()
	for id := range h.docker.images {
		delete(h.docker.images, id)
	}
	failures := 0
	h.docker.pullErr = func(string) error {
		if failures < 2 {
			failures++
			return errors.New("unexpected status from GET request: 401 Unauthorized")
		}
		return nil
	}
	h.docker.mu.Unlock()
	h.start()
	h.orch.setDesired(testAssignment(testWorker1))
	st := h.waitWorkerState(testWorker1, api.NodeWorkerError)
	if st.Error == nil || st.Error.Code != api.NodeWorkerImagePullFailed || !strings.Contains(st.Error.Message, "401") {
		t.Errorf("error = %+v", st.Error)
	}
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	if n := h.docker.callCount("pull "); n != 3 {
		t.Errorf("pulls = %d, want 3", n)
	}
}

func TestPlatformMismatchIsNotRetried(t *testing.T) {
	h := newHarness(t, nil)
	h.docker.mu.Lock()
	for id := range h.docker.images {
		delete(h.docker.images, id)
	}
	h.docker.pullPlatform = func(string) (string, string) { return "linux", "amd64" }
	h.docker.mu.Unlock()
	h.start()
	h.orch.setDesired(testAssignment(testWorker1))
	st := h.waitWorkerState(testWorker1, api.NodeWorkerError)
	if st.Error == nil || st.Error.Code != api.NodeWorkerPlatformMismatch {
		t.Fatalf("error = %+v", st.Error)
	}
	time.Sleep(300 * time.Millisecond)
	if n := h.docker.callCount("create "); n != 0 {
		t.Errorf("a platform mismatch must not create a container (creates = %d)", n)
	}
}

func TestInvalidAssignmentIsNeverCreated(t *testing.T) {
	h := newHarness(t, nil)
	h.start()
	a := testAssignment(testWorker1)
	a.CapAdd = []string{"SYS_ADMIN"}
	h.orch.setDesired(a)
	st := h.waitWorkerState(testWorker1, api.NodeWorkerError)
	if st.Error == nil || st.Error.Code != api.NodeWorkerCreateFailed || !strings.Contains(st.Error.Message, "capAdd") {
		t.Errorf("error = %+v", st.Error)
	}
	time.Sleep(200 * time.Millisecond)
	if h.docker.callCount("create ") != 0 {
		t.Error("an invalid assignment was created")
	}
}

func TestCrashBackoffAndRestart(t *testing.T) {
	h := newHarness(t, nil)
	h.docker.logs[workerName(testWorker1)] = strings.Repeat("x", 5000) + "\nboom é\n"
	h.start()
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	h.docker.exit(workerName(testWorker1), 137, true)
	st := h.waitWorkerState(testWorker1, api.NodeWorkerBackoff)
	if st.LastExit == nil || st.LastExit.ExitCode != 137 || !st.LastExit.OOMKilled || st.NextRestartAt == nil {
		t.Fatalf("backoff entry = %+v", st)
	}
	if len(st.LastExit.LogTail) > 4096 || !strings.HasSuffix(st.LastExit.LogTail, "boom é\n") {
		t.Errorf("logTail has %d bytes, suffix %q", len(st.LastExit.LogTail), st.LastExit.LogTail[max(0, len(st.LastExit.LogTail)-10):])
	}
	eventually(t, 5*time.Second, "restart", func() bool {
		w := h.orch.workerStatus(testWorker1)
		return w != nil && w.State == api.NodeWorkerRunning && w.Restarts != nil && *w.Restarts == 1
	})
	c := h.docker.container(workerName(testWorker1))
	if c.starts != 2 || h.docker.callCount("create ") != 1 {
		t.Errorf("the container must be restarted in place (starts=%d creates=%d)", c.starts, h.docker.callCount("create "))
	}
	// The exit keeps being reported with the restart.
	if w := h.orch.workerStatus(testWorker1); w.LastExit == nil || w.LastExit.ExitCode != 137 {
		t.Errorf("lastExit lost after restart: %+v", w)
	}
}

func TestCrashDelayDoubles(t *testing.T) {
	h := newHarness(t, nil)
	h.start()
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	var delays []time.Duration
	for i := 0; i < 3; i++ {
		h.docker.exit(workerName(testWorker1), 1, false)
		st := h.waitWorkerState(testWorker1, api.NodeWorkerBackoff)
		delays = append(delays, st.NextRestartAt.Sub(st.LastExit.At.Time))
		h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	}
	// 100 ms, 200 ms, 400 ms (crashMax) with ±10 % jitter (plus scheduling slack).
	for i, want := range []time.Duration{100 * time.Millisecond, 200 * time.Millisecond, 400 * time.Millisecond} {
		if delays[i] < want*85/100 || delays[i] > want*115/100+50*time.Millisecond {
			t.Errorf("delay %d = %s, want about %s", i+1, delays[i], want)
		}
	}
}

func TestCleanExitIsTransient(t *testing.T) {
	h := newHarness(t, nil)
	h.start()
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	h.docker.exit(workerName(testWorker1), 0, false)
	st := h.waitWorkerState(testWorker1, api.NodeWorkerBackoff)
	if d := st.NextRestartAt.Sub(st.LastExit.At.Time); d < 140*time.Millisecond || d > 300*time.Millisecond {
		t.Errorf("exit 0 delay = %s, want exitZeroDelay (150 ms)", d)
	}
	a := h.d.sessionActorForTest(testWorker1)
	if a == nil {
		t.Fatal("no actor")
	}
	a.mu.Lock()
	crashes := a.crashes
	a.mu.Unlock()
	if crashes != 0 {
		t.Errorf("exit 0 counted as a crash (%d)", crashes)
	}
}

func TestLiveResize(t *testing.T) {
	h := newHarness(t, nil)
	h.start()
	a := testAssignment(testWorker1)
	h.orch.setDesired(a)
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	a.Processes = 3
	a.Resources = api.AssignmentResources{NanoCPUs: 3e9, MemoryBytes: 3*512<<20 + 256<<20}
	h.orch.setDesired(a)
	eventually(t, 5*time.Second, "applied processes 3", func() bool {
		w := h.orch.workerStatus(testWorker1)
		return w != nil && w.Applied != nil && w.Applied.Processes == 3
	})
	c := h.docker.container(workerName(testWorker1))
	if c.host.Memory != a.Resources.MemoryBytes || c.host.MemorySwap != a.Resources.MemoryBytes || c.host.NanoCPUs != 3e9 {
		t.Errorf("limits = %d/%d/%d", c.host.Memory, c.host.MemorySwap, c.host.NanoCPUs)
	}
	if h.docker.callCount("create ") != 1 {
		t.Error("a resize must not recreate the container")
	}
	// A failing update keeps the old applied limits.
	h.docker.mu.Lock()
	h.docker.updateErr = errors.New("EBUSY")
	h.docker.mu.Unlock()
	a.Processes = 1
	a.Resources = api.AssignmentResources{NanoCPUs: 1e9, MemoryBytes: 512<<20 + 256<<20}
	h.orch.setDesired(a)
	time.Sleep(300 * time.Millisecond)
	if w := h.orch.workerStatus(testWorker1); w.Applied == nil || w.Applied.Processes != 3 {
		t.Errorf("applied after a failed update = %+v", w.Applied)
	}
	h.docker.mu.Lock()
	h.docker.updateErr = nil
	h.docker.mu.Unlock()
	eventually(t, 5*time.Second, "applied processes 1", func() bool {
		w := h.orch.workerStatus(testWorker1)
		return w != nil && w.Applied != nil && w.Applied.Processes == 1
	})
}

func TestBuiltInNodeNeedsSandboxNetwork(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.BuiltIn = true })
	h.start()
	h.orch.setDesired(testAssignment(testWorker1))
	st := h.waitWorkerState(testWorker1, api.NodeWorkerError)
	if st.Error == nil || !strings.Contains(st.Error.Message, container.NetworkSandbox) {
		t.Errorf("error = %+v", st.Error)
	}
	if h.docker.callCount("network create") != 0 {
		t.Error("the built-in node must not create networks")
	}
	// compose creates scantor-sandbox with inter-container traffic on, which the built-in node accepts.
	h.docker.addNetwork(network.Network{Name: container.NetworkSandbox, Driver: "bridge"})
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	if c := h.docker.container(workerName(testWorker1)); string(c.host.NetworkMode) != container.NetworkSandbox {
		t.Errorf("network = %s", c.host.NetworkMode)
	}
}

// An existing scantor-workers network that the daemon did not create as an isolated network is never
// used: workers of different scans and users on it could reach each other (docs/nodes.md §6.8).
func TestRemoteNodeRefusesAWorkerNetworkWithInterContainerTraffic(t *testing.T) {
	h := newHarness(t, nil)
	labels, err := container.ManagedLabels(container.KindNetwork, container.Identity{})
	if err != nil {
		t.Fatal(err)
	}
	h.docker.addNetwork(network.Network{Name: container.NetworkWorkers, Driver: "bridge", Labels: labels})
	h.start()
	h.orch.setDesired(testAssignment(testWorker1))
	st := h.waitWorkerState(testWorker1, api.NodeWorkerError)
	if st.Error == nil || st.Error.Code != api.NodeWorkerCreateFailed || !strings.Contains(st.Error.Message, "inter-container traffic is enabled") {
		t.Errorf("error = %+v", st.Error)
	}
	if h.docker.callCount("create "+workerName(testWorker1)) != 0 {
		t.Error("a worker was created on a network with inter-container traffic")
	}
	if !h.logContains("the worker network is not usable") {
		t.Error("the unsafe network was not logged")
	}

	// Once the operator replaced it with an isolated network, the worker is created at once.
	h.docker.addNetwork(network.Network{
		Name: container.NetworkWorkers, Driver: "bridge", Labels: labels,
		Options: map[string]string{"com.docker.network.bridge.enable_icc": "false"},
	})
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
}

func TestConflictStopsWithoutTouchingContainers(t *testing.T) {
	h := newHarness(t, nil)
	h.start()
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	hellos := h.orch.helloCount()
	h.orch.fail("assignments", fakeFailure{status: http.StatusConflict, code: api.CodeNodeInstanceConflict, details: map[string]any{"retryAfterMs": 0}})
	h.orch.fail("hello", fakeFailure{status: http.StatusConflict, code: api.CodeNodeInstanceConflict, details: map[string]any{"retryAfterMs": 50}, times: 2})
	h.orch.fail("status", fakeFailure{status: http.StatusConflict, code: api.CodeNodeInstanceConflict, details: map[string]any{"retryAfterMs": 0}, times: 1})
	eventually(t, 5*time.Second, "back to hello", func() bool { return h.orch.helloCount() > hellos })
	if h.docker.callCount("stop ") != 0 || h.docker.callCount("remove ") != 0 {
		t.Error("containers were touched after a 409 nodeInstanceConflict")
	}
	if !h.logContains("another daemon instance") {
		t.Error("the conflict was not logged")
	}
}

// A 409 after hello means another instance holds the lease now (docs/nodes.md §5.2). A hello would take
// a lease of the same engine over at once, so two daemons on one engine would evict each other forever.
// The superseded daemon stands by instead: it probes with wait=0 assignments calls, touches no
// container, and says hello again only when the other instance's lease has expired.
func TestSupersededInstanceStandsByUntilTheLeaseExpires(t *testing.T) {
	h := newHarness(t, nil)
	h.start()
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	hellos := h.orch.helloCount()
	h.orch.fail("assignments", fakeFailure{status: http.StatusConflict, code: api.CodeNodeInstanceConflict, details: map[string]any{"retryAfterMs": 100}})
	eventually(t, 5*time.Second, "lease probes while standing by", func() bool { return h.orch.failureCount("assignments") >= 5 })
	if n := h.orch.helloCount(); n != hellos {
		t.Errorf("%d hellos while another instance held the lease", n-hellos)
	}
	if h.docker.callCount("stop ") != 0 || h.docker.callCount("remove ") != 0 {
		t.Error("containers were touched while standing by")
	}
	if !h.logContains("standing by until its lease expires") {
		t.Error("the stand-by was not logged")
	}

	// The other instance's lease expired: the next probe says so, and the daemon registers again.
	h.orch.fail("assignments", fakeFailure{status: http.StatusConflict, code: api.CodeNodeInstanceConflict, details: map[string]any{"retryAfterMs": 0}, times: 1})
	eventually(t, 5*time.Second, "hello after the lease expired", func() bool { return h.orch.helloCount() > hellos })
	h.orch.setDesired(testAssignment(testWorker1), testAssignment(testWorker2))
	h.waitWorkerState(testWorker2, api.NodeWorkerRunning)
}

func TestUnauthorizedModeRemovesWorkersAfterTheOfflineWindow(t *testing.T) {
	h := newHarness(t, nil)
	h.orch.config.OfflineAfterMs = 400
	h.start()
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	h.orch.mu.Lock()
	h.orch.token = "snt_rotatedrotatedrotatedrotatedrotatedrotate"
	h.orch.mu.Unlock()
	eventually(t, 5*time.Second, "unauthorized mode", func() bool { return h.logContains("not creating containers") })
	start := time.Now()
	h.orch.setDesired(testAssignment(testWorker1), testAssignment(testWorker2))
	eventually(t, 5*time.Second, "workers removed", func() bool {
		return h.docker.container(workerName(testWorker1)) == nil
	})
	if time.Since(start) < 350*time.Millisecond {
		t.Errorf("workers were removed after %s, before the offline window", time.Since(start))
	}
	if h.docker.callCount("create "+workerName(testWorker2)) != 0 {
		t.Error("a container was created in unauthorized mode")
	}
}

func TestShutdownLeavesWorkersRunningAndSendsFinalStatus(t *testing.T) {
	h := newHarness(t, nil)
	h.start()
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	before := h.orch.statusCount()
	if err := h.stop(); err != nil {
		t.Fatalf("Run returned %v", err)
	}
	if c := h.docker.container(workerName(testWorker1)); c == nil || c.state.Status != dcontainer.StateRunning {
		t.Error("the worker must keep running when the daemon stops")
	}
	if h.orch.statusCount() <= before {
		t.Error("no final status at shutdown")
	}
}

func TestLogRequestsAreAnsweredOnce(t *testing.T) {
	h := newHarness(t, nil)
	h.docker.logs[workerName(testWorker1)] = strings.Repeat("line\n", 100)
	h.start()
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	h.orch.addLogRequest(api.LogRequest{RequestID: "61c0e9a2-3b4d-4e5f-8a6b-7c8d9e0f1a2b", WorkerID: testWorker1, TailBytes: 64})
	h.orch.addLogRequest(api.LogRequest{RequestID: "71c0e9a2-3b4d-4e5f-8a6b-7c8d9e0f1a2b", WorkerID: testWorker2, TailBytes: 64})
	eventually(t, 5*time.Second, "log uploads", func() bool {
		h.orch.mu.Lock()
		defer h.orch.mu.Unlock()
		return len(h.orch.logs[testWorker1]) > 0 && len(h.orch.logs[testWorker2]) > 0
	})
	h.orch.mu.Lock()
	got := h.orch.logs[testWorker1][0]
	none := h.orch.logs[testWorker2][0]
	h.orch.mu.Unlock()
	if got.Bytes != 64 || len(got.Text) != 64 || !got.Truncated || !strings.HasSuffix(got.Text, "line\n") {
		t.Errorf("upload = %+v", got)
	}
	if none.Text != "" || none.Bytes != 0 {
		t.Errorf("a worker without a container must be answered with empty text: %+v", none)
	}
	time.Sleep(200 * time.Millisecond)
	h.orch.mu.Lock()
	defer h.orch.mu.Unlock()
	if len(h.orch.logs[testWorker1]) != 1 {
		t.Errorf("a request was answered %d times", len(h.orch.logs[testWorker1]))
	}
}

func TestHelloRetryTable(t *testing.T) {
	h := newHarness(t, nil)
	h.d.started = time.Now()
	if err := h.d.connect(t.Context()); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name    string
		fail    fakeFailure
		kind    apiErrKind
		atLeast time.Duration
		atMost  time.Duration
	}{
		{"401", fakeFailure{status: 401, code: "unauthorized", times: 1}, errUnauthorized, h.d.t.unauthorizedRetry, h.d.t.unauthorizedRetry},
		{"409", fakeFailure{status: 409, code: api.CodeNodeInstanceConflict, details: map[string]any{"retryAfterMs": 5000}, times: 1}, errConflict, 5 * time.Second, 7 * time.Second},
		{"426", fakeFailure{status: 426, code: api.CodeIncompatibleVersion, details: map[string]any{"minVersion": "1.4.0"}, times: 1}, errIncompatible, h.d.t.incompatibleRetry, h.d.t.incompatibleRetry},
		{"503", fakeFailure{status: 503, code: "unavailable", times: 1}, errTransient, h.d.t.apiBackoffMin * 8 / 10, h.d.t.apiBackoffMin * 12 / 10},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h.orch.fail("hello", tc.fail)
			b := backoff{min: h.d.t.apiBackoffMin, max: h.d.t.apiBackoffMax}
			resp, delay, kind := h.d.helloOnce(t.Context(), &b)
			if resp != nil || kind != tc.kind || delay < tc.atLeast || delay > tc.atMost {
				t.Errorf("got resp=%v delay=%s kind=%d", resp != nil, delay, kind)
			}
		})
	}
	if !h.logContains("minVersion=1.4.0") {
		t.Error("426 must be logged with details.minVersion")
	}
}

func TestPlaintextToPublicHostIsAConfigError(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.URL = "http://203.0.113.10:3000" })
	err := h.d.Run(t.Context())
	var cfgErr *ConfigError
	if !errors.As(err, &cfgErr) || !errors.Is(err, api.ErrPlaintextRefused) {
		t.Fatalf("Run = %v, want a ConfigError wrapping ErrPlaintextRefused", err)
	}
}

// An engine older than Docker Engine 25 cannot become supported while the daemon runs, so start-up fails
// with exit 2 instead of retrying it as "Docker is not available yet" forever (docs/nodes.md §5.1).
func TestOldDockerEngineIsAConfigError(t *testing.T) {
	h := newHarness(t, nil)
	h.docker.apiVersion = "1.43"
	done := make(chan error, 1)
	go func() { done <- h.d.Run(t.Context()) }()
	select {
	case err := <-done:
		var cfgErr *ConfigError
		if !errors.As(err, &cfgErr) || !strings.Contains(err.Error(), "Docker Engine 25 or newer (API 1.44)") {
			t.Fatalf("Run = %v, want a ConfigError naming the required version", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the daemon kept retrying an engine that is too old")
	}
	if h.orch.helloCount() != 0 || h.logContains("Docker is not available yet") {
		t.Error("an engine that is too old was treated as unavailable")
	}
}

func TestStatusReportsCapacityAndClockOffset(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.MaxWorkers = 3 })
	h.start()
	eventually(t, 5*time.Second, "status", func() bool { return h.orch.statusCount() > 1 })
	st := h.orch.lastStatus()
	if st.Info.MaxWorkers != 3 || st.Info.CPUs != 8 || st.Info.MemoryBytes != 16<<30 || st.Info.Version != version.Version || st.Info.DiskFreeBytes != 100<<30 {
		t.Errorf("info = %+v", st.Info)
	}
	if st.InstanceID == "" {
		t.Error("no instanceId")
	}
	if st.ClockOffsetMs < -1000 || st.ClockOffsetMs > 1000 {
		t.Errorf("clockOffsetMs = %d against a local server", st.ClockOffsetMs)
	}
	data, err := os.ReadFile(h.d.statusFile)
	if err != nil {
		t.Fatal(err)
	}
	var rec statusRecord
	if err := json.Unmarshal(data, &rec); err != nil || rec.NodeID != h.orch.nodeID || rec.StatusIntervalMs != 200 {
		t.Errorf("status file = %s (%v)", data, err)
	}
}

func TestDinDDowngradeWithoutSysboxRuntime(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.DinD = DinDSysbox })
	h.start()
	eventually(t, 5*time.Second, "hello", func() bool { return h.orch.helloCount() > 0 })
	h.orch.mu.Lock()
	mode := h.orch.hellos[0].Info.DinDMode
	h.orch.mu.Unlock()
	if mode != DinDDisabled {
		t.Errorf("dindMode = %q, want disabled without sysbox-runc", mode)
	}
}

// sessionActorForTest returns the actor of a worker in the current session (tests only).
func (d *Daemon) sessionActorForTest(workerID string) *actor {
	s := d.current.Load()
	if s == nil {
		return nil
	}
	return s.actor(workerID)
}
