package scheduler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/protocol"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/bootstrap"
	"github.com/lonetis/scantor/internal/runtime/canonical"
	"github.com/lonetis/scantor/internal/runtime/logtail"
	"github.com/lonetis/scantor/internal/runtime/pool"
	"github.com/lonetis/scantor/internal/runtime/scerr"
	"github.com/lonetis/scantor/internal/templates"
)

// Fixed timers of the scheduler (docs/runtime.md §11, §17).
const (
	// failConfirmWait bounds the wait for outstanding confirms before `done` with outcome failed.
	failConfirmWait = 60 * time.Second
	// restartConfirmWait bounds the wait for outstanding confirms before an in-process restart, so the
	// restart resumes from the longest possible prefix.
	restartConfirmWait = 10 * time.Second
	// checkpointTick is how often the checkpoint condition is evaluated.
	checkpointTick = 250 * time.Millisecond
	startupRetries = 3
	respawnMax     = 60 * time.Second
)

// API is the orchestrator side of a scheduler (bootstrap.Client).
type API interface {
	Resolved(ctx context.Context, req api.SchedulerResolvedRequest) (*api.SchedulerResolvedResponse, error)
	Checkpoint(ctx context.Context, req api.SchedulerCheckpointRequest) (*api.SchedulerCheckpointResponse, error)
	Done(ctx context.Context, req api.SchedulerDoneRequest) (*api.SchedulerDoneResponse, error)
	ReportError(ctx context.Context, fatal bool, e scerr.ScantorError, stderrTail string) bool
	// ReportRestart reports a retryable scheduling error; the orchestrator counts restarts from it.
	ReportRestart(ctx context.Context, e scerr.ScantorError, stderrTail string) bool
}

// Spawner starts connector processes (pool.Launcher).
type Spawner interface {
	Spawn(ctx context.Context, slot, gen int, output pool.Sink) (*pool.Process, error)
}

// Config configures a Scheduler.
type Config struct {
	// Boot is the worker's bootstrap (role scheduler).
	Boot      *api.Bootstrap
	Publisher Publisher
	// Depth reads the scan queue's ready count for the scheduler's share of the queue (amqp.maxLength);
	// nil leaves only the broker's limit.
	Depth QueueDepth
	API   API
	// Spawner starts the connector of a custom schedule.
	Spawner Spawner
	// Env is the template environment: data sources and uploads from bootstrap, the data-source HTTP
	// client, a scratch directory.
	Env      templates.Env
	Now      func() time.Time
	PollNow  func()
	WorkRoot string
	Logger   *slog.Logger
}

type phase int

const (
	phaseRunning phase = iota
	phaseDraining
	phaseStopping
	phaseFenced
)

// StartError is returned by Run when the connector of a custom schedule never completed the handshake
// (docs/runtime.md §7.5): the caller reports it as fatal and exits 1.
type StartError struct{ Err error }

func (e *StartError) Error() string { return "the connector did not start: " + e.Err.Error() }
func (e *StartError) Unwrap() error { return e.Err }

// errEnded marks the end of the scheduler because of drain, stop or fencing.
var errEnded = errors.New("scheduling ended by the platform")

// Scheduler is the scheduler worker.
type Scheduler struct {
	cfg    Config
	log    *slog.Logger
	boot   *api.Bootstrap
	win    *window
	res    *Resolutions
	limits Limits
	mirror *logtail.Mirror

	pubCtx    context.Context
	pubCancel context.CancelFunc

	mu         sync.Mutex
	phase      phase
	pullCancel context.CancelFunc
	proc       *pool.Process
	gen        int
	src        *ConnectorSource
	scheduling bool
	changed    chan struct{}
	drainNow   chan struct{}
	drainOnce  sync.Once
}

// New returns a scheduler.
func New(cfg Config) *Scheduler {
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.DiscardHandler)
	}
	b := cfg.Boot
	s := &Scheduler{
		cfg: cfg, log: cfg.Logger, boot: b,
		limits:   Limits{MaxAnalysesPerScan: b.Limits.MaxAnalysesPerScan, MaxAnalysisConfigBytes: b.Limits.MaxAnalysisConfigBytes},
		mirror:   logtail.NewMirror(cfg.Logger, "connector output"),
		changed:  make(chan struct{}),
		drainNow: make(chan struct{}),
	}
	s.pubCtx, s.pubCancel = context.WithCancel(context.Background())
	var cp api.Checkpoint
	var stored map[string]api.Resolution
	if b.Scheduler != nil {
		cp, stored = b.Scheduler.Checkpoint, b.Scheduler.Resolved
	}
	wait := time.Duration(b.Intervals.BackpressureWaitMs) * time.Millisecond
	s.win = newWindow(s.pubCtx, cfg.Publisher, cfg.Depth, shareOf(b.AMQP.MaxLength), b.AMQP.AnalysesExchange, b.AMQP.RoutingKey, wait, cfg.PollNow, cfg.Logger, cp)
	s.res = NewResolutions(cfg.Env, stored, s.record)
	s.res.Now = func() api.Time { return api.NewTime(cfg.Now()) }
	return s
}

// record posts a new resolution; when another epoch stored one first, that one is used.
func (s *Scheduler) record(ctx context.Context, key string, r api.Resolution) (api.Resolution, error) {
	resp, err := s.cfg.API.Resolved(ctx, api.SchedulerResolvedRequest{
		Epoch: s.boot.Worker.Epoch, Key: key, Template: r.Template, ScanConfig: r.ScanConfig, Provenance: r.Provenance, ExpectedTotal: r.ExpectedTotal,
	})
	switch {
	case errors.Is(err, bootstrap.ErrStaleEpoch):
		s.fence(err) // also for wrapped calls, whose error would otherwise reach user code
		return api.Resolution{}, err
	case errors.Is(err, bootstrap.ErrUnauthorized):
		s.Stop()
		return api.Resolution{}, err
	case err != nil:
		return api.Resolution{}, err
	}
	if !resp.Stored {
		s.log.Info("another scheduler resolved the template first; using its resolution", "key", key)
		return resp.Resolution, nil
	}
	s.log.Info("template resolved", "key", key, "template", r.Template, "expectedTotal", r.ExpectedTotal)
	return r, nil
}

func (s *Scheduler) custom() bool { return s.boot.Revision.Schedule.Kind == api.ScheduleKindCustom }

// State returns the scheduler part of a state poll (docs/runtime.md §11.10).
func (s *Scheduler) State() (api.RuntimeProcesses, api.SchedulerProgress) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var p api.RuntimeProcesses
	if !s.custom() || (s.proc != nil && s.proc.Usable()) {
		p.Running = 1
	}
	if s.scheduling {
		p.Busy = 1
	}
	return p, s.win.progress()
}

// Drain stops scheduling without `done` (docs/runtime.md §11.10).
func (s *Scheduler) Drain() { s.end(phaseDraining) }

// DrainNow skips the waits of a drain (a second SIGTERM or a SIGINT).
func (s *Scheduler) DrainNow() {
	s.end(phaseDraining)
	s.drainOnce.Do(func() { close(s.drainNow) })
}

// Stop aborts scheduling (docs/runtime.md §14.2).
func (s *Scheduler) Stop() { s.end(phaseStopping) }

func (s *Scheduler) end(p phase) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.phase >= p {
		return
	}
	s.phase = p
	if p >= phaseStopping {
		s.pubCancel()
	}
	if s.pullCancel != nil {
		s.pullCancel()
	}
	close(s.changed)
	s.changed = make(chan struct{})
}

func (s *Scheduler) currentPhase() phase {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.phase
}

func (s *Scheduler) changedCh() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.changed
}

// Run schedules until done, a non-retryable failure, drain, stop or fencing. It returns a *StartError
// when the connector never started, nil otherwise (exit 0).
func (s *Scheduler) Run(ctx context.Context) error {
	stopAux := make(chan struct{})
	var aux sync.WaitGroup
	aux.Go(func() { s.checkpointLoop(ctx, stopAux) })
	aux.Go(func() { s.mirror.ReportLoop(ctx, stopAux) })
	defer func() {
		close(stopAux)
		aux.Wait()
		s.pubCancel()
	}()

	if s.custom() {
		if err := s.startup(ctx); err != nil {
			if s.currentPhase() != phaseRunning {
				return nil
			}
			return &StartError{Err: err}
		}
	}
	restarts := 0
	if s.boot.Scheduler != nil {
		restarts = s.boot.Scheduler.Restarts
	}
	for {
		err := s.runOnce(ctx, restarts+1)
		if s.currentPhase() != phaseRunning || errors.Is(err, errEnded) || ctx.Err() != nil {
			s.shutdown(ctx)
			return nil
		}
		if err == nil {
			s.finish(ctx, api.OutcomeDone, nil)
			return nil
		}
		e := scerr.FromError(err, api.PhaseSchedule, true)
		if e.Type == api.ErrorCancelled {
			e.Type, e.Retryable = api.ErrorTaskError, true
		}
		e.Attempt, e.At = restarts+1, s.cfg.Now()
		e = e.Truncate(s.boot.Limits.StackBytes)
		if !e.Retryable {
			s.log.Error("scheduling failed", "errorType", e.Type, "error", e.Message)
			s.finish(ctx, api.OutcomeFailed, &e)
			return nil
		}
		restarts++
		s.log.Warn("schedule failed; restarting", "errorType", e.Type, "error", e.Message, "restarts", restarts)
		s.cfg.API.ReportRestart(ctx, e, s.stderrTail())
		if !s.restartWait(ctx, restarts) {
			s.shutdown(ctx)
			return nil
		}
	}
}

// restartWait waits for outstanding confirms (bounded), the restart backoff
// min(backoff.maxMs, initialMs × factor^(restarts−1)), and recycles the connector.
func (s *Scheduler) restartWait(ctx context.Context, restarts int) bool {
	wctx, cancel := context.WithTimeout(ctx, restartConfirmWait)
	s.win.waitEmpty(wctx)
	cancel()
	s.win.reset()
	b := s.boot.Scan.Settings.Backoff
	factor := max(b.Factor, 1)
	delay := time.Duration(min(float64(b.MaxMs), float64(b.InitialMs)*math.Pow(factor, float64(restarts-1)))) * time.Millisecond
	t := time.NewTimer(delay)
	defer t.Stop()
	select {
	case <-t.C:
	case <-s.changedCh():
		return false
	case <-ctx.Done():
		return false
	}
	if s.custom() {
		s.retire(true)
		return s.respawn(ctx)
	}
	return true
}

// startup spawns the connector with the startup retry rule (1 s, 2 s, 4 s).
func (s *Scheduler) startup(ctx context.Context) error {
	for attempt := 0; ; attempt++ {
		err := s.spawn(ctx)
		if err == nil {
			return nil
		}
		if attempt == startupRetries || ctx.Err() != nil {
			return err
		}
		select {
		case <-time.After(time.Second << attempt):
		case <-s.changedCh():
			return err
		case <-ctx.Done():
			return err
		}
	}
}

// respawn spawns a replacement connector with 1 s → 60 s backoff until it succeeds or the scheduler
// ends; a spawn failure after startup is a retryable platform condition, not a scheduling error.
func (s *Scheduler) respawn(ctx context.Context) bool {
	for attempt := 1; ; attempt++ {
		err := s.spawn(ctx)
		if err == nil {
			return true
		}
		if s.currentPhase() != phaseRunning || ctx.Err() != nil {
			return false
		}
		e := scerr.Newf(api.ErrorPlatform, api.PhaseBootstrap, "connector respawn failed: %v", err)
		e.Retryable = true
		s.cfg.API.ReportError(ctx, false, e, spawnTail(err))
		select {
		case <-time.After(min(time.Second<<min(attempt-1, 10), respawnMax)):
		case <-s.changedCh():
			return false
		case <-ctx.Done():
			return false
		}
	}
}

func spawnTail(err error) string {
	var se *pool.SpawnError
	if errors.As(err, &se) {
		return se.StderrTail
	}
	return ""
}

func (s *Scheduler) spawn(ctx context.Context) error {
	s.mu.Lock()
	gen := s.gen
	s.gen++
	s.mu.Unlock()
	p, err := s.cfg.Spawner.Spawn(ctx, 0, gen, s.mirror.Sink("slot", 0))
	if err != nil {
		s.log.Warn("connector process failed to start", "gen", gen, "err", err)
		return err
	}
	s.mu.Lock()
	s.proc = p
	s.mu.Unlock()
	s.log.Info("connector process ready", "gen", gen, "pid", p.PID(), "protocolVersion", p.ProtocolVersion(),
		"revisionProtocolVersion", s.boot.Revision.ProtocolVersion)
	return nil
}

// retire shuts the connector down (killed when kill or not idle).
func (s *Scheduler) retire(kill bool) {
	s.mu.Lock()
	p := s.proc
	s.proc = nil
	s.mu.Unlock()
	if p == nil {
		return
	}
	if kill || !p.Usable() {
		p.Kill()
		<-p.Done()
		return
	}
	p.Shutdown(protocol.ShutdownGrace)
}

func (s *Scheduler) stderrTail() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.proc == nil {
		return ""
	}
	return s.proc.StderrTail()
}

// runOnce runs the schedule once from the confirmed prefix (docs/runtime.md §11.3–§11.6) and returns when
// the stream ended and every item was confirmed.
func (s *Scheduler) runOnce(ctx context.Context, attempt int) error {
	pullCtx, cancel := context.WithCancel(ctx)
	s.mu.Lock()
	if s.phase != phaseRunning {
		s.mu.Unlock()
		cancel()
		return errEnded
	}
	s.pullCancel = cancel
	s.scheduling = true
	s.mu.Unlock()
	defer func() {
		cancel()
		s.mu.Lock()
		s.pullCancel = nil
		s.scheduling = false
		s.mu.Unlock()
	}()

	execDir := filepath.Join(s.cfg.WorkRoot, "x-schedule-"+strconv.Itoa(attempt))
	tmpDir := filepath.Join(execDir, "tmp")
	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		return scerr.Newf(api.ErrorPlatform, api.PhaseSchedule, "cannot create the schedule directory: %v", err)
	}
	defer func() {
		if err := os.RemoveAll(execDir); err != nil {
			s.log.Warn("cannot remove the schedule directory", "err", err)
		}
	}()

	src, err := s.open(pullCtx, attempt, tmpDir)
	if err != nil {
		return s.endErr(pullCtx, err)
	}
	defer func() {
		// A drain or stop still needs the request to send `cancel` (shutdown closes it then).
		if s.currentPhase() == phaseRunning {
			s.mu.Lock()
			s.src = nil
			s.mu.Unlock()
			src.Close()
		} else if _, ok := src.(*ConnectorSource); !ok {
			src.Close()
		}
	}()
	cp := s.win.checkpoint()
	if err := Replay(pullCtx, src, cp); err != nil {
		return s.endErr(pullCtx, err)
	}
	seq := cp.Confirmed
	for {
		if err := s.win.waitRoom(pullCtx); err != nil {
			return s.endErr(pullCtx, err)
		}
		item, ok, err := src.Next(pullCtx)
		if err != nil {
			return s.endErr(pullCtx, err)
		}
		if !ok {
			break
		}
		cfg, err := s.limits.CheckItem(seq, item)
		if err != nil {
			s.abandon(src)
			return err
		}
		hash, err := canonical.Hash(cfg)
		if err != nil {
			s.abandon(src)
			return scerr.Newf(api.ErrorValidation, api.PhaseSchedule, "analysis config %d: %v", seq, err)
		}
		body, err := json.Marshal(runtime.AnalysisMessage{
			V: runtime.MessageVersion, AnalysisID: runtime.AnalysisID(s.boot.Worker.ScanID, seq), ScanID: s.boot.Worker.ScanID,
			Seq: seq, Round: s.boot.Scan.Round, Attempt: 1, Config: cfg, ScheduledAt: s.cfg.Now().UnixMilli(),
		})
		if err != nil {
			s.abandon(src)
			return scerr.Newf(api.ErrorValidation, api.PhaseSchedule, "analysis config %d: %v", seq, err)
		}
		s.win.add(seq, hash, body)
		seq++
	}
	s.log.Info("schedule stream ended; waiting for confirms", "items", seq)
	if !s.win.waitEmpty(pullCtx) {
		return s.endErr(pullCtx, pullCtx.Err())
	}
	return nil
}

// endErr maps a cancelled pull to errEnded and fencing or a rejected token to the corresponding end.
func (s *Scheduler) endErr(pullCtx context.Context, err error) error {
	switch {
	case errors.Is(err, bootstrap.ErrStaleEpoch):
		s.fence(err)
		return errEnded
	case errors.Is(err, bootstrap.ErrUnauthorized):
		s.log.Info("the orchestrator rejected the worker token; stopping")
		s.Stop()
		return errEnded
	case pullCtx.Err() != nil && errors.Is(err, pullCtx.Err()):
		return errEnded
	}
	return err
}

// abandon ends a connector request that is still streaming (the process is recycled).
func (s *Scheduler) abandon(src Source) {
	if cs, ok := src.(*ConnectorSource); ok && !cs.Ended() {
		cs.Close()
		s.retire(true)
	}
}

// open starts the item source of one run.
func (s *Scheduler) open(ctx context.Context, attempt int, tmpDir string) (Source, error) {
	sched := s.boot.Revision.Schedule
	if !s.custom() {
		name := sched.Template
		if name == "" {
			name = templates.Single
		}
		def, ok := templates.Lookup(name)
		if !ok {
			return nil, scerr.Newf(api.ErrorValidation, api.PhaseSchedule, "unknown template %q; this runtime does not implement it", name)
		}
		effective, err := Effective(def, s.boot.Scan.ScanConfig)
		if err != nil {
			return nil, err
		}
		res, err := s.res.Resolve(ctx, KeySchedule, def, effective)
		if err != nil {
			return nil, err
		}
		return NewNative(ctx, def, res, s.cfg.Env), nil
	}
	s.mu.Lock()
	p := s.proc
	s.mu.Unlock()
	if p == nil || !p.Usable() {
		s.retire(true)
		if !s.respawn(ctx) {
			return nil, errEnded
		}
		s.mu.Lock()
		p = s.proc
		s.mu.Unlock()
	}
	pctx := protocol.Ctx{ScanID: s.boot.Worker.ScanID, Attempt: attempt, TmpDir: tmpDir}
	server := NewTemplateServer(ctx, s.res, func(msg string, args ...any) { s.log.Warn(msg, args...) })
	timeout := time.Duration(s.boot.Scan.Settings.TimeoutMs) * time.Millisecond
	src, err := StartConnector(p, pctx, s.boot.Scan.ScanConfig, s.boot.Scan.TaskConfig, timeout, server)
	if err != nil {
		s.retire(true)
		return nil, scerr.Newf(api.ErrorCrash, api.PhaseSchedule, "cannot send the schedule request: %v", err)
	}
	s.mu.Lock()
	s.src = src
	s.mu.Unlock()
	return src, nil
}

// Replay regenerates the first cp.Confirmed items without publishing them and verifies the hash of item
// confirmed−1 against cp.TailHash (docs/runtime.md §11.3).
func Replay(ctx context.Context, src Source, cp api.Checkpoint) error {
	if cp.Confirmed <= 0 {
		return nil
	}
	for i := int64(0); i < cp.Confirmed; i++ {
		item, ok, err := src.Next(ctx)
		if err != nil {
			return err
		}
		if !ok {
			return scerr.Newf(api.ErrorValidation, api.PhaseSchedule, "schedule() is not deterministic: it produced only %d items on resume", i)
		}
		if i < cp.Confirmed-1 {
			continue
		}
		hash, err := canonical.Hash(item)
		if err != nil || cp.TailHash == nil || hash != *cp.TailHash {
			return scerr.Newf(api.ErrorValidation, api.PhaseSchedule, "schedule() is not deterministic: item %d hash mismatch on resume", i)
		}
	}
	return nil
}

// fence ends the scheduler on 409 staleEpoch (docs/runtime.md §11.8): no more pulls or publishes, no done.
func (s *Scheduler) fence(err error) {
	s.log.Info("a newer scheduler epoch exists; exiting", "err", err)
	s.end(phaseFenced)
}

// finish reports the end of scheduling (docs/runtime.md §11.7) after a final checkpoint.
func (s *Scheduler) finish(ctx context.Context, outcome string, e *scerr.ScantorError) {
	if outcome == api.OutcomeFailed {
		wctx, cancel := context.WithTimeout(ctx, failConfirmWait)
		s.win.waitEmpty(wctx)
		cancel()
	}
	s.retire(false)
	cp := s.win.checkpoint()
	req := api.SchedulerDoneRequest{Epoch: s.boot.Worker.Epoch, Outcome: outcome, Confirmed: cp.Confirmed, TailHash: cp.TailHash}
	if e != nil {
		ae := e.API()
		req.Error = &ae
	}
	resp, err := s.cfg.API.Done(ctx, req)
	switch {
	case err == nil:
		s.log.Info("scheduling finished", "outcome", outcome, "confirmed", cp.Confirmed, "state", resp.Scheduling.State)
	case errors.Is(err, bootstrap.ErrStaleEpoch):
		s.fence(err)
	case errors.Is(err, bootstrap.ErrUnauthorized):
		s.log.Info("the orchestrator rejected the worker token after scheduling")
	default:
		s.log.Error("cannot report the end of scheduling", "err", err)
	}
}

// shutdown runs the drain or stop sequence of the scheduler (docs/runtime.md §11.10, §14.2).
func (s *Scheduler) shutdown(ctx context.Context) {
	s.mu.Lock()
	src := s.src
	s.src = nil
	s.mu.Unlock()
	switch s.currentPhase() {
	case phaseDraining:
		grace := time.Duration(s.boot.Intervals.DrainGraceMs) * time.Millisecond
		deadline := time.Now().Add(grace)
		if src != nil && !src.Ended() {
			if err := src.Cancel(protocol.CancelDrain); err == nil {
				src.Drain(min(protocol.CancelGrace, time.Until(deadline)))
			}
		}
		wctx, cancel := context.WithDeadline(ctx, deadline)
		go func() {
			select {
			case <-s.drainNow:
				cancel()
			case <-wctx.Done():
			}
		}()
		s.win.waitEmpty(wctx)
		cancel()
		s.pubCancel()
		kill := src != nil && !src.Ended()
		if src != nil {
			src.Close()
		}
		s.retire(kill)
		s.finalCheckpoint(ctx)
	case phaseStopping:
		if src != nil && !src.Ended() {
			if err := src.Cancel(protocol.CancelStop); err == nil {
				src.Drain(protocol.CancelGrace)
			}
		}
		if src != nil {
			src.Close()
		}
		s.retire(true)
	default: // fenced or ctx done
		if src != nil {
			src.Close()
		}
		s.retire(true)
	}
	s.log.Info("scheduler ended", "confirmed", s.win.checkpoint().Confirmed)
}

// checkpointLoop stores the confirmed prefix whenever it grew and checkpointMs elapsed or
// checkpointItems items were confirmed since the last checkpoint (docs/runtime.md §11.5).
func (s *Scheduler) checkpointLoop(ctx context.Context, stop <-chan struct{}) {
	interval := time.Duration(s.boot.Intervals.CheckpointMs) * time.Millisecond
	items := s.boot.Intervals.CheckpointItems
	last := s.win.checkpoint().Confirmed
	lastAt := time.Now()
	t := time.NewTicker(checkpointTick)
	defer t.Stop()
	for {
		select {
		case <-t.C:
		case <-ctx.Done():
			return
		case <-stop:
			return
		}
		if s.currentPhase() >= phaseStopping {
			return
		}
		cp := s.win.checkpoint()
		if cp.Confirmed <= last || (time.Since(lastAt) < interval && (items <= 0 || cp.Confirmed-last < items)) {
			continue
		}
		lastAt = time.Now()
		if err := s.storeCheckpoint(ctx, cp); err != nil {
			continue
		}
		last = cp.Confirmed
	}
}

func (s *Scheduler) storeCheckpoint(ctx context.Context, cp api.Checkpoint) error {
	_, err := s.cfg.API.Checkpoint(ctx, api.SchedulerCheckpointRequest{Epoch: s.boot.Worker.Epoch, Confirmed: cp.Confirmed, TailHash: cp.TailHash})
	switch {
	case err == nil:
		return nil
	case errors.Is(err, bootstrap.ErrStaleEpoch):
		s.fence(err)
	case errors.Is(err, bootstrap.ErrUnauthorized):
		s.Stop()
	default:
		s.log.Warn("checkpoint failed; retrying at the next interval", "err", err)
	}
	return err
}

// finalCheckpoint stores the prefix once more at the end of a drain.
func (s *Scheduler) finalCheckpoint(ctx context.Context) {
	cp := s.win.checkpoint()
	if cp.Confirmed <= 0 {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, api.RuntimeCallTimeout)
	defer cancel()
	if err := s.storeCheckpoint(cctx, cp); err != nil {
		s.log.Warn("final checkpoint failed", "err", fmt.Sprint(err))
	}
}
