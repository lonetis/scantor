package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
)

func init() {
	registerGroup("", "scans", "Start, follow and control scans", false)
	registerGroup("scans", "worker", "Inspect one worker of a scan", false)
	for _, build := range []CommandBuilder{
		newScansStartCommand, newScansListCommand, newScansGetCommand, newScansWatchCommand,
		newScansPauseCommand, newScansResumeCommand, newScansScaleCommand, newScansCancelCommand,
		newScansRetryFailedCommand, newScansRestartCommand, newScansDeleteCommand,
		newScansInflightCommand, newScansConditionsCommand, newScansEventsCommand, newScansWorkersCommand,
	} {
		registerCommand("scans", build)
	}
	registerCommand("scans worker", newScansWorkerLogsCommand)
}

const apiScanExitHelp = "\n\nExit codes when waiting: 0 completed without failed or lost analyses, 1 completed with " +
	"failed or lost analyses, failed, cancelled or paused by the circuit breaker, 2 invalid input, 3 platform error."

// ── start ────────────────────────────────────────────────────────────────────

type apiScanStartOptions struct {
	revision   string
	name       string
	taskConfig string
	scanConfig string
	settings   string
	workers    int
	processes  int
	confirm    bool
	wait       apiWaitOptions
}

func newScansStartCommand(app *App) *cobra.Command {
	var o apiScanStartOptions
	cmd := &cobra.Command{
		Use:   "start [revision]",
		Short: "Start a scan of a revision",
		Long: "Start a scan of a ready revision. " + apiRevisionRefHelp + " A bare revision id works too.\n\n" +
			"The task and scan configs are JSON objects given inline, as @file or as - (stdin); they are " +
			"validated against the revision's schemas and completed with their defaults. A list file for the list " +
			"template is uploaded with 'scantor uploads create' and referenced by its id. Settings not given " +
			"come from the task's manifest defaults; --settings takes a partial settings object (timeoutMs, " +
			"maxAttempts, backoff, resources, maxAnalysesPerProcess, nodeSelector), and --workers and " +
			"--processes override it.\n\n" +
			"Scans whose estimated size exceeds the instance's confirmation threshold need --confirm. With " +
			"--wait the command waits until the scan has settled (finished or paused) and prints it." + apiScanExitHelp,
		Example: `  scantor scans start echo@latest
  scantor scans start origins@3 --scan-config '{"list":"latest","limit":100000}' --workers 4 --confirm
  scantor scans start --revision power@2 --task-config @task-config.json --wait`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref := o.revision
			if len(args) == 1 {
				if ref != "" && ref != args[0] {
					return UsageError(errors.New("give the revision either as an argument or with --revision"))
				}
				ref = args[0]
			}
			if ref == "" {
				return UsageError(errors.New("a revision is required (for example echo@latest)"))
			}
			if err := o.wait.validate(); err != nil {
				return err
			}
			body, err := o.body(cmd, app, ref)
			if err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx, stop := InterruptContext(cmd.Context())
			defer stop()
			scan, err := client.StartScan(ctx, body)
			if err != nil {
				err = apiWithHint(err, api.CodeConfirmationRequired, "re-run with --confirm to start it anyway")
				return err
			}
			out := app.Output()
			if !o.wait.wait {
				return out.Print(scan, func(w io.Writer) error {
					_, err := fmt.Fprintf(w, "started scan %s (%s, %s)\nfollow it with: scantor scans watch %s\n", scan.ID, scan.Revision.Ref, scan.State, scan.ID)
					return err
				})
			}
			if !out.JSON() {
				out.Infof("started scan %s (%s); waiting until it settles…", scan.ID, scan.Revision.Ref)
			}
			if scan, err = apiWaitScan(ctx, client, scan.ID, o.wait.timeout); err != nil {
				return err
			}
			if err := out.Print(scan, func(w io.Writer) error { return apiWriteScan(w, scan) }); err != nil {
				return err
			}
			return apiScanOutcome(scan)
		},
	}
	f := cmd.Flags()
	f.StringVar(&o.revision, "revision", "", "revision to scan (alternative to the argument)")
	f.StringVar(&o.name, "name", "", "scan name (≤ 100 characters)")
	f.StringVar(&o.taskConfig, "task-config", "", "task config: JSON object, @file or - (stdin)")
	f.StringVar(&o.scanConfig, "scan-config", "", "scan config: JSON object, @file or - (stdin)")
	f.StringVar(&o.settings, "settings", "", "partial scan settings: JSON object, @file or - (stdin)")
	f.IntVar(&o.workers, "workers", 0, "number of runner workers")
	f.IntVar(&o.processes, "processes", 0, "connector processes per worker")
	f.BoolVar(&o.confirm, "confirm", false, "confirm a scan above the instance's confirmation threshold")
	apiWaitFlags(cmd, &o.wait, "the scan has settled (finished or paused)")
	return cmd
}

// body builds the startScan request from the flags.
func (o *apiScanStartOptions) body(cmd *cobra.Command, app *App, ref string) (api.StartScan, error) {
	in := newAPIInputs(app)
	body := api.StartScan{Revision: ref, Name: o.name, Confirm: o.confirm}
	var err error
	if body.TaskConfig, err = in.object("--task-config", o.taskConfig); err != nil {
		return body, err
	}
	if body.ScanConfig, err = in.object("--scan-config", o.scanConfig); err != nil {
		return body, err
	}
	var settings api.SettingsPatch
	given, err := in.decodeStrict("--settings", o.settings, &settings)
	if err != nil {
		return body, err
	}
	if cmd.Flags().Changed("workers") {
		if o.workers < 1 {
			return body, UsageError(errors.New("--workers must be at least 1"))
		}
		settings.Workers, given = &o.workers, true
	}
	if cmd.Flags().Changed("processes") {
		if o.processes < 1 {
			return body, UsageError(errors.New("--processes must be at least 1"))
		}
		settings.Processes, given = &o.processes, true
	}
	if given {
		body.Settings = &settings
	}
	return body, nil
}

// ── reading ──────────────────────────────────────────────────────────────────

func newScansListCommand(app *App) *cobra.Command {
	var query api.ListScansQuery
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List scans",
		Long: "List your scans, newest first. Deleted scans are omitted unless --state names deleting or " +
			"deleted. Admins see every user's scans and may filter with --user.",
		Example: `  scantor scans list --state running,paused
  scantor scans list --task origins -o json`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := apiCheckLimit(query.Limit, 200); err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			page, err := client.ListScans(cmd.Context(), query)
			if err != nil {
				return err
			}
			err = app.Output().Print(page, func(w io.Writer) error {
				t := Table{Headers: []string{"SCAN", "NAME", "REVISION", "STATE", "PROGRESS", "FAILED", "CREATED"}}
				for _, s := range page.Items {
					name := s.Name
					if name == "" {
						name = "-"
					}
					t.Add(s.ID, name, s.Revision.Ref, apiScanState(s.State, s.StateReason), apiProgressText(s.Progress), fmt.Sprintf("%d", s.Stats.Failed+s.Stats.Lost), apiTimeValue(s.CreatedAt))
				}
				return t.Write(w)
			})
			if err == nil {
				apiPrintMore(app, page.NextCursor, "--cursor")
			}
			return err
		},
	}
	cmd.Flags().StringSliceVar(&query.States, "state", nil, "only scans in these states (comma-separated: creating, running, paused, completed, failed, cancelled, deleting, deleted)")
	cmd.Flags().StringVar(&query.Task, "task", "", "only scans of this task (name or id)")
	cmd.Flags().StringVar(&query.UserID, "user", "", "only scans of this user id (admins)")
	apiPageFlags(cmd, &query.PageQuery, 200)
	return cmd
}

func newScansGetCommand(app *App) *cobra.Command {
	var wait apiWaitOptions
	cmd := &cobra.Command{
		Use:   "get <scan>",
		Short: "Show a scan",
		Long: "Show a scan: state, progress, analysis counts, scheduling, workers, settings and conditions. With " +
			"--wait the command waits until the scan has settled (finished or paused)." + apiScanExitHelp,
		Example: `  scantor scans get 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f
  scantor scans get 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --wait --timeout 2h -o json`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := wait.validate(); err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx, stop := InterruptContext(cmd.Context())
			defer stop()
			var scan *api.Scan
			if wait.wait {
				scan, err = apiWaitScan(ctx, client, args[0], wait.timeout)
			} else {
				scan, err = client.GetScan(ctx, args[0], 0)
			}
			if err != nil {
				return err
			}
			if err := app.Output().Print(scan, func(w io.Writer) error { return apiWriteScan(w, scan) }); err != nil {
				return err
			}
			if wait.wait {
				return apiScanOutcome(scan)
			}
			return nil
		},
	}
	apiWaitFlags(cmd, &wait, "the scan has settled (finished or paused)")
	return cmd
}

// apiWaitScan long-polls getScan until the scan leaves creating and running.
func apiWaitScan(ctx context.Context, client *api.Client, scanID string, timeout time.Duration) (*api.Scan, error) {
	return apiPollUntil(ctx, timeout, "scan "+scanID, func(ctx context.Context, wait int) (*api.Scan, bool, error) {
		scan, err := client.GetScan(ctx, scanID, wait)
		if err != nil {
			return nil, false, err
		}
		return scan, scan.Settled(), nil
	})
}

// apiScanTerminal reports whether a scan can no longer make progress without a new user action.
func apiScanTerminal(state string) bool {
	switch state {
	case api.ScanCompleted, api.ScanFailed, api.ScanCancelled, api.ScanDeleting, api.ScanDeleted:
		return true
	}
	return false
}

// apiReasonFailureRate is the stateReason code of a scan paused by the circuit breaker
// (docs/data-model.md §4.5).
const apiReasonFailureRate = "failureRate"

// apiBreakerPaused reports whether the circuit breaker paused the scan. Only a user can resume it, so
// commands that follow a scan stop there instead of waiting indefinitely.
func apiBreakerPaused(scan *api.Scan) bool {
	return scan.State == api.ScanPaused && scan.StateReason != nil && scan.StateReason.Code == apiReasonFailureRate
}

// apiScanOutcome maps a settled scan to the exit class of the waiting commands: 1 (analysis failures)
// when analyses failed or were lost, when the scan failed or was cancelled, or when the circuit breaker
// paused it.
func apiScanOutcome(scan *api.Scan) error {
	failures := func(format string, args ...any) error {
		return WithExit(ExitAnalysisFailures, fmt.Errorf(format, args...))
	}
	switch scan.State {
	case api.ScanCompleted:
		if scan.Stats.Failed+scan.Stats.Lost > 0 {
			return failures("scan %s completed with %d failed and %d lost analyses", scan.ID, scan.Stats.Failed, scan.Stats.Lost)
		}
	case api.ScanFailed:
		if e := scan.Scheduling.Error; e != nil {
			return failures("scan %s failed: %s", scan.ID, e.Message)
		}
		return failures("scan %s failed", scan.ID)
	case api.ScanCancelled:
		return failures("scan %s was cancelled", scan.ID)
	case api.ScanPaused:
		if apiBreakerPaused(scan) {
			return failures("scan %s was paused by the circuit breaker: too many recent attempts failed; resume it with 'scantor scans resume %s'", scan.ID, scan.ID)
		}
	}
	return nil
}

func apiScanState(state string, reason *api.StateReason) string {
	if reason != nil && reason.Code != "" && (state == api.ScanPaused || state == api.ScanFailed) {
		return state + " (" + reason.Code + ")"
	}
	return state
}

// apiProgressText renders "terminal/total (percent)".
func apiProgressText(p api.ScanProgress) string {
	total := "?"
	if p.Total != nil {
		total = fmt.Sprintf("%d", *p.Total)
	}
	text := fmt.Sprintf("%d/%s", p.Terminal, total)
	if p.Percent != nil {
		text += fmt.Sprintf(" (%.1f%%)", *p.Percent)
	}
	return text
}

func apiStatsText(s api.ScanStats) string {
	return fmt.Sprintf("succeeded %d · failed %d · retrying %d · pending %d · lost %d · cancelled %d",
		s.Succeeded, s.Failed, s.Retrying, s.Pending, s.Lost, s.Cancelled)
}

func apiWorkersText(w api.ScanWorkers) string {
	text := fmt.Sprintf("%d/%d active", w.Active, w.Desired)
	if w.Pending > 0 {
		text += fmt.Sprintf(", %d pending", w.Pending)
	}
	if len(w.ByState) > 0 {
		states := make([]string, 0, len(w.ByState))
		for state, n := range w.ByState {
			states = append(states, fmt.Sprintf("%s %d", state, n))
		}
		sort.Strings(states)
		text += " (" + strings.Join(states, ", ") + ")"
	}
	return text
}

func apiWriteScan(w io.Writer, s *api.Scan) error {
	var kv apiKV
	kv.add("scan", s.ID)
	kv.add("name", s.Name)
	kv.add("revision", s.Revision.Ref)
	state := apiScanState(s.State, s.StateReason)
	if s.StateReason != nil && s.StateReason.Message != "" {
		state += ": " + s.StateReason.Message
	}
	kv.add("state", state)
	progress := apiProgressText(s.Progress)
	if s.Progress.ETASeconds != nil && s.State == api.ScanRunning {
		progress += ", eta " + HumanDuration(*s.Progress.ETASeconds*1000)
	}
	kv.add("progress", progress)
	kv.add("analyses", apiStatsText(s.Stats))
	scheduling := fmt.Sprintf("%s, %d confirmed", s.Scheduling.State, s.Scheduling.Confirmed)
	if s.Scheduling.Error != nil {
		scheduling += ", error: " + s.Scheduling.Error.Message
	}
	kv.add("scheduling", scheduling)
	kv.add("round", fmt.Sprintf("%d", s.Round))
	kv.add("workers", apiWorkersText(s.Workers))
	kv.add("settings", apiSettingsSummary(s.Settings))
	if s.ClonedFrom != nil {
		kv.add("restart of", *s.ClonedFrom)
	}
	kv.add("created", apiTimeValue(s.CreatedAt))
	kv.add("started", apiTime(s.StartedAt))
	if s.CompletedAt != nil {
		kv.add("completed", apiTime(s.CompletedAt))
	}
	if err := kv.write(w); err != nil {
		return err
	}
	return apiWriteConditions(w, s.Conditions)
}

func apiWriteConditions(w io.Writer, conditions []api.Condition) error {
	if len(conditions) == 0 {
		return nil
	}
	if _, err := fmt.Fprintln(w, "conditions:"); err != nil {
		return err
	}
	for _, c := range conditions {
		if _, err := fmt.Fprintf(w, "  %s (%s, %s): %s\n", c.Type, c.Severity, c.Reason, c.Message); err != nil {
			return err
		}
	}
	return nil
}

// ── watch ────────────────────────────────────────────────────────────────────

func newScansWatchCommand(app *App) *cobra.Command {
	var interval, timeout time.Duration
	cmd := &cobra.Command{
		Use:   "watch <scan>",
		Short: "Follow a scan's progress until it finishes",
		Long: "Print a scan's progress until it is completed, failed or cancelled, or until the circuit breaker " +
			"pauses it (a scan you paused is watched until it is resumed and finishes). Humans get one progress " +
			"line, rewritten in place on a terminal; " +
			"with -o json every change is printed as one Scan object per line (NDJSON). Interrupting the command " +
			"does not affect the scan." + apiScanExitHelp,
		Example: `  scantor scans watch 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f
  scantor scans watch 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f -o json | jq -c .progress`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if interval < 500*time.Millisecond {
				return UsageError(errors.New("--interval must be at least 500ms"))
			}
			if timeout < 0 {
				return UsageError(errors.New("--timeout must not be negative"))
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx, stop := InterruptContext(cmd.Context())
			defer stop()
			w := &apiScanWatcher{app: app, client: client, scanID: args[0], interval: interval, timeout: timeout}
			scan, err := w.run(ctx)
			if err != nil {
				return err
			}
			return apiScanOutcome(scan)
		},
	}
	cmd.Flags().DurationVar(&interval, "interval", 2*time.Second, "time between updates")
	cmd.Flags().DurationVar(&timeout, "timeout", 0, "give up after this duration (0 = no limit)")
	return cmd
}

// apiScanWatcher polls one scan and prints every change until the scan is terminal.
type apiScanWatcher struct {
	app      *App
	client   *api.Client
	scanID   string
	interval time.Duration
	timeout  time.Duration

	last     string
	liveLine bool
}

func (w *apiScanWatcher) run(ctx context.Context) (*api.Scan, error) {
	out := w.app.Output()
	w.liveLine = !out.JSON() && apiIsTerminal(out.Out)
	var deadline time.Time
	if w.timeout > 0 {
		deadline = time.Now().Add(w.timeout)
	}
	var failingSince time.Time
	defer w.endLine()
	for {
		scan, err := w.client.GetScan(ctx, w.scanID, 0)
		switch {
		case err == nil:
			failingSince = time.Time{}
			if err := w.emit(scan); err != nil {
				return nil, err
			}
			if apiScanTerminal(scan.State) || apiBreakerPaused(scan) {
				w.endLine()
				if !out.JSON() {
					if _, err := fmt.Fprintf(out.Out, "scan %s %s: %s\n", scan.ID, scan.State, apiStatsText(scan.Stats)); err != nil {
						return nil, PlatformError(err)
					}
				}
				return scan, nil
			}
		case ctx.Err() != nil:
			return nil, Interrupted()
		case !api.Temporary(err):
			return nil, err
		default:
			if failingSince.IsZero() {
				failingSince = time.Now()
				out.Warnf("%s; retrying", err)
			} else if time.Since(failingSince) > apiTransientBudget {
				return nil, err
			}
		}
		if !deadline.IsZero() && time.Now().Add(w.interval).After(deadline) {
			return nil, PlatformError(fmt.Errorf("%w after %s watching scan %s", errAPIWaitTimeout, w.timeout, w.scanID))
		}
		if err := apiSleep(ctx, w.interval); err != nil {
			return nil, err
		}
	}
}

// emit prints the scan when anything visible changed since the last update.
func (w *apiScanWatcher) emit(scan *api.Scan) error {
	sig, err := json.Marshal([]any{scan.State, scan.StateReason, scan.Progress, scan.Stats, scan.Workers, scan.Conditions, scan.Scheduling.State, scan.Scheduling.Confirmed, scan.Round})
	if err != nil {
		return PlatformError(err)
	}
	if string(sig) == w.last {
		return nil
	}
	w.last = string(sig)
	out := w.app.Output()
	if out.JSON() {
		return out.NDJSON().Write(scan)
	}
	line := apiScanProgressLine(scan)
	if w.liveLine {
		_, err = fmt.Fprintf(out.Out, "\r\033[K%s", line)
	} else {
		_, err = fmt.Fprintln(out.Out, line)
	}
	if err != nil {
		return PlatformError(fmt.Errorf("write output: %w", err))
	}
	return nil
}

// endLine finishes a progress line that is rewritten in place.
func (w *apiScanWatcher) endLine() {
	if w.liveLine && w.last != "" {
		_, _ = fmt.Fprintln(w.app.Output().Out)
		w.liveLine = false
	}
}

// apiScanProgressLine renders the one-line progress of `scans watch`.
func apiScanProgressLine(s *api.Scan) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%-9s %s  succeeded %d  failed %d  retrying %d", apiScanState(s.State, s.StateReason), apiProgressText(s.Progress), s.Stats.Succeeded, s.Stats.Failed, s.Stats.Retrying)
	if s.Stats.Lost > 0 {
		fmt.Fprintf(&b, "  lost %d", s.Stats.Lost)
	}
	if s.Stats.Cancelled > 0 {
		fmt.Fprintf(&b, "  cancelled %d", s.Stats.Cancelled)
	}
	fmt.Fprintf(&b, "  workers %d/%d", s.Workers.Active, s.Workers.Desired)
	if s.Progress.ETASeconds != nil && s.State == api.ScanRunning {
		fmt.Fprintf(&b, "  eta %s", HumanDuration(*s.Progress.ETASeconds*1000))
	}
	if len(s.Conditions) > 0 {
		types := make([]string, len(s.Conditions))
		for i, c := range s.Conditions {
			types[i] = c.Type
		}
		fmt.Fprintf(&b, "  [%s]", strings.Join(types, ", "))
	}
	return b.String()
}

// ── lifecycle ────────────────────────────────────────────────────────────────

// apiScanAction builds pause, resume and cancel: one POST without a body that returns the scan.
func apiScanAction(app *App, use, short, long string, call func(*api.Client, context.Context, string) (*api.Scan, error)) *cobra.Command {
	return &cobra.Command{
		Use:   use + " <scan>",
		Short: short,
		Long:  long,
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			scan, err := call(client, cmd.Context(), args[0])
			if err != nil {
				return err
			}
			return app.Output().Print(scan, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "scan %s is %s\n", scan.ID, apiScanState(scan.State, scan.StateReason))
				return err
			})
		},
	}
}

func newScansPauseCommand(app *App) *cobra.Command {
	return apiScanAction(app, "pause", "Pause a running scan",
		"Pause a running scan: its workers finish their current analyses within the drain grace and stop; "+
			"queued analyses stay queued until the scan is resumed.",
		(*api.Client).PauseScan)
}

func newScansResumeCommand(app *App) *cobra.Command {
	return apiScanAction(app, "resume", "Resume a paused scan",
		"Resume a paused scan (paused by you or by the circuit breaker): workers are placed again and an "+
			"unfinished schedule continues from its checkpoint.",
		(*api.Client).ResumeScan)
}

func newScansCancelCommand(app *App) *cobra.Command {
	return apiScanAction(app, "cancel", "Cancel a scan",
		"Cancel a creating, running or paused scan: its queue and workers are removed and analyses that have "+
			"not finished become cancelled. Results already recorded are kept. This cannot be undone; restart "+
			"the scan to run it again.",
		(*api.Client).CancelScan)
}

func newScansScaleCommand(app *App) *cobra.Command {
	var workers, processes int
	cmd := &cobra.Command{
		Use:   "scale <scan>",
		Short: "Change the workers or processes of a scan",
		Long: "Change the number of runner workers and/or connector processes per worker of a creating, running " +
			"or paused scan. Changes apply live: workers are added or drained, processes are resized in place.",
		Example: "  scantor scans scale 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --workers 8 --processes 4",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var body api.ScaleScan
			if cmd.Flags().Changed("workers") {
				if workers < 1 {
					return UsageError(errors.New("--workers must be at least 1"))
				}
				body.Workers = &workers
			}
			if cmd.Flags().Changed("processes") {
				if processes < 1 {
					return UsageError(errors.New("--processes must be at least 1"))
				}
				body.Processes = &processes
			}
			if body.Workers == nil && body.Processes == nil {
				return UsageError(errors.New("give --workers, --processes or both"))
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			scan, err := client.ScaleScan(cmd.Context(), args[0], body)
			if err != nil {
				return err
			}
			return app.Output().Print(scan, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "scan %s: %d workers, %d processes per worker\n", scan.ID, scan.Settings.Workers, scan.Settings.Processes)
				return err
			})
		},
	}
	cmd.Flags().IntVar(&workers, "workers", 0, "number of runner workers")
	cmd.Flags().IntVar(&processes, "processes", 0, "connector processes per worker")
	return cmd
}

func newScansRetryFailedCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "retry-failed <scan>",
		Short: "Run the failed and lost analyses of a scan again",
		Long: "Run every failed or lost analysis that has a stored config again, in a new round. Cancelled " +
			"analyses are never retried (restart the scan instead). Allowed once scheduling has finished; the " +
			"scan returns to running. Follow it with 'scantor scans watch'.",
		Example: "  scantor scans retry-failed 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			res, err := client.RetryFailedAnalyses(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			return app.Output().Print(res, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "retrying the failed analyses of scan %s in round %d (job %s)\n", res.Scan.ID, res.Scan.Round, res.Job.ID)
				return err
			})
		},
	}
}

func newScansRestartCommand(app *App) *cobra.Command {
	var name string
	var workers, processes int
	cmd := &cobra.Command{
		Use:   "restart <scan>",
		Short: "Start a new scan with the same revision, configs and settings",
		Long: "Start a new scan that clones a scan: same revision, same effective configs (including secrets) " +
			"and settings, optionally with a new name and other workers or processes. The original scan is " +
			"not changed. Template inputs such as \"latest\" lists are resolved again.",
		Example: "  scantor scans restart 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --workers 8",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := api.RestartScan{Name: name}
			var settings api.RestartSettings
			if cmd.Flags().Changed("workers") {
				if workers < 1 {
					return UsageError(errors.New("--workers must be at least 1"))
				}
				settings.Workers = &workers
			}
			if cmd.Flags().Changed("processes") {
				if processes < 1 {
					return UsageError(errors.New("--processes must be at least 1"))
				}
				settings.Processes = &processes
			}
			if settings.Workers != nil || settings.Processes != nil {
				body.Settings = &settings
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			scan, err := client.RestartScan(cmd.Context(), args[0], body)
			if err != nil {
				return err
			}
			return app.Output().Print(scan, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "started scan %s as a restart of %s\nfollow it with: scantor scans watch %s\n", scan.ID, args[0], scan.ID)
				return err
			})
		},
	}
	cmd.Flags().StringVar(&name, "name", "", "name of the new scan")
	cmd.Flags().IntVar(&workers, "workers", 0, "number of runner workers of the new scan")
	cmd.Flags().IntVar(&processes, "processes", 0, "connector processes per worker of the new scan")
	return cmd
}

func newScansDeleteCommand(app *App) *cobra.Command {
	var wait apiWaitOptions
	cmd := &cobra.Command{
		Use:   "delete <scan>",
		Short: "Delete a finished scan with its results",
		Long: "Delete a completed, failed or cancelled scan: its analyses, files, exports and events are removed " +
			"by a background job. With --wait the command waits for the job.",
		Example: "  scantor scans delete 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --wait",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := wait.validate(); err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx, stop := InterruptContext(cmd.Context())
			defer stop()
			res, err := client.DeleteScan(ctx, args[0])
			if err != nil {
				return err
			}
			if wait.wait {
				return apiPrintJobRef(ctx, app, client, res.Job, wait, "deleting scan "+res.Scan.ID)
			}
			return app.Output().Print(res, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "deleting scan %s (job %s)\n", res.Scan.ID, res.Job.ID)
				return err
			})
		},
	}
	apiWaitFlags(cmd, &wait, "the deletion has finished")
	return cmd
}

// ── operator detail ──────────────────────────────────────────────────────────

func newScansInflightCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "inflight <scan>",
		Short: "List the analyses running right now",
		Long:  "List the analyses the scan's workers are executing right now, as reported by their last state polls.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			list, err := client.ListInflightAnalyses(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			now := time.Now()
			return app.Output().Print(list, func(w io.Writer) error {
				t := Table{Headers: []string{"ANALYSIS", "ROUND", "ATTEMPT", "RUNNING", "WORKER", "NODE", "PROGRESS"}}
				for _, a := range list.Items {
					t.Add(a.AnalysisID, fmt.Sprintf("%d", a.Round), fmt.Sprintf("%d", a.Attempt), HumanAge(&a.StartedAt, now), apiShortID(a.WorkerID), apiShortID(a.NodeID), inflightProgress(a.Progress))
				}
				return t.Write(w)
			})
		},
	}
}

// inflightProgress renders the latest progress report of an analysis ({fraction, message}, protocol
// `progress`) as "67% 4 of 6 s"; any other shape is shown as compact JSON.
func inflightProgress(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return "-"
	}
	var p api.BusyProgress
	if err := json.Unmarshal(raw, &p); err == nil {
		var parts []string
		if p.Fraction != nil {
			parts = append(parts, fmt.Sprintf("%.0f%%", *p.Fraction*100))
		}
		if p.Message != nil && *p.Message != "" {
			parts = append(parts, *p.Message)
		}
		if len(parts) > 0 {
			return apiTruncate(strings.Join(parts, " "), 60)
		}
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return apiTruncate(string(raw), 60)
	}
	return apiTruncate(compact.String(), 60)
}

func newScansConditionsCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "conditions <scan>",
		Short: "List why a scan is not progressing",
		Long: "List the scan's conditions: typed status entries such as workersPending, crashLoop, " +
			"imagePullFailed, brokerAlarm or breakerTripped that explain why it is not progressing.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			items, err := client.ListScanConditions(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			return app.Output().Print(api.List[api.Condition]{Items: items}, func(w io.Writer) error {
				t := Table{Headers: []string{"TYPE", "SEVERITY", "REASON", "SINCE", "MESSAGE"}}
				for _, c := range items {
					t.Add(c.Type, c.Severity, c.Reason, apiTimeValue(c.Since), c.Message)
				}
				return t.Write(w)
			})
		},
	}
}

func newScansEventsCommand(app *App) *cobra.Command {
	var eventType string
	var page api.PageQuery
	cmd := &cobra.Command{
		Use:     "events <scan>",
		Short:   "List the timeline of a scan",
		Long:    "List the events of a scan, newest first: state changes, worker placement, crashes, retries and more.",
		Example: "  scantor scans events 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --limit 20",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := apiCheckLimit(page.Limit, 200); err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			list, err := client.ListScanEvents(cmd.Context(), args[0], eventType, page)
			if err != nil {
				return err
			}
			err = app.Output().Print(list, func(w io.Writer) error {
				t := Table{Headers: []string{"AT", "LEVEL", "TYPE", "MESSAGE"}}
				for _, e := range list.Items {
					t.Add(apiTimeValue(e.At), e.Level, e.Type, e.Message)
				}
				return t.Write(w)
			})
			if err == nil {
				apiPrintMore(app, list.NextCursor, "--cursor")
			}
			return err
		},
	}
	cmd.Flags().StringVar(&eventType, "type", "", "only events of this type")
	apiPageFlags(cmd, &page, 200)
	return cmd
}

func newScansWorkersCommand(app *App) *cobra.Command {
	var states []string
	var page api.PageQuery
	cmd := &cobra.Command{
		Use:     "workers <scan>",
		Short:   "List the workers of a scan",
		Long:    "List the scheduler and runner workers of a scan with their node, state, processes and restarts.",
		Example: "  scantor scans workers 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --state running,backoff",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := apiCheckLimit(page.Limit, 200); err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			list, err := client.ListScanWorkers(cmd.Context(), args[0], states, page)
			if err != nil {
				return err
			}
			err = app.Output().Print(list, func(w io.Writer) error { return apiWorkersTable(list.Items).Write(w) })
			if err == nil {
				apiPrintMore(app, list.NextCursor, "--cursor")
			}
			return err
		},
	}
	cmd.Flags().StringSliceVar(&states, "state", nil, "only workers in these states (comma-separated)")
	apiPageFlags(cmd, &page, 200)
	return cmd
}

// apiWorkersTable renders workers of a scan or a node.
func apiWorkersTable(workers []api.Worker) Table {
	t := Table{Headers: []string{"WORKER", "SCAN", "ROLE", "STATE", "NODE", "PROCESSES", "RESTARTS", "STARTED"}}
	for _, wk := range workers {
		node := "-"
		if wk.Node != nil {
			node = wk.Node.Name
		} else if wk.NodeID != nil {
			node = apiShortID(*wk.NodeID)
		}
		state := wk.State
		if wk.StateReason != nil && wk.StateReason.Code != "" {
			state += " (" + wk.StateReason.Code + ")"
		}
		restarts := "0"
		if wk.Container != nil {
			restarts = fmt.Sprintf("%d", wk.Container.Restarts)
		}
		t.Add(wk.ID, apiShortID(wk.ScanID), wk.Role, state, node, fmt.Sprintf("%d/%d", wk.Processes.Running, wk.Processes.Desired), restarts, apiTime(wk.StartedAt))
	}
	return t
}

func newScansWorkerLogsCommand(app *App) *cobra.Command {
	var tailBytes int
	var maxWait time.Duration
	cmd := &cobra.Command{
		Use:   "logs <scan> <worker>",
		Short: "Print the log tail of a worker",
		Long: "Ask the worker's node for a fresh tail of the worker container's log and print it. The command " +
			"waits up to --max-wait (at most 30s) for the node to answer; if it does not, the last tail collected " +
			"earlier is printed with a warning. On a terminal, control characters in the log are shown escaped " +
			"(\\x1b); into a pipe or file the bytes are unchanged.",
		Example: "  scantor scans worker logs 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f 9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d --tail-bytes 262144",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if tailBytes < 0 || tailBytes > 262144 {
				return UsageError(errors.New("--tail-bytes must be between 0 (the server default) and 262144"))
			}
			if maxWait < 0 || maxWait > 30*time.Second {
				return UsageError(errors.New("--max-wait must be between 0s and 30s"))
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx, stop := InterruptContext(cmd.Context())
			defer stop()
			logs, err := client.GetWorkerLogs(ctx, args[0], args[1], tailBytes, int(maxWait.Seconds()))
			if err != nil {
				if ctx.Err() != nil {
					return Interrupted()
				}
				return err
			}
			out := app.Output()
			if out.JSON() {
				return out.PrintJSON(logs)
			}
			if _, err := io.WriteString(out.Out, out.TerminalText(logs.Text)); err != nil {
				return PlatformError(fmt.Errorf("write output: %w", err))
			}
			if logs.Text != "" && !strings.HasSuffix(logs.Text, "\n") {
				_, _ = fmt.Fprintln(out.Out)
			}
			if logs.Pending {
				out.Warnf("the node has not sent a fresh tail yet; this tail was collected %s", apiTime(logs.CollectedAt))
			}
			if logs.Truncated {
				out.Warnf("the tail is truncated; raise --tail-bytes for more")
			}
			return nil
		},
	}
	cmd.Flags().IntVar(&tailBytes, "tail-bytes", 0, "bytes of log to fetch (server default 65536, max 262144)")
	cmd.Flags().DurationVar(&maxWait, "max-wait", 30*time.Second, "how long to wait for a fresh tail (≤ 30s)")
	return cmd
}
