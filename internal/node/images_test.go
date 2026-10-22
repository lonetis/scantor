package node

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moby/moby/api/types/image"

	"github.com/lonetis/scantor/internal/api"
)

// MC-8: the node credential travels only per pull in X-Registry-Auth: base64url WITH '=' padding of
// {"username": "node", "password": <node token>, "serveraddress": <registry host>}. The daemon never logs
// in and never touches the host's Docker configuration (the fake engine panics on any API outside the
// subset the daemon may use, RegistryLogin included).
func TestPullUsesAPerPullNodeCredential(t *testing.T) {
	docker := newFakeDocker()
	reg := api.NodeRegistryConfig{Host: "registry.example.com", Username: "node"}
	if err := pullImage(t.Context(), docker, testImage(), reg, testToken, time.Minute); err != nil {
		t.Fatal(err)
	}
	header := docker.pullAuth[testImage()]
	if len(header)%4 != 0 {
		t.Errorf("X-Registry-Auth %q is not padded", header)
	}
	raw, err := base64.URLEncoding.DecodeString(header)
	if err != nil {
		t.Fatalf("X-Registry-Auth is not padded base64url: %v", err)
	}
	var cfg map[string]string
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg["username"] != "node" || cfg["password"] != testToken || cfg["serveraddress"] != "registry.example.com" {
		t.Errorf("auth config = %v", cfg)
	}
	if !slices.Equal(docker.calls, []string{"pull " + testImage()}) {
		t.Errorf("engine calls = %v, want only the pull", docker.calls)
	}
}

func TestPullErrorsAndTimeout(t *testing.T) {
	docker := newFakeDocker()
	docker.pullErr = func(string) error { return errors.New("insufficient_scope: authorization failed") }
	reg := api.NodeRegistryConfig{Host: "registry.example.com", Username: "node"}
	err := pullImage(t.Context(), docker, testImage(), reg, testToken, time.Minute)
	if err == nil || !strings.Contains(err.Error(), "insufficient_scope") {
		t.Errorf("err = %v", err)
	}
	docker.pullErr = nil
	docker.pullDelay = time.Second
	err = pullImage(t.Context(), docker, "registry.example.com/tasks/other@"+testDigest, reg, testToken, 50*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Errorf("err = %v, want a timeout", err)
	}
}

func TestBaseImagePullIsAnonymousAndOptional(t *testing.T) {
	docker := newFakeDocker()
	docker.pullErr = func(string) error { return errors.New("denied") }
	base := "ghcr.io/lonetis/scantor-base-go@sha256:" + strings.Repeat("1", 64)
	pullBaseImage(t.Context(), docker, base, time.Minute, discardLogger())
	if auth, ok := docker.pullAuth[base]; !ok || auth != "" {
		t.Errorf("base image pull: called=%v auth=%q", ok, auth)
	}
	// A present base image is not pulled again.
	docker.pullErr = nil
	docker.addImage(base)
	docker.calls = nil
	pullBaseImage(t.Context(), docker, base, time.Minute, discardLogger())
	if len(docker.calls) != 0 {
		t.Errorf("calls = %v", docker.calls)
	}
}

// The pull slot is held by one actor at a time and handed to the waiter with the lowest assignment
// order.
func TestPullQueueOrder(t *testing.T) {
	var q pullQueue
	release, err := q.acquire(t.Context(), 5)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var got []int64
	var wg sync.WaitGroup
	for _, order := range []int64{9, 3, 7, 1} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rel, err := q.acquire(t.Context(), order)
			if err != nil {
				t.Error(err)
				return
			}
			mu.Lock()
			got = append(got, order)
			mu.Unlock()
			rel()
		}()
		eventually(t, time.Second, "waiter queued", func() bool {
			q.mu.Lock()
			defer q.mu.Unlock()
			return q.waiters.Len() > 0 && slices.ContainsFunc(q.waiters, func(w *pullWaiter) bool { return w.order == order })
		})
	}
	release()
	wg.Wait()
	if !slices.Equal(got, []int64{1, 3, 7, 9}) {
		t.Errorf("grant order = %v, want assignment order", got)
	}
	// A cancelled waiter leaves the queue and the slot stays usable.
	release, err = q.acquire(t.Context(), 1)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() {
		_, err := q.acquire(ctx, 2)
		done <- err
	}()
	eventually(t, time.Second, "waiter queued", func() bool {
		q.mu.Lock()
		defer q.mu.Unlock()
		return q.waiters.Len() == 1
	})
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled acquire = %v", err)
	}
	release()
	rel, err := q.acquire(t.Context(), 3)
	if err != nil {
		t.Fatal(err)
	}
	rel()
}

func TestGCCandidates(t *testing.T) {
	const host = "registry.example.com"
	cases := []struct {
		refs []string
		want bool
	}{
		{[]string{host + "/tasks/" + testTaskID + "@" + testDigest}, true},
		{[]string{host + "/tasks/" + testTaskID + ":rev"}, true},
		{[]string{"ghcr.io/lonetis/scantor-base-python:1.4.0"}, true},
		{[]string{"ghcr.io/lonetis/scantor-base-js@" + testDigest}, true},
		{[]string{"ghcr.io/lonetis/scantor-base-go:1.4.0", host + "/tasks/x:rev"}, true},
		{[]string{host + "/tasks/" + testTaskID + ":draft-1"}, false},
		{[]string{host + "/tasks/x:rev", host + "/tasks/x:draft-2"}, false},
		{[]string{"ghcr.io/lonetis/scantor:1.4.0"}, false},
		{[]string{"scantor-base-python:dev"}, false},
		{[]string{"postgres:17"}, false},
		{[]string{host + "/tasks/x:rev", "postgres:17"}, false},
		{[]string{"other.example.com/tasks/x:rev"}, false},
		{nil, false},
		{[]string{"<none>:<none>"}, false},
	}
	for _, tc := range cases {
		img := image.Summary{ID: "sha256:1"}
		for _, r := range tc.refs {
			if strings.Contains(r, "@") {
				img.RepoDigests = append(img.RepoDigests, r)
			} else {
				img.RepoTags = append(img.RepoTags, r)
			}
		}
		if got := gcCandidate(img, host); got != tc.want {
			t.Errorf("gcCandidate(%v) = %v, want %v", tc.refs, got, tc.want)
		}
	}
}

func TestGCPlan(t *testing.T) {
	const host = "registry.example.com"
	start := time.Date(2026, 10, 21, 10, 0, 0, 0, time.UTC)
	task := image.Summary{ID: "sha256:task", RepoDigests: []string{host + "/tasks/" + testTaskID + "@" + testDigest}}
	used := image.Summary{ID: "sha256:used", RepoTags: []string{host + "/tasks/u:rev"}}
	desired := image.Summary{ID: "sha256:desired", RepoDigests: []string{host + "/tasks/d@" + testDigest}}
	base := image.Summary{ID: "sha256:base", RepoTags: []string{"ghcr.io/lonetis/scantor-base-go:1.4.0"}}
	foreign := image.Summary{ID: "sha256:foreign", RepoTags: []string{"postgres:17"}}
	images := []image.Summary{task, used, desired, base, foreign}
	in := func(now time.Time, retention time.Duration) gcInput {
		return gcInput{
			images:       images,
			containerIDs: map[string]bool{"sha256:used": true},
			desiredRefs:  map[string]bool{host + "/tasks/d@" + testDigest: true},
			registryHost: host, retention: retention, now: now,
		}
	}
	ids := func(imgs []image.Summary) []string {
		var out []string
		for _, i := range imgs {
			out = append(out, i.ID)
		}
		slices.Sort(out)
		return out
	}
	gc := newImageGC(start)
	first := in(start.Add(time.Minute), time.Hour)
	first.observeOnly = true
	if got := gc.plan(first); len(got) != 0 {
		t.Errorf("an observing pass removed %v", ids(got))
	}
	// Images found at start count as used at the daemon start.
	if got := ids(gc.plan(in(start.Add(59*time.Minute), time.Hour))); len(got) != 0 {
		t.Errorf("removed before the retention: %v", got)
	}
	if got := ids(gc.plan(in(start.Add(61*time.Minute), time.Hour))); !slices.Equal(got, []string{"sha256:base", "sha256:task"}) {
		t.Errorf("removed = %v, want the unreferenced task and base images", got)
	}
	// An image seen later counts from then; the emergency GC (retention 0) takes it at once.
	late := image.Summary{ID: "sha256:late", RepoTags: []string{host + "/tasks/l:rev"}}
	images = append(images, late)
	if got := ids(gc.plan(in(start.Add(90*time.Minute), time.Hour))); slices.Contains(got, "sha256:late") {
		t.Errorf("a new image was removed before its retention: %v", got)
	}
	if got := ids(gc.plan(in(start.Add(91*time.Minute), 0))); !slices.Contains(got, "sha256:late") || slices.Contains(got, "sha256:used") || slices.Contains(got, "sha256:desired") || slices.Contains(got, "sha256:foreign") {
		t.Errorf("emergency GC removed %v", got)
	}
	if !gc.emergencyDue(start, 5*time.Minute) || gc.emergencyDue(start.Add(4*time.Minute), 5*time.Minute) || !gc.emergencyDue(start.Add(5*time.Minute), 5*time.Minute) {
		t.Error("the emergency GC must run at most once per 5 minutes")
	}
}

func TestRemoveImageNeverForces(t *testing.T) {
	docker := newFakeDocker()
	img := docker.addImage("registry.example.com/tasks/x:a", "registry.example.com/tasks/x:b")
	sum := image.Summary{ID: img.id, RepoTags: slices.Clone(img.repoTags)}
	if err := removeImage(t.Context(), docker, sum); err != nil {
		t.Fatal(err)
	}
	if docker.findImage(img.id) != nil {
		t.Error("image not removed")
	}
	for _, c := range docker.calls {
		if strings.HasSuffix(c, "force=true") {
			t.Errorf("forced removal: %v", docker.calls)
		}
	}
}

// The daemon's GC loop removes unreferenced task images after the retention and keeps everything else.
func TestImageGCLoop(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.ImageRetention = 0 })
	h.d.t.gcEvery = 100 * time.Millisecond
	stale := h.docker.addImage("registry.example.com/tasks/" + testWorker2 + "@" + testDigest)
	foreign := h.docker.addImage("postgres:17")
	h.start()
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	eventually(t, 5*time.Second, "stale image removed", func() bool {
		h.docker.mu.Lock()
		defer h.docker.mu.Unlock()
		return h.docker.findImage(stale.id) == nil
	})
	h.docker.mu.Lock()
	defer h.docker.mu.Unlock()
	if h.docker.findImage(foreign.id) == nil || h.docker.findImage(testImage()) == nil {
		t.Error("the GC removed an image that is not a candidate or still in use")
	}
}

// Free disk below config.minFreeDiskBytes runs an emergency GC with retention 0.
func TestEmergencyGC(t *testing.T) {
	h := newHarness(t, nil)
	h.orch.config.MinFreeDiskBytes = 10 << 30
	h.d.diskFree = func() (int64, error) { return 1 << 30, nil }
	stale := h.docker.addImage("registry.example.com/tasks/" + testWorker2 + ":rev")
	h.start()
	h.orch.setDesired()
	eventually(t, 5*time.Second, "emergency GC", func() bool {
		h.docker.mu.Lock()
		defer h.docker.mu.Unlock()
		return h.docker.findImage(stale.id) == nil
	})
	if !h.logContains("emergency image GC") {
		t.Error("the emergency GC was not logged")
	}
}

// Workers pull one at a time, in assignment order, and a worker removed while it waits for the slot
// never pulls.
func TestPullsAreSerializedAndCancelledWhenNotNeeded(t *testing.T) {
	h := newHarness(t, nil)
	h.docker.mu.Lock()
	for id := range h.docker.images {
		delete(h.docker.images, id)
	}
	h.docker.pullDelay = time.Second
	h.docker.mu.Unlock()
	h.start()
	var all []api.Assignment
	for i, id := range []string{testWorker1, testWorker2, "1c2d3e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f"} {
		a := testAssignment(id)
		a.Image = "registry.example.com/tasks/" + testTaskID + "@sha256:" + strings.Repeat(string(rune('a'+i)), 64)
		all = append(all, a)
	}
	h.orch.setDesired(all[0])
	eventually(t, 5*time.Second, "first pull in flight", func() bool {
		h.docker.mu.Lock()
		defer h.docker.mu.Unlock()
		return h.docker.pullsInFlight == 1
	})
	h.orch.setDesired(all...)
	h.waitWorkerState(all[2].WorkerID, api.NodeWorkerPulling)
	h.orch.setDesired(all[0], all[1])
	h.waitWorkerState(all[2].WorkerID, api.NodeWorkerRemoved)
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	h.waitWorkerState(testWorker2, api.NodeWorkerRunning)
	h.docker.mu.Lock()
	defer h.docker.mu.Unlock()
	if h.docker.maxPullsInFlight != 1 {
		t.Errorf("max concurrent pulls = %d, want 1", h.docker.maxPullsInFlight)
	}
	if _, pulled := h.docker.pullAuth[all[2].Image]; pulled {
		t.Error("a worker that left the desired set while waiting for the pull slot was pulled")
	}
}

func discardLogger() *slog.Logger { return slog.New(slog.DiscardHandler) }
