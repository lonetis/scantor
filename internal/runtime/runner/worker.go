// Package runner is the runner side of the runtime (docs/runtime.md §6.2–§8, §12–§14): process slots that
// each pair a connector process with an AMQP slot channel (prefetch 1), the run path of one delivery
// (validation, the redelivered status check, dispatch, classification, uploads, publish plans and the
// ack), the holding budget, recycling, live resize, the unhealthy state and the drain and stop sequences.
//
// Execute (one analysis on one process) and the message builders are shared with local mode, which runs
// the same path without AMQP.
package runner

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/protocol"
	"github.com/lonetis/scantor/internal/runtime/logtail"
	"github.com/lonetis/scantor/internal/runtime/scerr"
)

// Fixed timers of the runner (docs/runtime.md §17).
const (
	// holdingMargin is the safety margin of the holding budget.
	holdingMargin = 60 * time.Second
	// drainCancelGrace is how long before the drain grace deadline `cancel{drain}` is sent
	// (welcome.cancelGraceMs).
	drainCancelGrace = protocol.CancelGrace
	// drainCloseMargin is the part of the node's 5 s stop margin in which unconfirmed plans may still
	// finish after the drain grace deadline.
	drainCloseMargin = 4 * time.Second
	// shutdownGrace is the graceful shutdown of an idle process.
	shutdownGrace = protocol.ShutdownGrace
	// freeSpaceInterval is how often the free space of the work root is checked.
	freeSpaceInterval = 5 * time.Second
	// unhealthy backoff: 5 s → 5 min, ×2, full jitter.
	unhealthyInitial = 5 * time.Second
	unhealthyMax     = 5 * time.Minute
	// startup spawn retries: 1 s, 2 s, 4 s.
	startupRetries = 3
	// respawn and consume backoffs.
	respawnInitial = time.Second
	respawnMax     = 60 * time.Second
	consumeInitial = time.Second
	consumeMax     = 30 * time.Second
	// recheckInterval bounds every wait for a state change.
	recheckInterval = time.Second
	// republishWait is the pause between republishes of a retry that the full scan queue refused
	// (docs/runtime.md §8.11), ± 20 %.
	republishWait = 500 * time.Millisecond
)

// Config configures a Worker.
type Config struct {
	// Boot is the worker's bootstrap (role runner).
	Boot *api.Bootstrap
	// WorkRoot is /tmp/scantor.
	WorkRoot string

	Spawner  Spawner
	Broker   Broker
	Uploader Uploader
	// Status asks for the stored status of redelivered analyses (one try, 5 s timeout).
	Status StatusFunc
	// Now is the server-corrected clock.
	Now func() time.Time
	// PollNow asks the state poller to poll at once (a returned republish, a missing queue).
	PollNow func()
	// Report sends POST /api/runtime/errors (rate limited by the caller).
	Report func(ctx context.Context, fatal bool, e scerr.ScantorError, stderrTail string)
	// FreeSpace returns the free bytes of the filesystem holding the work root.
	FreeSpace func() (int64, error)
	// Probe performs a state poll and reports whether it succeeded (the unhealthy recovery probe).
	Probe  func(ctx context.Context) bool
	Logger *slog.Logger
}

type phase int

const (
	phaseRunning phase = iota
	phaseDraining
	phaseStopping
)

// StartError is returned by Start when no connector process of the worker ever completed the handshake
// (docs/runtime.md §7.5): the caller reports it as fatal and exits 1.
type StartError struct{ Err error }

func (e *StartError) Error() string { return "the connector did not start: " + e.Err.Error() }
func (e *StartError) Unwrap() error { return e.Err }

// Worker runs the slots of one runner worker.
type Worker struct {
	cfg      Config
	log      *slog.Logger
	health   *Health
	status   *statusBatcher
	policy   scerr.Policy
	mirror   *logtail.Mirror
	limits   Limits
	timeout  time.Duration
	maxProcs int

	mu         sync.Mutex
	slots      map[int]*slot
	gens       map[int]int
	phase      phase
	changed    chan struct{}
	counters   api.RuntimeCounters
	everReady  atomic.Bool
	lowSpace   atomic.Bool
	aborting   atomic.Bool
	abortCh    chan struct{} // closed while aborting (ACCESS_REFUSED)
	running    int           // slot goroutines alive
	runCtx     context.Context
	abort      context.CancelFunc // spawns, waits: cancelled on stop or at the drain deadline
	abortCtx   context.Context
	pubCancel  context.CancelFunc // publishing: cancelled on stop or after the drain close margin
	pubCtx     context.Context
	drainNow   chan struct{}
	drainOnce  sync.Once
	started    bool
	runStarted chan struct{}
}

// New returns a worker for cfg.Boot.
func New(cfg Config) *Worker {
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.DiscardHandler)
	}
	b := cfg.Boot
	w := &Worker{
		cfg:    cfg,
		log:    cfg.Logger,
		policy: scerr.Policy{Backoff: b.Scan.Settings.Backoff, MaxAttempts: b.Scan.Settings.MaxAttempts},
		limits: Limits{
			MaxResultBytes: b.Limits.MaxResultBytes, MaxFileBytes: b.Uploads.MaxFileBytes,
			MaxFilesPerAnalysis: b.Uploads.MaxFilesPerAnalysis, StackBytes: b.Limits.StackBytes,
		},
		timeout:    time.Duration(b.Scan.Settings.TimeoutMs) * time.Millisecond,
		maxProcs:   max(b.Limits.MaxProcessesPerWorker, 1),
		slots:      map[int]*slot{},
		gens:       map[int]int{},
		changed:    make(chan struct{}),
		drainNow:   make(chan struct{}),
		runStarted: make(chan struct{}),
		abortCh:    make(chan struct{}),
	}
	w.mirror = logtail.NewMirror(w.log, "connector output")
	w.health = NewHealth(w.notify)
	w.runCtx = context.Background()
	w.abortCtx, w.abort = context.WithCancel(context.Background())
	w.status = newStatusBatcher(w.abortCtx, cfg.Status)
	w.pubCtx, w.pubCancel = context.WithCancel(context.Background())
	return w
}

// Health returns the health state.
func (w *Worker) Health() *Health { return w.health }

func (w *Worker) clampProcesses(n int) int { return min(max(n, 1), w.maxProcs) }

// Start spawns the initial connector processes in parallel (docs/runtime.md §4.1). While no process of
// the worker has completed the handshake, a failing slot is retried 3 times (1 s, 2 s, 4 s); then Start
// returns a *StartError. Slots that fail after another process became ready keep retrying in Run.
func (w *Worker) Start(ctx context.Context) error {
	w.mu.Lock()
	if w.started {
		w.mu.Unlock()
		return errors.New("runner already started")
	}
	w.started = true
	n := w.clampProcesses(w.cfg.Boot.Scan.Settings.Processes)
	for i := range n {
		w.slots[i] = w.newSlotLocked(i)
	}
	slots := w.slotList()
	w.mu.Unlock()

	errs := make(chan error, len(slots))
	var wg sync.WaitGroup
	for _, s := range slots {
		wg.Go(func() { errs <- s.startup(ctx) })
	}
	wg.Wait()
	close(errs)
	var first error
	for err := range errs {
		if err != nil && first == nil {
			first = err
		}
	}
	if first != nil && !w.everReady.Load() {
		w.Stop()
		for _, s := range slots {
			s.killProcess()
		}
		return &StartError{Err: first}
	}
	return nil
}

func (w *Worker) newSlotLocked(index int) *slot {
	return &slot{w: w, index: index, gen: w.gens[index], ctl: make(chan Control, 4), capture: logtail.NewBuffer(w.logTailCapacity())}
}

func (w *Worker) logTailCapacity() int { return max(w.cfg.Boot.Limits.LogTailBytes, 1) }

// slotList returns the slots ordered by index (under w.mu).
func (w *Worker) slotList() []*slot {
	out := make([]*slot, 0, len(w.slots))
	for _, s := range w.slots {
		out = append(out, s)
	}
	slices.SortFunc(out, func(a, b *slot) int { return cmp.Compare(a.index, b.index) })
	return out
}

// Run runs the slots until they all ended after Drain or Stop, or ctx ended.
func (w *Worker) Run(ctx context.Context) {
	w.checkSpace() // before any slot consumes (docs/runtime.md §4.1)
	w.mu.Lock()
	w.runCtx = ctx
	for _, s := range w.slotList() {
		w.launchLocked(s)
	}
	close(w.runStarted)
	w.mu.Unlock()

	stopWatch := make(chan struct{})
	var aux sync.WaitGroup
	aux.Go(func() { w.watchBroker(ctx, stopWatch) })
	aux.Go(func() { w.monitorSpace(ctx, stopWatch) })
	aux.Go(func() { w.monitorHealth(ctx, stopWatch) })
	aux.Go(func() { w.mirror.ReportLoop(ctx, stopWatch) })

	w.waitSlots(ctx)
	close(stopWatch)
	aux.Wait()
	w.abort()
	w.pubCancel()
}

// waitSlots returns when no slot goroutine runs any more and the worker is shutting down; Resize may add
// slots meanwhile.
func (w *Worker) waitSlots(ctx context.Context) {
	for {
		w.mu.Lock()
		done := w.running == 0 && w.phase != phaseRunning
		changed := w.changed
		w.mu.Unlock()
		if done {
			return
		}
		select {
		case <-changed:
		case <-ctx.Done():
			// Slots end on their own once ctx is done; wait for them so no process outlives Run.
			w.mu.Lock()
			n := w.running
			w.mu.Unlock()
			if n == 0 {
				return
			}
			<-w.changedCh()
		}
	}
}

func (w *Worker) launchLocked(s *slot) {
	w.running++
	go func() {
		s.run(w.runCtx)
		w.mu.Lock()
		w.running--
		if w.slots[s.index] == s {
			delete(w.slots, s.index)
		}
		w.gens[s.index] = s.gen + 1
		w.notifyLocked()
		w.mu.Unlock()
	}()
}

// notify wakes every slot waiting for a state change.
func (w *Worker) notify() {
	w.mu.Lock()
	w.notifyLocked()
	w.mu.Unlock()
}

func (w *Worker) notifyLocked() {
	close(w.changed)
	w.changed = make(chan struct{})
}

func (w *Worker) changedCh() <-chan struct{} {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.changed
}

func (w *Worker) currentPhase() phase {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.phase
}

// watchBroker forwards connection and block changes to the slots.
func (w *Worker) watchBroker(ctx context.Context, stop <-chan struct{}) {
	for {
		ch := w.cfg.Broker.Changed()
		select {
		case <-ch:
			w.notify()
		case <-ctx.Done():
			return
		case <-stop:
			return
		}
	}
}

// monitorSpace checks the free space of the work root (docs/runtime.md §12).
func (w *Worker) monitorSpace(ctx context.Context, stop <-chan struct{}) {
	t := time.NewTicker(freeSpaceInterval)
	defer t.Stop()
	for {
		w.checkSpace()
		select {
		case <-t.C:
		case <-ctx.Done():
			return
		case <-stop:
			return
		}
	}
}

// checkSpace reports whether the free space is at least limits.minFreeTmpBytes, tripping the health
// state otherwise.
func (w *Worker) checkSpace() bool {
	minFree := w.cfg.Boot.Limits.MinFreeTmpBytes
	if minFree <= 0 || w.cfg.FreeSpace == nil {
		return true
	}
	free, err := w.cfg.FreeSpace()
	if err != nil {
		w.log.Warn("cannot read the free space of the work root", "err", err)
		return true
	}
	if free < minFree {
		if !w.lowSpace.Swap(true) {
			w.log.Error("free space under the work root is below the minimum", "freeBytes", free, "minFreeBytes", minFree)
		}
		w.health.LowSpace(free, minFree)
		return false
	}
	w.lowSpace.Store(false)
	return true
}

// monitorHealth runs the unhealthy sequence (docs/runtime.md §12): report, back off 5 s → 5 min, probe.
func (w *Worker) monitorHealth(ctx context.Context, stop <-chan struct{}) {
	attempt := 0
	for {
		reason, unhealthy := w.health.Reason()
		if !unhealthy {
			attempt = 0
			select {
			case <-w.changedCh():
				continue
			case <-ctx.Done():
				return
			case <-stop:
				return
			}
		}
		if attempt == 0 {
			w.log.Error("worker is unhealthy; slots stop consuming", "reason", reason.Message, "phase", reason.Phase)
			if w.cfg.Report != nil {
				w.cfg.Report(ctx, false, reason, "")
			}
		}
		attempt++
		delay := time.Duration(rand.Float64() * float64(min(unhealthyInitial<<min(attempt-1, 10), unhealthyMax))) //nolint:gosec // backoff jitter
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return
		case <-stop:
			return
		}
		if w.probe(ctx) {
			w.log.Info("worker is healthy again; slots consume", "probes", attempt)
			w.health.Recover()
		}
	}
}

// probe checks a state poll, the AMQP connection, a ready process per slot and the free space.
func (w *Worker) probe(ctx context.Context) bool {
	if w.cfg.Probe != nil && !w.cfg.Probe(ctx) {
		return false
	}
	if !w.cfg.Broker.Connected() || !w.checkSpace() {
		return false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, s := range w.slots {
		if !s.procReady && !s.removed {
			return false
		}
	}
	return true
}

// mayConsume reports whether slot s may consume (docs/runtime.md §6.2): the worker runs, is healthy, the
// connection is up and not blocked, there is enough space and the slot is wanted.
func (w *Worker) mayConsume(s *slot) bool {
	w.mu.Lock()
	ok := w.phase == phaseRunning && !s.removed
	w.mu.Unlock()
	return ok && w.health.Healthy() && !w.lowSpace.Load() && w.cfg.Broker.Connected() && !w.cfg.Broker.Blocked()
}

// Resize sets the number of slots to n, clamped to 1 … limits.maxProcessesPerWorker
// (docs/runtime.md §7.4).
func (w *Worker) Resize(n int) {
	n = w.clampProcesses(n)
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.phase != phaseRunning {
		return
	}
	var active []*slot
	for _, s := range w.slotList() {
		if !s.removed {
			active = append(active, s)
		}
	}
	switch {
	case n > len(active):
		added := 0
		for i := 0; added < n-len(active); i++ {
			if _, used := w.slots[i]; used {
				continue
			}
			s := w.newSlotLocked(i)
			w.slots[i] = s
			added++
			select {
			case <-w.runStarted:
				w.launchLocked(s)
			default: // Run launches every slot
			}
		}
		w.log.Info("resized the process pool", "processes", n)
	case n < len(active):
		// Idle slots first, then busy slots whose analyses started first; the highest index breaks ties.
		slices.SortFunc(active, func(a, b *slot) int {
			switch {
			case (a.busy == nil) != (b.busy == nil):
				if a.busy == nil {
					return -1
				}
				return 1
			case a.busy != nil && !a.busyStart.Equal(b.busyStart):
				return a.busyStart.Compare(b.busyStart)
			default:
				return cmp.Compare(b.index, a.index)
			}
		})
		for _, s := range active[:len(active)-n] {
			s.removed = true
		}
		w.log.Info("resized the process pool", "processes", n)
	default:
		return
	}
	w.notifyLocked()
}

// Drain starts the graceful drain (docs/runtime.md §14.1): consumers are cancelled, running analyses may
// finish until drainGraceMs − 1 s, `cancel{drain}` is sent cancelGraceMs before that, and at the grace
// deadline the remaining process groups are killed and their deliveries given back.
func (w *Worker) Drain() {
	w.mu.Lock()
	if w.phase != phaseRunning {
		w.mu.Unlock()
		return
	}
	w.phase = phaseDraining
	w.notifyLocked()
	w.mu.Unlock()
	w.log.Info("draining")
	grace := time.Duration(w.cfg.Boot.Intervals.DrainGraceMs)*time.Millisecond - time.Second
	go w.drainTimers(max(grace, 0))
}

// DrainNow skips to the grace deadline (a second SIGTERM or a SIGINT).
func (w *Worker) DrainNow() {
	w.Drain()
	w.drainOnce.Do(func() { close(w.drainNow) })
}

func (w *Worker) drainTimers(grace time.Duration) {
	start := time.Now()
	cancelAt := grace - drainCancelGrace
	if cancelAt > 0 {
		select {
		case <-time.After(cancelAt):
		case <-w.drainNow:
		case <-w.abortCtx.Done():
			return
		}
	}
	if w.currentPhase() != phaseDraining {
		return
	}
	w.control(Control{Cancel: protocol.CancelDrain})
	select {
	case <-time.After(time.Until(start.Add(grace))):
	case <-w.drainNow:
	case <-w.abortCtx.Done():
		return
	}
	if w.currentPhase() != phaseDraining {
		return
	}
	w.log.Info("drain grace expired; killing the remaining analyses")
	w.control(Control{Kill: true})
	w.abort()
	time.AfterFunc(drainCloseMargin, w.pubCancel)
}

// Stop aborts (docs/runtime.md §14.2): consumers stop, every process with a request in flight gets
// `cancel{stop}` and is killed as soon as it replied, at the latest after cancelGraceMs; nothing is
// published, acked or nacked.
func (w *Worker) Stop() {
	w.mu.Lock()
	if w.phase == phaseStopping {
		w.mu.Unlock()
		return
	}
	w.phase = phaseStopping
	w.notifyLocked()
	w.mu.Unlock()
	w.log.Info("stopping")
	w.pubCancel()
	w.control(Control{Cancel: protocol.CancelStop})
	time.AfterFunc(protocol.CancelGrace, func() {
		w.control(Control{Kill: true})
		w.abort()
	})
}

// Stopping reports whether Stop was called.
func (w *Worker) Stopping() bool { return w.currentPhase() == phaseStopping }

// Abort aborts the running analyses without ending the worker (ACCESS_REFUSED on reconnect,
// docs/runtime.md §6.6): there is nowhere to publish, so every process with a request in flight gets
// `cancel{stop}` and is killed after cancelGraceMs, and outcomes are discarded until Resume.
func (w *Worker) Abort() {
	w.mu.Lock()
	if w.aborting.Load() {
		w.mu.Unlock()
		return
	}
	w.aborting.Store(true)
	close(w.abortCh)
	w.mu.Unlock()
	w.log.Warn("the broker refused the scan's credentials; aborting the running analyses")
	w.control(Control{Cancel: protocol.CancelStop})
	time.AfterFunc(protocol.CancelGrace, func() {
		if w.aborting.Load() {
			w.control(Control{Kill: true})
		}
	})
}

// Resume ends an Abort after the connection was re-established.
func (w *Worker) Resume() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.aborting.Swap(false) {
		w.abortCh = make(chan struct{})
		w.log.Info("the broker accepts the scan's credentials again")
	}
}

// discarding reports whether outcomes are thrown away: the worker stops or aborts.
func (w *Worker) discarding() bool { return w.Stopping() || w.aborting.Load() }

func (w *Worker) abortSignal() <-chan struct{} {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.abortCh
}

// control sends c to every slot whose analysis is executing.
func (w *Worker) control(c Control) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, s := range w.slots {
		if s.executing {
			select {
			case s.ctl <- c:
			default:
			}
		}
	}
}

// State returns the runner part of a state poll (docs/runtime.md §5.1).
func (w *Worker) State() (api.RuntimeProcesses, []api.BusyAnalysis, bool, api.RuntimeCounters) {
	w.mu.Lock()
	defer w.mu.Unlock()
	var procs api.RuntimeProcesses
	busy := []api.BusyAnalysis{}
	consuming := false
	for _, s := range w.slotList() {
		if s.procReady && s.consuming {
			procs.Running++
			consuming = true
		}
		if s.busy != nil {
			procs.Busy++
			busy = append(busy, *s.busy)
		}
	}
	if w.phase != phaseRunning || !w.health.Healthy() || w.cfg.Broker.Blocked() {
		consuming = false
	}
	return procs, busy, consuming, w.counters
}

func (w *Worker) count(f func(*api.RuntimeCounters)) {
	w.mu.Lock()
	f(&w.counters)
	w.mu.Unlock()
}

func workerID8(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func consumerTag(workerID string, slot, gen int) string {
	return fmt.Sprintf("w-%s-s%d-%d", workerID8(workerID), slot, gen)
}
