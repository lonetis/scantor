package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"time"

	"github.com/google/uuid"
	amqp "github.com/rabbitmq/amqp091-go"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/amqpx"
	"github.com/lonetis/scantor/internal/runtime/bootstrap"
	"github.com/lonetis/scantor/internal/runtime/logtail"
	"github.com/lonetis/scantor/internal/runtime/pool"
	"github.com/lonetis/scantor/internal/runtime/scerr"
	"github.com/lonetis/scantor/internal/runtime/upload"
)

// slot is one connector process paired with one AMQP slot channel. Its goroutine owns the process and
// the channel; the fields below the marker are shared with the worker under w.mu.
type slot struct {
	w       *Worker
	index   int
	gen     int // process generation (proc-<slot>-<gen>)
	consGen int // consumer generation (tag w-<workerId8>-s<slot>-<gen>)
	proc    *pool.Process
	handled int // analyses handled by proc
	capture *logtail.Buffer
	ctl     chan Control

	// Guarded by w.mu.
	removed   bool
	exiting   bool // the goroutine decided to end; a resize up no longer revives the slot
	procReady bool
	consuming bool
	executing bool
	busy      *api.BusyAnalysis
	busyStart time.Time
}

// disposition is what happens to a delivery after its plan.
type disposition int

const (
	dispAck  disposition = iota // the plan was confirmed (or nothing had to be published)
	dispNack                    // give back with requeue: not an attempt, not counted
	dispNone                    // neither: the delivery returns with the channel or is dropped with the queue
)

func (s *slot) set(f func()) {
	s.w.mu.Lock()
	f()
	s.w.mu.Unlock()
}

func (s *slot) logger() []any { return []any{"slot", s.index} }

// startup spawns the first process with the startup retry rule (docs/runtime.md §7.5).
func (s *slot) startup(ctx context.Context) error {
	for attempt := 0; ; attempt++ {
		err := s.spawn(ctx)
		if err == nil {
			return nil
		}
		if s.w.everReady.Load() {
			return nil // another process is ready: the slot respawns with backoff in run
		}
		if attempt == startupRetries || ctx.Err() != nil {
			return err
		}
		if !sleepCtx(ctx, time.Second<<attempt, nil) {
			return err
		}
	}
}

// spawn starts the next generation of the slot's process.
func (s *slot) spawn(ctx context.Context) error {
	gen := s.gen
	s.gen++
	out := s.w.mirror.Sink("slot", s.index)
	p, err := s.w.cfg.Spawner.Spawn(ctx, s.index, gen, out)
	if err != nil {
		s.w.log.Warn("connector process failed to start", append(s.logger(), "gen", gen, "err", err)...)
		return err
	}
	s.proc, s.handled = p, 0
	s.w.everReady.Store(true)
	s.w.health.SpawnSucceeded()
	s.set(func() { s.procReady = true })
	s.w.log.Info("connector process ready", append(s.logger(), "gen", gen, "pid", p.PID(), "protocolVersion", p.ProtocolVersion(),
		"revisionProtocolVersion", s.w.cfg.Boot.Revision.ProtocolVersion, "connector", p.Hello().Connector.Version)...)
	return nil
}

// ensureProcess makes sure the slot has a usable process, respawning with 1 s → 60 s backoff without
// consuming (docs/runtime.md §7.5). It reports false when it had to wait (the caller re-evaluates).
func (s *slot) ensureProcess() bool {
	if s.proc != nil && s.proc.Usable() {
		return true
	}
	s.set(func() { s.procReady = false })
	if s.proc != nil {
		s.retireProcess(false)
	}
	for attempt := 1; ; attempt++ {
		if s.w.abortCtx.Err() != nil || s.shouldExit() {
			return false
		}
		err := s.spawn(s.w.abortCtx)
		if err == nil {
			return true
		}
		if s.w.abortCtx.Err() != nil {
			return false
		}
		s.w.health.SpawnFailed(err)
		d := time.Duration(rand.Float64() * float64(min(respawnInitial<<min(attempt-1, 10), respawnMax))) //nolint:gosec // backoff jitter
		sleepCtx(s.w.abortCtx, max(d, 100*time.Millisecond), s.w.changedCh())
	}
}

// retireProcess shuts the current process down (graceful when idle and usable, otherwise killed) and
// removes it.
func (s *slot) retireProcess(kill bool) {
	p := s.proc
	if p == nil {
		return
	}
	s.proc = nil
	s.set(func() { s.procReady = false })
	if kill || !p.Usable() {
		p.Kill()
		<-p.Done()
		return
	}
	p.Shutdown(shutdownGrace)
}

func (s *slot) killProcess() {
	if s.proc != nil {
		s.retireProcess(true)
	}
}

// shouldExit reports whether the slot's goroutine should end: the worker is shutting down or the slot
// was removed by a resize. Once it reported true, the slot ends.
func (s *slot) shouldExit() bool {
	s.w.mu.Lock()
	defer s.w.mu.Unlock()
	if s.w.phase != phaseRunning || s.removed {
		s.exiting = true
	}
	return s.exiting
}

// run is the slot loop: keep a ready process, consume while allowed, handle one delivery at a time.
func (s *slot) run(ctx context.Context) {
	var ch SlotChannel
	consumeAttempt := 0
	closeChannel := func() {
		if ch == nil {
			return
		}
		s.stopConsumer(ch)
		ch = nil
		s.set(func() { s.consuming = false })
	}
	defer func() {
		closeChannel()
		s.retireProcess(s.w.Stopping() || ctx.Err() != nil)
	}()
	for {
		if ctx.Err() != nil || s.shouldExit() {
			return
		}
		if s.proc == nil || !s.proc.Usable() {
			// Never hold a delivery while the slot respawns with backoff: cancel the consumer and give back
			// what arrived meanwhile first (docs/runtime.md §7.3, §7.5, §12).
			closeChannel()
		}
		if !s.ensureProcess() {
			continue
		}
		if !s.w.mayConsume(s) {
			closeChannel()
			sleepCtx(ctx, recheckInterval, s.w.changedCh())
			continue
		}
		if ch == nil {
			var err error
			ch, err = s.w.cfg.Broker.Consume(s.w.abortCtx, consumerTag(s.w.cfg.Boot.Worker.ID, s.index, s.consGen))
			s.consGen++
			if err != nil {
				ch = nil
				consumeAttempt++
				if amqpx.IsNotFound(err) {
					s.w.log.Warn("the scan queue does not exist; polling state", append(s.logger(), "err", err)...)
					if s.w.cfg.PollNow != nil {
						s.w.cfg.PollNow()
					}
				} else if s.w.abortCtx.Err() == nil {
					s.w.log.Warn("cannot consume the scan queue", append(s.logger(), "err", err)...)
				}
				d := time.Duration(rand.Float64() * float64(min(consumeInitial<<min(consumeAttempt-1, 10), consumeMax))) //nolint:gosec // backoff jitter
				sleepCtx(ctx, max(d, 100*time.Millisecond), s.w.changedCh())
				continue
			}
			consumeAttempt = 0
			s.set(func() { s.consuming = true })
			s.w.log.Info("consuming", s.logger()...)
		}
		changed := s.w.changedCh()
		select {
		case d, ok := <-ch.Deliveries():
			if !ok {
				closeChannel()
				continue
			}
			if keep := s.handle(ctx, ch, d); !keep {
				closeChannel()
			}
		case <-ch.Lost():
			s.w.log.Warn("slot channel lost", append(s.logger(), "reason", ch.LostReason())...)
			closeChannel()
		case <-changed:
		case <-ctx.Done():
			return
		}
	}
}

// stopConsumer cancels the consumer, gives back a delivery that arrived meanwhile and closes the channel.
func (s *slot) stopConsumer(ch SlotChannel) {
	select {
	case <-ch.Lost():
	default:
		if err := ch.Cancel(); err == nil {
			for d := range ch.Deliveries() {
				if err := ch.Nack(d.DeliveryTag); err != nil {
					s.w.log.Warn("cannot give back a delivery", append(s.logger(), "err", err)...)
				}
			}
		}
	}
	if err := ch.Close(); err != nil {
		s.w.log.Debug("closing the slot channel", append(s.logger(), "err", err)...)
	}
}

// delivery is one held delivery.
type delivery struct {
	ch          SlotChannel
	tag         uint64
	deliveredAt time.Time
	budget      time.Time // deadline of the holding budget (docs/runtime.md §8.10)
}

func (d *delivery) detached() bool {
	select {
	case <-d.ch.Lost():
		return true
	default:
		return false
	}
}

// handle processes one delivery and settles it. It reports whether the channel keeps consuming.
func (s *slot) handle(ctx context.Context, ch SlotChannel, msg amqp.Delivery) bool {
	consumerTimeout := time.Duration(s.w.cfg.Boot.AMQP.ConsumerTimeoutMs) * time.Millisecond
	d := &delivery{ch: ch, tag: msg.DeliveryTag, deliveredAt: time.Now()}
	d.budget = d.deliveredAt.Add(consumerTimeout - holdingMargin)
	disp, recycle := s.process(ctx, d, msg)
	// A process that became unusable while the plan ran (it exited or violated the protocol after its reply) is
	// replaced like a recycle, so the consumer is cancelled before the ack and no next delivery arrives.
	recycle = recycle || s.proc == nil || !s.proc.Usable()

	keep := !recycle && s.w.mayConsume(s) && !d.detached()
	if !keep && !d.detached() {
		// Stop receiving before settling: no message is ever held during a recycle (docs/runtime.md §7.3).
		if err := ch.Cancel(); err != nil {
			s.w.log.Warn("cannot cancel the consumer", append(s.logger(), "err", err)...)
		}
	}
	if !d.detached() {
		var err error
		switch disp {
		case dispAck:
			err = ch.Ack(d.tag)
		case dispNack:
			err = ch.Nack(d.tag)
		}
		if err != nil {
			s.w.log.Warn("cannot settle the delivery; it will be redelivered", append(s.logger(), "err", err)...)
		}
	} else if disp != dispNone {
		s.w.log.Warn("the delivery was detached; it is not settled", append(s.logger(), "reason", ch.LostReason())...)
	}
	if recycle {
		s.retireProcess(s.w.Stopping())
	}
	return keep
}

// process runs the path of one delivery (docs/runtime.md §8) and returns its disposition and whether
// the process must be replaced.
func (s *slot) process(ctx context.Context, d *delivery, msg amqp.Delivery) (disposition, bool) {
	boot := s.w.cfg.Boot
	parsed := parseAnalysis(msg.Body, boot.Worker.ScanID, boot.Scan.Settings.MaxAttempts)
	if parsed.malformed != "" {
		return s.malformed(ctx, d, parsed), false
	}
	m := parsed.msg
	log := append(s.logger(), "analysisId", m.AnalysisID, "seq", m.Seq, "round", m.Round, "attempt", m.Attempt)
	id := identity{
		ScanID: boot.Worker.ScanID, WorkerID: boot.Worker.ID, NodeID: boot.Worker.NodeID, Seq: m.Seq, Round: m.Round,
		Attempt: m.Attempt, Config: m.Config, ScheduledAt: m.ScheduledAt,
	}
	if limit := boot.Limits.MaxAnalysisConfigBytes; limit > 0 && compactSize(m.Config) > limit {
		id.ExecutionID = uuid.NewString()
		e := scerr.Newf(api.ErrorValidation, api.PhaseValidate, "analysis config is %d bytes; the maximum is %d", compactSize(m.Config), limit)
		return s.publishFinal(ctx, d, id, s.instant(m.ScheduledAt), nil, &e, nil, "", log), false
	}
	if msg.Redelivered {
		if alreadyFinal(s.w.status.Lookup(s.w.abortCtx, m.Seq), m.Round) {
			s.w.count(func(c *api.RuntimeCounters) { c.RedeliveredSkipped++ })
			s.w.log.Info("redelivered analysis is already final; skipped", log...)
			return dispAck, false
		}
	}
	if s.proc == nil || !s.proc.Usable() {
		// The process died while idle. Never hold a delivery during a respawn: give it back, stop
		// consuming and respawn (docs/runtime.md §7.3).
		s.w.log.Warn("connector process is gone; the delivery is given back", log...)
		return dispNack, true
	}
	for {
		disp, recycle, inline := s.runAttempt(ctx, d, id, log)
		if !inline {
			return disp, recycle
		}
		// The full scan queue refused the retry until it was due: the next attempt runs on the held delivery
		// (docs/runtime.md §8.11).
		id.Attempt++
		log = append(s.logger(), "analysisId", m.AnalysisID, "seq", m.Seq, "round", m.Round, "attempt", id.Attempt)
		if recycle || s.proc == nil || !s.proc.Usable() {
			if !s.replaceHeldProcess(d, log) {
				// recycle: stop consuming while the slot respawns with backoff (docs/runtime.md §7.3).
				return s.giveBackRefused(log), true
			}
		}
		s.w.log.Info("the scan queue is full; running the next attempt on the held delivery", log...)
	}
}

// replaceHeldProcess replaces the slot's process before an attempt that runs on a held delivery, within
// the delivery's holding budget. It reports false when no new process completed the handshake.
func (s *slot) replaceHeldProcess(d *delivery, log []any) bool {
	s.retireProcess(s.w.Stopping())
	ctx, cancel := s.budgetContext(d)
	defer cancel()
	if err := s.spawn(ctx); err != nil {
		if ctx.Err() == nil {
			s.w.health.SpawnFailed(err)
		}
		s.w.log.Warn("cannot start a connector process for the held delivery", append(log, "err", err)...)
		return false
	}
	return true
}

// runAttempt executes one attempt of the delivery's analysis and runs its publish plan (docs/runtime.md
// §8.3–§8.9, §8.11). inline reports that the retry was refused by the full scan queue until it was due and the next
// attempt is to run on the held delivery.
func (s *slot) runAttempt(ctx context.Context, d *delivery, id identity, log []any) (disp disposition, recycle, inline bool) {
	boot := s.w.cfg.Boot
	log = append(log, "pid", s.proc.PID())
	for len(s.ctl) > 0 { // controls meant for an earlier execution
		<-s.ctl
	}
	s.set(func() { s.executing = true })
	x := Execute(ctx, ExecSpec{
		Process: s.proc, ScanID: boot.Worker.ScanID, Seq: id.Seq, Round: id.Round, Attempt: id.Attempt,
		Config: id.Config, TaskConfig: boot.Scan.TaskConfig, Timeout: s.w.timeout, WorkRoot: s.w.cfg.WorkRoot,
		Limits: s.w.limits, Now: s.w.cfg.Now, Capture: s.capture, Control: s.ctl,
		Output: s.w.mirror.Sink(log...),
		OnStart: func(executionID string, startedAt time.Time) {
			s.set(func() {
				s.busy = &api.BusyAnalysis{Seq: id.Seq, Round: id.Round, Attempt: id.Attempt, ExecutionID: executionID, StartedAt: api.NewTime(startedAt)}
				s.busyStart = time.Now()
			})
		},
		OnProgress: func(p json.RawMessage) {
			s.set(func() {
				if s.busy != nil {
					s.busy.Progress = p
				}
			})
		},
	})
	s.set(func() { s.executing = false })
	defer func() {
		if err := x.Cleanup(); err != nil {
			s.w.log.Warn("cannot remove the execution directory", append(log, "err", err)...)
		}
		s.set(func() { s.busy = nil })
	}()
	s.handled++
	recycle = x.Recycle || (boot.Scan.Settings.MaxAnalysesPerProcess > 0 && s.handled >= boot.Scan.Settings.MaxAnalysesPerProcess)
	id.ExecutionID = x.ID
	log = append(log, "executionId", x.ID)

	switch {
	case s.w.discarding():
		s.w.log.Info("analysis aborted; nothing is published", log...)
		return dispNone, recycle, false
	case x.Aborted, x.Cancelled:
		s.w.log.Info("analysis given back", append(log, "cancelled", x.Cancelled)...)
		return dispNack, recycle, false
	case x.Error != nil && x.Error.Type == api.ErrorPlatform:
		s.w.health.Transient(x.Error.Phase, errors.New(x.Error.Message))
		return dispNack, recycle, false
	}

	if x.Succeeded() && len(x.Files) > 0 {
		budgetCtx, cancel := s.budgetContext(d)
		err := s.w.cfg.Uploader.Upload(budgetCtx, upload.Target{Seq: id.Seq, Round: id.Round, Attempt: id.Attempt, ExecutionID: x.ID}, x.Files)
		cancel()
		var se scerr.ScantorError
		switch {
		case err == nil:
		case errors.As(err, &se):
			se.Attempt, se.At = id.Attempt, s.w.cfg.Now()
			se = se.Truncate(s.w.limits.StackBytes)
			x.Error, x.Result = &se, nil
		case errors.Is(err, bootstrap.ErrUnauthorized):
			s.w.log.Warn("the orchestrator rejected the worker token; stopping", log...)
			s.w.Stop()
			return dispNone, recycle, false
		default:
			return s.giveUp(d, api.PhaseUpload, "uploading files", log), recycle, false
		}
	}

	if x.Error == nil {
		return s.publishFinal(ctx, d, id, timings(id, x), x.Result, nil, x.Files, s.capture.Tail(s.tailBytes()), log), recycle, false
	}
	e := *x.Error
	if s.w.policy.Retry(e, id.Attempt) {
		disp, inline = s.publishRetry(ctx, d, id, timings(id, x), e, log)
		return disp, recycle, inline
	}
	return s.publishFinal(ctx, d, id, timings(id, x), nil, &e, nil, s.capture.Tail(s.tailBytes()), log), recycle, false
}

func (s *slot) tailBytes() int { return max(s.w.cfg.Boot.Limits.LogTailBytes, 0) }

// instant returns the timings of a delivery that never ran.
func (s *slot) instant(scheduledAt int64) runtime.Timings {
	now := s.w.cfg.Now().UnixMilli()
	return runtime.Timings{ScheduledAt: scheduledAt, StartedAt: now, FinishedAt: now}
}

// malformed handles a delivery that cannot be attributed reliably (docs/runtime.md §8.1).
func (s *slot) malformed(ctx context.Context, d *delivery, p parsedDelivery) disposition {
	reason := "malformed analysis message: " + p.malformed
	if !p.attributable {
		s.w.log.Error("dropping an unattributable analysis message", append(s.logger(), "reason", p.malformed)...)
		if s.w.cfg.Report != nil {
			s.w.cfg.Report(ctx, false, scerr.New(api.ErrorValidation, api.PhaseValidate, reason), "")
		}
		return dispAck
	}
	m := p.msg
	log := append(s.logger(), "analysisId", m.AnalysisID, "seq", m.Seq, "round", m.Round, "reason", p.malformed)
	s.w.log.Error("malformed analysis message; recording it as failed", log...)
	id := identity{
		ScanID: s.w.cfg.Boot.Worker.ScanID, WorkerID: s.w.cfg.Boot.Worker.ID, NodeID: s.w.cfg.Boot.Worker.NodeID,
		Seq: m.Seq, Round: m.Round, Attempt: m.Attempt, ExecutionID: uuid.NewString(), Config: m.Config, ScheduledAt: m.ScheduledAt,
	}
	e := scerr.New(api.ErrorValidation, api.PhaseValidate, reason)
	return s.publishFinal(ctx, d, id, s.instant(m.ScheduledAt), nil, &e, nil, "", log)
}

// budgetContext bounds platform retries by the holding budget, the drain close margin, stop and abort.
func (s *slot) budgetContext(d *delivery) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithDeadline(s.w.pubCtx, d.budget)
	abort := s.w.abortSignal()
	go func() {
		select {
		case <-abort:
			cancel()
		case <-ctx.Done():
		}
	}()
	return ctx, cancel
}

// giveUp gives a delivery back when its plan could not be confirmed: the holding budget ran out (the
// worker becomes unhealthy, docs/runtime.md §8.10), the drain grace ended, or the worker stops (then
// nothing is settled).
func (s *slot) giveUp(d *delivery, phase api.ErrorPhase, what string, log []any) disposition {
	switch {
	case s.w.discarding():
		return dispNone
	case s.w.pubCtx.Err() != nil:
		s.w.log.Warn("drain grace expired; the analysis is given back", append(log, "while", what)...)
	default:
		s.w.log.Error("holding budget exhausted; the analysis is given back", append(log, "while", what)...)
		s.w.health.BudgetExhausted(phase, what)
	}
	return dispNack
}

// publishFinal publishes a final result: succeeded when e is nil, otherwise failed.
func (s *slot) publishFinal(ctx context.Context, d *delivery, id identity, t runtime.Timings, result json.RawMessage, e *scerr.ScantorError, files []upload.File, logTail string, log []any) disposition {
	boot := s.w.cfg.Boot
	if e != nil {
		v := *e
		v.Attempt = id.Attempt
		if v.At.IsZero() {
			v.At = s.w.cfg.Now()
		}
		v = v.Truncate(s.w.limits.StackBytes)
		e = &v
	}
	refs := make([]api.FileRef, 0, len(files))
	for _, f := range files {
		refs = append(refs, api.FileRef{ID: f.ID, Name: f.Name, Size: f.Size, SHA256: f.SHA256, ContentType: f.ContentType})
	}
	body, tooLarge := resultBody(id, t, result, e, refs, logTail, boot.Limits.MaxResultMessageBytes)
	if tooLarge != nil {
		v := *tooLarge
		v.Attempt, v.At = id.Attempt, s.w.cfg.Now()
		e = &v
		body, tooLarge = resultBody(id, t, nil, e, nil, "", boot.Limits.MaxResultMessageBytes)
		if tooLarge != nil {
			s.w.log.Error("cannot build a result message", append(log, "err", tooLarge.Message)...)
			return s.giveUp(d, api.PhasePublish, "building the result message", log)
		}
	}
	pub := amqpx.Publication{Exchange: boot.AMQP.ResultsExchange, RoutingKey: boot.AMQP.RoutingKey, Type: runtime.TypeResult, Body: body}
	switch s.publish(d, pub, false) {
	case pubDropped:
		return dispNone
	case pubGaveUp:
		return s.giveUp(d, api.PhasePublish, "publishing the result", log)
	}
	outcome := "succeeded"
	if e != nil {
		outcome = "failed"
		s.w.count(func(c *api.RuntimeCounters) { c.Failed++ })
		log = append(log, "errorType", e.Type, "error", e.Message)
	} else {
		s.w.count(func(c *api.RuntimeCounters) { c.Succeeded++ })
	}
	s.w.log.Info("analysis finished", append(log, "outcome", outcome, "durationMs", t.DurationMs)...)
	return dispAck
}

// publishRetry publishes the attempt event and the delayed republish (docs/runtime.md §8.9 retry plan).
// inline reports that the full scan queue refused the republish until the retry was due and the next attempt
// is to run on the held delivery.
func (s *slot) publishRetry(ctx context.Context, d *delivery, id identity, t runtime.Timings, e scerr.ScantorError, log []any) (disp disposition, inline bool) {
	boot := s.w.cfg.Boot
	e.Attempt = id.Attempt
	if e.At.IsZero() {
		e.At = s.w.cfg.Now()
	}
	e = e.Truncate(s.w.limits.StackBytes)
	body, err := attemptBody(id, t, e, s.capture.Tail(max(boot.Limits.LogTailEarlierBytes, 0)))
	if err != nil {
		s.w.log.Error("cannot build the attempt event", append(log, "err", err)...)
		return s.giveUp(d, api.PhasePublish, "building the attempt event", log), false
	}
	retry, err := retryBody(id)
	if err != nil {
		s.w.log.Error("cannot build the retry message", append(log, "err", err)...)
		return s.giveUp(d, api.PhasePublish, "building the retry message", log), false
	}
	attemptPub := amqpx.Publication{Exchange: boot.AMQP.ResultsExchange, RoutingKey: boot.AMQP.RoutingKey, Type: runtime.TypeAttempt, Body: body}
	switch s.publish(d, attemptPub, false) {
	case pubDropped:
		return dispNone, false
	case pubGaveUp:
		return s.giveUp(d, api.PhasePublish, "publishing the attempt event", log), false
	}
	s.w.count(func(c *api.RuntimeCounters) { c.Retried++ })
	delay := s.w.policy.Delay(e, id.Attempt)
	due := s.w.policy.DeliveryTime(s.w.cfg.Now(), delay)
	log = append(log, "errorType", e.Type, "error", e.Message, "nextAttempt", id.Attempt+1)
	result, at := s.republish(d, retry, due, log)
	switch result {
	case repConfirmed:
		s.w.log.Info("analysis finished", append(log, "outcome", "retrying", "deliveryTime", at.UTC().Format(time.RFC3339Nano), "durationMs", t.DurationMs)...)
		return dispAck, false
	case repInline:
		return dispNone, true
	case repDropped:
		s.w.log.Warn("the scan queue is gone; the retry was dropped", log...)
		if s.w.cfg.PollNow != nil {
			s.w.cfg.PollNow()
		}
		return dispNone, false
	case repRefused:
		return s.giveBackRefused(log), false
	default:
		return s.giveUp(d, api.PhasePublish, "publishing the retry", log), false
	}
}

// republishResult is the outcome of a retry republish.
type republishResult int

const (
	repConfirmed republishResult = iota
	repDropped                   // returned: the scan queue is gone
	repInline                    // refused by the full queue until due: run the next attempt on the held delivery
	repRefused                   // refused by the full queue and no attempt can run on the held delivery
	repGaveUp                    // budget exhausted, drain closed or stop after other failures
)

// republish publishes the retry of an analysis, due at `due`, until the broker confirms it
// (docs/runtime.md §8.11). A nack means the scan queue is full: x-max-length with reject-publish
// refuses future-dated messages too (docs/queue.md §3.3). That is backpressure, not a
// platform failure: the slot keeps the delivery and republishes every republishWait ± 20 % until the retry
// is due. Then the next attempt runs on the held delivery (repInline) while the holding budget still covers
// a whole attempt; otherwise the slot keeps republishing until the budget ends (repRefused). It returns the
// delivery time of the confirmed publish.
func (s *slot) republish(d *delivery, body []byte, due time.Time, log []any) (republishResult, time.Time) {
	boot := s.w.cfg.Boot
	ctx, cancel := s.budgetContext(d)
	defer cancel()
	refused := 0
	for attempt := 1; ; attempt++ {
		now := s.w.cfg.Now()
		at := due
		if floor := now.Add(scerr.MinRetryDelay); at.Before(floor) {
			at = floor
		}
		pub := amqpx.Publication{
			Exchange: boot.AMQP.AnalysesExchange, RoutingKey: boot.AMQP.RoutingKey, Type: runtime.TypeAnalysis, Body: body,
			Headers: amqp.Table{runtime.HeaderDeliveryTime: at.UnixMilli()},
		}
		outcome := s.w.cfg.Broker.Publish(ctx, pub)
		var wait time.Duration
		switch outcome {
		case amqpx.Confirmed:
			if refused > 0 {
				s.w.log.Info("the scan queue accepted the held retry", append(log, "refused", refused)...)
			}
			return repConfirmed, at
		case amqpx.Returned:
			return repDropped, at
		case amqpx.Nacked:
			refused++
			if refused == 1 {
				s.w.log.Info("the scan queue is full; holding the retry", append(log, "due", due.UTC().Format(time.RFC3339Nano))...)
			}
			if d.detached() || s.w.currentPhase() != phaseRunning || s.w.discarding() {
				// The broker took the delivery back (it runs again elsewhere), or a draining or stopping worker
				// runs no further attempt.
				return repRefused, at
			}
			if !s.w.cfg.Now().Before(due) && s.inlineAllowed(d) {
				return repInline, at
			}
			wait = time.Duration(float64(republishWait) * (0.8 + 0.4*rand.Float64())) //nolint:gosec // jitter
			if until := due.Sub(s.w.cfg.Now()); until > 0 && until < wait {
				wait = until // run the attempt as soon as it is due
			}
		case amqpx.Unconfirmed:
			if ctx.Err() == nil {
				s.w.health.Transient(api.PhasePublish, errors.New("the publish was not confirmed"))
			}
			wait = time.Duration(rand.Float64() * float64(min(time.Second<<min(attempt-1, 10), 30*time.Second))) //nolint:gosec // backoff jitter
		}
		if ctx.Err() == nil && outcome != amqpx.Nacked {
			s.w.log.Warn("publish failed; retrying", append(s.logger(), "type", pub.Type, "outcome", outcome.String(), "attempt", attempt)...)
		}
		if ctx.Err() != nil || (!sleepCtx(ctx, wait, nil) && ctx.Err() != nil) {
			if outcome == amqpx.Nacked {
				return repRefused, at
			}
			return repGaveUp, at
		}
	}
}

// inlineAllowed reports whether the next attempt may run on the held delivery: the worker runs, the delivery
// is still held and the holding budget still covers a whole attempt (settings.timeoutMs plus uploads.timeoutMs).
func (s *slot) inlineAllowed(d *delivery) bool {
	need := s.w.timeout + time.Duration(s.w.cfg.Boot.Uploads.TimeoutMs)*time.Millisecond
	return s.w.currentPhase() == phaseRunning && !s.w.discarding() && !d.detached() && time.Until(d.budget) >= need
}

// giveBackRefused gives back a delivery whose retry the full scan queue refused (docs/runtime.md §8.11):
// basic.nack with requeue, which is not counted toward the delivery limit. The worker stays healthy: a full
// queue is backpressure, not a worker problem. When the worker stops, nothing is settled.
func (s *slot) giveBackRefused(log []any) disposition {
	if s.w.discarding() {
		return dispNone
	}
	s.w.log.Warn("the scan queue refused the retry; the analysis is given back", log...)
	return dispNack
}

type pubResult int

const (
	pubConfirmed pubResult = iota
	pubDropped             // a returned republish: the scan queue is gone
	pubGaveUp              // budget exhausted, drain closed or stop
)

// publish publishes until the broker confirms, within the holding budget (docs/runtime.md §8.9).
func (s *slot) publish(d *delivery, pub amqpx.Publication, republish bool) pubResult {
	ctx, cancel := s.budgetContext(d)
	defer cancel()
	for attempt := 1; ; attempt++ {
		outcome := s.w.cfg.Broker.Publish(ctx, pub)
		switch outcome {
		case amqpx.Confirmed:
			return pubConfirmed
		case amqpx.Returned:
			if republish {
				return pubDropped
			}
			s.w.health.Transient(api.PhasePublish, errors.New("the result was returned as unroutable (ingest binding missing)"))
		case amqpx.Nacked:
			s.w.health.Transient(api.PhasePublish, errors.New("the broker nacked the publish"))
		case amqpx.Unconfirmed:
			if ctx.Err() == nil {
				s.w.health.Transient(api.PhasePublish, errors.New("the publish was not confirmed"))
			}
		}
		if ctx.Err() != nil {
			return pubGaveUp
		}
		s.w.log.Warn("publish failed; retrying", append(s.logger(), "type", pub.Type, "outcome", outcome.String(), "attempt", attempt)...)
		delay := time.Duration(rand.Float64() * float64(min(time.Second<<min(attempt-1, 10), 30*time.Second))) //nolint:gosec // backoff jitter
		if !sleepCtx(ctx, delay, nil) && ctx.Err() != nil {
			return pubGaveUp
		}
	}
}

func (s *slot) String() string { return fmt.Sprintf("slot %d", s.index) }
