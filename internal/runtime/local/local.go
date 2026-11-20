package local

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/protocol"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/health"
	"github.com/lonetis/scantor/internal/runtime/logtail"
	"github.com/lonetis/scantor/internal/runtime/pool"
	"github.com/lonetis/scantor/internal/runtime/runner"
	"github.com/lonetis/scantor/internal/runtime/scerr"
	"github.com/lonetis/scantor/internal/runtime/scheduler"
	"github.com/lonetis/scantor/internal/runtime/upload"
	"github.com/lonetis/scantor/internal/templates"
	"github.com/lonetis/scantor/internal/templates/fetch"
	"github.com/lonetis/scantor/internal/version"
)

// Exit codes of local mode (docs/runtime.md §15.4); the highest applicable code wins.
const (
	ExitOK         = 0
	ExitFailures   = 1
	ExitValidation = 2
	ExitPlatform   = 3
)

// Local-mode constants (docs/runtime.md §15.2, §15.3, §15.6, §17).
const (
	// MaxDelay caps every retry delay so the dev loop stays fast (unless Options.UncappedRetryDelay).
	MaxDelay = 2 * time.Second
	// MaxLogBytes bounds the log events of one analysis.
	MaxLogBytes = 1 << 20
	// logTruncated is the line emitted when MaxLogBytes is reached.
	logTruncated = "[log output truncated]"
	// maxSpawnFailures consecutive failed spawns across the lanes of a streaming run abort it (startFailed).
	maxSpawnFailures = 3
)

// The wait of a streaming lane after a failed spawn: the initial delay, doubled after each further failure
// of the lane up to the maximum (variables for tests).
var (
	spawnBackoffInitial = time.Second
	spawnBackoffMax     = 60 * time.Second
)

// Options configure Run. Without Events, Stream, UncappedRetryDelay, FileOwner and Stop a run behaves as dev
// runs and test runs need it (docs/runtime.md §15.2); bundle mode sets them (§15.6, §15.7).
type Options struct {
	Spec   *Spec
	Config runtime.Config
	// Stdout receives the NDJSON events (unless Events is set); Stderr the runtime's own diagnostics.
	Stdout io.Writer
	Stderr io.Writer
	// Signals delivers SIGTERM and SIGINT.
	Signals <-chan os.Signal
	// TaskDir is the working directory of connector processes (runtime.TaskDir when empty; tests).
	TaskDir string
	// Events receives the events instead of an NDJSON Emitter on Stdout.
	Events Sink
	// Stream runs the analyses while the schedule produces them, through a queue of 2 × processes items,
	// instead of collecting the schedule first; Spec.Limit 0 then means no limit (docs/runtime.md §15.6).
	Stream bool
	// UncappedRetryDelay applies the backoff of the settings as scans do, without the cap of MaxDelay.
	UncappedRetryDelay bool
	// FileOwner owns outDir/files and every directory and file the run writes below it (best effort).
	FileOwner *FileOwner
	// Stop aborts the run with reason outputFailed (exit 3) when it is closed.
	Stop <-chan struct{}
}

// FileOwner is the numeric owner of the files a run writes.
type FileOwner struct {
	UID, GID int
}

// item is one analysis to run.
type item struct {
	seq         int64
	config      json.RawMessage
	scheduledAt time.Time
}

type run struct {
	opts   Options
	spec   *Spec
	cfg    runtime.Config
	events Sink
	log    *slog.Logger
	policy scerr.Policy
	limits runner.Limits

	launcher pool.Launcher
	env      templates.Env

	mu        sync.Mutex
	exitCode  int
	summary   Summary
	abortWhy  string // the end reason once aborted (timeout, interrupted, startFailed, outputFailed)
	abortCh   chan struct{}
	executing map[*lane]bool
	// spawnFails counts the consecutive failed spawns of a streaming run across its lanes.
	spawnFails int
}

// Run runs local mode and returns the exit code; it always ends with an `end` event.
func Run(ctx context.Context, opts Options) int {
	stderr := opts.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}
	events := opts.Events
	if events == nil {
		events = NewEmitter(opts.Stdout)
	}
	r := &run{
		opts: opts, spec: opts.Spec, cfg: opts.Config, events: events,
		log:     slog.New(slog.NewTextHandler(stderr, &slog.HandlerOptions{Level: slog.LevelInfo})).With("component", "runtime"),
		abortCh: make(chan struct{}), executing: map[*lane]bool{},
	}
	return r.run(ctx)
}

func (r *run) raise(code int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.exitCode = max(r.exitCode, code)
}

func (r *run) end(reason string) int {
	r.mu.Lock()
	code, summary := r.exitCode, r.summary
	r.mu.Unlock()
	r.events.Emit(EndEvent{Type: EventEnd, At: at(time.Now()), Reason: reason, Summary: summary, ExitCode: code})
	if err := r.events.Err(); err != nil {
		r.log.Error("cannot write the output events", "err", err)
		return ExitPlatform
	}
	return code
}

func (r *run) errorEvent(e scerr.ScantorError) {
	if e.At.IsZero() {
		e.At = time.Now()
	}
	e = e.Truncate(scerr.MaxStackBytes)
	r.events.Emit(ErrorEvent{Type: EventError, At: at(time.Now()), Error: e.API()})
}

// fail emits an error event outside analyses and raises the exit code (validation → 2).
func (r *run) fail(e scerr.ScantorError, code int) {
	r.errorEvent(e)
	if e.Type == api.ErrorValidation {
		code = max(code, ExitValidation)
	}
	r.raise(code)
}

func (r *run) aborted() (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.abortWhy, r.abortWhy != ""
}

// abort ends the run on the total timeout, a signal, Options.Stop or repeated spawn failures of a streaming
// run: every process group is killed (no cancel) and in-flight analyses end failed with type cancelled
// (docs/runtime.md §15.2).
func (r *run) abort(reason string) {
	r.mu.Lock()
	if r.abortWhy != "" {
		r.mu.Unlock()
		return
	}
	r.abortWhy = reason
	close(r.abortCh)
	lanes := make([]*lane, 0, len(r.executing))
	for l := range r.executing {
		lanes = append(lanes, l)
	}
	r.mu.Unlock()
	r.log.Warn("aborting the local run", "reason", reason)
	r.raise(ExitPlatform)
	for _, l := range lanes {
		select {
		case l.ctl <- runner.Control{Kill: true}:
		default:
		}
	}
}

func (r *run) run(ctx context.Context) int {
	s := r.spec
	maxDelay := MaxDelay
	if r.opts.UncappedRetryDelay {
		maxDelay = 0
	}
	r.policy = scerr.Policy{Backoff: s.Backoff, MaxAttempts: s.MaxAttempts, MaxDelay: maxDelay}
	r.limits = runner.Limits{MaxResultBytes: s.Limits.MaxResultBytes, MaxFileBytes: s.Limits.MaxFileBytes, MaxFilesPerAnalysis: s.Limits.MaxFilesPerAnalysis, StackBytes: scerr.MaxStackBytes}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go r.watch(ctx)

	if err := r.prepare(); err != nil {
		r.fail(scerr.Newf(api.ErrorPlatform, api.PhaseBootstrap, "%v", err), ExitPlatform)
		return r.end(ReasonStartFailed)
	}
	// Local mode has no state poll; the container healthcheck follows a heartbeat tick (docs/runtime.md §5.3).
	beater := &health.Beater{Path: health.Path(r.cfg.WorkRoot), Mode: "local", Logger: r.log}
	beatCtx, stopBeats := context.WithCancel(ctx)
	var beats sync.WaitGroup
	beats.Go(func() { beater.Run(beatCtx, health.LocalInterval) })
	defer beats.Wait()
	defer stopBeats()
	closeUploads, err := r.serveUploads()
	if err != nil {
		r.fail(scerr.Newf(api.ErrorPlatform, api.PhaseBootstrap, "%v", err), ExitPlatform)
		return r.end(ReasonStartFailed)
	}
	defer closeUploads()

	first, err := r.launcher.Spawn(ctx, 0, 0, r.unattributed())
	if err != nil {
		r.spawnFailed(err)
		return r.end(ReasonStartFailed)
	}
	desc, err := describe(first)
	if err != nil {
		first.Kill()
		<-first.Done()
		r.fail(scerr.Newf(api.ErrorValidation, api.PhaseBootstrap, "describe failed: %v", err), ExitValidation)
		return r.end(ReasonStartFailed)
	}
	r.start(first, desc)

	if r.opts.Stream {
		reason := r.stream(ctx, first, desc.Schedule)
		if why, ok := r.aborted(); ok {
			return r.end(why)
		}
		return r.end(reason)
	}
	items, reason := r.collect(ctx, first, desc.Schedule)
	if why, ok := r.aborted(); ok {
		first.Kill()
		return r.end(why)
	}
	r.runItems(ctx, items, first)
	if why, ok := r.aborted(); ok {
		return r.end(why)
	}
	return r.end(reason)
}

// watch aborts on the total timeout (disabled in debug mode), a signal or Options.Stop.
func (r *run) watch(ctx context.Context) {
	var timeout <-chan time.Time
	if r.spec.TotalTimeoutMs > 0 && !r.spec.Debug {
		t := time.NewTimer(time.Duration(r.spec.TotalTimeoutMs) * time.Millisecond)
		defer t.Stop()
		timeout = t.C
	}
	select {
	case <-timeout:
		r.abort(ReasonTimeout)
	case sig := <-r.opts.Signals:
		r.log.Info("signal received", "signal", fmt.Sprint(sig))
		r.abort(ReasonInterrupted)
	case <-r.opts.Stop:
		r.abort(ReasonOutputFailed)
	case <-ctx.Done():
	}
}

// prepare checks the output directory and builds the launcher and the template environment.
func (r *run) prepare() error {
	s, cfg := r.spec, r.cfg
	if err := os.MkdirAll(filepath.Join(s.OutDir, "files"), 0o755); err != nil { //nolint:gosec // the consumer copies outDir out
		return fmt.Errorf("the output directory %s is not writable: %w", s.OutDir, err)
	}
	r.chown(filepath.Join(s.OutDir, "files"))
	probe, err := os.CreateTemp(s.OutDir, ".probe-*")
	if err != nil {
		return fmt.Errorf("the output directory %s is not writable: %w", s.OutDir, err)
	}
	_ = probe.Close()
	_ = os.Remove(probe.Name())
	if err := os.MkdirAll(cfg.WorkRoot, 0o700); err != nil {
		return fmt.Errorf("cannot create the work root %s: %w", cfg.WorkRoot, err)
	}
	command := cfg.ConnectorCmd
	if s.Debug {
		command = cfg.DebugCmd
		if command == "" {
			return errors.New(runtime.EnvDebugCmd + " is not set in the image; debugging needs a scantor base image")
		}
	} else if err := cfg.RequireConnector(); err != nil {
		return err
	}
	dir := r.opts.TaskDir
	if dir == "" {
		dir = runtime.TaskDir
	}
	r.launcher = pool.Launcher{
		Command: command, Entry: s.Entry, Environ: cfg.Environ, Dir: dir, WorkRoot: cfg.WorkRoot, Mode: protocol.ModeLocal,
		RuntimeVersion: version.Version, Debug: s.Debug, Logger: r.log,
		Limits: protocol.Limits{
			MaxResultBytes: s.Limits.MaxResultBytes, MaxAnalysisConfigBytes: s.Limits.MaxAnalysisConfigBytes,
			MaxFileBytes: s.Limits.MaxFileBytes, MaxFilesPerAnalysis: s.Limits.MaxFilesPerAnalysis,
		},
	}
	httpClient, err := fetch.NewHTTPClient(cfg.CACert)
	if err != nil {
		return err
	}
	tmp := filepath.Join(cfg.WorkRoot, "templates")
	if err := os.MkdirAll(tmp, 0o700); err != nil {
		return err
	}
	r.env = templates.Env{
		DataSources: map[string]string{
			templates.DataSourceTranco:    s.DataSources.Tranco,
			templates.DataSourceCrux:      s.DataSources.Crux,
			templates.DataSourceCruxCache: s.DataSources.CruxCache,
		},
		Uploads: map[string]templates.Upload{}, HTTP: httpClient, TmpDir: tmp,
	}
	return nil
}

// serveUploads makes the local upload files available to templates the same way presigned GETs are: an
// HTTP server on the loopback interface (docs/runtime.md §15.1: uploads are local files).
func (r *run) serveUploads() (func(), error) {
	if len(r.spec.Uploads) == 0 {
		return func() {}, nil
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("cannot serve the uploads: %w", err)
	}
	mux := http.NewServeMux()
	for id, u := range r.spec.Uploads {
		st, err := os.Stat(u.Path)
		if err != nil {
			_ = l.Close()
			return nil, fmt.Errorf("upload %s: %w", id, err)
		}
		p := "/uploads/" + id
		mux.HandleFunc("GET "+p, func(w http.ResponseWriter, req *http.Request) { http.ServeFile(w, req, u.Path) })
		r.env.Uploads[id] = templates.Upload{URL: "http://" + l.Addr().String() + p, SHA256: u.SHA256, Bytes: st.Size()}
	}
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(l) }()
	return func() { _ = srv.Close() }, nil
}

// spawnFailed reports a connector that could not start (exit 2).
func (r *run) spawnFailed(err error) {
	e := scerr.Newf(api.ErrorValidation, api.PhaseBootstrap, "the connector did not start: %v", err)
	var se *pool.SpawnError
	if errors.As(err, &se) {
		switch {
		case se.Connector != nil:
			typ := api.ErrorTaskError
			if se.Connector.Type == protocol.ErrorValidation {
				typ = api.ErrorValidation
			}
			e = scerr.New(typ, api.PhaseBootstrap, se.Connector.Message)
			e.Stack = se.Connector.Stack
		case se.StderrTail != "":
			e.Message += "\n" + se.StderrTail
		}
	}
	r.fail(e, ExitValidation)
}

// describe asks the connector for its description to learn the schedule kind.
func describe(p *pool.Process) (*protocol.Description, error) {
	call, err := p.Describe()
	if err != nil {
		return nil, err
	}
	defer call.End()
	t := time.NewTimer(protocol.DescriptionTimeout)
	defer t.Stop()
	select {
	case ev := <-call.Events():
		switch {
		case ev.Violation != nil:
			return nil, ev.Violation
		case ev.Exit != nil:
			return nil, fmt.Errorf("the connector exited (%s)", ev.Exit)
		}
		switch m := ev.Msg.(type) {
		case protocol.Description:
			return &m, nil
		case protocol.Error:
			return nil, errors.New(m.Error.Message)
		}
		return nil, fmt.Errorf("unexpected %s", ev.Msg.MessageType())
	case <-t.C:
		return nil, fmt.Errorf("no description within %s", protocol.DescriptionTimeout)
	}
}

func (r *run) start(p *pool.Process, desc *protocol.Description) {
	hello := p.Hello()
	// The connector names the language it loaded the entry as; SCANTOR_LANGUAGE lists every language
	// of the image ("typescript javascript" for scantor-base-js) and is only the fallback.
	language := hello.Connector.Language
	if language == "" {
		language = r.cfg.Language
	}
	ev := StartEvent{
		Type: EventStart, At: at(time.Now()), RuntimeVersion: version.Version, Language: language, ProtocolVersion: p.ProtocolVersion(),
		Connector: ConnectorRef{Language: hello.Connector.Language, Version: hello.Connector.Version},
		Schedule:  api.Schedule{Kind: desc.Schedule.Kind, Template: desc.Schedule.Template}, Limit: r.spec.Limit, Processes: r.spec.Processes,
	}
	if r.spec.Debug {
		if port, err := strconv.Atoi(r.cfg.DebugPort); err == nil {
			ev.DebugPort = &port
		}
	}
	r.events.Emit(ev)
}

// unattributed is the sink of output outside analyses: log events without seq.
func (r *run) unattributed() pool.Sink {
	return func(stream, line string) {
		r.events.Emit(LogEvent{Type: EventLog, At: at(time.Now()), Stream: stream, Text: line})
	}
}

// collect takes at most limit items from the schedule (docs/runtime.md §15.2 step 2) and returns them
// with the end reason.
func (r *run) collect(ctx context.Context, p *pool.Process, sched protocol.ScheduleInfo) ([]item, string) {
	var items []item
	reason := r.produce(ctx, p, sched, func(it item) bool {
		items = append(items, it)
		return true
	})
	return items, reason
}

// produce takes the items of the schedule (or the single analysis config item), emits their scheduled
// events and hands each to push, until the stream ends, limit items were taken (Spec.Limit 0: no limit),
// the schedule fails or push reports that nobody takes items any more. It returns the end reason.
func (r *run) produce(ctx context.Context, p *pool.Process, sched protocol.ScheduleInfo, push func(item) bool) string {
	s := r.spec
	if s.HasAnalysisConfig() {
		it := item{seq: 0, config: s.AnalysisConfig, scheduledAt: time.Now()}
		r.events.Emit(ScheduledEvent{Type: EventScheduled, At: at(it.scheduledAt), Seq: 0, Config: it.config})
		push(it)
		return ReasonDone
	}
	resolutions := scheduler.NewResolutions(r.env, s.Resolved, func(_ context.Context, key string, res api.Resolution) (api.Resolution, error) {
		provenance := res.Provenance
		if len(provenance) == 0 {
			provenance = json.RawMessage(`{}`)
		}
		r.events.Emit(ResolvedEvent{Type: EventResolved, At: at(time.Now()), Key: key, Template: res.Template, ScanConfig: res.ScanConfig, Provenance: provenance, ExpectedTotal: res.ExpectedTotal})
		return res, nil
	})
	resolutions.Now = api.Now
	pullCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		select {
		case <-r.abortCh:
			cancel()
		case <-pullCtx.Done():
		}
	}()

	var src scheduler.Source
	var conn *scheduler.ConnectorSource
	execDir := filepath.Join(r.cfg.WorkRoot, "x-schedule-1")
	defer func() { _ = os.RemoveAll(execDir) }()
	if sched.Kind == api.ScheduleKindCustom {
		tmp := filepath.Join(execDir, "tmp")
		if err := os.MkdirAll(tmp, 0o700); err != nil {
			r.fail(scerr.Newf(api.ErrorPlatform, api.PhaseSchedule, "cannot create the schedule directory: %v", err), ExitPlatform)
			return ReasonScheduleFailed
		}
		server := scheduler.NewTemplateServer(pullCtx, resolutions, func(msg string, args ...any) { r.log.Warn(msg, args...) })
		var err error
		conn, err = scheduler.StartConnector(p, protocol.Ctx{ScanID: s.RunID, Attempt: 1, TmpDir: tmp}, s.ScanConfig, s.TaskConfig, r.itemTimeout(), server)
		if err != nil {
			r.fail(scerr.Newf(api.ErrorCrash, api.PhaseSchedule, "cannot send the schedule request: %v", err), ExitFailures)
			return ReasonScheduleFailed
		}
		src = conn
	} else {
		name := sched.Template
		if name == "" {
			name = templates.Single
		}
		def, ok := templates.Lookup(name)
		if !ok {
			r.fail(scerr.Newf(api.ErrorValidation, api.PhaseSchedule, "unknown template %q", name), ExitValidation)
			return ReasonScheduleFailed
		}
		effective, err := scheduler.Effective(def, s.ScanConfig)
		if err == nil {
			var res templates.Resolution
			if res, err = resolutions.Resolve(pullCtx, scheduler.KeySchedule, def, effective); err == nil {
				src = scheduler.NewNative(pullCtx, def, res, r.env)
			}
		}
		if err != nil {
			r.scheduleFailed(err)
			return ReasonScheduleFailed
		}
	}
	defer src.Close()

	var n int64
	reason := ReasonDone
	for {
		cfg, ok, err := src.Next(pullCtx)
		if err != nil {
			if pullCtx.Err() == nil {
				r.scheduleFailed(err)
				reason = ReasonScheduleFailed
			}
			break
		}
		if !ok {
			break
		}
		// The item after the limit was already pulled: a stream of exactly limit items ends with done.
		if s.Limit > 0 && n == int64(s.Limit) {
			reason = ReasonLimit
			break
		}
		seq := n
		compact, err := scheduler.Limits{MaxAnalysisConfigBytes: s.Limits.MaxAnalysisConfigBytes}.CheckItem(seq, cfg)
		if err != nil {
			r.scheduleFailed(err)
			reason = ReasonScheduleFailed
			break
		}
		it := item{seq: seq, config: compact, scheduledAt: time.Now()}
		r.events.Emit(ScheduledEvent{Type: EventScheduled, At: at(it.scheduledAt), Seq: seq, Config: compact})
		if !push(it) {
			break
		}
		n++
	}
	if conn != nil && !conn.Ended() {
		conn.Close()
		p.Kill() // the schedule is abandoned; the process is recycled
		<-p.Done()
	}
	return reason
}

func (r *run) scheduleFailed(err error) {
	e := scerr.FromError(err, api.PhaseSchedule, true)
	e.Attempt = 1
	r.fail(e, ExitFailures)
}

func (r *run) itemTimeout() time.Duration {
	if r.spec.Debug {
		return 0
	}
	return time.Duration(r.spec.TimeoutMs) * time.Millisecond
}

// lane is one of the `processes` concurrent connector processes.
type lane struct {
	index   int
	gen     int
	proc    *pool.Process
	handled int
	capture *logtail.Buffer
	ctl     chan runner.Control
	// spawnDelay is the lane's wait after its last failed spawn (streaming runs); 0 after a success.
	spawnDelay time.Duration
}

// runItems runs the collected items with `processes` lanes; the first lane reuses the describe process.
func (r *run) runItems(ctx context.Context, items []item, first *pool.Process) {
	queue := make(chan item, len(items))
	for _, it := range items {
		queue <- it
	}
	close(queue)
	n := min(r.spec.Processes, max(len(items), 1))
	r.startLanes(ctx, n, queue, first)()
	if !first.Usable() {
		<-first.Done()
	}
}

// stream runs the analyses while the schedule produces them (docs/runtime.md §15.6): the producer sends
// into a queue of 2 × processes items that `processes` lanes consume from the start, so backpressure
// reaches native iterators and the connector's schedule stream. A custom schedule keeps the describe
// process until it ends and retires it then (processes + 1 processes, as a scan); native templates and
// analysis-config runs hand it to lane 0 at once. It returns the end reason of the schedule.
func (r *run) stream(ctx context.Context, first *pool.Process, sched protocol.ScheduleInfo) string {
	queue := make(chan item, 2*r.spec.Processes)
	scheduleKeeps := sched.Kind == api.ScheduleKindCustom && !r.spec.HasAnalysisConfig()
	lane0 := first
	if scheduleKeeps {
		lane0 = nil
	}
	wait := r.startLanes(ctx, r.spec.Processes, queue, lane0)
	reason := r.produce(ctx, first, sched, func(it item) bool {
		if _, ok := r.aborted(); ok {
			return false
		}
		select {
		case queue <- it:
			return true
		case <-r.abortCh:
			return false
		}
	})
	close(queue)
	if scheduleKeeps {
		retire(first)
	}
	wait()
	if !first.Usable() {
		<-first.Done()
	}
	return reason
}

// startLanes starts n lanes that run the items of queue until it is closed or the run aborts (queued
// items are then dropped); lane 0 starts with first when it is usable. The returned function waits for
// the lanes.
func (r *run) startLanes(ctx context.Context, n int, queue <-chan item, first *pool.Process) func() {
	var wg sync.WaitGroup
	for i := range n {
		l := &lane{index: i, gen: 1, capture: logtail.NewBuffer(r.spec.Limits.LogTailBytes), ctl: make(chan runner.Control, 4)}
		if i == 0 && first != nil && first.Usable() {
			l.proc = first
		}
		wg.Go(func() {
			defer l.retire()
			for it := range queue {
				if _, ok := r.aborted(); ok {
					return
				}
				r.analyse(ctx, l, it)
			}
		})
	}
	return wg.Wait
}

func (l *lane) retire() {
	if l.proc == nil {
		return
	}
	retire(l.proc)
	l.proc = nil
}

// retire ends a process: a graceful shutdown when it is usable, otherwise a kill.
func retire(p *pool.Process) {
	if p.Usable() {
		p.Shutdown(protocol.ShutdownGrace)
	} else {
		p.Kill()
		<-p.Done()
	}
}

// ensure gives the lane a usable process.
func (r *run) ensure(ctx context.Context, l *lane) error {
	if l.proc != nil && l.proc.Usable() {
		return nil
	}
	l.retire()
	p, err := r.launcher.Spawn(ctx, l.index, l.gen, r.unattributed())
	l.gen++
	if err != nil {
		return err
	}
	l.proc, l.handled = p, 0
	if r.opts.Stream {
		l.spawnDelay = 0
		r.mu.Lock()
		r.spawnFails = 0
		r.mu.Unlock()
	}
	return nil
}

// spawnBackoff follows a failed spawn of a streaming run: maxSpawnFailures consecutive failures across the
// lanes abort the run (startFailed, exit 3); otherwise the lane waits 1 s, doubling up to 60 s, before it
// takes its next item, so an unbounded stream does not turn every item into a platform failure at once.
func (r *run) spawnBackoff(l *lane) {
	r.mu.Lock()
	r.spawnFails++
	fails := r.spawnFails
	r.mu.Unlock()
	if fails >= maxSpawnFailures {
		r.log.Error("the connector failed to start repeatedly", "failures", fails)
		r.abort(ReasonStartFailed)
		return
	}
	if l.spawnDelay == 0 {
		l.spawnDelay = spawnBackoffInitial
	} else {
		l.spawnDelay = min(2*l.spawnDelay, spawnBackoffMax)
	}
	t := time.NewTimer(l.spawnDelay)
	defer t.Stop()
	select {
	case <-t.C:
	case <-r.abortCh:
	}
}

// analyse runs one item with retries until it is final and emits its events.
func (r *run) analyse(ctx context.Context, l *lane, it item) {
	var history []Attempt
	logs := &logBudget{} // ≤ 1 MiB of log events per analysis, across its attempts
	for attempt := 1; ; attempt++ {
		if err := r.ensure(ctx, l); err != nil {
			e := scerr.Newf(api.ErrorPlatform, api.PhaseBootstrap, "the connector did not start: %v", err)
			r.final(it, attempt, nil, &e, nil, "", history, time.Now(), time.Now(), 0)
			if r.opts.Stream {
				r.spawnBackoff(l)
			}
			return
		}
		x := r.execute(ctx, l, it, attempt, logs)
		if why, ok := r.aborted(); ok && (x.Aborted || !x.Succeeded()) {
			e := scerr.New(api.ErrorCancelled, api.PhaseRun, r.abortMessage(why))
			r.final(it, attempt, nil, &e, nil, l.capture.Tail(r.spec.Limits.LogTailBytes), history, x.StartedAt, x.FinishedAt, x.Duration)
			_ = x.Cleanup()
			return
		}
		if x.Error == nil {
			files, err := r.copyFiles(it.seq, x.Files)
			if err != nil {
				e := scerr.Newf(api.ErrorPlatform, api.PhaseUpload, "cannot write the files to the output directory: %v", err)
				r.raise(ExitPlatform)
				r.final(it, attempt, nil, &e, nil, l.capture.Tail(r.spec.Limits.LogTailBytes), history, x.StartedAt, x.FinishedAt, x.Duration)
			} else {
				r.final(it, attempt, x.Result, nil, files, l.capture.Tail(r.spec.Limits.LogTailBytes), history, x.StartedAt, x.FinishedAt, x.Duration)
			}
			_ = x.Cleanup()
			return
		}
		e := *x.Error
		_ = x.Cleanup()
		if !r.policy.Retry(e, attempt) {
			r.final(it, attempt, nil, &e, nil, l.capture.Tail(r.spec.Limits.LogTailBytes), history, x.StartedAt, x.FinishedAt, x.Duration)
			return
		}
		delay := r.policy.Delay(e, attempt)
		next := time.Now().Add(delay)
		apiErr := e.API()
		r.events.Emit(AttemptEvent{Type: EventAttempt, At: at(time.Now()), Seq: it.seq, Attempt: attempt, Error: apiErr, NextAttemptAt: at(next)})
		history = append(history, Attempt{
			Attempt: attempt, StartedAt: at(x.StartedAt), FinishedAt: at(x.FinishedAt), DurationMs: x.Duration.Milliseconds(),
			Error: &apiErr, LogTail: l.capture.Tail(r.spec.Limits.LogTailEarlierBytes),
		})
		select {
		case <-time.After(delay):
		case <-r.abortCh:
		}
	}
}

// abortMessage is the error message of the analyses an abort cancels. Dev runs and test runs keep their
// wording; a streaming run (a bundle run) is not called local.
func (r *run) abortMessage(why string) string {
	subject := "the local run"
	if r.opts.Stream {
		subject = "the run"
	}
	switch why {
	case ReasonTimeout:
		return fmt.Sprintf("%s exceeded its total timeout of %d ms", subject, r.spec.TotalTimeoutMs)
	case ReasonStartFailed:
		return fmt.Sprintf("%s stopped: the connector failed to start %d times in a row", subject, maxSpawnFailures)
	case ReasonOutputFailed:
		return subject + " stopped: its output could not be written"
	default:
		return subject + " was interrupted"
	}
}

// execute runs one attempt on the lane's process (the run path of docs/runtime.md §8 without AMQP).
func (r *run) execute(ctx context.Context, l *lane, it item, attempt int, logs *logBudget) *runner.Execution {
	for len(l.ctl) > 0 {
		<-l.ctl
	}
	r.mu.Lock()
	r.executing[l] = true
	aborted := r.abortWhy != ""
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		delete(r.executing, l)
		r.mu.Unlock()
	}()
	if aborted {
		l.ctl <- runner.Control{Kill: true}
	}
	timeout := time.Duration(r.spec.TimeoutMs) * time.Millisecond
	if r.spec.Debug {
		timeout = 0
	}
	seq, att := it.seq, attempt
	x := runner.Execute(ctx, runner.ExecSpec{
		Process: l.proc, ScanID: r.spec.RunID, Seq: it.seq, Round: 1, Attempt: attempt, Config: it.config, TaskConfig: r.spec.TaskConfig,
		Timeout: timeout, WorkRoot: r.cfg.WorkRoot, Limits: r.limits, Now: time.Now, Capture: l.capture, Control: l.ctl,
		Output: func(stream, line string) {
			if text, ok := logs.take(line); ok {
				r.events.Emit(LogEvent{Type: EventLog, At: at(time.Now()), Seq: &seq, Attempt: &att, Stream: stream, Text: text})
			}
		},
	})
	l.handled++
	if x.Recycle || l.handled >= r.spec.MaxAnalysesPerProcess {
		l.retire()
	}
	return x
}

// logBudget bounds the log events of one analysis to MaxLogBytes.
type logBudget struct {
	used      int
	truncated bool
}

func (b *logBudget) take(line string) (string, bool) {
	if b.truncated {
		return "", false
	}
	if b.used+len(line) > MaxLogBytes {
		b.truncated = true
		return logTruncated, true
	}
	b.used += len(line)
	return line, true
}

// final emits the result event of an analysis.
func (r *run) final(it item, attempt int, result json.RawMessage, e *scerr.ScantorError, files []File, logTail string, history []Attempt, started, finished time.Time, d time.Duration) {
	ev := ResultEvent{
		Type: EventResult, At: at(time.Now()), Seq: it.seq, Attempt: attempt, Config: it.config, Result: result,
		Files: files, LogTail: logTail, Attempts: history,
		Timings: Timings{ScheduledAt: at(it.scheduledAt), StartedAt: at(started), FinishedAt: at(finished), DurationMs: max(d.Milliseconds(), 0)},
	}
	if ev.Files == nil {
		ev.Files = []File{}
	}
	if ev.Attempts == nil {
		ev.Attempts = []Attempt{}
	}
	r.mu.Lock()
	r.summary.Analyses++
	if e == nil {
		ev.Status = runtime.StatusSucceeded
		r.summary.Succeeded++
	} else {
		ev.Status = runtime.StatusFailed
		r.summary.Failed++
		v := *e
		v.Attempt = attempt
		if v.At.IsZero() {
			v.At = time.Now()
		}
		v = v.Truncate(scerr.MaxStackBytes)
		a := v.API()
		ev.Error = &a
		ev.Result = nil
		r.exitCode = max(r.exitCode, ExitFailures)
	}
	r.mu.Unlock()
	r.events.Emit(ev)
}

// copyFiles writes the files of a successful analysis to <outDir>/files/<seq>/<fileId>/<safeName>.
func (r *run) copyFiles(seq int64, files []upload.File) ([]File, error) {
	out := make([]File, 0, len(files))
	for _, f := range files {
		seqDir := path.Join("files", strconv.FormatInt(seq, 10))
		rel := path.Join(seqDir, f.ID, SafeName(f.Name))
		dst := filepath.Join(r.spec.OutDir, filepath.FromSlash(rel))
		if err := copyFile(f.Path, dst); err != nil {
			return nil, err
		}
		r.chown(filepath.Join(r.spec.OutDir, filepath.FromSlash(seqDir)))
		r.chown(filepath.Dir(dst))
		r.chown(dst)
		out = append(out, File{ID: f.ID, Name: f.Name, Size: f.Size, SHA256: f.SHA256, ContentType: f.ContentType, Path: rel})
	}
	return out, nil
}

// chown gives a directory or file the run created to Options.FileOwner; errors are ignored.
func (r *run) chown(name string) {
	if o := r.opts.FileOwner; o != nil {
		_ = os.Lchown(name, o.UID, o.GID)
	}
}

func copyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil { //nolint:gosec // the consumer copies outDir out
		return err
	}
	in, err := os.OpenFile(src, os.O_RDONLY|syscall.O_NOFOLLOW, 0) //nolint:gosec // a file registered inside the execution's filesDir
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644) //nolint:gosec // readable by the consumer
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}
