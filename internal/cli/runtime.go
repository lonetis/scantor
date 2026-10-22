package cli

import (
	"errors"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/check"
	"github.com/lonetis/scantor/internal/runtime/describe"
	"github.com/lonetis/scantor/internal/runtime/local"
	"github.com/lonetis/scantor/internal/runtime/worker"
)

// The runtime commands are hidden: scantor's own consumers start them inside task containers
// (docs/runtime.md §2); users never call them. Flags carry inputs, never configuration.
func init() {
	registerGroup("", "runtime", "Run the scantor runtime inside a task container", true)
	registerCommand("runtime", newRuntimeWorkerCommand)
	registerCommand("runtime", newRuntimeLocalCommand)
	registerCommand("runtime", newRuntimeDescribeCommand)
	registerCommand("runtime", newRuntimeCheckCommand)
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
// itself, so nothing more is printed.
func runtimeExit(code int) error {
	if code == 0 {
		return nil
	}
	return SilentExit(code)
}

// runtimeSignals delivers SIGTERM and SIGINT (docker-init forwards them to the runtime).
func runtimeSignals() (<-chan os.Signal, func()) {
	ch := make(chan os.Signal, 4)
	signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT)
	return ch, func() { signal.Stop(ch) }
}

func newRuntimeWorkerCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:    "worker",
		Short:  "Run a scan worker (scheduler or runner); started by the node daemon",
		Hidden: true,
		Args:   cobra.NoArgs,
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
		Use:    "local",
		Short:  "Run a task without queue or platform (dev run, test runs)",
		Hidden: true,
		Args:   cobra.NoArgs,
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
		Use:    "describe",
		Short:  "Describe a task (task pipeline)",
		Hidden: true,
		Args:   cobra.NoArgs,
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
		Use:    "check",
		Short:  "Type-check a task (task pipeline)",
		Hidden: true,
		Args:   cobra.NoArgs,
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
