package node

import (
	"container/heap"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/api/types/image"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
	"github.com/lonetis/scantor/internal/redact"
)

// Images (docs/nodes.md §8, §10): task images are pulled by digest with a per-pull node credential
// (X-Registry-Auth; never `docker login`, never the host's Docker configuration, docs/security.md MC-8),
// one pull at a time node-wide in assignment order, and unreferenced task and base images are removed
// after SCANTOR_NODE_IMAGE_RETENTION.

// pullQueue is the node-wide pull slot: one holder at a time, granted to the waiter with the lowest
// order (assignment order), ties broken by arrival.
type pullQueue struct {
	mu      sync.Mutex
	busy    bool
	waiters waiterHeap
	seq     int64
}

type pullWaiter struct {
	order, seq int64
	ready      chan struct{}
	index      int
}

type waiterHeap []*pullWaiter

func (h waiterHeap) Len() int { return len(h) }
func (h waiterHeap) Less(i, j int) bool {
	if h[i].order != h[j].order {
		return h[i].order < h[j].order
	}
	return h[i].seq < h[j].seq
}
func (h waiterHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i]; h[i].index = i; h[j].index = j }
func (h *waiterHeap) Push(x any)   { w := x.(*pullWaiter); w.index = len(*h); *h = append(*h, w) }
func (h *waiterHeap) Pop() any {
	old := *h
	w := old[len(old)-1]
	*h = old[:len(old)-1]
	w.index = -1
	return w
}

// acquire waits for the pull slot. The returned release must be called exactly once.
func (q *pullQueue) acquire(ctx context.Context, order int64) (func(), error) {
	q.mu.Lock()
	if !q.busy && q.waiters.Len() == 0 {
		q.busy = true
		q.mu.Unlock()
		return q.release, nil
	}
	q.seq++
	w := &pullWaiter{order: order, seq: q.seq, ready: make(chan struct{})}
	heap.Push(&q.waiters, w)
	q.mu.Unlock()
	select {
	case <-w.ready:
		return q.release, nil
	case <-ctx.Done():
		q.mu.Lock()
		defer q.mu.Unlock()
		if w.index >= 0 {
			heap.Remove(&q.waiters, w.index)
			return nil, ctx.Err()
		}
		// The slot was granted concurrently: hand it on.
		q.releaseLocked()
		return nil, ctx.Err()
	}
}

func (q *pullQueue) release() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.releaseLocked()
}

func (q *pullQueue) releaseLocked() {
	if q.waiters.Len() == 0 {
		q.busy = false
		return
	}
	w := heap.Pop(&q.waiters).(*pullWaiter)
	close(w.ready)
}

// workerError is a failure of a worker that is reported as state error (docs/api.md §7.3).
type workerError struct {
	code  string
	msg   string
	retry bool
}

func (e *workerError) Error() string { return e.code + ": " + e.msg }

func newWorkerError(code string, retry bool, format string, args ...any) *workerError {
	return &workerError{code: code, msg: truncateUTF8(redact.String(fmt.Sprintf(format, args...)), maxMessageBytes), retry: retry}
}

// imagePlatform is the os/arch of a local image, or found == false when it is absent.
func imagePlatform(ctx context.Context, docker client.APIClient, ref string) (osName, arch string, found bool, err error) {
	res, err := docker.ImageInspect(ctx, ref)
	if err != nil {
		if container.IsNotFound(err) {
			return "", "", false, nil
		}
		return "", "", false, fmt.Errorf("inspect image: %w", err)
	}
	return res.Os, res.Architecture, true, nil
}

// pullImage pulls ref with the node credential for registryHost, bounded by timeout.
func pullImage(ctx context.Context, docker client.APIClient, ref string, reg api.NodeRegistryConfig, token string, timeout time.Duration) error {
	auth, err := container.RegistryAuth(reg.Username, token, reg.Host)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if err := container.Pull(ctx, docker, ref, container.PullOptions{RegistryAuth: auth}); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("pull %s: timed out after %s", ref, timeout)
		}
		return err
	}
	return nil
}

// pullBaseImage pulls a base image anonymously from its public registry. It is only an optimisation
// (the task pull then transfers only the user layers), so failures are logged and ignored.
func pullBaseImage(ctx context.Context, docker client.APIClient, ref string, timeout time.Duration, log *slog.Logger) {
	if _, _, found, err := imagePlatform(ctx, docker, ref); err != nil || found {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if err := container.Pull(ctx, docker, ref, container.PullOptions{}); err != nil {
		log.Info("base image pull failed; the task pull transfers all layers", "image", ref, "err", err)
	}
}

// Image GC (docs/nodes.md §8).

// baseImageRepos are the repository name suffixes of base images the GC may remove.
var baseImageRepos = []string{"/scantor-base-python", "/scantor-base-js", "/scantor-base-go"}

// gcCandidate reports whether an image may be removed by the GC: every name it carries is a task image
// of the node's registry (<registry host>/tasks/*) or a base image (repository ending in
// /scantor-base-python, -js or -go), and none is a draft image (tasks/<taskId>:draft-*, which the
// orchestrator's GC handles). Images with any other name are never touched.
func gcCandidate(img image.Summary, registryHost string) bool {
	refs := imageRefs(img)
	if len(refs) == 0 {
		return false
	}
	for _, ref := range refs {
		repo, tag := splitRef(ref)
		switch {
		case registryHost != "" && strings.HasPrefix(repo, registryHost+"/tasks/"):
			if strings.HasPrefix(tag, "draft-") {
				return false
			}
		case hasAnySuffix(repo, baseImageRepos):
		default:
			return false
		}
	}
	return true
}

// imageRefs returns the tags and digest references of an image, without Docker's <none> placeholders.
func imageRefs(img image.Summary) []string {
	var out []string
	for _, r := range append(append([]string{}, img.RepoTags...), img.RepoDigests...) {
		if r == "" || strings.HasPrefix(r, "<none>") {
			continue
		}
		out = append(out, r)
	}
	return out
}

// splitRef splits "repo:tag" or "repo@digest" into the repository and the tag (empty for digests).
func splitRef(ref string) (repo, tag string) {
	if i := strings.Index(ref, "@"); i >= 0 {
		return ref[:i], ""
	}
	if i := strings.LastIndex(ref, ":"); i > strings.LastIndex(ref, "/") {
		return ref[:i], ref[i+1:]
	}
	return ref, ""
}

func hasAnySuffix(s string, suffixes []string) bool {
	for _, suf := range suffixes {
		if strings.HasSuffix(s, suf) {
			return true
		}
	}
	return false
}

// imageGC remembers when each candidate image was last used. It lives as long as the daemon.
type imageGC struct {
	mu       sync.Mutex
	started  time.Time
	lastUsed map[string]time.Time
	lastRun  time.Time
	// lastEmergency bounds the emergency GC to once per emergencyGCEvery.
	lastEmergency time.Time
}

func newImageGC(started time.Time) *imageGC {
	return &imageGC{started: started, lastUsed: map[string]time.Time{}}
}

// gcInput is a snapshot the GC decides on.
type gcInput struct {
	images       []image.Summary
	containerIDs map[string]bool // image ids referenced by existing containers (any container)
	desiredRefs  map[string]bool // image references of the desired set (task and base images)
	registryHost string
	retention    time.Duration
	now          time.Time
	// observeOnly records usage without selecting anything (before the first desired set is known).
	observeOnly bool
}

// plan updates lastUsed and returns the ids of images to remove. Images seen for the first time count
// as used at the daemon start when the first pass sees them, else at that moment.
func (g *imageGC) plan(in gcInput) []image.Summary {
	g.mu.Lock()
	defer g.mu.Unlock()
	firstPass := g.lastRun.IsZero()
	g.lastRun = in.now
	present := map[string]bool{}
	var remove []image.Summary
	for _, img := range in.images {
		present[img.ID] = true
		used := in.containerIDs[img.ID]
		for _, ref := range imageRefs(img) {
			if in.desiredRefs[ref] {
				used = true
			}
		}
		if used {
			g.lastUsed[img.ID] = in.now
			continue
		}
		last, seen := g.lastUsed[img.ID]
		if !seen {
			last = in.now
			if firstPass {
				last = g.started
			}
			g.lastUsed[img.ID] = last
		}
		if in.observeOnly || !gcCandidate(img, in.registryHost) {
			continue
		}
		if in.now.Sub(last) >= in.retention {
			remove = append(remove, img)
		}
	}
	for id := range g.lastUsed {
		if !present[id] {
			delete(g.lastUsed, id)
		}
	}
	return remove
}

// emergencyDue reports whether an emergency GC may run now and records it.
func (g *imageGC) emergencyDue(now time.Time, every time.Duration) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.lastEmergency.IsZero() && now.Sub(g.lastEmergency) < every {
		return false
	}
	g.lastEmergency = now
	return true
}

// removeImage deletes an unreferenced image without force (DELETE /images/{id}?noprune=false). An image
// with several names cannot be deleted by id without force, so it is then untagged name by name; the
// last name removes it. A conflict with a container (the image came into use meanwhile) is returned.
func removeImage(ctx context.Context, docker client.APIClient, img image.Summary) error {
	_, err := docker.ImageRemove(ctx, img.ID, client.ImageRemoveOptions{PruneChildren: true})
	if err == nil || container.IsNotFound(err) {
		return nil
	}
	refs := imageRefs(img)
	if !container.IsConflict(err) || len(refs) < 2 {
		return err
	}
	for _, ref := range refs {
		if _, err := docker.ImageRemove(ctx, ref, client.ImageRemoveOptions{PruneChildren: true}); err != nil && !container.IsNotFound(err) {
			return err
		}
	}
	return nil
}
