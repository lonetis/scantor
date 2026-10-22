package node

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/moby/moby/api/types/image"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/version"
)

// Assignments long-poll (docs/nodes.md §5.3).

// assignmentsLoop keeps the desired set current. The first call uses wait=0 so the daemon gets the
// complete set at once; later calls wait up to assignmentsWaitSeconds. A status response with a newer
// rev cancels the pending poll. On errors the last desired set stays in force.
func (s *session) assignmentsLoop(ctx context.Context) {
	b := backoff{min: s.d.t.apiBackoffMin, max: s.d.t.apiBackoffMax}
	var rev int64
	first := true
	for ctx.Err() == nil {
		wait := s.config.AssignmentsWaitSeconds
		if first {
			wait = 0
		}
		resp, meta, interrupted, err := s.pollAssignments(ctx, rev, wait)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if interrupted {
				continue
			}
			if s.handleAPIError(err) {
				return
			}
			delay := b.next()
			s.log.Warn("assignments request failed; keeping the last desired set", "retryIn", delay.Round(time.Millisecond), "err", err)
			if !sleep(ctx, delay) {
				return
			}
			continue
		}
		b.reset()
		s.d.observeClock(resp.ServerTime, meta)
		s.applyDesired(resp.Workers, resp.Rev)
		s.handleLogRequests(resp.LogRequests)
		if first {
			s.statusChanged()
		}
		rev, first = resp.Rev, false
	}
}

// pollAssignments performs one long-poll that a newer status rev may interrupt; interrupted reports
// that the poll was cancelled for that reason.
func (s *session) pollAssignments(ctx context.Context, rev int64, wait int) (*api.NodeAssignments, *api.Response, bool, error) {
	pctx, cancel := context.WithCancel(ctx)
	defer cancel()
	interrupted := make(chan struct{})
	done := make(chan struct{})
	go func() {
		select {
		case <-s.pollNowCh:
			close(interrupted)
			cancel()
		case <-done:
		}
	}()
	resp, meta, err := s.d.api.GetNodeAssignments(pctx, rev, wait)
	close(done)
	if err != nil {
		select {
		case <-interrupted:
			return nil, nil, true, err
		default:
		}
	}
	return resp, meta, false, err
}

// pollNow interrupts the pending long-poll (non-blocking).
func (s *session) pollNow() {
	select {
	case s.pollNowCh <- struct{}{}:
	default:
	}
}

// On-demand worker logs (docs/nodes.md §7.3).

// handleLogRequests answers every new request id once; answered ids are remembered for
// logRequestMemory. A failed upload is retried when the request appears again.
func (s *session) handleLogRequests(reqs []api.LogRequest) {
	now := s.d.now()
	s.logsMu.Lock()
	for id, at := range s.answered {
		if now.Sub(at) > s.d.t.logRequestMemory {
			delete(s.answered, id)
		}
	}
	var todo []api.LogRequest
	for _, r := range reqs {
		if _, done := s.answered[r.RequestID]; done || s.inflight[r.RequestID] {
			continue
		}
		s.inflight[r.RequestID] = true
		todo = append(todo, r)
	}
	s.logsMu.Unlock()
	for _, r := range todo {
		s.goLoop(func() { s.answerLogRequest(r) })
	}
}

func (s *session) answerLogRequest(r api.LogRequest) {
	answered := false
	defer func() {
		s.logsMu.Lock()
		delete(s.inflight, r.RequestID)
		if answered {
			s.answered[r.RequestID] = s.d.now()
		}
		s.logsMu.Unlock()
	}()
	tailBytes := min(max(r.TailBytes, 0), maxRequestBytes)
	tail := logTail{}
	if id := s.ownContainerID(r.WorkerID); id != "" {
		var err error
		tail, err = containerLogTail(s.stopCtx, s.d.docker, id, requestLines(tailBytes), tailBytes)
		if err != nil {
			s.log.Warn("cannot read worker logs", "workerId", r.WorkerID, "err", err)
			tail = logTail{}
		}
	}
	body := api.WorkerLogsUpload{
		RequestID:   r.RequestID,
		Text:        tail.text,
		Bytes:       len(tail.text),
		Truncated:   tail.truncated,
		CollectedAt: api.NewTime(s.d.now()),
	}
	err := s.d.api.PostWorkerLogs(s.stopCtx, r.WorkerID, body)
	switch {
	case err == nil:
		answered = true
	case api.IsStatus(err, http.StatusNotFound):
		// The request is no longer open (or the worker left this node): nothing to answer.
		answered = true
	case s.stopCtx.Err() != nil:
	case s.handleAPIError(err):
	default:
		s.log.Warn("cannot upload worker logs; retrying with the next assignments response", "workerId", r.WorkerID, "err", err)
	}
}

// ownContainerID returns the id of the worker's container when it exists and belongs to this node.
func (s *session) ownContainerID(workerID string) string {
	res, err := s.d.docker.ContainerInspect(s.stopCtx, workerName(workerID), client.ContainerInspectOptions{})
	if err != nil {
		return ""
	}
	labels := map[string]string{}
	if res.Container.Config != nil {
		labels = res.Container.Config.Labels
	}
	w, reason := classifyWorker(res.Container.ID, trimSlash(res.Container.Name), labels)
	if reason != "" || w.nodeID != s.node.ID {
		return ""
	}
	return res.Container.ID
}

// Status reports (docs/nodes.md §7).

// statusChanged requests a status report soon (debounced by statusDebounce).
func (s *session) statusChanged() {
	select {
	case s.statusCh <- struct{}{}:
	default:
	}
}

// statusLoop sends a status every statusIntervalMs (±10 % jitter) and statusDebounce after local
// changes. Failures back off from 1 s to 30 s.
func (s *session) statusLoop(ctx context.Context) {
	interval := time.Duration(s.config.StatusIntervalMs) * time.Millisecond
	if interval <= 0 {
		interval = defaultStatusInterval
	}
	b := backoff{min: s.d.t.apiBackoffMin, max: s.d.t.apiBackoffMax}
	timer := time.NewTimer(s.d.t.statusDebounce)
	defer timer.Stop()
	due := s.d.now().Add(s.d.t.statusDebounce)
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.statusCh:
			if soon := s.d.now().Add(s.d.t.statusDebounce); soon.Before(due) {
				due = soon
				resetTimer(timer, s.d.t.statusDebounce)
			}
			continue
		case <-timer.C:
		}
		next := jitter(interval, 0.1)
		if err := s.sendStatus(ctx); err != nil {
			if ctx.Err() != nil || s.handleAPIError(err) {
				return
			}
			next = b.next()
			s.log.Warn("status report failed", "retryIn", next.Round(time.Millisecond), "err", err)
		} else {
			b.reset()
			if ms := s.nextStatus.Load(); ms > 0 {
				next = jitter(time.Duration(ms)*time.Millisecond, 0.1)
			}
		}
		due = s.d.now().Add(next)
		resetTimer(timer, next)
	}
}

func resetTimer(t *time.Timer, d time.Duration) {
	t.Stop()
	select {
	case <-t.C:
	default:
	}
	t.Reset(d)
}

// sendStatus posts one complete snapshot and processes the response.
func (s *session) sendStatus(ctx context.Context) error {
	actors := s.actorList()
	workers := make([]api.NodeWorkerStatus, 0, len(actors))
	var removed []*actor
	for _, a := range actors {
		if a.finished(s.d.t.removedReports) {
			continue // reported as removed often enough; the next reconcile pass drops the actor
		}
		st, isRemoved := a.report()
		workers = append(workers, st)
		if isRemoved {
			removed = append(removed, a)
		}
	}
	slices.SortFunc(workers, func(x, y api.NodeWorkerStatus) int {
		switch {
		case x.WorkerID < y.WorkerID:
			return -1
		case x.WorkerID > y.WorkerID:
			return 1
		}
		return 0
	})
	disk := s.d.diskFreeBytes()
	body := api.NodeStatusRequest{
		InstanceID:    s.d.instanceID,
		AppliedRev:    s.appliedRevision(),
		ClockOffsetMs: s.d.clock.ms(),
		Info: api.NodeStatusInfo{
			Version:           version.Version,
			CPUs:              s.d.host.cpus,
			MemoryBytes:       s.d.host.memoryBytes,
			DiskFreeBytes:     disk,
			DinDMode:          s.d.dind,
			MaxWorkers:        s.d.maxWorkers(),
			EgressDenyApplied: s.d.egressOK.Load(),
		},
		Workers: workers,
	}
	resp, meta, err := s.d.api.PostNodeStatus(ctx, body)
	if err != nil {
		return err
	}
	for _, a := range removed {
		a.reportedRemoved()
	}
	s.d.observeClock(resp.ServerTime, meta)
	if resp.Rev > body.AppliedRev {
		s.pollNow()
	}
	s.nextStatus.Store(resp.NextStatusMs)
	interval := s.config.StatusIntervalMs
	if resp.NextStatusMs > 0 {
		interval = resp.NextStatusMs
	}
	if err := writeStatusFile(s.d.statusFile, statusRecord{At: s.d.now().UnixMilli(), NodeID: s.node.ID, StatusIntervalMs: interval}); err != nil {
		s.log.Warn("cannot write the status file", "err", err)
	}
	lowDisk := s.config.MinFreeDiskBytes > 0 && disk > 0 && disk < s.config.MinFreeDiskBytes
	if lowDisk && s.stopCtx.Err() == nil && s.d.gc.emergencyDue(s.d.now(), s.d.t.emergencyGCEvery) {
		s.log.Warn("free disk below the minimum; running an emergency image GC", "diskFreeBytes", disk, "minFreeDiskBytes", s.config.MinFreeDiskBytes)
		s.goLoop(func() { s.runGC(0) })
	}
	return nil
}

// Image GC (docs/nodes.md §8).

// gcLoop runs the image GC every gcEvery. The first pass only records which images exist; nothing is
// removed before the first desired set is known.
func (s *session) gcLoop() {
	s.runGC(-1)
	for sleep(s.stopCtx, s.d.t.gcEvery) {
		s.runGC(s.d.cfg.ImageRetention)
	}
}

// runGC performs one GC pass with the given retention; a negative retention only observes.
func (s *session) runGC(retention time.Duration) {
	ctx := s.stopCtx
	desired, have := s.desiredSnapshot()
	imgs, err := s.d.docker.ImageList(ctx, client.ImageListOptions{})
	if err != nil {
		if ctx.Err() == nil {
			s.log.Warn("image GC: cannot list images", "err", err)
		}
		return
	}
	ctrs, err := s.d.docker.ContainerList(ctx, client.ContainerListOptions{All: true})
	if err != nil {
		if ctx.Err() == nil {
			s.log.Warn("image GC: cannot list containers", "err", err)
		}
		return
	}
	in := gcInput{
		images:       imgs.Items,
		containerIDs: map[string]bool{},
		desiredRefs:  map[string]bool{},
		registryHost: s.config.Registry.Host,
		retention:    retention,
		now:          s.d.now(),
		observeOnly:  retention < 0 || !have,
	}
	for _, c := range ctrs.Items {
		in.containerIDs[c.ImageID] = true
	}
	for _, a := range desired {
		in.desiredRefs[a.Image] = true
		if a.BaseImage != nil {
			in.desiredRefs[*a.BaseImage] = true
		}
	}
	for _, img := range s.d.gc.plan(in) {
		if ctx.Err() != nil {
			return
		}
		if err := removeImage(ctx, s.d.docker, img); err != nil {
			s.log.Info("image GC: image not removed", "image", firstRef(img), "err", err)
			continue
		}
		s.log.Info("image GC: removed an unused image", "image", firstRef(img), "id", shortImageID(img.ID))
	}
}

func firstRef(img image.Summary) string {
	if refs := imageRefs(img); len(refs) > 0 {
		return refs[0]
	}
	return shortImageID(img.ID)
}

func shortImageID(id string) string {
	const prefix = "sha256:"
	if len(id) > len(prefix)+12 && id[:len(prefix)] == prefix {
		return id[len(prefix) : len(prefix)+12]
	}
	return id
}

// Egress deny helper (docs/nodes.md §9).

// egressLoop applies the deny list now and every egressEvery. An empty list disables the helper.
func (s *session) egressLoop() {
	if len(s.d.cfg.EgressDeny) == 0 {
		s.d.egressOK.Store(false)
		s.log.Info("SCANTOR_NODE_EGRESS_DENY is empty; the egress helper is disabled")
		return
	}
	for {
		s.applyEgress()
		if !sleep(s.stopCtx, s.d.t.egressEvery) {
			return
		}
	}
}

func (s *session) applyEgress() {
	if s.d.self == nil {
		s.d.egressOK.Store(false)
		s.log.Warn(errEgressSkipped.Error())
		return
	}
	network := s.d.helperNetwork
	if network == "" {
		network = "host"
	}
	h := egressHelper{
		docker: s.d.docker, nodeID: s.node.ID, imageID: s.d.self.imageID, deny: s.d.cfg.EgressDeny,
		timeout: s.d.t.helperTimeout, networkMode: network,
	}
	res, err := h.run(s.stopCtx)
	switch {
	case err != nil:
		if errors.Is(err, context.Canceled) && s.stopCtx.Err() != nil {
			return
		}
		s.d.egressOK.Store(false)
		s.log.Warn("the egress deny list was not applied; retrying at the next interval", "err", err)
	case !res.Applied:
		s.d.egressOK.Store(false)
		s.log.Warn("the egress deny list was not applied completely; retrying at the next interval", "families", res.Families, "errors", res.Errors)
	default:
		if !s.d.egressOK.Swap(true) {
			s.log.Info("egress deny list applied", "families", res.Families)
		}
	}
	s.statusChanged()
}
