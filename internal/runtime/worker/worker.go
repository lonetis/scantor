// Package worker wires worker mode (`scantor runtime worker`, docs/runtime.md §4, §5, §14): the
// transport check, bootstrap and its exit semantics, the work root, the inner dockerd of DinD workers,
// the AMQP connection with reconnects and the ACCESS_REFUSED kill switch, the role (runner or
// scheduler), the state-poll loop, signals and the exit code.
package worker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/protocol"
	"github.com/lonetis/scantor/internal/redact"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/amqpx"
	"github.com/lonetis/scantor/internal/runtime/bootstrap"
	"github.com/lonetis/scantor/internal/runtime/dind"
	"github.com/lonetis/scantor/internal/runtime/pool"
	"github.com/lonetis/scantor/internal/runtime/runner"
	"github.com/lonetis/scantor/internal/runtime/scerr"
	"github.com/lonetis/scantor/internal/runtime/scheduler"
	"github.com/lonetis/scantor/internal/runtime/upload"
	"github.com/lonetis/scantor/internal/templates"
	"github.com/lonetis/scantor/internal/templates/fetch"
	"github.com/lonetis/scantor/internal/version"
)

// Exit codes of worker mode (docs/runtime.md §14.3).
const (
	ExitOK    = 0
	ExitFatal = 1
)

// Timers of worker mode (docs/runtime.md §6.6, §17).
const (
	accessRefusedLimit = 60 * time.Second
	finalPollTimeout   = 5 * time.Second
	connectInitial     = time.Second
	connectMax         = 30 * time.Second
)

// Options configure Run.
type Options struct {
	Config runtime.Config
	// Signals delivers SIGTERM and SIGINT (docker-init forwards them).
	Signals <-chan os.Signal
	// Stderr receives the JSON log.
	Stderr io.Writer
	// TaskDir is the working directory of connector processes (runtime.TaskDir when empty; tests).
	TaskDir string
	// Unsetenv removes the worker token from the process environment (os.Unsetenv when nil).
	Unsetenv func(string) error
}

// Run runs worker mode until the worker ends and returns the exit code.
func Run(ctx context.Context, opts Options) int {
	cfg := opts.Config
	stderr := opts.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}
	log := redact.NewLogger(stderr, redact.FormatJSON, slog.LevelInfo).With("component", "runtime", "version", version.Version)
	if err := cfg.RequireWorker(); err != nil {
		log.Error("invalid runtime environment", "err", err)
		return ExitFatal
	}
	unsetenv := opts.Unsetenv
	if unsetenv == nil {
		unsetenv = os.Unsetenv
	}
	if err := unsetenv(runtime.EnvWorkerToken); err != nil {
		log.Warn("cannot remove the worker token from the environment", "err", err)
	}
	policy := api.Policy{CACertPEM: cfg.CACert, AllowInsecure: cfg.AllowInsecure, EnforcePlaintext: true}
	if err := policy.CheckTransport(ctx, cfg.URL); err != nil {
		log.Error("the orchestrator URL is refused by the transport policy", "err", err)
		return ExitFatal
	}
	client, err := api.New(api.Options{BaseURL: cfg.URL, Credential: api.Credential{Kind: api.PrincipalWorker, Token: cfg.WorkerToken}, Policy: policy})
	if err != nil {
		log.Error("invalid worker configuration", "err", err)
		return ExitFatal
	}
	w := &worker{cfg: cfg, opts: opts, log: log, policy: policy, api: bootstrap.NewClient(client, bootstrap.NewClock(), log)}
	return w.run(ctx)
}

type worker struct {
	cfg    runtime.Config
	opts   Options
	log    *slog.Logger
	policy api.Policy
	api    *bootstrap.Client
	boot   *api.Bootstrap
	poller *bootstrap.Poller
	conn   *amqpx.Conn
	daemon *dind.Daemon

	// The role, set once before it starts. The AMQP callbacks run on the connection goroutine, which starts
	// earlier, so every access is atomic; stopped records a stop that came before the role existed.
	runner  atomic.Pointer[runner.Worker]
	sched   atomic.Pointer[scheduler.Scheduler]
	stopped atomic.Bool
	// handoff ends the start-up signal handling (earlySignals).
	handoff func()

	mu       sync.Mutex
	exitCode int
}

// earlySignals cancels the start-up (bootstrap, inner dockerd, AMQP connect, connector start) when
// SIGTERM or SIGINT arrives before the role handles signals itself: nothing was taken from the queue
// yet, so the worker simply exits 0. handoff stops it; afterwards the role's watch loop owns the signals.
func (w *worker) earlySignals(cancel context.CancelFunc) (handoff func()) {
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		select {
		case sig := <-w.opts.Signals:
			w.log.Info("signal received during start-up; exiting", "signal", sig.String())
			cancel()
		case <-stop:
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(stop)
			<-done
		})
	}
}

func (w *worker) run(parent context.Context) int {
	ctx, cancelStart := context.WithCancel(parent)
	defer cancelStart()
	w.handoff = w.earlySignals(cancelStart)
	defer w.handoff()
	boot, err := w.api.Bootstrap(ctx)
	switch {
	case errors.Is(err, bootstrap.ErrUnauthorized):
		w.log.Info("the worker is no longer active (401); exiting")
		return ExitOK
	case errors.Is(err, bootstrap.ErrIncompatible):
		w.log.Error("the orchestrator does not accept this runtime version", "err", err)
		return ExitFatal
	case ctx.Err() != nil:
		return ExitOK
	case err != nil:
		w.log.Error("bootstrap failed", "err", err)
		return ExitFatal
	}
	if boot.Action == api.ActionStop {
		w.log.Info("the scan is not running; exiting")
		return ExitOK
	}
	w.boot = boot
	w.log = w.log.With("role", boot.Worker.Role, "scanId", boot.Worker.ScanID, "workerId", boot.Worker.ID, "nodeId", boot.Worker.NodeID)
	w.log.Info("bootstrapped", "revision", boot.Revision.Number, "processes", boot.Scan.Settings.Processes, "clockOffsetMs", w.api.Clock().Offset().Milliseconds())

	if err := w.prepareWorkRoot(); err != nil {
		w.fatal(ctx, scerr.Newf(api.ErrorPlatform, api.PhaseBootstrap, "cannot prepare the work root %s: %v", w.cfg.WorkRoot, err), "")
		return ExitFatal
	}
	if w.cfg.DinD {
		if code, ok := w.startDockerd(ctx); !ok {
			return code
		}
		defer w.daemon.Stop()
	}
	if code, ok := w.connect(ctx); !ok {
		return code
	}
	defer w.conn.Close()
	publisher := amqpx.NewPublisher(w.conn, boot.AMQP.Username, version.UserAgent("scantor-runtime"), w.log)
	defer publisher.Close()

	w.poller = &bootstrap.Poller{
		Client: w.api, Interval: time.Duration(boot.Intervals.StatePollMs) * time.Millisecond, Jitter: boot.Intervals.StatePollJitter,
		Build: w.stateRequest, Handle: w.handleState, Logger: w.log,
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var aux sync.WaitGroup
	defer aux.Wait()
	defer cancel()
	aux.Go(func() { w.conn.Run(runCtx) })

	var code int
	switch boot.Worker.Role {
	case api.RoleScheduler:
		code = w.runScheduler(runCtx, publisher, &aux)
	case api.RoleRunner:
		code = w.runRunner(runCtx, publisher, &aux)
	default:
		w.fatal(ctx, scerr.Newf(api.ErrorPlatform, api.PhaseBootstrap, "unknown worker role %q", boot.Worker.Role), "")
		return ExitFatal
	}
	w.finalPoll(ctx)
	w.log.Info("worker exits", "exitCode", code)
	return code
}

// prepareWorkRoot creates /tmp/scantor (0700) and removes leftovers of a previous container start.
func (w *worker) prepareWorkRoot() error {
	if filepath.Base(w.cfg.WorkRoot) != "scantor" {
		return fmt.Errorf("unexpected work root %s", w.cfg.WorkRoot)
	}
	if err := os.RemoveAll(w.cfg.WorkRoot); err != nil {
		return err
	}
	return os.MkdirAll(w.cfg.WorkRoot, 0o700)
}

// startDockerd starts the inner dockerd of a DinD worker (docs/runtime.md §4.4).
func (w *worker) startDockerd(ctx context.Context) (int, bool) {
	// dockerd is no connector process, but it gets no platform credentials either.
	d, err := dind.Start(ctx, dind.Options{Environ: pool.WithoutRuntimeOnly(w.cfg.Environ), Logger: w.log})
	var re *dind.ReadyError
	switch {
	case err == nil:
		w.daemon = d
		w.log.Info("the inner dockerd is ready")
		return 0, true
	case errors.Is(err, dind.ErrMissing):
		w.fatal(ctx, scerr.New(api.ErrorValidation, api.PhaseBootstrap, err.Error()), "")
	case errors.As(err, &re):
		w.fatal(ctx, scerr.New(api.ErrorPlatform, api.PhaseBootstrap, re.Message), re.Tail)
	case ctx.Err() != nil:
		return ExitOK, false
	default:
		w.fatal(ctx, scerr.Newf(api.ErrorPlatform, api.PhaseBootstrap, "cannot start dockerd: %v", err), "")
	}
	return ExitFatal, false
}

// connect opens the AMQP connection (docs/runtime.md §6.1): a refused transport is fatal, ACCESS_REFUSED
// polls state (stop → exit 0) and gives up after 60 s, other failures are retried 1 s → 30 s.
func (w *worker) connect(ctx context.Context) (int, bool) {
	a := w.boot.AMQP
	if err := w.policy.CheckTransport(ctx, a.URL); err != nil {
		w.fatal(ctx, scerr.Newf(api.ErrorPlatform, api.PhaseBootstrap, "the AMQP URL is refused by the transport policy: %v", err), "")
		return ExitFatal, false
	}
	cfg := amqpx.Config{
		URL: a.URL, VHost: a.VHost, Username: a.Username, Password: a.Password,
		Heartbeat:      time.Duration(a.HeartbeatSeconds) * time.Second,
		ConnectionName: "scantor-runtime/" + w.boot.Worker.Role + "/" + w.boot.Worker.ID,
		Policy:         w.policy, Logger: w.log,
		OnAccessRefused: w.accessRefused,
		OnReconnect:     w.reconnected,
	}
	var refusedSince time.Time
	for attempt := 1; ; attempt++ {
		conn, err := amqpx.Dial(ctx, cfg)
		if err == nil {
			w.conn = conn
			w.log.Info("connected to the broker")
			return 0, true
		}
		switch {
		case errors.Is(err, api.ErrPlaintextRefused):
			w.fatal(ctx, scerr.Newf(api.ErrorPlatform, api.PhaseBootstrap, "the AMQP connection is refused by the transport policy: %v", err), "")
			return ExitFatal, false
		case amqpx.IsAccessRefused(err):
			if refusedSince.IsZero() {
				refusedSince = time.Now()
			}
			w.log.Warn("the broker refused the scan's credentials; polling state", "err", err)
			if resp, perr := w.api.State(ctx, api.RuntimeStateRequest{}); errors.Is(perr, bootstrap.ErrUnauthorized) || (perr == nil && resp.Action != api.ActionRun) {
				return ExitOK, false
			}
			if time.Since(refusedSince) >= accessRefusedLimit {
				w.log.Warn("the broker refused the scan's credentials for 60 s; exiting")
				return ExitOK, false
			}
		default:
			refusedSince = time.Time{}
			w.log.Warn("cannot connect to the broker; retrying", "err", err, "attempt", attempt)
		}
		delay := min(connectInitial<<min(attempt-1, 10), connectMax)
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return ExitOK, false
		}
	}
}

// accessRefused handles reconnects refused with ACCESS_REFUSED (docs/runtime.md §6.6 step 4).
func (w *worker) accessRefused(streak time.Duration) {
	if r := w.runner.Load(); r != nil {
		r.Abort()
	}
	if w.poller != nil {
		w.poller.PollNow()
	}
	if streak >= accessRefusedLimit {
		w.log.Warn("the broker refused the scan's credentials for 60 s; stopping")
		w.stop()
	}
}

func (w *worker) reconnected() {
	if r := w.runner.Load(); r != nil {
		r.Resume()
	}
}

// stop ends the worker with exit 0 (state `stop`, 401, persistent ACCESS_REFUSED). A role that does not
// exist yet stops as soon as it is set (setRunner, setScheduler).
func (w *worker) stop() {
	w.stopped.Store(true)
	if r := w.runner.Load(); r != nil {
		r.Stop()
	}
	if s := w.sched.Load(); s != nil {
		s.Stop()
	}
}

func (w *worker) setRunner(r *runner.Worker) {
	w.runner.Store(r)
	if w.stopped.Load() {
		r.Stop()
	}
}

func (w *worker) setScheduler(s *scheduler.Scheduler) {
	w.sched.Store(s)
	if w.stopped.Load() {
		s.Stop()
	}
}

func (w *worker) drain(now bool) {
	r, s := w.runner.Load(), w.sched.Load()
	switch {
	case r != nil && now:
		r.DrainNow()
	case r != nil:
		r.Drain()
	case s != nil && now:
		s.DrainNow()
	case s != nil:
		s.Drain()
	}
}

// handleState applies a state-poll response (docs/runtime.md §5.1).
func (w *worker) handleState(resp *api.RuntimeStateResponse) {
	switch resp.Action {
	case api.ActionStop:
		w.stop()
	case api.ActionDrain:
		w.drain(false)
	case api.ActionRun:
		if r := w.runner.Load(); r != nil && resp.Processes > 0 {
			r.Resize(resp.Processes)
		}
	}
}

// stateRequest builds a state poll (docs/runtime.md §5.1).
func (w *worker) stateRequest() api.RuntimeStateRequest {
	req := api.RuntimeStateRequest{ClockOffsetMs: w.api.Clock().Offset().Milliseconds(), Busy: []api.BusyAnalysis{}}
	if free, err := freeSpace(w.cfg.WorkRoot); err == nil {
		req.TmpFreeBytes = free
	}
	if r := w.runner.Load(); r != nil {
		req.Processes, req.Busy, req.Consuming, req.Counters = r.State()
	} else if s := w.sched.Load(); s != nil {
		procs, progress := s.State()
		req.Processes, req.Scheduler = procs, &progress
	}
	return req
}

func (w *worker) finalPoll(ctx context.Context) {
	if w.poller == nil {
		return
	}
	pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), finalPollTimeout)
	defer cancel()
	if _, err := w.api.State(pctx, w.stateRequest()); err != nil {
		w.log.Debug("final state poll failed", "err", err)
	}
}

// fatal reports a fatal error (POST /api/runtime/errors, fatal: true) before exit 1.
func (w *worker) fatal(ctx context.Context, e scerr.ScantorError, stderrTail string) {
	w.log.Error("fatal error", "type", e.Type, "phase", e.Phase, "error", e.Message)
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	w.api.ReportError(rctx, true, e, stderrTail)
}

// watch handles signals (SIGTERM drains, a second SIGTERM or SIGINT skips to the grace deadline) and the
// end of the inner dockerd until done is closed.
func (w *worker) watch(ctx context.Context, done <-chan struct{}) {
	var dockerd <-chan struct{}
	if w.daemon != nil {
		dockerd = w.daemon.Exited()
	}
	terms := 0
	for {
		select {
		case sig := <-w.opts.Signals:
			terms++
			if sig == syscall.SIGINT || terms > 1 {
				w.log.Info("signal received; ending the drain now", "signal", sig.String())
				w.drain(true)
			} else {
				w.log.Info("signal received; draining", "signal", sig.String())
				w.drain(false)
			}
		case <-dockerd:
			dockerd = nil
			w.fatal(ctx, scerr.Newf(api.ErrorPlatform, api.PhasePlatform, "dockerd exited with %s", w.daemon.ExitText()), w.daemon.Tail())
			w.setExit(ExitFatal)
			w.drain(false)
		case <-done:
			return
		case <-ctx.Done():
			return
		}
	}
}

func (w *worker) setExit(code int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.exitCode = max(w.exitCode, code)
}

func (w *worker) exit() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.exitCode
}

func (w *worker) launcher() pool.Launcher {
	dir := w.opts.TaskDir
	if dir == "" {
		dir = runtime.TaskDir
	}
	b := w.boot
	return pool.Launcher{
		Command: w.cfg.ConnectorCmd, Entry: b.Revision.Entry, Environ: w.cfg.Environ, Dir: dir, WorkRoot: w.cfg.WorkRoot,
		Mode: protocol.ModeWorker, RuntimeVersion: version.Version, Logger: w.log,
		Limits: protocol.Limits{
			MaxResultBytes: b.Limits.MaxResultBytes, MaxAnalysisConfigBytes: b.Limits.MaxAnalysisConfigBytes,
			MaxFileBytes: b.Uploads.MaxFileBytes, MaxFilesPerAnalysis: b.Uploads.MaxFilesPerAnalysis,
		},
	}
}

// reportSpawnFailure reports a connector that never started (docs/runtime.md §7.5).
func (w *worker) reportSpawnFailure(ctx context.Context, err error) {
	e := scerr.Newf(api.ErrorPlatform, api.PhaseBootstrap, "%v", err)
	tail := ""
	var se *pool.SpawnError
	if errors.As(err, &se) {
		tail = se.StderrTail
		switch {
		case se.Connector != nil:
			typ := api.ErrorTaskError
			if se.Connector.Type == protocol.ErrorValidation {
				typ = api.ErrorValidation
			}
			e = scerr.New(typ, api.PhaseBootstrap, se.Connector.Message)
			e.Stack = se.Connector.Stack
		case se.Unsupported:
			e = scerr.New(api.ErrorValidation, api.PhaseBootstrap, se.Reason)
		}
	}
	w.fatal(ctx, e, tail)
}

func (w *worker) runRunner(ctx context.Context, publisher *amqpx.Publisher, aux *sync.WaitGroup) int {
	if err := w.cfg.RequireConnector(); err != nil {
		w.fatal(ctx, scerr.New(api.ErrorValidation, api.PhaseBootstrap, err.Error()), "")
		return ExitFatal
	}
	b := w.boot
	uploader := &upload.Uploader{
		Presigner: w.api, HTTP: w.api.HTTPClient(), Policy: w.policy,
		Timeout: time.Duration(b.Uploads.TimeoutMs) * time.Millisecond, Now: w.api.Clock().Now, Logger: w.log,
	}
	r := runner.New(runner.Config{
		Boot: b, WorkRoot: w.cfg.WorkRoot, Spawner: w.launcher(),
		Broker:   runner.AMQPBroker{Conn: w.conn, Publisher: publisher, Queue: b.AMQP.Queue},
		Uploader: uploader, Status: w.api.AnalysesStatus, Now: w.api.Clock().Now, PollNow: func() { w.poller.PollNow() },
		Report: func(ctx context.Context, fatal bool, e scerr.ScantorError, tail string) {
			w.api.ReportError(ctx, fatal, e, tail)
		},
		FreeSpace: func() (int64, error) { return freeSpace(w.cfg.WorkRoot) },
		Probe:     w.poller.Poll,
		Logger:    w.log,
	})
	uploader.OnTransient = func(err error) { r.Health().Transient(api.PhaseUpload, err) }
	w.setRunner(r)
	if err := r.Start(ctx); err != nil {
		var se *runner.StartError
		if errors.As(err, &se) && ctx.Err() == nil {
			w.reportSpawnFailure(ctx, se.Err)
			return ExitFatal
		}
		return ExitOK
	}
	// From here the watch loop handles signals; a signal that arrived meanwhile cancelled ctx, which ends
	// Run before any slot consumes.
	w.handoff()
	done := make(chan struct{})
	aux.Go(func() { w.poller.Run(ctx) })
	aux.Go(func() { w.watch(ctx, done) })
	r.Run(ctx)
	close(done)
	return w.exit()
}

func (w *worker) runScheduler(ctx context.Context, publisher *amqpx.Publisher, aux *sync.WaitGroup) int {
	b := w.boot
	if b.Revision.Schedule.Kind == api.ScheduleKindCustom {
		if err := w.cfg.RequireConnector(); err != nil {
			w.fatal(ctx, scerr.New(api.ErrorValidation, api.PhaseBootstrap, err.Error()), "")
			return ExitFatal
		}
	}
	env, err := templateEnv(b, w.cfg, w.policy)
	if err != nil {
		w.fatal(ctx, scerr.Newf(api.ErrorPlatform, api.PhaseBootstrap, "%v", err), "")
		return ExitFatal
	}
	s := scheduler.New(scheduler.Config{
		Boot: b, Publisher: publisher, Depth: amqpx.Queue{Conn: w.conn, Name: b.AMQP.Queue}, API: w.api, Spawner: w.launcher(), Env: env, Now: w.api.Clock().Now,
		PollNow: func() { w.poller.PollNow() }, WorkRoot: w.cfg.WorkRoot, Logger: w.log,
	})
	w.setScheduler(s)
	// The scheduler handles signals as a drain from its start-up on (the watch loop).
	w.handoff()
	done := make(chan struct{})
	aux.Go(func() { w.poller.Run(ctx) })
	aux.Go(func() { w.watch(ctx, done) })
	err = s.Run(ctx)
	close(done)
	if err != nil {
		if ctx.Err() != nil {
			return ExitOK
		}
		var se *scheduler.StartError
		if errors.As(err, &se) {
			w.reportSpawnFailure(ctx, se.Err)
		}
		return ExitFatal
	}
	return w.exit()
}

// templateEnv builds the template environment of a scheduler from bootstrap. Downloads of uploaded lists follow
// the platform transport rule (withUploadRule).
func templateEnv(b *api.Bootstrap, cfg runtime.Config, policy api.Policy) (templates.Env, error) {
	httpClient, err := fetch.NewHTTPClient(cfg.CACert)
	if err != nil {
		return templates.Env{}, err
	}
	tmp := filepath.Join(cfg.WorkRoot, "templates")
	if err := os.MkdirAll(tmp, 0o700); err != nil {
		return templates.Env{}, err
	}
	env := templates.Env{DataSources: map[string]string{}, Uploads: map[string]templates.Upload{}, HTTP: httpClient, TmpDir: tmp}
	if s := b.Scheduler; s != nil {
		env.DataSources[templates.DataSourceTranco] = s.DataSources.Tranco
		env.DataSources[templates.DataSourceCrux] = s.DataSources.Crux
		urls := make([]string, 0, len(s.Uploads))
		for id, u := range s.Uploads {
			env.Uploads[id] = templates.Upload{URL: u.URL, SHA256: u.SHA256, Bytes: u.Bytes}
			urls = append(urls, u.URL)
		}
		httpClient.Transport = withUploadRule(httpClient.Transport, policy, urls)
	}
	return env, nil
}
