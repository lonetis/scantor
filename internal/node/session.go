package node

import (
	"context"
	"fmt"
	"log/slog"
	"maps"
	"sync"
	"sync/atomic"
	"time"

	"github.com/moby/moby/api/types/events"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
)

// A session is the life of one registered instance: it starts with a successful hello and ends at
// shutdown, at a 409 nodeInstanceConflict (stop at once, touch no container, stand by while another
// instance holds the lease, then back to hello), at a 426, or when unauthorized mode ends with a new
// hello.
//
// Three contexts govern it:
//   - apiCtx: the assignments long-poll and the status loop; cancelled first on every exit.
//   - stopCtx: loops and actor decisions; when it ends, nothing new is started and pulls stop.
//   - opCtx: in-flight Docker calls; cancelled shutdownGrace after stopCtx at shutdown, at once
//     otherwise.

// sessionEvent ends a session's normal operation.
type sessionEvent int

const (
	eventConflict sessionEvent = iota
	eventUnauthorized
	eventIncompatible
)

type session struct {
	d      *Daemon
	log    *slog.Logger
	node   api.NodeIdentity
	config api.NodeConfig
	ws     workerSettings
	limits nodeLimits

	stopCtx    context.Context
	stopCancel context.CancelFunc
	opCtx      context.Context
	opCancel   context.CancelFunc

	mu          sync.Mutex
	actors      map[string]*actor
	desired     map[string]api.Assignment
	order       map[string]int64
	nextOrder   int64
	haveDesired bool
	appliedRev  int64
	ignored     map[string]bool

	pulls        pullQueue
	removals     chan struct{}
	networkOK    atomic.Bool
	unauthorized atomic.Bool
	// conflictAfter is details.retryAfterMs of the first 409 nodeInstanceConflict.
	conflictAfter atomic.Pointer[time.Duration]
	// nextStatus is the interval the last status response asked for (nextStatusMs; 0 = the hello
	// config's statusIntervalMs).
	nextStatus atomic.Int64

	reconcileCh chan struct{}
	statusCh    chan struct{}
	pollNowCh   chan struct{}
	events      chan sessionEvent

	logsMu   sync.Mutex
	answered map[string]time.Time
	inflight map[string]bool

	actorsWG sync.WaitGroup
	loopsWG  sync.WaitGroup
}

// maxConcurrentRemovals bounds stops and removals per node (docs/nodes.md §6.6).
const maxConcurrentRemovals = 4

func newSession(ctx context.Context, d *Daemon, hello *api.NodeHelloResponse) *session {
	s := &session{
		d:           d,
		log:         d.log.With("nodeId", hello.Node.ID),
		node:        hello.Node,
		config:      hello.Config,
		actors:      map[string]*actor{},
		desired:     map[string]api.Assignment{},
		order:       map[string]int64{},
		ignored:     map[string]bool{},
		removals:    make(chan struct{}, maxConcurrentRemovals),
		reconcileCh: make(chan struct{}, 1),
		statusCh:    make(chan struct{}, 1),
		pollNowCh:   make(chan struct{}, 1),
		events:      make(chan sessionEvent, 4),
		answered:    map[string]time.Time{},
		inflight:    map[string]bool{},
	}
	s.ws = workerSettings{
		nodeID:        hello.Node.ID,
		network:       d.workerNetworkName(),
		drainGraceMs:  hello.Config.DrainGraceMs,
		pidsLimit:     d.cfg.PidsLimit,
		shmSize:       d.cfg.ShmSize,
		nofile:        d.cfg.Nofile,
		logMaxSize:    d.cfg.LogMaxSize,
		logMaxFiles:   d.cfg.LogMaxFiles,
		caCert:        d.cfg.CACert,
		allowInsecure: d.cfg.AllowInsecure,
	}
	s.limits = nodeLimits{
		registryHost: hello.Config.Registry.Host,
		dindMode:     d.dind,
		cpus:         d.host.cpus,
		memoryBytes:  d.host.memoryBytes,
	}
	s.stopCtx, s.stopCancel = context.WithCancel(ctx)
	s.opCtx, s.opCancel = context.WithCancel(context.WithoutCancel(ctx))
	return s
}

// sessionEnd is how a session ended. next is the hello response of the next session when unauthorized
// mode ended with a successful hello; supersededFor is the remaining lease time of the instance that
// took this one's lease over (Daemon.standBy waits for it). Both zero: back to the hello loop, or
// shutdown when ctx ended.
type sessionEnd struct {
	next          *api.NodeHelloResponse
	supersededFor time.Duration
}

// runSession runs a session until it ends.
func (d *Daemon) runSession(ctx context.Context, hello *api.NodeHelloResponse) sessionEnd {
	s := newSession(ctx, d, hello)
	d.current.Store(s)
	defer d.current.Store(nil)
	apiCtx, apiCancel := context.WithCancel(s.stopCtx)
	defer apiCancel()
	s.start(apiCtx)
	for {
		select {
		case <-ctx.Done():
			apiCancel()
			s.shutdown()
			return sessionEnd{}
		case ev := <-s.events:
			apiCancel()
			switch ev {
			case eventConflict:
				s.log.Warn("another daemon instance took over this node's lease; stopping without touching containers")
				s.abort()
				var after time.Duration
				if p := s.conflictAfter.Load(); p != nil {
					after = *p
				}
				return sessionEnd{supersededFor: after}
			case eventIncompatible:
				s.log.Error("the orchestrator no longer accepts this daemon version; stopping without touching containers")
				s.abort()
				return sessionEnd{}
			case eventUnauthorized:
				next := s.unauthorizedMode(ctx)
				if ctx.Err() != nil {
					s.shutdown()
					return sessionEnd{}
				}
				s.abort()
				return sessionEnd{next: next}
			}
		}
	}
}

// start adopts the containers of this node and starts the session's loops (docs/nodes.md §5.1 step 8).
func (s *session) start(apiCtx context.Context) {
	s.checkNetwork()
	s.reconcile()
	s.goLoop(func() { s.assignmentsLoop(apiCtx) })
	s.goLoop(func() { s.statusLoop(apiCtx) })
	s.goLoop(s.eventsLoop)
	s.goLoop(s.reconcileLoop)
	s.goLoop(s.networkLoop)
	s.goLoop(s.egressLoop)
	s.goLoop(s.gcLoop)
}

func (s *session) goLoop(f func()) {
	s.loopsWG.Add(1)
	go func() {
		defer s.loopsWG.Done()
		f()
	}()
}

// signal reports a session event (non-blocking; the first event decides).
func (s *session) signal(ev sessionEvent) {
	select {
	case s.events <- ev:
	default:
	}
}

// handleAPIError classifies an error of a node API call and reports session events. It returns true
// when the calling loop must stop.
func (s *session) handleAPIError(err error) bool {
	switch kindOf(err) {
	case errConflict:
		after := conflictRetryAfter(err)
		s.conflictAfter.CompareAndSwap(nil, &after)
		s.signal(eventConflict)
		return true
	case errUnauthorized:
		s.signal(eventUnauthorized)
		return true
	case errIncompatible:
		s.signal(eventIncompatible)
		return true
	default:
		return false
	}
}

// shutdown stops gracefully (docs/nodes.md §7.5): no new operations, the long-poll and pulls are
// cancelled, in-flight create/start/update calls get shutdownGrace, then a final status is sent. Workers
// keep running.
func (s *session) shutdown() {
	s.stopCancel()
	timer := time.AfterFunc(s.d.t.shutdownGrace, s.opCancel)
	s.actorsWG.Wait()
	s.loopsWG.Wait()
	timer.Stop()
	s.opCancel()
	ctx, cancel := context.WithTimeout(context.Background(), s.d.t.finalStatusTimeout)
	defer cancel()
	if err := s.sendStatus(ctx); err != nil {
		s.log.Info("final status not delivered", "err", err)
	}
}

// abort stops at once without touching any container (409, 426, end of unauthorized mode).
func (s *session) abort() {
	s.stopCancel()
	s.opCancel()
	s.actorsWG.Wait()
	s.loopsWG.Wait()
}

// unauthorizedMode handles a 401 on a node route (docs/nodes.md §7.4): no new containers, existing
// ones keep running, hello is retried every minute. After the offline window the daemon removes all of
// its workers, because the orchestrator has already marked them lost. It returns the hello response
// when the node is authorized again, or nil (conflict, incompatible, or ctx ended).
func (s *session) unauthorizedMode(ctx context.Context) *api.NodeHelloResponse {
	s.unauthorized.Store(true)
	window := time.Duration(s.config.OfflineAfterMs) * time.Millisecond
	if window <= 0 {
		window = s.d.t.defaultOfflineAfter
	}
	s.log.Warn("the orchestrator rejected the node token (401); not creating containers, retrying hello",
		"retryIn", s.d.t.unauthorizedRetry, "removeWorkersAfter", window)
	purge := time.NewTimer(window)
	defer purge.Stop()
	retry := time.NewTimer(s.d.t.unauthorizedRetry)
	defer retry.Stop()
	b := backoff{min: s.d.t.apiBackoffMin, max: s.d.t.apiBackoffMax}
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-purge.C:
			s.log.Warn("still unauthorized after the offline window; removing all workers of this node")
			s.applyDesired(nil, s.appliedRevision())
		case <-retry.C:
			resp, delay, kind := s.d.helloOnce(ctx, &b)
			switch {
			case resp != nil:
				s.log.Info("authorized again; restarting the session")
				return resp
			case kind == errConflict || kind == errIncompatible:
				return nil
			}
			retry.Reset(max(delay, s.d.t.unauthorizedRetry))
		}
	}
}

// Desired state.

// applyDesired stores a complete desired set and reconciles (docs/nodes.md §5.3).
func (s *session) applyDesired(workers []api.Assignment, rev int64) {
	s.mu.Lock()
	next := make(map[string]api.Assignment, len(workers))
	for _, w := range workers {
		next[w.WorkerID] = w
		if _, ok := s.order[w.WorkerID]; !ok {
			s.nextOrder++
			s.order[w.WorkerID] = s.nextOrder
		}
	}
	for id := range s.order {
		if _, ok := next[id]; !ok {
			delete(s.order, id)
		}
	}
	s.desired = next
	s.haveDesired = true
	s.appliedRev = rev
	s.mu.Unlock()
	s.reconcile()
}

func (s *session) appliedRevision() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.appliedRev
}

func (s *session) desiredSnapshot() (map[string]api.Assignment, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return maps.Clone(s.desired), s.haveDesired
}

func (s *session) actor(workerID string) *actor {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.actors[workerID]
}

func (s *session) actorList() []*actor {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*actor, 0, len(s.actors))
	for _, a := range s.actors {
		out = append(out, a)
	}
	return out
}

// mayCreate reports whether actors may create containers (not in unauthorized mode, not stopping).
func (s *session) mayCreate() bool {
	return !s.unauthorized.Load() && s.stopCtx.Err() == nil
}

// Docker events.

// eventsLoop watches managed containers and wakes the actor of a worker when its container changes
// (docs/nodes.md §5.1). The stream is re-opened with backoff when it breaks.
func (s *session) eventsLoop() {
	b := backoff{min: s.d.t.apiBackoffMin, max: s.d.t.apiBackoffMax}
	for s.stopCtx.Err() == nil {
		filters := client.Filters{}
		filters.Add("type", string(events.ContainerEventType))
		filters.Add("label", container.LabelManaged+"=true")
		res := s.d.docker.Events(s.stopCtx, client.EventsListOptions{Filters: filters})
		err := s.consumeEvents(res)
		if s.stopCtx.Err() != nil {
			return
		}
		delay := b.next()
		s.log.Debug("Docker event stream ended; reconnecting", "err", err, "retryIn", delay)
		s.requestReconcile()
		if !sleep(s.stopCtx, delay) {
			return
		}
	}
}

func (s *session) consumeEvents(res client.EventsResult) error {
	for {
		select {
		case <-s.stopCtx.Done():
			return s.stopCtx.Err()
		case err := <-res.Err:
			return err
		case msg, ok := <-res.Messages:
			if !ok {
				return nil
			}
			attrs := msg.Actor.Attributes
			if attrs[container.LabelKind] != string(container.KindWorker) || attrs[container.LabelNode] != s.node.ID {
				continue
			}
			if a := s.actor(attrs[container.LabelWorker]); a != nil {
				a.kick()
			} else {
				s.requestReconcile()
			}
		}
	}
}

// Worker network (docs/nodes.md §6.8).

// networkLoop makes sure the worker network exists: the daemon creates scantor-workers on remote nodes
// and only checks scantor-sandbox (created by compose) on the built-in node. While it is missing, every
// creation fails with createFailed; when it appears, those workers are retried at once.
func (s *session) networkLoop() {
	for sleep(s.stopCtx, s.d.t.networkRetry) {
		if s.checkNetwork() {
			for _, a := range s.actorList() {
				a.retryNow()
			}
		}
	}
}

// checkNetwork updates networkOK and reports whether the network just became available.
func (s *session) checkNetwork() bool {
	err := s.ensureNetwork()
	wasOK := s.networkOK.Swap(err == nil)
	if err != nil {
		if s.stopCtx.Err() == nil {
			s.log.Error("the worker network is not available; workers cannot be created", "network", s.ws.network, "err", err)
		}
		return false
	}
	return !wasOK
}

// ensureNetwork checks that the worker network exists and, on remote nodes, creates it when it is
// missing (an existing network of that name counts as success; the daemon never deletes networks).
func (s *session) ensureNetwork() error {
	_, err := s.d.docker.NetworkInspect(s.opCtx, s.ws.network, client.NetworkInspectOptions{})
	switch {
	case err == nil:
		return nil
	case !container.IsNotFound(err):
		return fmt.Errorf("inspect network %s: %w", s.ws.network, err)
	case s.d.cfg.BuiltIn:
		return fmt.Errorf("network %s does not exist (it is created by the compose stack)", s.ws.network)
	}
	if err := container.EnsureNetwork(s.opCtx, s.d.docker, s.ws.network); err != nil {
		return err
	}
	s.log.Info("created the worker network", "network", s.ws.network)
	return nil
}
