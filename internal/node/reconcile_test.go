package node

import (
	"strings"
	"testing"
	"time"

	dcontainer "github.com/moby/moby/api/types/container"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
)

func workerLabels(t *testing.T, workerID, nodeID, specHash string) map[string]string {
	t.Helper()
	labels, err := container.ManagedLabels(container.KindWorker, container.Identity{Worker: workerID, Scan: testScanID, User: testUserID, Node: nodeID, SpecHash: specHash})
	if err != nil {
		t.Fatal(err)
	}
	return labels
}

// LBL-5: a container is a worker only with the managed labels the daemon sets AND the name
// scantor-w-<scantor.worker>.
func TestClassifyWorker(t *testing.T) {
	good := workerLabels(t, testWorker1, testNodeID, "sha256:aa")
	hostile := map[string]string{}
	for k, v := range good {
		hostile[k] = v
	}
	hostile["com.docker.compose.project"] = "scantor"
	cases := []struct {
		name   string
		cname  string
		labels map[string]string
		ok     bool
	}{
		{"worker", "scantor-w-" + testWorker1, good, true},
		{"docker name with slash", "/scantor-w-" + testWorker1, good, true},
		{"copied labels, foreign name", "evil-" + testWorker1, good, false},
		{"copied labels, another worker's name", "scantor-w-" + testWorker2, good, false},
		{"name prefix only", "scantor-w-", good, false},
		{"image labels claiming another project", "scantor-w-" + testWorker1, hostile, false},
		{"no labels", "scantor-w-" + testWorker1, nil, false},
		{"helper kind", "scantor-w-" + testWorker1, map[string]string{"scantor.managed": "true", "scantor.kind": "helper"}, false},
	}
	for _, tc := range cases {
		w, reason := classifyWorker("id", tc.cname, tc.labels)
		if (reason == "") != tc.ok {
			t.Errorf("%s: reason %q, want ok=%v", tc.name, reason, tc.ok)
		}
		if tc.ok && (w.workerID != testWorker1 || w.nodeID != testNodeID || w.specHash != "sha256:aa") {
			t.Errorf("%s: %+v", tc.name, w)
		}
	}
}

// SB-6: a worker container of this node that is not in the desired set is stopped and removed with its
// anonymous volumes; foreign containers stay untouched.
func TestUnassignedWorkersAreRemoved(t *testing.T) {
	h := newHarness(t, nil)
	stale := h.docker.addContainer(workerName(testWorker2), workerLabels(t, testWorker2, h.orch.nodeID, "sha256:aa"), dcontainer.StateExited)
	foreign := h.docker.addContainer("postgres", map[string]string{"scantor.managed": "true"}, dcontainer.StateRunning)
	h.start()
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	h.waitWorkerState(testWorker2, api.NodeWorkerRemoved)
	if h.docker.container(stale.id) != nil || h.docker.callCount("remove "+stale.id+" force=true v=true") != 1 {
		t.Errorf("the unassigned container was not removed with its volumes: %v", h.docker.calls)
	}
	if h.docker.container(foreign.id) == nil {
		t.Error("a foreign container was removed")
	}
}

// A corrected assignment is tried at once, even when spec hash and image did not change.
func TestCorrectedAssignmentIsRetried(t *testing.T) {
	h := newHarness(t, nil)
	h.start()
	a := testAssignment(testWorker1)
	a.Env["SCANTOR_WORKER_TOKEN"] = "swt_" + testWorker2 + ".mac"
	h.orch.setDesired(a)
	st := h.waitWorkerState(testWorker1, api.NodeWorkerError)
	if st.Error == nil || !strings.Contains(st.Error.Message, "SCANTOR_WORKER_TOKEN") {
		t.Fatalf("error = %+v", st.Error)
	}
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
}

func TestForeignNameConflictIsNeverRemoved(t *testing.T) {
	h := newHarness(t, nil)
	foreign := h.docker.addContainer(workerName(testWorker1), map[string]string{"app": "other"}, dcontainer.StateRunning)
	h.start()
	h.orch.setDesired(testAssignment(testWorker1))
	st := h.waitWorkerState(testWorker1, api.NodeWorkerError)
	if st.Error == nil || st.Error.Code != api.NodeWorkerCreateFailed || !strings.Contains(st.Error.Message, "foreign") {
		t.Errorf("error = %+v", st.Error)
	}
	h.orch.setDesired()
	time.Sleep(300 * time.Millisecond)
	if h.docker.container(foreign.id) == nil || h.docker.callCount("stop ") != 0 || h.docker.callCount("remove ") != 0 {
		t.Error("a foreign container was touched")
	}
}

func TestSpecHashChangeRecreates(t *testing.T) {
	h := newHarness(t, nil)
	h.start()
	a := testAssignment(testWorker1)
	h.orch.setDesired(a)
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	first := h.docker.container(workerName(testWorker1)).id
	a.SpecHash = "sha256:ffff"
	h.orch.setDesired(a)
	eventually(t, 5*time.Second, "recreated", func() bool {
		c := h.docker.container(workerName(testWorker1))
		return c != nil && c.id != first && c.state.Status == dcontainer.StateRunning
	})
	if c := h.docker.container(workerName(testWorker1)); c.config.Labels[container.LabelSpecHash] != "sha256:ffff" {
		t.Errorf("spec hash label = %q", c.config.Labels[container.LabelSpecHash])
	}
}

func TestRemovalStopsWithGraceAndReportsRemoved(t *testing.T) {
	h := newHarness(t, nil)
	h.start()
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	c := h.docker.container(workerName(testWorker1))
	h.orch.setDesired()
	h.waitWorkerState(testWorker1, api.NodeWorkerRemoved)
	if len(c.stopArgs) != 1 || c.stopArgs[0] != 35 {
		t.Errorf("stop timeouts = %v, want [35] (drainGraceMs/1000 + 5)", c.stopArgs)
	}
	if h.docker.callCount("remove "+c.id+" force=true v=true") != 1 {
		t.Errorf("calls = %v", h.docker.calls)
	}
	// Removed workers are reported three times, then dropped.
	eventually(t, 5*time.Second, "removed entry dropped", func() bool {
		st := h.orch.lastStatus()
		return st != nil && len(st.Workers) == 0
	})
	h.orch.mu.Lock()
	removedReports := 0
	for _, st := range h.orch.statuses {
		for _, w := range st.Workers {
			if w.State == api.NodeWorkerRemoved {
				removedReports++
			}
		}
	}
	h.orch.mu.Unlock()
	if removedReports != 3 {
		t.Errorf("removed was reported %d times, want 3", removedReports)
	}
}

func TestAdoptionKeepsRunningContainerAndReissuesLimits(t *testing.T) {
	h := newHarness(t, nil)
	a := testAssignment(testWorker1)
	labels, _ := container.ManagedLabels(container.KindWorker, container.Identity{Worker: testWorker1, Scan: testScanID, User: testUserID, Node: h.orch.nodeID, SpecHash: a.SpecHash})
	c := h.docker.addContainer(workerName(testWorker1), labels, dcontainer.StateRunning)
	c.host.Memory, c.host.NanoCPUs = a.Resources.MemoryBytes, a.Resources.NanoCPUs
	h.orch.setDesired(a)
	h.start()
	st := h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	eventually(t, 5*time.Second, "applied known after adoption", func() bool {
		w := h.orch.workerStatus(testWorker1)
		return w != nil && w.Applied != nil
	})
	if c.updates != 1 {
		t.Errorf("updates after adoption = %d, want exactly 1", c.updates)
	}
	if h.docker.callCount("create ") != 0 || h.docker.callCount("stop ") != 0 || c.starts != 0 {
		t.Error("an adopted running container must keep running untouched")
	}
	if st.ContainerID != shortID(c.id) {
		t.Errorf("containerId = %q", st.ContainerID)
	}
}

func TestAdoptedContainersAreOnlyTrackedBeforeTheFirstAssignments(t *testing.T) {
	h := newHarness(t, nil)
	labels, _ := container.ManagedLabels(container.KindWorker, container.Identity{Worker: testWorker1, Scan: testScanID, User: testUserID, Node: h.orch.nodeID, SpecHash: "sha256:aa"})
	c := h.docker.addContainer(workerName(testWorker1), labels, dcontainer.StateRunning)
	h.orch.fail("assignments", fakeFailure{status: 503, code: "unavailable"})
	h.start()
	st := h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	if st.ContainerID != shortID(c.id) {
		t.Errorf("tracked entry = %+v", st)
	}
	time.Sleep(300 * time.Millisecond)
	if h.docker.container(c.id) == nil || h.docker.callCount("stop ") != 0 {
		t.Fatal("a container was removed before the first assignments response")
	}
	// The first desired set does not list it: now it is removed.
	h.orch.clearFailures()
	h.waitWorkerState(testWorker1, api.NodeWorkerRemoved)
	if h.docker.container(c.id) != nil {
		t.Error("an undesired adopted container was not removed")
	}
}

func TestForeignContainersAreIgnored(t *testing.T) {
	h := newHarness(t, nil)
	// LBL-5: copied labels but a foreign name, and a worker name with another node's label.
	copied, _ := container.ManagedLabels(container.KindWorker, container.Identity{Worker: testWorker1, Scan: testScanID, User: testUserID, Node: h.orch.nodeID, SpecHash: "sha256:aa"})
	evil := h.docker.addContainer("evil-scantor-w-x", copied, dcontainer.StateRunning)
	otherNode, _ := container.ManagedLabels(container.KindWorker, container.Identity{Worker: testWorker2, Scan: testScanID, User: testUserID, Node: "11111111-2222-4333-8444-555555555555", SpecHash: "sha256:aa"})
	other := h.docker.addContainer(workerName(testWorker2), otherNode, dcontainer.StateRunning)
	h.start()
	h.orch.setDesired()
	eventually(t, 5*time.Second, "a status after the first desired set", func() bool { return h.orch.statusCount() > 2 })
	time.Sleep(200 * time.Millisecond)
	if h.docker.container(evil.id) == nil || h.docker.container(other.id) == nil || h.docker.callCount("stop ") != 0 || h.docker.callCount("remove ") != 0 {
		t.Error("a container that is not a worker of this node was touched")
	}
	if st := h.orch.lastStatus(); len(st.Workers) != 0 {
		t.Errorf("foreign containers were reported: %+v", st.Workers)
	}
	if !h.logContains("ignoring a container that is not a worker of this node") {
		t.Error("ignored containers are not logged")
	}
}
