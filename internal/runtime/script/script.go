// Package script is script mode (`scantor runtime script --entry <entry>`, docs/runtime.md,
// docs/scripts.md), the runtime of a script-run container. It starts the base image's script command
// (SCANTOR_SCRIPT_CMD, a command template with {entry}) in /task as the leader of its own process group,
// with the container's stdio and its complete environment (the script reads SCANTOR_URL and
// SCANTOR_SCRIPT_TOKEN itself). While the script runs it writes the heartbeat of the container
// healthcheck, forwards SIGTERM and SIGINT to the process group and kills the group KillGrace after the
// first forwarded signal. It exits with the script's exit code, or 128 + the signal number when the
// script was killed by a signal. It frames no output and calls no API: the script talks to the script
// runtime API on its own.
package script

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/health"
	"github.com/lonetis/scantor/internal/runtime/pool"
)

// ExitRuntime is the exit code when the runtime cannot start or supervise the script (no or an invalid
// SCANTOR_SCRIPT_CMD, a missing executable); the reason is printed on stderr.
const ExitRuntime = 2

// KillGrace is the time from the first forwarded signal until the process group is killed. It stays
// below the 60 s stop timeout of script-run containers, so the runtime outlives the script and reports
// the kill as the exit code 137.
const KillGrace = 50 * time.Second

// HeartbeatMode is the mode named in the heartbeat file.
const HeartbeatMode = "script"

// Options configure Run.
type Options struct {
	// Entry is the manifest's entry, substituted for {entry}.
	Entry  string
	Config runtime.Config
	// Signals delivers SIGTERM and SIGINT; each one is forwarded to the script's process group.
	Signals <-chan os.Signal
	// Stdin, Stdout and Stderr are the script's stdio; *os.File values are inherited as they are.
	// Stderr also carries the runtime's own messages.
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
	// TaskDir is the working directory (runtime.TaskDir when empty; tests).
	TaskDir string
	// KillGrace overrides KillGrace (tests).
	KillGrace time.Duration
	// HeartbeatInterval overrides health.LocalInterval (tests).
	HeartbeatInterval time.Duration
}

// Run runs the script to its end and returns the exit code of the runtime: the script's own exit code,
// 128 + signal when a signal ended it, or ExitRuntime when it could not be started. A cancelled ctx is
// handled like SIGTERM.
func Run(ctx context.Context, opts Options) int {
	cmd, err := command(opts)
	if err != nil {
		report(opts.Stderr, "%v", err)
		return ExitRuntime
	}
	if err := os.MkdirAll(opts.Config.WorkRoot, 0o700); err != nil {
		report(opts.Stderr, "cannot create the work root %s: %v", opts.Config.WorkRoot, err)
		return ExitRuntime
	}
	if err := cmd.Start(); err != nil {
		report(opts.Stderr, "cannot start the script: %v", err)
		return ExitRuntime
	}
	beatCtx, stopBeats := context.WithCancel(context.Background())
	var beats sync.WaitGroup
	beater := &health.Beater{Path: health.Path(opts.Config.WorkRoot), Mode: HeartbeatMode, Logger: slog.New(slog.NewTextHandler(opts.Stderr, nil))}
	beats.Go(func() { beater.Run(beatCtx, orDefault(opts.HeartbeatInterval, health.LocalInterval)) })
	defer func() {
		stopBeats()
		beats.Wait()
	}()
	return supervise(ctx, cmd, opts)
}

// command builds the script process from SCANTOR_SCRIPT_CMD (docs/runtime.md §3.3): no shell, the
// executable resolved like execvp, /task as working directory, its own process group.
func command(opts Options) (*exec.Cmd, error) {
	cfg := opts.Config
	if strings.TrimSpace(cfg.ScriptCmd) == "" {
		return nil, fmt.Errorf("this base image does not support scripts: %s is not set", runtime.EnvScriptCmd)
	}
	argv, err := pool.ParseCommand(cfg.ScriptCmd, opts.Entry)
	if err != nil {
		return nil, fmt.Errorf("invalid %s: %w", runtime.EnvScriptCmd, err)
	}
	dir := opts.TaskDir
	if dir == "" {
		dir = runtime.TaskDir
	}
	exe, err := pool.ResolveExecutable(argv[0], dir, cfg.Environ)
	if err != nil {
		return nil, fmt.Errorf("the script command %q cannot be started: %w", argv[0], err)
	}
	return &exec.Cmd{
		Path: exe, Args: argv, Dir: dir, Env: cfg.Environ,
		Stdin: opts.Stdin, Stdout: opts.Stdout, Stderr: opts.Stderr,
		SysProcAttr: &syscall.SysProcAttr{Setpgid: true},
	}, nil
}

// supervise waits for the script while it forwards signals and enforces the kill grace.
func supervise(ctx context.Context, cmd *exec.Cmd, opts Options) int {
	pgid := cmd.Process.Pid
	grace := orDefault(opts.KillGrace, KillGrace)
	waitErr := make(chan error, 1)
	go func() { waitErr <- cmd.Wait() }()
	var kill <-chan time.Time
	stop := func(sig syscall.Signal) {
		if kill == nil {
			report(opts.Stderr, "received %s; stopping the script (killed after %s)", sigName(sig), grace)
			kill = time.NewTimer(grace).C
		}
		_ = syscall.Kill(-pgid, sig)
	}
	done := ctx.Done()
	for {
		select {
		case err := <-waitErr:
			_ = syscall.Kill(-pgid, syscall.SIGKILL) // stragglers left in the group
			return exitCode(cmd, err, opts.Stderr)
		case sig := <-opts.Signals:
			s, ok := sig.(syscall.Signal)
			if !ok {
				s = syscall.SIGTERM
			}
			stop(s)
		case <-done:
			done = nil
			stop(syscall.SIGTERM)
		case <-kill:
			report(opts.Stderr, "the script did not stop within %s; killing it", grace)
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
		}
	}
}

// exitCode returns the script's exit code, or 128 + signal when a signal ended it.
func exitCode(cmd *exec.Cmd, waitErr error, stderr io.Writer) int {
	state := cmd.ProcessState
	if state == nil {
		report(stderr, "wait for the script: %v", waitErr)
		return ExitRuntime
	}
	var ee *exec.ExitError
	if waitErr != nil && !errors.As(waitErr, &ee) {
		// The script ended, but copying its output failed (only with non-file stdio).
		report(stderr, "the script's output: %v", waitErr)
	}
	if ws, ok := state.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return 128 + int(ws.Signal())
	}
	return state.ExitCode()
}

// report prints a runtime message on stderr; it becomes a line of the run log.
func report(w io.Writer, format string, args ...any) {
	_, _ = fmt.Fprintf(w, "scantor: "+format+"\n", args...)
}

func sigName(s syscall.Signal) string {
	switch s {
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGINT:
		return "SIGINT"
	}
	return s.String()
}

func orDefault(d, fallback time.Duration) time.Duration {
	if d > 0 {
		return d
	}
	return fallback
}
