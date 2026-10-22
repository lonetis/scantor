package node

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
)

// The reconcile pass (docs/nodes.md §6) and the recognition of worker containers (§6.1,
// docs/security.md LBL-5).
//
// A container is a worker of this daemon only when it carries the managed labels the daemon sets
// (scantor.managed=true, scantor.kind=worker plus the fixed labels), its name is exactly
// scantor-w-<scantor.worker>, and its scantor.node label is this node's id. Image labels alone can never
// make a foreign container pass, because the name is checked too, and the daemon never touches what it
// cannot attribute to itself.

// workerContainer is a managed worker container found on the engine.
type workerContainer struct {
	id       string
	name     string
	workerID string
	nodeID   string
	specHash string
	state    string
}

// ignoredContainer is a container that matched the listing filters but failed the identity checks.
type ignoredContainer struct {
	id     string
	name   string
	reason string
}

// listWorkerContainers lists the worker containers of every node on this engine (all states). The
// listing filters (labels plus the name prefix) are only a pre-selection; classifyWorker decides.
func listWorkerContainers(ctx context.Context, docker client.APIClient) ([]workerContainer, error) {
	found, _, err := listWorkerContainersDetailed(ctx, docker)
	return found, err
}

func listWorkerContainersDetailed(ctx context.Context, docker client.APIClient) ([]workerContainer, []ignoredContainer, error) {
	filters := client.Filters{}
	filters.Add("label", container.LabelManaged+"=true", container.LabelKind+"="+string(container.KindWorker))
	filters.Add("name", container.NamePrefix(container.KindWorker))
	res, err := docker.ContainerList(ctx, client.ContainerListOptions{All: true, Filters: filters})
	if err != nil {
		return nil, nil, fmt.Errorf("list worker containers: %w", err)
	}
	var found []workerContainer
	var ignored []ignoredContainer
	for _, c := range res.Items {
		name := ""
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}
		w, reason := classifyWorker(c.ID, name, c.Labels)
		if reason != "" {
			ignored = append(ignored, ignoredContainer{id: c.ID, name: name, reason: reason})
			continue
		}
		w.state = string(c.State)
		found = append(found, w)
	}
	return found, ignored, nil
}

// classifyWorker checks the identity of a worker container (of any node); reason is non-empty when it
// is not one.
func classifyWorker(id, name string, labels map[string]string) (workerContainer, string) {
	name = strings.TrimPrefix(name, "/")
	if !container.IsManaged(container.KindWorker, name, labels) {
		return workerContainer{}, "missing managed labels or name prefix"
	}
	workerID := labels[container.LabelWorker]
	if workerID == "" || name != workerName(workerID) {
		return workerContainer{}, "the name does not match its scantor.worker label"
	}
	return workerContainer{
		id: id, name: name, workerID: workerID,
		nodeID: labels[container.LabelNode], specHash: labels[container.LabelSpecHash],
	}, ""
}

// helloContainers converts found containers into the hello body (adoption candidates). Before hello the
// daemon does not know its node id, so it reports the workers of every node; the orchestrator ignores
// entries that are not assigned to the node.
func helloContainers(found []workerContainer) []api.NodeContainer {
	out := make([]api.NodeContainer, 0, len(found))
	for _, c := range found {
		out = append(out, api.NodeContainer{WorkerID: c.workerID, ContainerID: shortID(c.id), State: c.state, SpecHash: c.specHash})
	}
	return out
}

// shortID returns the 12-character form of a container id, as the API reports it.
func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

// requestReconcile asks the reconcile loop for a pass (non-blocking).
func (s *session) requestReconcile() {
	select {
	case s.reconcileCh <- struct{}{}:
	default:
	}
}

// reconcileLoop runs a pass on request (new desired set, Docker events) and at least every
// reconcileEvery.
func (s *session) reconcileLoop() {
	ticker := time.NewTicker(s.d.t.reconcileEvery)
	defer ticker.Stop()
	for {
		select {
		case <-s.stopCtx.Done():
			return
		case <-ticker.C:
		case <-s.reconcileCh:
		}
		s.reconcile()
	}
}

// reconcile is one level-triggered pass: it maps the containers of this node and the desired set onto
// actors, gives every actor its target and wakes it. Containers that cannot be attributed to this node
// are ignored and logged once. Before the first desired set, adopted containers are only tracked, never
// removed; afterwards every worker container of this node that is not desired is removed (SB-6).
func (s *session) reconcile() {
	if s.stopCtx.Err() != nil {
		return
	}
	found, ignored, err := listWorkerContainersDetailed(s.opCtx, s.d.docker)
	if err != nil {
		if s.stopCtx.Err() == nil {
			s.log.Warn("reconcile: cannot list worker containers", "err", err)
		}
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, ig := range ignored {
		s.warnIgnored(ig.id, ig.name, ig.reason)
	}
	present := map[string]bool{}
	for _, c := range found {
		if c.nodeID != s.node.ID {
			s.warnIgnored(c.id, c.name, "it belongs to node "+c.nodeID)
			continue
		}
		present[c.workerID] = true
		if s.actors[c.workerID] == nil {
			s.startActor(c.workerID, true)
		}
	}
	for id := range s.desired {
		if s.actors[id] == nil {
			s.startActor(id, false)
		}
	}
	for id, a := range s.actors {
		switch d, ok := s.desired[id]; {
		case !s.haveDesired:
			a.setTarget(targetTrack, nil, 0)
		case ok:
			a.setTarget(targetRun, &d, s.order[id])
		default:
			if a.finished(s.d.t.removedReports) && !present[id] {
				a.stop()
				delete(s.actors, id)
				continue
			}
			a.setTarget(targetRemove, nil, 0)
		}
		a.kick()
	}
}

// warnIgnored logs a container that looks like a worker but cannot be attributed to this daemon, once
// (s.mu held).
func (s *session) warnIgnored(id, name, reason string) {
	if s.ignored[id] {
		return
	}
	s.ignored[id] = true
	s.log.Warn("ignoring a container that is not a worker of this node", "container", shortID(id), "name", name, "reason", reason)
}

// startActor creates and starts the actor of a worker (s.mu held).
func (s *session) startActor(workerID string, adopted bool) {
	a := newActor(s, workerID, adopted)
	s.actors[workerID] = a
	s.actorsWG.Add(1)
	go func() {
		defer s.actorsWG.Done()
		a.run()
	}()
}
