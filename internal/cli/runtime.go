package cli

import (
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/check"
	"github.com/lonetis/scantor/internal/runtime/describe"
	"github.com/lonetis/scantor/internal/runtime/health"
	"github.com/lonetis/scantor/internal/runtime/local"
	"github.com/lonetis/scantor/internal/runtime/script"
	"github.com/lonetis/scantor/internal/runtime/worker"
)

// The runtime commands are hidden: scantor's own consumers start them inside task and script-run
// containers (docs/runtime.md §2); users never call them. Flags carry inputs, never configuration. They
// keep their own signal handling (annotationOwnSignals): worker and local mode receive SIGTERM and SIGINT
// on a channel and shut down as docs/runtime.md §14 and §15.2 describe, script mode forwards them to the
// script; describe and check keep the default disposition. `runtime healthcheck` is the container
// healthcheck of workers, test runs and script runs (§5.3).
func init() {
	registerGroup("", "runtime", "Run the scantor runtime inside a task container", true)
	registerCommand("runtime", newRuntimeWorkerCommand)
	registerCommand("runtime", newRuntimeLocalCommand)
	registerCommand("runtime", newRuntimeDescribeCommand)
	registerCommand("runtime", newRuntimeCheckCommand)
	registerCommand("runtime", newRuntimeScriptCommand)
	registerCommand("runtime", newRuntimeHealthcheckCommand)
}

// runtimeConfig reads the runtime environment (docs/runtime.md §3.2).
func runtimeConfig(app *App) (runtime.Config, error) {
	cfg, err := runtime.LoadConfig(app.Getenv, os.Environ())
	if err != nil {
		return cfg, ValidationError(err)
	}
	return cfg, nil
}

// runtimeExit turns a runtime exit code into the command's result; the runtime reported everything
// itself, so nothing more is printed, and the code is the process's as it is (script mode passes the
// script's own code or 128 + signal through, which the exit classes would turn into 3).
func runtimeExit(code int) error {
	if code == 0 {
		return nil
	}
	return ProcessExit(code)
}

// runtimeAnnotations marks a runtime command as handling signals itself.
func runtimeAnnotations() map[string]string { return map[string]string{annotationOwnSignals: "true"} }

// runtimeSignals delivers SIGTERM and SIGINT (docker-init forwards them to the runtime).
func runtimeSignals() (<-chan os.Signal, func()) {
	ch := make(chan os.Signal, 4)
	signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT)
	return ch, func() { signal.Stop(ch) }
}

func newRuntimeWorkerCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:         "worker",
		Short:       "Run a scan worker (scheduler or runner); started by the node daemon",
		Hidden:      true,
		Annotations: runtimeAnnotations(),
		Args:        cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := runtimeConfig(app)
			if err != nil {
				return WithExit(worker.ExitFatal, err)
			}
			signals, stop := runtimeSignals()
			defer stop()
			return runtimeExit(worker.Run(cmd.Context(), worker.Options{Config: cfg, Signals: signals, Stderr: app.Stderr}))
		},
	}
}

func newRuntimeLocalCommand(app *App) *cobra.Command {
	var specPath string
	cmd := &cobra.Command{
		Use:         "local",
		Short:       "Run a task without queue or platform (dev run, test runs)",
		Hidden:      true,
		Annotations: runtimeAnnotations(),
		Args:        cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if specPath == "" {
				return UsageError(errors.New("--spec is required"))
			}
			cfg, err := runtimeConfig(app)
			if err != nil {
				return WithExit(local.ExitPlatform, err)
			}
			spec, err := local.ReadSpec(specPath)
			if err != nil {
				local.InvalidSpec(app.Stdout, err)
				return SilentExit(local.ExitPlatform)
			}
			signals, stop := runtimeSignals()
			defer stop()
			return runtimeExit(local.Run(cmd.Context(), local.Options{Spec: spec, Config: cfg, Stdout: app.Stdout, Stderr: app.Stderr, Signals: signals}))
		},
	}
	cmd.Flags().StringVar(&specPath, "spec", "", "path of the local-mode spec (/scantor/in/spec.json)")
	return cmd
}

func newRuntimeDescribeCommand(app *App) *cobra.Command {
	var entry string
	cmd := &cobra.Command{
		Use:         "describe",
		Short:       "Describe a task (task pipeline)",
		Hidden:      true,
		Annotations: runtimeAnnotations(),
		Args:        cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if entry == "" {
				return UsageError(errors.New("--entry is required"))
			}
			cfg, err := runtimeConfig(app)
			if err != nil {
				return err
			}
			return runtimeExit(describe.Run(cmd.Context(), describe.Options{Entry: entry, Config: cfg, Stdout: app.Stdout}))
		},
	}
	cmd.Flags().StringVar(&entry, "entry", "", "the task's entry (substituted for {entry})")
	return cmd
}

func newRuntimeCheckCommand(app *App) *cobra.Command {
	var entry string
	cmd := &cobra.Command{
		Use:         "check",
		Short:       "Type-check a task (task pipeline)",
		Hidden:      true,
		Annotations: runtimeAnnotations(),
		Args:        cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if entry == "" {
				return UsageError(errors.New("--entry is required"))
			}
			cfg, err := runtimeConfig(app)
			if err != nil {
				return err
			}
			return runtimeExit(check.Run(cmd.Context(), check.Options{Entry: entry, Config: cfg, Stdout: app.Stdout}))
		},
	}
	cmd.Flags().StringVar(&entry, "entry", "", "the task's entry (substituted for {entry})")
	return cmd
}

func newRuntimeScriptCommand(app *App) *cobra.Command {
	var entry string
	cmd := &cobra.Command{
		Use:         "script",
		Short:       "Run a script (script-run container)",
		Hidden:      true,
		Annotations: runtimeAnnotations(),
		Args:        cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if entry == "" {
				return UsageError(errors.New("--entry is required"))
			}
			cfg, err := runtimeConfig(app)
			if err != nil {
				return WithExit(script.ExitRuntime, err)
			}
			signals, stop := runtimeSignals()
			defer stop()
			return runtimeExit(script.Run(cmd.Context(), script.Options{
				Entry: entry, Config: cfg, Signals: signals, Stdin: app.Stdin, Stdout: app.Stdout, Stderr: app.Stderr,
			}))
		},
	}
	cmd.Flags().StringVar(&entry, "entry", "", "the script's entry (substituted for {entry})")
	return cmd
}

func newRuntimeHealthcheckCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "healthcheck",
		Short: "Check that the runtime in this container wrote a heartbeat recently (container healthcheck)",
		Long: "Exit 0 when the runtime's last heartbeat (" + health.FileName + " below the work root) is younger " +
			"than three of its intervals, and 1 otherwise. Docker runs it inside worker, test-run and script-run containers.",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			if err := health.Check(health.Path(runtime.WorkRoot(app.Getenv)), time.Now()); err != nil {
				return WithExit(1, err)
			}
			_, err := fmt.Fprintln(app.Stdout, "healthy")
			return err
		},
	}
}
