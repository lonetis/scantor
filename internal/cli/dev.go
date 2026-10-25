package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/taskpipe"
)

func init() {
	registerGroup("", "dev", "Run and debug a task folder", false)
	registerCommand("dev", newDevRunCommand)
	registerCommand("dev", newDevDebugCommand)
}

// Bounds of the dev run flags.
const (
	devMaxLimit       = 1_000_000
	devMaxAttempts    = 20
	devMinTimeout     = time.Second
	devMaxTimeout     = 24 * time.Hour
	devCancelTimeout  = 30 * time.Second
	devStderrTailSize = 4 << 10
)

// devOptions are the flags of `dev run` and `dev debug` (docs/tasks.md §11.4).
type devOptions struct {
	taskConfig, scanConfig, analysisConfig string
	limit, maxAttempts                     int
	timeout                                time.Duration
	remote, force, debug                   bool
}

func (o *devOptions) addFlags(cmd *cobra.Command, defaultLimit int) {
	f := cmd.Flags()
	f.StringVar(&o.taskConfig, "task-config", "", "task config: JSON, @file or - (stdin)")
	f.StringVar(&o.scanConfig, "scan-config", "", "scan config: JSON, @file or - (stdin)")
	f.StringVar(&o.analysisConfig, "analysis-config", "", "run once with this analysis config and skip schedule: JSON, @file or - (stdin)")
	f.IntVar(&o.limit, "limit", defaultLimit, "maximum number of analyses taken from the schedule")
	f.IntVar(&o.maxAttempts, "max-attempts", 1, "attempts per analysis")
	f.DurationVar(&o.timeout, "timeout", 0, "per-analysis timeout, for example 30s (default: the manifest's)")
}

func (o devOptions) validate() error {
	switch {
	case o.limit < 1 || o.limit > devMaxLimit:
		return UsageError(fmt.Errorf("--limit must be between 1 and %d", devMaxLimit))
	case o.maxAttempts < 1 || o.maxAttempts > devMaxAttempts:
		return UsageError(fmt.Errorf("--max-attempts must be between 1 and %d", devMaxAttempts))
	case o.timeout != 0 && (o.timeout < devMinTimeout || o.timeout > devMaxTimeout):
		return UsageError(fmt.Errorf("--timeout must be between %s and %s", devMinTimeout, devMaxTimeout))
	}
	return nil
}

// devConfigs are the parsed config flags; nil means not given.
type devConfigs struct{ task, scan, analysis json.RawMessage }

func (o devOptions) configs(app *App) (devConfigs, error) {
	in := newAPIInputs(app)
	var c devConfigs
	var err error
	if c.task, err = in.object("--task-config", o.taskConfig); err != nil {
		return c, err
	}
	if c.scan, err = in.object("--scan-config", o.scanConfig); err != nil {
		return c, err
	}
	c.analysis, err = in.object("--analysis-config", o.analysisConfig)
	return c, err
}

const devRunLong = "Build the task folder on the local Docker daemon (as validate, without the type check), describe " +
	"it, validate the configs against its schemas with defaults filled, and run it in the runtime's local mode: " +
	"schedule (at most --limit analyses), then run. Nothing is bind-mounted; files the task produces are copied " +
	"to .scantor/out/<timestamp>/files/ in the folder.\n\n" +
	"With --remote, or SCANTOR_DEV_MODE=remote (set in the editor), the run is a test run on the platform: " +
	"outside the editor the folder is first uploaded into the task's workspace without publishing (--force " +
	"replaces unpublished workspace changes), then the test run is followed and its files are downloaded.\n\n" +
	"Events are printed as they happen; with -o json one JSON object per line (local: the runtime's local-mode " +
	"events; remote: {\"type\": <event>, \"data\": <payload>} per test-run event). Exit codes: 0 all analyses " +
	"succeeded, 1 some failed, 2 invalid task or configs, 3 platform failure."

func newDevRunCommand(app *App) *cobra.Command {
	var opts devOptions
	cmd := &cobra.Command{
		Use:   "run [dir]",
		Short: "Build and run a task folder (locally, or as a platform test run)",
		Long:  devRunLong,
		Example: `  scantor dev run
  scantor dev run ./echo --task-config '{"text": "hi"}' --limit 2
  scantor dev run --analysis-config @analysis.json -o json
  scantor dev run --remote`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return devCommand(cmd, app, args, opts)
		},
	}
	opts.addFlags(cmd, 5)
	cmd.Flags().BoolVar(&opts.remote, "remote", false, "run a test run on the platform instead of local Docker")
	cmd.Flags().BoolVar(&opts.force, "force", false, "with --remote: replace unpublished changes of the platform workspace")
	return cmd
}

func newDevDebugCommand(app *App) *cobra.Command {
	opts := devOptions{debug: true}
	cmd := &cobra.Command{
		Use:   "debug [dir]",
		Short: "Run a task folder under a debugger and wait for your IDE to attach",
		Long: "Like 'dev run' on local Docker, with one connector process started by the base image's debug " +
			"command (debugpy, the Node inspector or Delve; Go is built with SCANTOR_GCFLAGS=\"" + taskpipe.DebugGCFlags +
			"\"), timeouts disabled, and the debugger port published on 127.0.0.1. The scaffold's launch " +
			"configuration 'scantor: attach to dev debug' attaches to it. Debugging needs local Docker, so it is " +
			"not available with SCANTOR_DEV_MODE=remote (exit 3).",
		Example: "  scantor dev debug\n  scantor dev debug ./echo --analysis-config '{}'",
		Args:    cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return devCommand(cmd, app, args, opts)
		},
	}
	opts.addFlags(cmd, 1)
	return cmd
}

func devCommand(cmd *cobra.Command, app *App, args []string, opts devOptions) error {
	if err := opts.validate(); err != nil {
		return err
	}
	cfg, err := app.Config()
	if err != nil {
		return err
	}
	remote := opts.remote || cfg.DevMode == DevModeRemote
	if opts.debug && remote {
		return PlatformError(errors.New("debugging needs local Docker; SCANTOR_DEV_MODE=remote runs test runs on the platform, which cannot be debugged"))
	}
	configs, err := opts.configs(app)
	if err != nil {
		return err
	}
	dir := "."
	if len(args) == 1 {
		dir = args[0]
	}
	ctx := cmd.Context()
	printer := newDevPrinter(app, devOutDir(dir))
	if remote {
		return devRemote(ctx, app, cfg, dir, opts, configs, printer)
	}
	return devLocal(ctx, app, cfg, dir, opts, configs, printer)
}

// devOutDir is the folder that receives the files of one run: <dir>/.scantor/out/<timestamp>.
func devOutDir(dir string) string {
	return filepath.Join(dir, ".scantor", "out", time.Now().UTC().Format("20060102T150405Z"))
}

// ── local mode ───────────────────────────────────────────────────────────────

func devLocal(ctx context.Context, app *App, cfg Config, dir string, opts devOptions, configs devConfigs, printer *devPrinter) error {
	emitter := taskpipe.NewEmitter(app.Stderr, devEventFormat(app))
	res, err := localBuild(ctx, app, emitter, dir, taskpipe.BuildOptions{SkipCheck: true, DebugBuild: opts.debug})
	if err != nil {
		return err
	}
	if err := taskOutcome(emitter, res); err != nil {
		return err
	}
	spec, err := devSpec(app.Output(), res, opts, configs, cfg)
	if err != nil {
		return err
	}
	docker, err := app.Docker()
	if err != nil {
		return err
	}
	run := taskpipe.LocalRun{
		Docker:    docker,
		Runtime:   taskRuntimeBinary(docker, cfg),
		Image:     res.Image.ID,
		Spec:      spec,
		Resources: res.SettingsDefaults.Resources,
		OutDir:    printer.outDir,
		OnStart:   printer.debugPort,
		OnEvent:   printer.localLine,
		OnStderr:  printer.runtimeStderr,
	}
	lr, err := run.Run(ctx)
	if err != nil {
		return interruptedOr(ctx, PlatformError(fmt.Errorf("local run: %w", err)))
	}
	printer.filesWritten(lr.Files)
	return printer.localOutcome(lr)
}

// devSpec builds the local-mode spec (docs/tasks.md §11.3): effective configs validated against the
// described schemas with defaults filled, the flags, and the manifest's settings defaults.
func devSpec(out *Output, res *taskpipe.Result, opts devOptions, configs devConfigs, cfg Config) (taskpipe.LocalSpec, error) {
	desc, settings := res.Description, res.SettingsDefaults
	var issues []api.BuildError
	var schemaErr error
	fill := func(name string, schema, raw json.RawMessage) json.RawMessage {
		filled, errs, err := taskpipe.EffectiveConfig(name, schema, raw)
		if err != nil && schemaErr == nil {
			schemaErr = err
		}
		issues = append(issues, errs...)
		return filled
	}
	taskConfig := fill("taskConfig", desc.Schemas.TaskConfig, configs.task)
	scanConfig := json.RawMessage(`{}`)
	var analysisConfig json.RawMessage
	if configs.analysis != nil {
		// schedule is skipped, so the scan config only matters when it was given.
		analysisConfig = fill("analysisConfig", desc.Schemas.AnalysisConfig, configs.analysis)
		if configs.scan != nil {
			scanConfig = fill("scanConfig", desc.Schemas.ScanConfig, configs.scan)
		}
	} else {
		scanConfig = fill("scanConfig", desc.Schemas.ScanConfig, configs.scan)
	}
	if schemaErr != nil {
		return taskpipe.LocalSpec{}, ValidationError(fmt.Errorf("the task's described schema cannot be used: %w", schemaErr))
	}
	if len(issues) > 0 {
		for _, is := range issues {
			out.Infof("  %s", FormatBuildError(is))
		}
		return taskpipe.LocalSpec{}, ValidationError(fmt.Errorf("the configs do not match the task's schemas: %s%s", issues[0].Message, moreSuffix(len(issues)-1)))
	}
	for _, ref := range []struct {
		name  string
		paths []string
		value json.RawMessage
	}{
		{"taskConfig", desc.UploadPaths.TaskConfig, taskConfig},
		{"scanConfig", desc.UploadPaths.ScanConfig, scanConfig},
	} {
		if used := taskpipe.ReferencedUploads(ref.paths, ref.value); len(used) > 0 {
			return taskpipe.LocalSpec{}, ValidationError(fmt.Errorf("%s %s references an upload; local runs cannot read platform uploads, use --remote", ref.name, used[0]))
		}
	}
	timeoutMs := settings.TimeoutMs
	if opts.timeout > 0 {
		timeoutMs = opts.timeout.Milliseconds()
	}
	return taskpipe.LocalSpec{
		V:                     taskpipe.LocalSpecVersion,
		RunID:                 taskpipe.LocalRunID,
		Entry:                 res.Manifest.Entry,
		TaskConfig:            taskConfig,
		ScanConfig:            scanConfig,
		AnalysisConfig:        analysisConfig,
		Limit:                 opts.limit,
		Processes:             1,
		TimeoutMs:             timeoutMs,
		MaxAttempts:           opts.maxAttempts,
		Backoff:               settings.Backoff,
		MaxAnalysesPerProcess: settings.MaxAnalysesPerProcess,
		Debug:                 opts.debug,
		DataSources:           cfg.DataSources,
		Uploads:               map[string]taskpipe.LocalUpload{},
		Resolved:              map[string]json.RawMessage{},
		Limits:                taskpipe.DefaultLocalLimits(),
		OutDir:                taskpipe.LocalOutDir,
	}, nil
}

func moreSuffix(n int) string {
	if n <= 0 {
		return ""
	}
	return fmt.Sprintf(" (and %d more)", n)
}

// ── remote mode ──────────────────────────────────────────────────────────────

func devRemote(ctx context.Context, app *App, cfg Config, dir string, opts devOptions, configs devConfigs, printer *devPrinter) error {
	task, inEditor, err := editorTask(cfg.Workspace, dir)
	if err != nil {
		return err
	}
	client, err := app.APIClient()
	if err != nil {
		return err
	}
	if !inEditor {
		up, _, err := uploadFolder(ctx, app, client, dir, api.UploadTaskOptions{NoPublish: true, Force: opts.force})
		if err != nil {
			return err
		}
		task = up.Task.Name
	}
	body := api.TestTask{
		TaskConfig:     configs.task,
		ScanConfig:     configs.scan,
		AnalysisConfig: configs.analysis,
		Limit:          opts.limit,
		MaxAttempts:    opts.maxAttempts,
	}
	if opts.timeout > 0 {
		body.TimeoutMs = opts.timeout.Milliseconds()
	}
	run, err := client.TestTask(ctx, task, body, 0)
	if err != nil {
		return interruptedOr(ctx, err)
	}
	printer.testRunCreated(run)
	final, err := devFollowTestRun(ctx, app, client, run.ID, printer)
	if ctx.Err() != nil {
		devCancelTestRun(ctx, app, client, run.ID)
		return Interrupted()
	}
	if err != nil {
		return err
	}
	full, err := client.GetTestRun(ctx, final.ID, true, 0)
	if err != nil {
		return interruptedOr(ctx, err)
	}
	files, err := devDownloadTestRunFiles(ctx, app, client, full, printer.outDir)
	printer.filesWritten(files)
	if err != nil {
		return interruptedOr(ctx, err)
	}
	if err := printer.writeErr(); err != nil {
		return err
	}
	return devTestRunOutcome(full)
}

// devFollowTestRun prints the events of streamTestRun until `end`. When the stream breaks off early it
// long-polls getTestRun until the test run settled.
func devFollowTestRun(ctx context.Context, app *App, client *api.Client, id string, printer *devPrinter) (*api.TestRun, error) {
	stream, err := client.StreamTestRun(ctx, id)
	if err == nil {
		final, streamErr := devReadTestRunStream(stream, printer)
		if closeErr := stream.Close(); closeErr != nil && ctx.Err() == nil && streamErr == nil {
			app.Output().Warnf("close the event stream: %v", closeErr)
		}
		if final != nil || ctx.Err() != nil {
			return final, nil
		}
		err = streamErr
	}
	if ctx.Err() != nil {
		return nil, Interrupted()
	}
	app.Output().Warnf("the event stream of test run %s ended early (%v); waiting for the test run to finish", id, err)
	return apiPollUntil(ctx, 0, "test run "+id, func(ctx context.Context, wait int) (*api.TestRun, bool, error) {
		run, err := client.GetTestRun(ctx, id, false, wait)
		if err != nil {
			return nil, false, err
		}
		return run, run.Settled(), nil
	})
}

// devReadTestRunStream dispatches stream events to the printer and returns the test run of the `end`
// event; nil with the read error when the stream ended without one.
func devReadTestRunStream(stream *api.EventStream, printer *devPrinter) (*api.TestRun, error) {
	for {
		ev, err := stream.Next()
		if err != nil {
			if errors.Is(err, io.EOF) {
				err = io.ErrUnexpectedEOF
			}
			return nil, err
		}
		final, err := printer.testRunEvent(ev)
		if err != nil {
			return nil, err
		}
		if final != nil {
			return final, nil
		}
	}
}

func devCancelTestRun(ctx context.Context, app *App, client *api.Client, id string) {
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), devCancelTimeout)
	defer cancel()
	if _, err := client.CancelTestRun(cctx, id); err != nil {
		app.Output().Warnf("cancel test run %s: %v", id, err)
		return
	}
	app.Output().Infof("cancelled test run %s", id)
}

// devDownloadTestRunFiles downloads the files of every analysis to <outDir>/files/<seq>/<fileId>/<name>,
// the layout of local runs.
func devDownloadTestRunFiles(ctx context.Context, app *App, client *api.Client, run *api.TestRun, outDir string) (int, error) {
	n := 0
	for _, a := range run.Analyses {
		for i, f := range a.Files {
			dl, err := client.GetTestRunFileDownload(ctx, run.ID, f.ID)
			if err != nil {
				return n, err
			}
			dir := filepath.Join(outDir, "files", strconv.FormatInt(a.Seq, 10), apiSafeFileName(f.ID, strconv.Itoa(i)))
			if err := os.MkdirAll(dir, 0o750); err != nil {
				return n, ValidationError(fmt.Errorf("create %s: %w", dir, err))
			}
			target := apiOutputTarget{path: filepath.Join(dir, apiSafeFileName(f.Name, "file")), force: true}
			if _, err := apiDownload(ctx, app, client, dl.URL, target, apiExpect{size: f.Size, sha256: f.SHA256}); err != nil {
				return n, err
			}
			n++
		}
	}
	return n, nil
}

// devTestRunOutcome maps a settled test run to the exit codes of docs/tasks.md §11.4: 0 all analyses
// succeeded, 1 some failed (or schedule failed), 2 invalid task or configs, 3 platform failures.
func devTestRunOutcome(run *api.TestRun) error {
	switch run.State {
	case api.TestRunCompleted:
		if run.Summary.Failed > 0 {
			return SilentExit(ExitAnalysisFailures)
		}
		return nil
	case api.TestRunCancelled:
		return PlatformError(fmt.Errorf("test run %s was cancelled", run.ID))
	}
	if len(run.Errors) == 0 {
		return PlatformError(fmt.Errorf("test run %s failed", run.ID))
	}
	code := ExitOK
	for _, e := range run.Errors {
		code = max(code, devPhaseExit(e.Phase))
	}
	return WithExit(code, fmt.Errorf("test run %s failed: %s%s", run.ID, FormatBuildError(run.Errors[0]), moreSuffix(len(run.Errors)-1)))
}

// devPhaseExit is the exit code of a test-run error phase; the highest code of all errors wins.
func devPhaseExit(phase api.BuildPhase) int {
	switch phase {
	case api.BuildPhasePlatform, api.BuildPhasePush:
		return ExitPlatform
	case api.BuildPhaseSchedule:
		return ExitAnalysisFailures
	default:
		return ExitValidation
	}
}

// ── output ───────────────────────────────────────────────────────────────────

// devPrinter renders local-mode events and test-run events: one JSON object per line with -o json,
// readable lines otherwise. It is safe for concurrent use (stdout and stderr of a container are read
// concurrently).
type devPrinter struct {
	out    *Output
	nd     *NDJSON
	outDir string

	mu     sync.Mutex
	ended  *taskpipe.LocalEvent
	tail   []byte
	failed bool
}

func newDevPrinter(app *App, outDir string) *devPrinter {
	out := app.Output()
	return &devPrinter{out: out, nd: out.NDJSON(), outDir: outDir}
}

// line writes one terminal-safe line: logs, errors and results come from task code and scanned data.
func (p *devPrinter) line(format string, args ...any) {
	if _, err := io.WriteString(p.out.Out, TerminalSafe(fmt.Sprintf(format, args...))+"\n"); err != nil {
		p.failed = true
	}
}

func (p *devPrinter) json(v any) {
	if err := p.nd.Write(v); err != nil {
		p.failed = true
	}
}

// debugPort announces the published debugger port before the container starts: the debugger waits for
// the IDE before the connector says hello, so the start event comes only after attaching.
func (p *devPrinter) debugPort(port int) {
	if port == 0 || p.out.JSON() {
		return
	}
	p.out.Infof("debugger: listening on 127.0.0.1:%d; attach with the launch configuration 'scantor: attach to dev debug'", port)
}

// localLine handles one stdout line of the local-mode runtime.
func (p *devPrinter) localLine(line []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	ev, err := taskpipe.ParseLocalEvent(line)
	if err != nil {
		p.out.Warnf("runtime: %s", apiTruncate(string(line), 300))
		return
	}
	if ev.Type == taskpipe.LocalEventEnd {
		p.ended = &ev
	}
	if p.out.JSON() {
		p.json(json.RawMessage(line))
		return
	}
	p.renderLocal(ev)
}

// runtimeStderr keeps the tail of the runtime's own diagnostics for a failure report.
func (p *devPrinter) runtimeStderr(line []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.tail = append(p.tail, line...)
	p.tail = append(p.tail, '\n')
	if len(p.tail) > devStderrTailSize {
		p.tail = p.tail[len(p.tail)-devStderrTailSize:]
	}
}

func (p *devPrinter) renderLocal(ev taskpipe.LocalEvent) {
	switch ev.Type {
	case taskpipe.LocalEventStart:
		connector, schedule := "", ""
		if ev.Connector != nil {
			connector = fmt.Sprintf("%s connector %s", ev.Connector.Language, ev.Connector.Version)
		}
		if ev.Schedule != nil {
			schedule = devScheduleText(*ev.Schedule)
		}
		p.line("started: %s, schedule %s, limit %d, %d process(es)", connector, schedule, ev.Limit, ev.Processes)
	case taskpipe.LocalEventResolved:
		total := "unknown size"
		if ev.ExpectedTotal != nil {
			total = fmt.Sprintf("%d items expected", *ev.ExpectedTotal)
		}
		p.line("resolved %s (%s): %s", ev.Template, ev.Key, total)
	case taskpipe.LocalEventScheduled:
		p.line("%s scheduled %s", devSeq(ev.Seq), devCompact(ev.Config))
	case taskpipe.LocalEventLog:
		p.line("%s %s: %s", devSeq(ev.Seq), ev.Stream, ev.Text)
	case taskpipe.LocalEventAttempt:
		p.line("%s attempt %d failed: %s; retrying", devSeq(ev.Seq), devInt(ev.Attempt), devErrorText(ev.Error))
	case taskpipe.LocalEventResult:
		var duration int64
		if ev.Timings != nil {
			duration = ev.Timings.DurationMs
		}
		p.renderResult(devSeq(ev.Seq), ev.Status, devInt(ev.Attempt), duration, ev.Result, ev.Error)
		for _, f := range ev.Files {
			p.line("    file %s (%s) → %s", f.Name, HumanBytes(f.Size), filepath.Join(p.outDir, filepath.FromSlash(f.Path)))
		}
	case taskpipe.LocalEventError:
		p.line("error: %s", devErrorText(ev.Error))
	case taskpipe.LocalEventEnd:
		summary := taskpipe.LocalSummary{}
		if ev.Summary != nil {
			summary = *ev.Summary
		}
		p.line("done (%s): %s, %d succeeded, %d failed", ev.Reason, countNoun(summary.Analyses, "analysis", "analyses"), summary.Succeeded, summary.Failed)
	}
}

func (p *devPrinter) renderResult(seq, status string, attempt int, durationMs int64, result json.RawMessage, scErr *api.ScantorError) {
	if status == "succeeded" {
		p.line("%s succeeded (attempt %d, %s): %s", seq, attempt, HumanDuration(durationMs), devCompact(result))
		return
	}
	p.line("%s %s (attempt %d): %s", seq, status, attempt, devErrorText(scErr))
}

// localOutcome maps the runtime's exit code (docs/runtime.md §15.4) to the command's exit.
func (p *devPrinter) localOutcome(lr taskpipe.LocalResult) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if lr.Interrupted {
		return Interrupted()
	}
	if p.failed {
		return errDevOutput
	}
	code := int(lr.ExitCode)
	switch {
	case code == ExitOK:
		return nil
	case p.ended != nil && code <= ExitPlatform:
		// The events already reported the outcome.
		return SilentExit(code)
	}
	msg := fmt.Sprintf("the runtime exited with code %d before the run ended", code)
	if tail := strings.TrimSpace(string(p.tail)); tail != "" {
		msg += ":\n" + tail
	}
	return WithExit(ExitPlatform, errors.New(msg))
}

// errDevOutput reports that writing the events to stdout failed (for example a closed pipe).
var errDevOutput = PlatformError(errors.New("write output failed"))

// writeErr returns errDevOutput when an event could not be written.
func (p *devPrinter) writeErr() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.failed {
		return errDevOutput
	}
	return nil
}

// filesWritten reports where the files of the run are.
func (p *devPrinter) filesWritten(n int) {
	if n > 0 && !p.out.JSON() {
		p.out.Infof("%d file(s) written to %s", n, filepath.Join(p.outDir, "files"))
	}
}

func (p *devPrinter) testRunCreated(run *api.TestRun) {
	if !p.out.JSON() {
		p.out.Infof("test run %s of task %s: %s", run.ID, run.TaskName, run.State)
	}
}

// devStreamEvent is the -o json form of a test-run event.
type devStreamEvent struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// testRunEvent handles one event of streamTestRun and returns the test run of the `end` event.
func (p *devPrinter) testRunEvent(ev api.ServerEvent) (*api.TestRun, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.out.JSON() && json.Valid(ev.Data) {
		p.json(devStreamEvent{Type: ev.Name, Data: ev.Data})
	}
	switch ev.Name {
	case api.TestRunEventState:
		var st api.TestRunStateEvent
		if err := json.Unmarshal(ev.Data, &st); err == nil && !p.out.JSON() {
			p.out.Infof("test run: %s", st.State)
		}
	case api.TestRunEventLog:
		var l api.TestRunLogEvent
		if err := json.Unmarshal(ev.Data, &l); err == nil && !p.out.JSON() {
			p.line("%s %s: %s", devSeq(l.Seq), l.Stream, l.Text)
		}
	case api.TestRunEventAnalysis:
		var a api.TestRunAnalysis
		if err := json.Unmarshal(ev.Data, &a); err == nil && !p.out.JSON() {
			p.renderAnalysis(a)
		}
	case api.TestRunEventError:
		var be api.BuildError
		if err := json.Unmarshal(ev.Data, &be); err == nil && !p.out.JSON() {
			p.line("error: %s", FormatBuildError(be))
		}
	case api.TestRunEventEnd:
		var run api.TestRun
		if err := json.Unmarshal(ev.Data, &run); err != nil {
			return nil, PlatformError(fmt.Errorf("invalid end event of the test run: %w", err))
		}
		if !p.out.JSON() {
			p.line("done (%s): %s, %d succeeded, %d failed", run.State, countNoun(run.Summary.Analyses, "analysis", "analyses"), run.Summary.Succeeded, run.Summary.Failed)
		}
		return &run, nil
	}
	return nil, nil
}

func (p *devPrinter) renderAnalysis(a api.TestRunAnalysis) {
	seq := devSeq(&a.Seq)
	if a.Status != "succeeded" && a.Status != "failed" {
		p.line("%s %s (attempt %d)", seq, a.Status, a.Attempt)
		return
	}
	var duration int64
	if a.Timings != nil {
		duration = a.Timings.DurationMs
	}
	// The test run reports an analysis once it settled; its earlier attempts render as local mode's attempt events.
	for _, earlier := range a.Attempts {
		p.line("%s attempt %d failed: %s; retrying", seq, earlier.Attempt, devErrorText(earlier.Error))
	}
	p.renderResult(seq, a.Status, a.Attempt, duration, a.Result, a.Error)
	for _, f := range a.Files {
		p.line("    file %s (%s), downloaded when the test run ends", f.Name, HumanBytes(f.Size))
	}
}

func devScheduleText(s api.Schedule) string {
	if s.Kind == api.ScheduleKindTemplate {
		return "template " + s.Template
	}
	return s.Kind
}

func devSeq(seq *int64) string {
	if seq == nil {
		return "[-]"
	}
	return "[#" + strconv.FormatInt(*seq, 10) + "]"
}

func devInt(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

// devCompact renders a JSON value on one line, shortened for the terminal.
func devCompact(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "null"
	}
	return apiTruncate(string(raw), 200)
}

func devErrorText(e *api.ScantorError) string {
	if e == nil {
		return "unknown error"
	}
	return fmt.Sprintf("%s: %s", e.Type, apiTruncate(e.Message, 500))
}
