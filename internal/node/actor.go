package node

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	dcontainer "github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
)

// The worker actor (docs/nodes.md §6): one goroutine per worker that drives its container towards the
// target level-triggered. Every step inspects the container and takes the next action:
//
//	target remove:         stop (grace) → remove (force, anonymous volumes)
//	no container:          ensure image (pull slot) → create → inject runtime → start
//	other specHash:        remove → create → inject → start
//	running:               apply limits (live resize)
//	exited/dead:           record the exit, back off, restart in place
//	created:               inject (idempotent) → start
//
// Before the first desired set (target track) the actor only observes.

// phase is the node-local actor state.
type phase string

const (
	phaseWaitingPull phase = "waitingPull"
	phasePulling     phase = "pulling"
	phaseCreating    phase = "creating"
	phaseStarting    phase = "starting"
	phaseRunning     phase = "running"
	phaseBackoff     phase = "backoff"
	phaseStopping    phase = "stopping"
	phaseRemoved     phase = "removed"
	phaseFailed      phase = "failed"
)

// reported maps an actor phase to the reported worker state (docs/api.md §7.3).
func (p phase) reported() string {
	switch p {
	case phaseWaitingPull, phasePulling:
		return api.NodeWorkerPulling
	case phaseCreating, phaseStarting:
		return api.NodeWorkerStarting
	case phaseRunning:
		return api.NodeWorkerRunning
	case phaseBackoff:
		return api.NodeWorkerBackoff
	case phaseStopping:
		return api.NodeWorkerStopping
	case phaseRemoved:
		return api.NodeWorkerRemoved
	default:
		return api.NodeWorkerError
	}
}

// targetMode is what the actor drives its container towards.
type targetMode int

const (
	// targetTrack: before the first desired set; observe only.
	targetTrack targetMode = iota
	// targetRun: the worker is desired with the given assignment.
	targetRun
	// targetRemove: the worker is not desired; stop and remove its container.
	targetRemove
)

type actor struct {
	s        *session
	workerID string
	log      *slog.Logger
	kickCh   chan struct{}
	stopCh   chan struct{}
	stopOnce sync.Once

	mu    sync.Mutex
	mode  targetMode
	want  *api.Assignment
	order int64

	phase       phase
	containerID string
	startedAt   time.Time
	restarts    int
	crashes     int
	applied     *api.AppliedLimits
	forceLimits bool
	lastExit    *api.NodeWorkerExit
	exitKey     string
	nextRestart time.Time
	pull        *api.NodeWorkerPull
	failure     *workerError
	failureKey  string
	retryAt     time.Time
	failures    int
	removedSeen int
	// pullCancel cancels the pull (or the wait for the pull slot) in progress when the target no longer
	// needs it; pullFor is the image and spec hash it is for.
	pullCancel context.CancelFunc
	pullFor    string
}

func newActor(s *session, workerID string, adopted bool) *actor {
	return &actor{
		s:        s,
		workerID: workerID,
		log:      s.log.With("workerId", workerID),
		kickCh:   make(chan struct{}, 1),
		stopCh:   make(chan struct{}),
		phase:    phaseCreating,
		// After adoption the limits are re-issued once, so `applied` is known again (§6.7).
		forceLimits: adopted,
	}
}

// run steps the actor until the session stops or the actor is retired.
func (a *actor) run() {
	ctx := a.s.stopCtx
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	defer timer.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		delay := a.step()
		var wake <-chan time.Time
		if delay > 0 && delay < forever {
			resetTimer(timer, delay)
			wake = timer.C
		}
		select {
		case <-ctx.Done():
			return
		case <-a.stopCh:
			return
		case <-a.kickCh:
		case <-wake:
		}
	}
}

// forever is the step delay of a failure that is not retried until the assignment changes.
const forever = time.Duration(1<<63 - 1)

func (a *actor) kick() {
	select {
	case a.kickCh <- struct{}{}:
	default:
	}
}

func (a *actor) stop() { a.stopOnce.Do(func() { close(a.stopCh) }) }

// setTarget updates the target. A pull in progress (or a wait for the pull slot) for an image the new
// target does not need is cancelled, so a removed or changed worker never waits behind other pulls.
func (a *actor) setTarget(mode targetMode, want *api.Assignment, order int64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.mode, a.want, a.order = mode, want, order
	if a.pullCancel != nil && (mode != targetRun || pullKey(*want) != a.pullFor) {
		a.pullCancel()
	}
}

func (a *actor) target() (targetMode, *api.Assignment, int64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.mode, a.want, a.order
}

// step performs one reconcile step and returns the delay of the next timed step (0: wait for a kick or
// the periodic reconcile).
func (a *actor) step() time.Duration {
	mode, want, order := a.target()
	switch mode {
	case targetRemove:
		return a.stepRemove()
	case targetTrack:
		return a.stepTrack()
	default:
		return a.stepRun(*want, order)
	}
}

// lookup inspects the worker's container by name. foreign is true when a container of that name exists
// but is not a worker of this node; such a container is never touched.
func (a *actor) lookup() (*dcontainer.InspectResponse, bool, error) {
	res, err := a.s.d.docker.ContainerInspect(a.s.opCtx, workerName(a.workerID), client.ContainerInspectOptions{})
	if err != nil {
		if container.IsNotFound(err) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("inspect container: %w", err)
	}
	c := res.Container
	labels := map[string]string{}
	if c.Config != nil {
		labels = c.Config.Labels
	}
	w, reason := classifyWorker(c.ID, trimSlash(c.Name), labels)
	if reason != "" || w.workerID != a.workerID || w.nodeID != a.s.node.ID || c.State == nil {
		return &c, true, nil
	}
	return &c, false, nil
}

// stepTrack observes the container without changing it (before the first desired set).
func (a *actor) stepTrack() time.Duration {
	c, foreign, err := a.lookup()
	if err != nil {
		a.log.Warn("cannot inspect the worker container", "err", err)
		return a.s.d.t.recheck
	}
	if c == nil || foreign {
		a.setPhase(phaseRemoved)
		return 0
	}
	a.observe(c)
	switch c.State.Status {
	case dcontainer.StateExited, dcontainer.StateDead:
		a.recordExit(c)
	}
	return 0
}

// stepRemove stops and removes the container (docs/nodes.md §6.6).
func (a *actor) stepRemove() time.Duration {
	c, foreign, err := a.lookup()
	if err != nil {
		a.log.Warn("cannot inspect the worker container", "err", err)
		return a.s.d.t.recheck
	}
	if c == nil || foreign {
		a.setRemoved()
		return 0
	}
	if err := a.remove(c.ID); err != nil {
		if a.s.stopCtx.Err() == nil {
			a.log.Warn("cannot remove the worker container; retrying", "err", err)
		}
		return a.s.d.t.recheck
	}
	a.log.Info("worker container removed")
	return 0
}

// stepRun drives a desired worker.
func (a *actor) stepRun(want api.Assignment, order int64) time.Duration {
	if err := validateAssignment(want, a.s.limits); err != nil {
		a.fail(newWorkerError(api.NodeWorkerCreateFailed, false, "invalid assignment: %v", err), want)
		return 0
	}
	c, foreign, err := a.lookup()
	if err != nil {
		a.log.Warn("cannot inspect the worker container", "err", err)
		return a.s.d.t.recheck
	}
	if foreign {
		return a.failOrWait(newWorkerError(api.NodeWorkerCreateFailed, true, "name conflict with a foreign container %s", workerName(a.workerID)), want)
	}
	if c == nil {
		if wait := a.pendingFailure(want); wait > 0 {
			return wait
		}
		return a.create(want, order)
	}
	if c.Config.Labels[container.LabelSpecHash] != want.SpecHash {
		a.log.Info("the worker spec changed; recreating the container")
		if err := a.remove(c.ID); err != nil {
			a.log.Warn("cannot remove the outdated worker container; retrying", "err", err)
			return a.s.d.t.recheck
		}
		return time.Millisecond
	}
	a.observe(c)
	switch c.State.Status {
	case dcontainer.StateRunning, dcontainer.StatePaused:
		a.clearFailure()
		a.resetCrashes(c)
		a.ensureLimits(c, want)
		return 0
	case dcontainer.StateCreated:
		if wait := a.pendingFailure(want); wait > 0 {
			return wait
		}
		return a.startExisting(c.ID, want, false)
	case dcontainer.StateExited, dcontainer.StateDead:
		return a.handleExit(c, want)
	default: // restarting, removing: transient
		return a.s.d.t.recheck
	}
}

// create pulls the image when needed, creates the container (adopting a container of ours that a
// concurrent create left behind), injects the runtime and starts it (docs/nodes.md §6.2).
func (a *actor) create(want api.Assignment, order int64) time.Duration {
	if !a.s.mayCreate() {
		return 0
	}
	if ok, problem := a.s.networkUsable(); !ok {
		return a.failOrWait(newWorkerError(api.NodeWorkerCreateFailed, true, "the worker network %s is not usable: %s", a.s.ws.network, problem), want)
	}
	if err := a.ensureImage(want, order); err != nil {
		var werr *workerError
		switch {
		case a.s.stopCtx.Err() != nil:
			return 0
		case errors.As(err, &werr):
			return a.failOrWait(werr, want)
		default: // errPullNotNeeded: the target changed while waiting for or during the pull
			return time.Millisecond
		}
	}
	if !a.s.mayCreate() {
		return 0
	}
	mode, cur, _ := a.target()
	if mode != targetRun || pullKey(*cur) != pullKey(want) {
		return time.Millisecond // the target changed during the pull
	}
	want = *cur // the latest limits and environment of the same spec
	if err := validateAssignment(want, a.s.limits); err != nil {
		return time.Millisecond // the next step reports it
	}
	a.setPhase(phaseCreating)
	opts, err := workerCreateOptions(want, a.s.ws)
	if err != nil {
		return a.failOrWait(newWorkerError(api.NodeWorkerCreateFailed, false, "worker spec: %v", err), want)
	}
	res, err := a.s.d.docker.ContainerCreate(a.s.opCtx, opts)
	id := res.ID
	switch {
	case err == nil:
		for _, w := range res.Warnings {
			a.log.Info("container create warning", "warning", w)
		}
	case container.IsConflict(err):
		// The name is in use: adopt it when it is ours, never remove a foreign container.
		c, foreign, lerr := a.lookup()
		switch {
		case lerr != nil:
			return a.failOrWait(newWorkerError(api.NodeWorkerCreateFailed, true, "create: %v", lerr), want)
		case c == nil:
			return a.s.d.t.recheck
		case foreign:
			return a.failOrWait(newWorkerError(api.NodeWorkerCreateFailed, true, "name conflict with a foreign container %s", workerName(a.workerID)), want)
		}
		return time.Millisecond // ours: the next step continues with it
	default:
		if a.s.opCtx.Err() != nil {
			return 0
		}
		return a.failOrWait(newWorkerError(api.NodeWorkerCreateFailed, true, "create: %v", err), want)
	}
	a.mu.Lock()
	a.containerID = id
	a.restarts, a.crashes = 0, 0
	a.lastExit, a.exitKey, a.nextRestart = nil, "", time.Time{}
	limits := limitsOf(want)
	a.applied = &limits
	a.forceLimits = false
	a.mu.Unlock()
	a.log.Info("worker container created", "container", shortID(id), "image", want.Image)
	return a.startExisting(id, want, true)
}

// startExisting injects the runtime when it is missing and starts the container. 304 (already started)
// counts as success.
func (a *actor) startExisting(id string, want api.Assignment, fresh bool) time.Duration {
	if a.s.stopCtx.Err() != nil {
		return 0
	}
	a.setPhase(phaseStarting)
	if err := a.inject(id, fresh); err != nil {
		if a.s.opCtx.Err() != nil {
			return 0
		}
		return a.failOrWait(newWorkerError(api.NodeWorkerCreateFailed, true, "inject runtime: %v", err), want)
	}
	if _, err := a.s.d.docker.ContainerStart(a.s.opCtx, id, client.ContainerStartOptions{}); err != nil {
		if a.s.opCtx.Err() != nil {
			return 0
		}
		return a.failOrWait(newWorkerError(api.NodeWorkerCreateFailed, true, "start: %v", err), want)
	}
	a.s.statusChanged()
	return time.Millisecond // observe the running container
}

// inject copies the runtime binary into the container unless /scantor/scantor already exists.
func (a *actor) inject(id string, fresh bool) error {
	if !fresh {
		ok, err := container.Injected(a.s.opCtx, a.s.d.docker, id)
		if err != nil {
			return err
		}
		if ok {
			return nil
		}
	}
	bin, err := a.s.d.runtimeBinary(a.s.opCtx)
	if err != nil {
		return err
	}
	return container.Inject(a.s.opCtx, a.s.d.docker, id, bin, nil)
}

// errPullNotNeeded marks a pull that was cancelled because the actor's target no longer needs it.
var errPullNotNeeded = errors.New("the pull is no longer needed")

// pullKey identifies what a pull is for: a new target with the same key still needs it.
func pullKey(want api.Assignment) string { return want.SpecHash + "|" + want.Image }

// beginPull returns the context of a pull for want; setTarget cancels it when the target changes.
func (a *actor) beginPull(want api.Assignment) (context.Context, func()) {
	ctx, cancel := context.WithCancel(a.s.stopCtx)
	a.mu.Lock()
	a.pullCancel, a.pullFor = cancel, pullKey(want)
	a.mu.Unlock()
	return ctx, func() {
		a.mu.Lock()
		a.pullCancel, a.pullFor = nil, ""
		a.mu.Unlock()
		cancel()
	}
}

// ensureImage makes the task image available: present images are used as they are; missing ones are
// pulled in the node-wide pull slot (base image first, anonymously, as an optimisation), bounded by
// SCANTOR_NODE_PULL_TIMEOUT. The image's platform must be the node's (docs/nodes.md §10.1). A returned
// error wraps errPullNotNeeded when the target changed meanwhile.
func (a *actor) ensureImage(want api.Assignment, order int64) error {
	docker := a.s.d.docker
	osName, arch, found, err := imagePlatform(a.s.opCtx, docker, want.Image)
	if err != nil {
		return newWorkerError(api.NodeWorkerImagePullFailed, true, "%v", err)
	}
	if !found {
		if err := a.pullTaskImage(want, order); err != nil {
			return err
		}
		if osName, arch, found, err = imagePlatform(a.s.opCtx, docker, want.Image); err != nil || !found {
			return newWorkerError(api.NodeWorkerImagePullFailed, true, "the image is missing after the pull: %v", err)
		}
	}
	if osName != a.s.d.host.os || arch != a.s.d.host.arch {
		return newWorkerError(api.NodeWorkerPlatformMismatch, false, "the image is %s/%s, the node is %s/%s", osName, arch, a.s.d.host.os, a.s.d.host.arch)
	}
	return nil
}

// pullTaskImage waits for the node-wide pull slot and pulls the task image with the node credential.
func (a *actor) pullTaskImage(want api.Assignment, order int64) error {
	ctx, done := a.beginPull(want)
	defer done()
	failed := func(err error) error {
		if ctx.Err() != nil && a.s.stopCtx.Err() == nil {
			return errPullNotNeeded // cancelled by setTarget, not a pull failure
		}
		return newWorkerError(api.NodeWorkerImagePullFailed, true, "%v", err)
	}
	a.setPulling(phaseWaitingPull, want.Image)
	release, err := a.s.pulls.acquire(ctx, order)
	if err != nil {
		return failed(err)
	}
	defer release()
	a.setPulling(phasePulling, want.Image)
	if want.BaseImage != nil {
		pullBaseImage(ctx, a.s.d.docker, *want.BaseImage, a.s.d.cfg.PullTimeout, a.log)
	}
	a.log.Info("pulling the task image", "image", want.Image)
	if err := pullImage(ctx, a.s.d.docker, want.Image, a.s.config.Registry, a.s.d.cfg.Token, a.s.d.cfg.PullTimeout); err != nil {
		return failed(err)
	}
	return nil
}

// ensureLimits applies the assignment's resources to a running container with one ContainerUpdate
// (docs/nodes.md §6.7). On failure (for example EBUSY when lowering memory below the current usage) the
// old applied limits stay and the update is retried at the next step.
func (a *actor) ensureLimits(c *dcontainer.InspectResponse, want api.Assignment) {
	m, n := want.Resources.MemoryBytes, want.Resources.NanoCPUs
	a.mu.Lock()
	force := a.forceLimits
	a.mu.Unlock()
	if !force && c.HostConfig != nil && c.HostConfig.Memory == m && c.HostConfig.NanoCPUs == n {
		a.setApplied(limitsOf(want))
		return
	}
	_, err := a.s.d.docker.ContainerUpdate(a.s.opCtx, c.ID, client.ContainerUpdateOptions{
		Resources: &dcontainer.Resources{Memory: m, MemorySwap: m, NanoCPUs: n},
	})
	if err != nil {
		if a.s.opCtx.Err() == nil {
			a.log.Warn("cannot update the worker's limits; retrying", "memoryBytes", m, "nanoCpus", n, "err", err)
		}
		return
	}
	a.mu.Lock()
	a.forceLimits = false
	a.mu.Unlock()
	a.log.Info("worker limits applied", "processes", want.Processes, "memoryBytes", m, "nanoCpus", n)
	a.setApplied(limitsOf(want))
}

// handleExit records an exit once, backs off and restarts the container in place
// (docs/nodes.md §6.5).
func (a *actor) handleExit(c *dcontainer.InspectResponse, want api.Assignment) time.Duration {
	a.recordExit(c)
	a.mu.Lock()
	next := a.nextRestart
	a.mu.Unlock()
	if wait := next.Sub(a.s.d.now()); wait > 0 {
		return wait
	}
	if !a.s.mayCreate() {
		return 0
	}
	if wait := a.pendingFailure(want); wait > 0 {
		return wait
	}
	if c.State.Status == dcontainer.StateDead {
		// A dead container cannot be started; it is replaced.
		if err := a.remove(c.ID); err != nil {
			a.log.Warn("cannot remove the dead worker container; retrying", "err", err)
			return a.s.d.t.recheck
		}
		return time.Millisecond
	}
	a.mu.Lock()
	a.restarts++
	a.nextRestart = time.Time{}
	a.mu.Unlock()
	a.log.Info("restarting the worker container", "restarts", a.restartCount())
	return a.startExisting(c.ID, want, false)
}

// recordExit stores the exit of the container's current run (once per run) and schedules the restart:
// exit 0 without OOM is transient (10 s, the crash counter is unchanged); any other exit counts as a
// crash with backoff min(5 s × 2^(crashes−1), 5 min) × U(0.9, 1.1).
func (a *actor) recordExit(c *dcontainer.InspectResponse) {
	key := c.ID + "|" + c.State.FinishedAt
	a.mu.Lock()
	seen := key == a.exitKey
	a.mu.Unlock()
	if seen {
		return
	}
	finished, err := time.Parse(time.RFC3339Nano, c.State.FinishedAt)
	if err != nil || finished.Year() < 2000 {
		finished = a.s.d.now()
	}
	tail, err := containerLogTail(a.s.opCtx, a.s.d.docker, c.ID, exitTailLines, exitTailBytes)
	if err != nil {
		a.log.Info("cannot read the log tail of an exited worker", "err", err)
	}
	exit := &api.NodeWorkerExit{ExitCode: c.State.ExitCode, OOMKilled: c.State.OOMKilled, At: api.NewTime(finished), LogTail: tail.text}
	now := a.s.d.now()
	t := a.s.d.t
	a.mu.Lock()
	a.exitKey = key
	a.lastExit = exit
	a.containerID = c.ID
	if exit.ExitCode == 0 && !exit.OOMKilled {
		a.nextRestart = now.Add(t.exitZeroDelay)
	} else {
		if started, err := time.Parse(time.RFC3339Nano, c.State.StartedAt); err == nil && finished.Sub(started) >= t.crashReset {
			a.crashes = 0
		}
		a.crashes++
		delay := time.Duration(float64(expBackoff(t.crashBase, t.crashMax, a.crashes)) * (0.9 + 0.2*rand.Float64())) //nolint:gosec // jitter
		a.nextRestart = now.Add(delay)
	}
	a.phase = phaseBackoff
	crashes, next := a.crashes, a.nextRestart
	a.mu.Unlock()
	a.log.Info("worker container exited", "exitCode", exit.ExitCode, "oomKilled", exit.OOMKilled, "crashes", crashes, "nextRestartAt", next)
	a.s.statusChanged()
}

// resetCrashes clears the crash counter once the container has run crashReset without exiting.
func (a *actor) resetCrashes(c *dcontainer.InspectResponse) {
	started, err := time.Parse(time.RFC3339Nano, c.State.StartedAt)
	if err != nil || a.s.d.now().Sub(started) < a.s.d.t.crashReset {
		return
	}
	a.mu.Lock()
	a.crashes = 0
	a.mu.Unlock()
}

// remove stops the container with the drain grace and removes it with its anonymous volumes
// (docs/nodes.md §6.6). At most maxConcurrentRemovals run at once per node.
func (a *actor) remove(id string) error {
	ctx := a.s.opCtx
	select {
	case a.s.removals <- struct{}{}:
		defer func() { <-a.s.removals }()
	case <-ctx.Done():
		return ctx.Err()
	}
	a.setPhase(phaseStopping)
	grace := stopTimeoutSeconds(a.s.config.DrainGraceMs)
	stopCtx, cancel := context.WithTimeout(ctx, time.Duration(grace)*time.Second+30*time.Second)
	defer cancel()
	if _, err := a.s.d.docker.ContainerStop(stopCtx, id, client.ContainerStopOptions{Timeout: &grace}); err != nil && !container.IsNotFound(err) {
		a.log.Warn("stopping the worker container failed; removing it with force", "err", err)
	}
	if _, err := a.s.d.docker.ContainerRemove(ctx, id, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true}); err != nil && !container.IsNotFound(err) {
		return fmt.Errorf("remove container: %w", err)
	}
	a.setRemoved()
	return nil
}

// observe copies the container facts into the actor and derives the phase from the Docker state.
func (a *actor) observe(c *dcontainer.InspectResponse) {
	a.mu.Lock()
	changed := false
	if a.containerID != c.ID {
		a.containerID, changed = c.ID, true
	}
	if started, err := time.Parse(time.RFC3339Nano, c.State.StartedAt); err == nil && started.Year() >= 2000 {
		a.startedAt = started
	}
	var p phase
	switch c.State.Status {
	case dcontainer.StateRunning, dcontainer.StatePaused:
		p = phaseRunning
	case dcontainer.StateCreated, dcontainer.StateRestarting:
		p = phaseStarting
	case dcontainer.StateRemoving:
		p = phaseStopping
	default:
		p = a.phase // exits are handled by recordExit
	}
	// A failed start keeps reporting the failure instead of "starting".
	keepFailure := a.phase == phaseFailed && p == phaseStarting
	if p != a.phase && !keepFailure {
		a.phase, changed = p, true
	}
	if p == phaseRunning {
		a.pull = nil
	}
	a.mu.Unlock()
	if changed {
		a.s.statusChanged()
	}
}

func (a *actor) setPhase(p phase) {
	a.mu.Lock()
	changed := a.phase != p
	a.phase = p
	if p != phaseWaitingPull && p != phasePulling {
		a.pull = nil
	}
	a.mu.Unlock()
	if changed {
		a.s.statusChanged()
	}
}

func (a *actor) setPulling(p phase, image string) {
	a.mu.Lock()
	if a.pull == nil || a.pull.Image != image {
		a.pull = &api.NodeWorkerPull{Image: image, StartedAt: api.NewTime(a.s.d.now())}
	}
	a.mu.Unlock()
	a.setPhase(p)
}

func (a *actor) setApplied(l api.AppliedLimits) {
	a.mu.Lock()
	changed := a.applied == nil || *a.applied != l
	a.applied = &l
	a.mu.Unlock()
	if changed {
		a.s.statusChanged()
	}
}

func (a *actor) setRemoved() {
	a.mu.Lock()
	wasRemoved := a.phase == phaseRemoved
	if !wasRemoved {
		a.removedSeen = 0
	}
	a.phase = phaseRemoved
	a.containerID = ""
	a.applied, a.pull, a.nextRestart = nil, nil, time.Time{}
	a.startedAt = time.Time{}
	a.mu.Unlock()
	if !wasRemoved {
		a.s.statusChanged()
	}
}

func (a *actor) restartCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.restarts
}

// Failures (docs/nodes.md §6, §10.1): imagePullFailed and createFailed are retried with backoff from
// failureBase to failureMax; platformMismatch and invalid assignments are not retried until the
// assignment changes.

// failureKey identifies the assignment a failure belongs to: any change of the assignment (a corrected
// field, a new image) retries at once.
func failureKey(want api.Assignment) string {
	data, err := json.Marshal(want) // map keys are sorted, so the encoding is deterministic
	if err != nil {
		return want.SpecHash + "|" + want.Image
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// fail records a failure and schedules the retry.
func (a *actor) fail(werr *workerError, want api.Assignment) {
	key := failureKey(want)
	now := a.s.d.now()
	a.mu.Lock()
	if a.failureKey != key {
		a.failures = 0
	}
	a.failures++
	first := a.failure == nil || a.failure.code != werr.code || a.failure.msg != werr.msg
	a.failure, a.failureKey = werr, key
	a.retryAt = time.Time{}
	if werr.retry {
		a.retryAt = now.Add(expBackoff(a.s.d.t.failureBase, a.s.d.t.failureMax, a.failures))
	}
	changed := a.phase != phaseFailed || first
	a.phase = phaseFailed
	a.pull = nil
	a.mu.Unlock()
	if first {
		a.log.Warn("worker failed", "code", werr.code, "err", werr.msg, "retry", werr.retry)
	}
	if changed {
		a.s.statusChanged()
	}
}

// failOrWait records a failure and returns the delay until its retry.
func (a *actor) failOrWait(werr *workerError, want api.Assignment) time.Duration {
	a.fail(werr, want)
	return a.pendingFailure(want)
}

// pendingFailure returns how long a failure of this assignment still blocks a retry (0 when none).
// Failures without retry block until the assignment changes.
func (a *actor) pendingFailure(want api.Assignment) time.Duration {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.failure == nil || a.failureKey != failureKey(want) {
		return 0
	}
	if !a.failure.retry {
		return forever
	}
	return max(a.retryAt.Sub(a.s.d.now()), 0)
}

// retryNow lets a retryable failure be retried at once (for example when the worker network appeared)
// and wakes the actor.
func (a *actor) retryNow() {
	a.mu.Lock()
	if a.failure != nil && a.failure.retry {
		a.retryAt = time.Time{}
	}
	a.mu.Unlock()
	a.kick()
}

func (a *actor) clearFailure() {
	a.mu.Lock()
	cleared := a.failure != nil
	a.failure, a.failureKey, a.failures, a.retryAt = nil, "", 0, time.Time{}
	a.mu.Unlock()
	if cleared {
		a.s.statusChanged()
	}
}

// Reporting (docs/nodes.md §7.1).

// report returns the worker's status entry and whether it is reported as removed.
func (a *actor) report() (api.NodeWorkerStatus, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	st := api.NodeWorkerStatus{WorkerID: a.workerID, State: a.phase.reported()}
	if a.phase == phaseRemoved {
		return st, true
	}
	if a.containerID != "" {
		st.ContainerID = shortID(a.containerID)
		restarts := a.restarts
		st.Restarts = &restarts
		if !a.startedAt.IsZero() {
			st.StartedAt = api.TimePtr(a.startedAt)
		}
	}
	if a.applied != nil {
		applied := *a.applied
		st.Applied = &applied
	}
	if a.lastExit != nil {
		exit := *a.lastExit
		st.LastExit = &exit
	}
	if a.phase == phaseBackoff && !a.nextRestart.IsZero() {
		st.NextRestartAt = api.TimePtr(a.nextRestart)
	}
	if a.pull != nil && (a.phase == phaseWaitingPull || a.phase == phasePulling) {
		pull := *a.pull
		st.Pull = &pull
	}
	if a.phase == phaseFailed && a.failure != nil {
		st.Error = &api.NodeWorkerFailure{Code: a.failure.code, Message: a.failure.msg}
	}
	return st, false
}

// reportedRemoved counts a delivered report that listed the worker as removed.
func (a *actor) reportedRemoved() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.phase == phaseRemoved {
		a.removedSeen++
	}
}

// finished reports whether a removed worker was reported often enough to be forgotten.
func (a *actor) finished(reports int) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.phase == phaseRemoved && a.removedSeen >= reports
}

func trimSlash(name string) string {
	if len(name) > 0 && name[0] == '/' {
		return name[1:]
	}
	return name
}
