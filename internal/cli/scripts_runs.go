package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/envconf"
	"github.com/lonetis/scantor/internal/manifest"
)

// `scantor scripts run` and `scantor scripts runs …`: start, follow and inspect script runs
// (docs/scripts.md). A followed run is never cancelled by an interrupt unless --cancel-on-interrupt is
// given: runs can last days, so Ctrl-C (or a closed terminal) only detaches.

func init() {
	registerGroup("scripts", "runs", "Inspect and control script runs", false)
	registerGroup("scripts runs", "outputs", "Download the output files of a script run", false)
	registerCommand("scripts", newScriptsRunCommand)
	registerCommand("scripts runs", newScriptsRunsListCommand)
	registerCommand("scripts runs", newScriptsRunsGetCommand)
	registerCommand("scripts runs", newScriptsRunsCancelCommand)
	registerCommand("scripts runs", newScriptsRunsRestartCommand)
	registerCommand("scripts runs", newScriptsRunsLogsCommand)
	registerCommand("scripts runs", newScriptsRunsSourceCommand)
	registerCommand("scripts runs outputs", newScriptsRunsOutputsGetCommand)
}

const scriptsRunExitHelp = "\n\nExit codes when following or waiting: 0 the run completed, 1 it failed or was cancelled, " +
	"2 invalid input, 3 a platform error (also a run that failed for a platform reason) or an interrupt."

// scriptsLogPage is the page size of getScriptRunLogs requests.
const scriptsLogPage = 1000

// scriptsLogPoll is the interval of --follow while no new lines arrive.
var scriptsLogPoll = 2 * time.Second

// scriptsCancelTimeout bounds the cancel request sent after an interrupt with --cancel-on-interrupt.
const scriptsCancelTimeout = 15 * time.Second

// ── settings flags ───────────────────────────────────────────────────────────

// scriptsSettingsFlags are --timeout, --cpus, --memory and --limit of run and restart.
type scriptsSettingsFlags struct {
	timeout time.Duration
	cpus    float64
	memory  string
	limit   int64
}

func (s *scriptsSettingsFlags) add(cmd *cobra.Command) {
	f := cmd.Flags()
	f.DurationVar(&s.timeout, "timeout", 0, "maximum duration of the run (for example 12h; default: the manifest default, capped by the instance)")
	f.Float64Var(&s.cpus, "cpus", 0, "CPUs of the run's container (default: the manifest default)")
	f.StringVar(&s.memory, "memory", "", "memory of the run's container, for example 512MiB or 4GiB (default: the manifest default)")
	f.Int64Var(&s.limit, "limit", 0, "sample run: every analysis stream ends after this many analyses")
}

// timeoutMs, resources and limitValue return the given values (nil when the flag is not set).
func (s *scriptsSettingsFlags) timeoutMs(cmd *cobra.Command) (*int64, error) {
	if !cmd.Flags().Changed("timeout") {
		return nil, nil
	}
	if s.timeout < time.Second {
		return nil, UsageError(errors.New("--timeout must be at least 1s"))
	}
	ms := s.timeout.Milliseconds()
	return &ms, nil
}

func (s *scriptsSettingsFlags) resources(cmd *cobra.Command) (*api.ScriptRunResourcesInput, error) {
	var res api.ScriptRunResourcesInput
	given := false
	if cmd.Flags().Changed("cpus") {
		if s.cpus <= 0 {
			return nil, UsageError(errors.New("--cpus must be greater than 0"))
		}
		res.CPUs, given = &s.cpus, true
	}
	if cmd.Flags().Changed("memory") {
		n, err := envconf.ParseByteSize(s.memory)
		if err != nil {
			return nil, UsageError(fmt.Errorf("--memory: %w", err))
		}
		if n <= 0 || n%envconf.MiB != 0 {
			return nil, UsageError(errors.New("--memory must be a whole number of MiB, for example 512MiB or 4GiB"))
		}
		mib := n / envconf.MiB
		res.MemoryMiB, given = &mib, true
	}
	if !given {
		return nil, nil
	}
	return &res, nil
}

func (s *scriptsSettingsFlags) limitValue(cmd *cobra.Command) (*int64, error) {
	if !cmd.Flags().Changed("limit") {
		return nil, nil
	}
	if s.limit < 1 {
		return nil, UsageError(errors.New("--limit must be at least 1"))
	}
	return &s.limit, nil
}

// startSettings returns the settings of startScriptRun, nil when no flag is set.
func (s *scriptsSettingsFlags) startSettings(cmd *cobra.Command) (*api.ScriptRunSettingsInput, error) {
	timeout, err := s.timeoutMs(cmd)
	if err != nil {
		return nil, err
	}
	resources, err := s.resources(cmd)
	if err != nil {
		return nil, err
	}
	limit, err := s.limitValue(cmd)
	if err != nil {
		return nil, err
	}
	if timeout == nil && resources == nil && limit == nil {
		return nil, nil
	}
	return &api.ScriptRunSettingsInput{TimeoutMs: timeout, Resources: resources, Limit: limit}, nil
}

// ── secrets ──────────────────────────────────────────────────────────────────

var scriptsSecretName = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)

// scriptsSecrets parses the --secret NAME=VALUE and NAME=@file values.
func scriptsSecrets(app *App, values []string) (map[string]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	in := newAPIInputs(app)
	secrets := make(map[string]string, len(values))
	for _, v := range values {
		name, value, found := strings.Cut(v, "=")
		switch {
		case !found:
			// The value may be the secret itself, so it is never echoed.
			return nil, UsageError(errors.New("invalid --secret: use NAME=VALUE or NAME=@file"))
		case !scriptsSecretName.MatchString(name):
			return nil, UsageError(fmt.Errorf("invalid --secret name %q: use an uppercase name such as API_TOKEN (NAME=VALUE or NAME=@file)", apiTruncate(name, 64)))
		}
		if _, dup := secrets[name]; dup {
			return nil, UsageError(fmt.Errorf("--secret %s is given twice", name))
		}
		if file, ok := strings.CutPrefix(value, "@"); ok {
			data, err := in.file("--secret "+name, file)
			if err != nil {
				return nil, err
			}
			if !utf8.Valid(data) {
				return nil, ValidationError(fmt.Errorf("--secret %s: %s is not UTF-8 text", name, file))
			}
			value = string(data)
		}
		secrets[name] = value
	}
	return secrets, nil
}

// ── run ──────────────────────────────────────────────────────────────────────

// scriptsTarget is the script `scripts run` starts: a name or id, or a folder that is uploaded first.
type scriptsTarget struct {
	name string
	dir  string
}

// scriptsResolveTarget decides what the argument of `scripts run` names. A directory that holds
// scantor-script.yaml, the current directory (no argument) and any argument that looks like a path (".",
// "..", or with a path separator) are script folders; anything else is a script name or id. A folder
// inside the editor workspace is the script's folder already, so only its name is used.
func scriptsResolveTarget(workspaceRoot string, args []string) (scriptsTarget, error) {
	arg := "."
	if len(args) == 1 {
		arg = args[0]
	}
	info, statErr := os.Stat(arg)
	isDir := statErr == nil && info.IsDir()
	hasManifest := false
	if isDir {
		var err error
		if hasManifest, err = hasRegularFile(arg, manifest.ScriptFileName); err != nil {
			return scriptsTarget{}, err
		}
	}
	pathLike := len(args) == 0 || arg == "." || arg == ".." || strings.ContainsAny(arg, `/`+string(filepath.Separator))
	switch {
	case !pathLike && !hasManifest:
		return scriptsTarget{name: arg}, nil
	case !isDir:
		return scriptsTarget{}, ValidationError(fmt.Errorf("%s is not a directory; give a script folder or a script name", arg))
	}
	folder, inEditor, err := editorFolder(workspaceRoot, arg)
	if err != nil {
		return scriptsTarget{}, err
	}
	if inEditor {
		if folder.kind != editorKindScript {
			return scriptsTarget{}, UsageError(fmt.Errorf("%s belongs to task %s, not to a script", arg, folder.name))
		}
		return scriptsTarget{name: folder.name}, nil
	}
	if !hasManifest {
		return scriptsTarget{}, ValidationError(fmt.Errorf("%s has no %s; give a script folder or a script name", arg, manifest.ScriptFileName))
	}
	if hasTask, err := hasRegularFile(arg, manifest.FileName); err != nil {
		return scriptsTarget{}, err
	} else if hasTask {
		return scriptsTarget{}, UsageError(fmt.Errorf("%s holds both %s and %s; a folder is either a task or a script", arg, manifest.FileName, manifest.ScriptFileName))
	}
	return scriptsTarget{dir: arg}, nil
}

type scriptsRunOptions struct {
	scans             []string
	config            string
	secrets           []string
	settings          scriptsSettingsFlags
	follow            bool
	yes               bool
	cancelOnInterrupt bool
}

func newScriptsRunCommand(app *App) *cobra.Command {
	var o scriptsRunOptions
	cmd := &cobra.Command{
		Use:   "run [<script>|dir]",
		Short: "Start a run of a script on scans",
		Long: "Start a run of a script on one or more of your scans (--scan, up to 20). The argument is a script " +
			"name or id, or a script folder: a folder (also the current directory when no argument is given) is " +
			"uploaded first like 'scantor scripts push'; inside the editor the folder's script is used as it is.\n\n" +
			"The run executes the script folder as it is now: the platform snapshots it, builds its image and runs " +
			"one container that reads the scans' results and files. --config is the script's config (a JSON " +
			"object inline, as @file or - for stdin); --secret NAME=VALUE (or NAME=@file, the file's exact " +
			"content) passes a secret the script reads as ctx.secrets[NAME], stored encrypted and never shown " +
			"again. --limit N makes a sample run: every analysis stream ends after N analyses. --timeout, --cpus " +
			"and --memory override the manifest defaults within the instance's limits. --yes confirms a run that " +
			"needs a confirmation.\n\n" +
			"--follow prints the run's log until the run ends. Interrupting a followed run (Ctrl-C) only " +
			"detaches: the run keeps running, and the command prints how to follow or cancel it again; " +
			"--cancel-on-interrupt cancels it instead. With -o json, --follow prints only the final run." +
			scriptsRunExitHelp,
		Example: `  scantor scripts run csp-report --scan 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --limit 100 --follow
  scantor scripts run ./csp-report --scan 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --config '{"minBytes":1024}' --cpus 4 --memory 4GiB
  scantor scripts run csp-report --scan 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --secret API_TOKEN=@token.txt --follow`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(o.scans) == 0 {
				return UsageError(errors.New("--scan is required (repeat it for several scans)"))
			}
			if o.cancelOnInterrupt && !o.follow {
				return UsageError(errors.New("--cancel-on-interrupt needs --follow"))
			}
			body := api.StartScriptRun{Scans: o.scans, Confirm: o.yes}
			in := newAPIInputs(app)
			var err error
			if body.Config, err = in.object("--config", o.config); err != nil {
				return err
			}
			if body.Secrets, err = scriptsSecrets(app, o.secrets); err != nil {
				return err
			}
			if body.Settings, err = o.settings.startSettings(cmd); err != nil {
				return err
			}
			cfg, err := app.Config()
			if err != nil {
				return err
			}
			target, err := scriptsResolveTarget(cfg.Workspace, args)
			if err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			out := app.Output()
			if target.dir != "" {
				up, _, err := scriptsUploadFolder(ctx, app, client, target.dir, false)
				if err != nil {
					return err
				}
				target.name = up.Script.Name
				if !out.JSON() {
					verb := "uploaded the folder of script"
					if up.Created {
						verb = "created script"
					}
					out.Infof("%s %s", verb, up.Script.Name)
				}
			}
			run, err := client.StartScriptRun(ctx, target.name, body, 0)
			if err != nil {
				return interruptedOr(ctx, apiWithHint(err, api.CodeConfirmationRequired, "re-run with --yes to start it anyway"))
			}
			if !o.follow {
				return out.Print(run, func(w io.Writer) error {
					_, err := fmt.Fprintf(w, "started script run %s (%s, %s)\nfollow it with: scantor scripts runs logs %s --follow\n", run.ID, run.ScriptName, run.State, run.ID)
					return err
				})
			}
			return scriptsFollowRun(ctx, app, client, run, o.cancelOnInterrupt)
		},
	}
	f := cmd.Flags()
	f.StringSliceVar(&o.scans, "scan", nil, "id of a scan the run reads (repeatable, up to 20)")
	f.StringVar(&o.config, "config", "", "script config: JSON object, @file or - (stdin)")
	f.StringArrayVar(&o.secrets, "secret", nil, "secret NAME=VALUE or NAME=@file (repeatable)")
	o.settings.add(cmd)
	f.BoolVar(&o.follow, "follow", false, "print the run's log until the run ends")
	f.BoolVar(&o.yes, "yes", false, "confirm a run that needs a confirmation")
	f.BoolVar(&o.cancelOnInterrupt, "cancel-on-interrupt", false, "with --follow: cancel the run on Ctrl-C instead of detaching")
	return cmd
}

// scriptsFollowRun prints the log of a started run until it is terminal, then the run, and maps it to
// the exit class. An interrupt detaches (or cancels the run with cancelOnInterrupt).
func scriptsFollowRun(ctx context.Context, app *App, client *api.Client, run *api.ScriptRun, cancelOnInterrupt bool) error {
	out := app.Output()
	if !out.JSON() {
		out.Infof("started script run %s (%s); following its log…", run.ID, run.ScriptName)
	}
	err := scriptsFollowLog(ctx, app, client, run.ID, 0, !out.JSON())
	var final *api.ScriptRun
	if err == nil {
		final, err = scriptsGetRunRetrying(ctx, out, client, run.ID)
	}
	if ctx.Err() != nil {
		if cancelOnInterrupt {
			scriptsCancelAfterInterrupt(ctx, app, client, run.ID)
		} else {
			scriptsDetach(app, run)
		}
		return Interrupted()
	}
	if err != nil {
		if !out.JSON() {
			out.Infof("stopped following script run %s; it keeps running: follow it again with 'scantor scripts runs logs %s --follow'", run.ID, run.ID)
		}
		return err
	}
	if err := out.Print(final, func(w io.Writer) error { return scriptsWriteRun(w, final, false) }); err != nil {
		return err
	}
	return scriptsRunOutcome(final)
}

// scriptsDetach tells how to reach a run the command stopped following. In JSON mode the run goes to
// stdout, so its id is machine-readable next to the interrupt error.
func scriptsDetach(app *App, run *api.ScriptRun) {
	out := app.Output()
	if out.JSON() {
		_ = out.PrintJSON(run)
		return
	}
	out.Infof("detached from script run %s; it keeps running\n  follow it again: scantor scripts runs logs %s --follow\n  cancel it:       scantor scripts runs cancel %s", run.ID, run.ID, run.ID)
}

// scriptsCancelAfterInterrupt cancels a run with a context of its own: the command context is cancelled
// already.
func scriptsCancelAfterInterrupt(ctx context.Context, app *App, client *api.Client, id string) {
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), scriptsCancelTimeout)
	defer cancel()
	if _, err := client.CancelScriptRun(cctx, id); err != nil {
		app.Output().Warnf("cancel script run %s: %v", id, err)
		return
	}
	app.Output().Infof("cancelled script run %s", id)
}

// scriptsFollowLog pages through getScriptRunLogs after afterLine until the log is complete (the run is
// terminal and every line was read); print writes the lines (as human text or NDJSON) or not (JSON mode
// of `scripts run --follow`, which prints only the final run). Temporary failures are retried for up to
// apiTransientBudget, so following survives an orchestrator restart.
func scriptsFollowLog(ctx context.Context, app *App, client *api.Client, id string, afterLine int64, print bool) error {
	out := app.Output()
	nd := out.NDJSON()
	var failingSince time.Time
	for {
		page, err := client.GetScriptRunLogs(ctx, id, afterLine, scriptsLogPage)
		if err != nil {
			if err := scriptsRetryable(ctx, out, err, &failingSince); err != nil {
				return err
			}
			continue
		}
		failingSince = time.Time{}
		before := afterLine
		for _, line := range page.Lines {
			if print {
				if err := scriptsPrintLogLine(out, nd, line, afterLine); err != nil {
					return err
				}
			}
			afterLine = max(afterLine, line.Line)
		}
		if len(page.Lines) > 0 {
			if afterLine == before {
				return PlatformError(fmt.Errorf("the log of script run %s did not advance past line %d", id, afterLine))
			}
			continue
		}
		if page.Complete {
			return nil
		}
		if err := apiSleep(ctx, scriptsLogPoll); err != nil {
			return err
		}
	}
}

// scriptsRetryable sleeps after a temporary failure and returns nil to retry; it returns the error to
// give up (permanent, interrupted, or failing for longer than apiTransientBudget).
func scriptsRetryable(ctx context.Context, out *Output, err error, failingSince *time.Time) error {
	switch {
	case ctx.Err() != nil:
		return Interrupted()
	case !api.Temporary(err):
		return err
	case failingSince.IsZero():
		*failingSince = time.Now()
		out.Warnf("%s; retrying", err)
	case time.Since(*failingSince) > apiTransientBudget:
		return err
	}
	return apiSleep(ctx, scriptsLogPoll)
}

func scriptsGetRunRetrying(ctx context.Context, out *Output, client *api.Client, id string) (*api.ScriptRun, error) {
	var failingSince time.Time
	for {
		run, err := client.GetScriptRun(ctx, id, 0)
		if err == nil {
			return run, nil
		}
		if err := scriptsRetryable(ctx, out, err, &failingSince); err != nil {
			return nil, err
		}
	}
}

// scriptsPrintLogLine writes one log line: a JSON object per line in JSON mode, else "<stream> <text>"
// made terminal-safe (script output and build logs are user-controlled). A jump in the line numbers means
// the log retention dropped lines; humans get a notice on stderr.
func scriptsPrintLogLine(out *Output, nd *NDJSON, line api.ScriptRunLogLine, afterLine int64) error {
	if out.JSON() {
		return nd.Write(line)
	}
	if afterLine > 0 && line.Line > afterLine+1 {
		out.Warnf("lines %d to %d of the log were dropped by the log retention", afterLine+1, line.Line-1)
	}
	if _, err := fmt.Fprintln(out.Out, TerminalSafe(fmt.Sprintf("%-6s %s", line.Stream, line.Text))); err != nil {
		return PlatformError(fmt.Errorf("write output: %w", err))
	}
	return nil
}

// scriptsRunOutcome maps a settled run to the exit class: 0 completed, 1 failed or cancelled, 3 failed
// for a platform reason.
func scriptsRunOutcome(run *api.ScriptRun) error {
	switch run.State {
	case api.ScriptRunCompleted:
		return nil
	case api.ScriptRunCancelled:
		return WithExit(ExitAnalysisFailures, fmt.Errorf("script run %s was cancelled", run.ID))
	case api.ScriptRunFailed:
		msg := fmt.Sprintf("script run %s failed", run.ID)
		platform := false
		switch {
		case run.Error != nil:
			msg += fmt.Sprintf(": %s: %s", run.Error.Type, apiTruncate(run.Error.Message, 300))
			platform = run.Error.Type == api.ScriptErrorPlatform
		case len(run.Errors) > 0:
			msg += fmt.Sprintf(" with %d build error(s)", len(run.Errors))
			for _, e := range run.Errors {
				platform = platform || e.Phase == api.BuildPhasePlatform
			}
		}
		if platform {
			return PlatformError(errors.New(msg))
		}
		return WithExit(ExitAnalysisFailures, errors.New(msg))
	}
	return nil
}

// ── runs ─────────────────────────────────────────────────────────────────────

func newScriptsRunsListCommand(app *App) *cobra.Command {
	var page api.PageQuery
	cmd := &cobra.Command{
		Use:     "list <script>",
		Short:   "List the runs of a script",
		Long:    "List the runs of a script, newest first. " + scriptsArgHelp,
		Example: "  scantor scripts runs list csp-report",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := apiCheckLimit(page.Limit, 200); err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			list, err := client.ListScriptRuns(cmd.Context(), args[0], page)
			if err != nil {
				return err
			}
			err = app.Output().Print(list, func(w io.Writer) error {
				t := Table{Headers: []string{"RUN", "STATE", "SCANS", "PROGRESS", "CREATED", "FINISHED"}}
				for _, r := range list.Items {
					t.Add(r.ID, scriptsRunState(&r), fmt.Sprintf("%d", len(r.Scans)), scriptsProgressText(r.Progress), apiTimeValue(r.CreatedAt), apiTime(r.FinishedAt))
				}
				return t.Write(w)
			})
			if err == nil {
				apiPrintMore(app, list.NextCursor, "--cursor")
			}
			return err
		},
	}
	apiPageFlags(cmd, &page, 200)
	return cmd
}

func newScriptsRunsGetCommand(app *App) *cobra.Command {
	var wait apiWaitOptions
	cmd := &cobra.Command{
		Use:   "get <run>",
		Short: "Show a script run",
		Long: "Show a script run: state, scans, settings, progress, error, result, outputs and the end of its log. " +
			"With --wait the command waits until the run has ended." + scriptsRunExitHelp,
		Example: `  scantor scripts runs get 4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8
  scantor scripts runs get 4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8 --wait -o json`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := wait.validate(); err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			var run *api.ScriptRun
			if wait.wait {
				run, err = apiPollUntil(ctx, wait.timeout, "script run "+args[0], func(ctx context.Context, w int) (*api.ScriptRun, bool, error) {
					run, err := client.GetScriptRun(ctx, args[0], w)
					if err != nil {
						return nil, false, err
					}
					return run, run.Settled(), nil
				})
			} else {
				run, err = client.GetScriptRun(ctx, args[0], 0)
			}
			if err != nil {
				return err
			}
			if err := app.Output().Print(run, func(w io.Writer) error { return scriptsWriteRun(w, run, true) }); err != nil {
				return err
			}
			if wait.wait {
				return scriptsRunOutcome(run)
			}
			return nil
		},
	}
	apiWaitFlags(cmd, &wait, "the run has ended (completed, failed or cancelled)")
	return cmd
}

func newScriptsRunsCancelCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "cancel <run>",
		Short: "Cancel a script run",
		Long: "Cancel a queued, building or running script run: its container is stopped and removed. Outputs " +
			"already stored are kept. This cannot be undone; restart the run to run it again.",
		Example: "  scantor scripts runs cancel 4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			run, err := client.CancelScriptRun(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			return app.Output().Print(run, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "script run %s is %s\n", run.ID, run.State)
				return err
			})
		},
	}
}

func newScriptsRunsRestartCommand(app *App) *cobra.Command {
	var resume, noLimit bool
	var config string
	var settings scriptsSettingsFlags
	cmd := &cobra.Command{
		Use:   "restart <run>",
		Short: "Start a new run like an earlier one",
		Long: "Start a new run of the script's current folder with the scans, config, secrets and settings of an " +
			"earlier run. --config replaces the config; --timeout, --cpus, --memory and --limit override the " +
			"settings, and --no-limit turns a sample run into a full one. --resume (only for a run that has " +
			"ended) hands the earlier run's last checkpoint and its outputs to the new run, so the script can " +
			"continue where it stopped.",
		Example: `  scantor scripts runs restart 4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8 --resume
  scantor scripts runs restart 6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c --no-limit --memory 8GiB`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if noLimit && cmd.Flags().Changed("limit") {
				return UsageError(errors.New("--limit and --no-limit exclude each other"))
			}
			body := api.RestartScriptRun{Resume: resume}
			var err error
			if body.Config, err = newAPIInputs(app).object("--config", config); err != nil {
				return err
			}
			timeout, err := settings.timeoutMs(cmd)
			if err != nil {
				return err
			}
			resources, err := settings.resources(cmd)
			if err != nil {
				return err
			}
			limit, err := settings.limitValue(cmd)
			if err != nil {
				return err
			}
			if timeout != nil || resources != nil || limit != nil || noLimit {
				body.Settings = &api.RestartScriptRunSettings{TimeoutMs: timeout, Resources: resources, Limit: limit, ClearLimit: noLimit}
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			run, err := client.RestartScriptRun(cmd.Context(), args[0], body)
			if err != nil {
				return apiWithHint(err, api.CodeInvalidState, "--resume needs a run that has ended")
			}
			return app.Output().Print(run, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "started script run %s (%s, %s)\nfollow it with: scantor scripts runs logs %s --follow\n", run.ID, run.ScriptName, run.State, run.ID)
				return err
			})
		},
	}
	cmd.Flags().BoolVar(&resume, "resume", false, "hand the earlier run's checkpoint and outputs to the new run")
	cmd.Flags().StringVar(&config, "config", "", "replace the config: JSON object, @file or - (stdin)")
	settings.add(cmd)
	cmd.Flags().BoolVar(&noLimit, "no-limit", false, "remove the earlier run's --limit (a full run)")
	return cmd
}

func newScriptsRunsLogsCommand(app *App) *cobra.Command {
	var follow bool
	var afterLine int64
	cmd := &cobra.Command{
		Use:   "logs <run>",
		Short: "Print the log of a script run",
		Long: "Print the log of a script run: the image build (build), the script's output (stdout, stderr) and " +
			"platform notices (system). --follow keeps printing new lines until the run has ended; interrupting it " +
			"never affects the run. The log keeps its first MiB and its newest lines; lines in between can be " +
			"dropped for long runs. With -o json every line is printed as one JSON object per line.",
		Example: `  scantor scripts runs logs 4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8
  scantor scripts runs logs 4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8 --follow`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if afterLine < 0 {
				return UsageError(errors.New("--after-line must not be negative"))
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			if follow {
				return scriptsFollowLog(ctx, app, client, args[0], afterLine, true)
			}
			return scriptsPrintLog(ctx, app, client, args[0], afterLine)
		},
	}
	cmd.Flags().BoolVar(&follow, "follow", false, "keep printing new lines until the run has ended")
	cmd.Flags().Int64Var(&afterLine, "after-line", 0, "start after this line number")
	return cmd
}

// scriptsPrintLog prints the lines stored so far.
func scriptsPrintLog(ctx context.Context, app *App, client *api.Client, id string, afterLine int64) error {
	out := app.Output()
	nd := out.NDJSON()
	for {
		page, err := client.GetScriptRunLogs(ctx, id, afterLine, scriptsLogPage)
		if err != nil {
			return interruptedOr(ctx, err)
		}
		before := afterLine
		for _, line := range page.Lines {
			if err := scriptsPrintLogLine(out, nd, line, afterLine); err != nil {
				return err
			}
			afterLine = max(afterLine, line.Line)
		}
		if len(page.Lines) == 0 {
			return nil
		}
		if afterLine == before {
			return PlatformError(fmt.Errorf("the log of script run %s did not advance past line %d", id, afterLine))
		}
	}
}

func newScriptsRunsOutputsGetCommand(app *App) *cobra.Command {
	var target apiOutputTarget
	cmd := &cobra.Command{
		Use:   "get <run> <output>",
		Short: "Download an output file of a script run",
		Long: "Download an output file of a script run by its id, as listed by 'scantor scripts runs get'. The file " +
			"is saved under its name in the current directory unless --file names another path (- writes to " +
			"stdout). Size and SHA-256 are verified; an existing file is only replaced with --force.",
		Example: `  scantor scripts runs outputs get 4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8 8a9b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d
  scantor scripts runs outputs get 4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8 8a9b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d --file - | head`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			dl, err := client.GetScriptRunOutputDownload(ctx, args[0], args[1])
			if err != nil {
				return err
			}
			if target.path == "" {
				target.path = apiSafeFileName(dl.Name, args[1])
			}
			saved, err := apiDownload(ctx, app, client, dl.URL, target, apiExpect{size: dl.Size, sha256: dl.SHA256})
			if err != nil {
				return err
			}
			return apiPrintSaved(app, saved)
		},
	}
	apiOutputFlags(cmd, &target, "the output file")
	return cmd
}

func newScriptsRunsSourceCommand(app *App) *cobra.Command {
	var target apiOutputTarget
	cmd := &cobra.Command{
		Use:   "source <run>",
		Short: "Download the snapshot a script run was built from",
		Long: "Download the snapshot of the script folder a run was built from, as a tar.gz. It is saved as " +
			"<script>-<run>.tar.gz in the current directory unless --file names another path (- writes to " +
			"stdout). The size is verified; an existing file is only replaced with --force.",
		Example: "  scantor scripts runs source 4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8\n  scantor scripts runs source 4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8 --file - | tar -tz",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			run, err := client.GetScriptRun(ctx, args[0], 0)
			if err != nil {
				return err
			}
			dl, err := client.GetScriptRunSourceDownload(ctx, run.ID)
			if err != nil {
				return err
			}
			if target.path == "" {
				target.path = apiSafeFileName(run.ScriptName+"-"+apiShortID(run.ID)+".tar.gz", "source.tar.gz")
			}
			saved, err := apiDownload(ctx, app, client, dl.URL, target, apiExpect{size: run.Source.PackBytes})
			if err != nil {
				return err
			}
			return apiPrintSaved(app, saved)
		},
	}
	apiOutputFlags(cmd, &target, "the snapshot")
	return cmd
}

// ── rendering ────────────────────────────────────────────────────────────────

// scriptsRunState renders the state with the error type of a failed run.
func scriptsRunState(run *api.ScriptRun) string {
	if run.State == api.ScriptRunFailed && run.Error != nil {
		return run.State + " (" + run.Error.Type + ")"
	}
	return run.State
}

// scriptsProgressText renders "done/total (percent) message", or "-".
func scriptsProgressText(p *api.ScriptRunProgress) string {
	if p == nil {
		return "-"
	}
	text := fmt.Sprintf("%g", p.Done)
	if p.Total != nil {
		text += fmt.Sprintf("/%g", *p.Total)
		if *p.Total > 0 {
			text += fmt.Sprintf(" (%.1f%%)", 100*p.Done / *p.Total)
		}
	}
	if p.Message != nil && *p.Message != "" {
		text += " " + *p.Message
	}
	return text
}

// scriptsSettingsText renders the settings on one line; unset values (before the build) are omitted.
func scriptsSettingsText(s api.ScriptRunSettings) string {
	var parts []string
	if s.TimeoutMs != nil {
		parts = append(parts, "timeout "+HumanDuration(*s.TimeoutMs))
	}
	if s.Resources.CPUs != nil {
		parts = append(parts, fmt.Sprintf("%g cpu", *s.Resources.CPUs))
	}
	if s.Resources.MemoryMiB != nil {
		parts = append(parts, fmt.Sprintf("%d MiB", *s.Resources.MemoryMiB))
	}
	if s.Limit != nil {
		parts = append(parts, fmt.Sprintf("limit %d analyses per stream", *s.Limit))
	}
	if len(parts) == 0 {
		return "defaults (set when the run is built)"
	}
	return strings.Join(parts, " · ")
}

// scriptsCompactJSON renders a JSON value on one line, or "" for null.
func scriptsCompactJSON(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return string(raw)
	}
	b, err := scriptsMarshalCompact(v)
	if err != nil {
		return string(raw)
	}
	return string(b)
}

func scriptsMarshalCompact(v any) ([]byte, error) {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return []byte(strings.TrimSuffix(b.String(), "\n")), nil
}

// scriptsWriteRun renders a script run for humans; withLog adds the log tail (the follow commands printed
// the log already).
func scriptsWriteRun(w io.Writer, run *api.ScriptRun, withLog bool) error {
	var kv apiKV
	kv.add("script run", run.ID)
	kv.add("script", fmt.Sprintf("%s (%s)", run.ScriptName, run.ScriptID))
	kv.add("state", scriptsRunState(run))
	scans := make([]string, len(run.Scans))
	for i, s := range run.Scans {
		scans[i] = s.ID
		if s.Name != nil && *s.Name != "" {
			scans[i] = fmt.Sprintf("%s (%s)", *s.Name, s.ID)
		}
	}
	kv.add("scans", strings.Join(scans, "\n"))
	kv.add("config", scriptsCompactJSON(run.Input.Config))
	kv.add("settings", scriptsSettingsText(run.Input.Settings))
	kv.add("secrets", strings.Join(run.Secrets, ", "))
	kv.add("source", fmt.Sprintf("%d files, %s, pack %s", run.Source.FileCount, HumanBytes(run.Source.PackBytes), apiShortCommit(run.Source.PackSHA256)))
	if r := run.RestartedFrom; r != nil {
		how := "restart of"
		if r.Resume {
			how = "resumes"
		}
		kv.add(how, r.ID)
	}
	if img := run.Image; img != nil {
		image := img.Ref
		if img.Cached {
			image += " (cached)"
		}
		kv.add("image", image)
	}
	if run.Progress != nil {
		kv.add("progress", scriptsProgressText(run.Progress))
	}
	if c := run.Checkpoint; c != nil {
		kv.add("checkpoint", fmt.Sprintf("%s, saved %s", HumanBytes(c.Bytes), apiTimeValue(c.SavedAt)))
	}
	if run.ExitCode != nil {
		kv.add("exit code", fmt.Sprintf("%d", *run.ExitCode))
	}
	if e := run.Error; e != nil {
		kv.add("error", e.Type+": "+e.Message)
	}
	kv.add("result", scriptsCompactJSON(run.Result))
	kv.add("log", fmt.Sprintf("%d lines (first retained %d, %d dropped)", run.Log.Lines, run.Log.FirstLine, run.Log.DroppedLines))
	kv.add("created", apiTimeValue(run.CreatedAt))
	kv.add("started", apiTime(run.StartedAt))
	if run.FinishedAt != nil {
		kv.add("finished", apiTime(run.FinishedAt))
		if run.StartedAt != nil {
			kv.add("duration", HumanDuration(run.FinishedAt.Sub(run.StartedAt.Time).Milliseconds()))
		}
	}
	if run.ExpiresAt != nil {
		kv.add("expires", apiTime(run.ExpiresAt))
	}
	if err := kv.write(w); err != nil {
		return err
	}
	if e := run.Error; e != nil && e.Stack != "" {
		if _, err := fmt.Fprintf(w, "stack:\n  %s\n", strings.ReplaceAll(strings.TrimRight(normaliseNewlines(e.Stack), "\n"), "\n", "\n  ")); err != nil {
			return err
		}
	}
	if len(run.Errors) > 0 {
		if _, err := fmt.Fprintln(w, "errors:"); err != nil {
			return err
		}
		for _, e := range run.Errors {
			if _, err := fmt.Fprintf(w, "  %s\n", FormatBuildError(e)); err != nil {
				return err
			}
		}
	}
	if len(run.Outputs) > 0 {
		if _, err := fmt.Fprintln(w, "outputs:"); err != nil {
			return err
		}
		t := Table{Headers: []string{"  OUTPUT", "NAME", "SIZE", "CREATED"}}
		for _, o := range run.Outputs {
			t.Add("  "+o.ID, o.Name, HumanBytes(o.Size), apiTimeValue(o.CreatedAt))
		}
		if err := t.Write(w); err != nil {
			return err
		}
	}
	if withLog && run.LogTail != nil && len(*run.LogTail) > 0 {
		if _, err := fmt.Fprintln(w, "log tail:"); err != nil {
			return err
		}
		for _, line := range *run.LogTail {
			if _, err := fmt.Fprintf(w, "  %-6s %s\n", line.Stream, line.Text); err != nil {
				return err
			}
		}
	}
	return nil
}
