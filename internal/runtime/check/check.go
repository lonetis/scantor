// Package check is check mode (`scantor runtime check --entry <entry>`, docs/runtime.md §16): it runs the
// base image's static type-check command (SCANTOR_CHECK_CMD) in /task with a 300 s timeout and reports
// its output as task-pipeline events; lines of the form `<file>:<line>[:<column>]: <message>` are also
// reported as errors.
package check

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/logtail"
	"github.com/lonetis/scantor/internal/runtime/pipeline"
	"github.com/lonetis/scantor/internal/runtime/pool"
)

// Exit codes of check mode.
const (
	ExitOK     = 0
	ExitFailed = 2
)

// Timeout bounds the check command (docs/runtime.md §17).
const Timeout = 300 * time.Second

// diagnostic matches `<file>:<line>[:<column>]: <message>`.
var diagnostic = regexp.MustCompile(`^([^:\s][^:]*):(\d+)(?::(\d+))?: (.+)$`)

// Options configure Run.
type Options struct {
	Entry  string
	Config runtime.Config
	Stdout io.Writer
	// TaskDir is the working directory (runtime.TaskDir when empty; tests).
	TaskDir string
	// Timeout overrides Timeout (tests).
	Timeout time.Duration
}

// Run runs the check and returns the exit code: 0 when the command succeeded or is not configured, 2
// otherwise.
func Run(ctx context.Context, opts Options) int {
	ev := pipeline.New(opts.Stdout, api.BuildPhaseCheck)
	ok, code, skipped := run(ctx, opts, ev)
	var exitCode any = code
	if code < 0 {
		exitCode = nil // the command did not run to completion
	}
	ev.Result(map[string]any{"ok": ok, "exitCode": exitCode, "skipped": skipped})
	if !ok || ev.Err() != nil {
		return ExitFailed
	}
	return ExitOK
}

func run(ctx context.Context, opts Options, ev *pipeline.Emitter) (ok bool, exitCode int, skipped bool) {
	cfg := opts.Config
	if strings.TrimSpace(cfg.CheckCmd) == "" {
		ev.Log(pipeline.StreamCheck, "no type checker is configured for this language (SCANTOR_CHECK_CMD is empty); skipped")
		return true, 0, true
	}
	dir := opts.TaskDir
	if dir == "" {
		dir = runtime.TaskDir
	}
	argv, err := pool.ParseCommand(cfg.CheckCmd, opts.Entry)
	if err != nil {
		ev.Errorf(fmt.Sprintf("invalid %s: %v", runtime.EnvCheckCmd, err))
		return false, -1, false
	}
	exe, err := pool.ResolveExecutable(argv[0], dir, cfg.Environ)
	if err != nil {
		ev.Errorf(fmt.Sprintf("the check command %q cannot be started: %v", argv[0], err))
		return false, -1, false
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = Timeout
	}
	devnull, err := os.Open(os.DevNull)
	if err != nil {
		ev.Errorf(err.Error())
		return false, -1, false
	}
	defer devnull.Close()
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		ev.Errorf(err.Error())
		return false, -1, false
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		_ = stdoutR.Close()
		_ = stdoutW.Close()
		ev.Errorf(err.Error())
		return false, -1, false
	}
	cmd := &exec.Cmd{
		Path: exe, Args: argv, Dir: dir, Env: pool.WithoutRuntimeOnly(cfg.Environ), Stdin: devnull,
		Stdout: stdoutW, Stderr: stderrW, SysProcAttr: &syscall.SysProcAttr{Setpgid: true},
	}
	if err := cmd.Start(); err != nil {
		for _, f := range []*os.File{stdoutR, stdoutW, stderrR, stderrW} {
			_ = f.Close()
		}
		ev.Errorf(fmt.Sprintf("the check command cannot be started: %v", err))
		return false, -1, false
	}
	_ = stdoutW.Close()
	_ = stderrW.Close()
	var wg sync.WaitGroup
	var mu sync.Mutex // keeps diagnostics of both streams in arrival order
	for _, r := range []*os.File{stdoutR, stderrR} {
		wg.Go(func() {
			defer r.Close()
			_ = logtail.SplitLines(r, func(line string) {
				mu.Lock()
				defer mu.Unlock()
				ev.Log(pipeline.StreamCheck, line)
				if be, ok := parse(line); ok {
					ev.Error(be)
				}
			})
		})
	}
	waitErr := make(chan error, 1)
	go func() { waitErr <- cmd.Wait() }()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	var werr error
	timedOut := false
	select {
	case werr = <-waitErr:
	case <-timer.C:
		timedOut = true
	case <-ctx.Done():
		timedOut = true
	}
	if timedOut {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		werr = <-waitErr
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) // stragglers that keep the pipes open
	readers := make(chan struct{})
	go func() {
		wg.Wait()
		close(readers)
	}()
	select {
	case <-readers:
	case <-time.After(2 * time.Second): // processes that left the group still hold the pipes
		_ = stdoutR.Close()
		_ = stderrR.Close()
		<-readers
	}
	if timedOut {
		ev.Errorf(fmt.Sprintf("check exceeded %s", timeout))
		return false, -1, false
	}
	code := 0
	var ee *exec.ExitError
	switch {
	case werr == nil:
	case errors.As(werr, &ee):
		code = ee.ExitCode()
	default:
		ev.Errorf(fmt.Sprintf("the check command failed: %v", werr))
		return false, -1, false
	}
	return code == 0, code, false
}

// parse turns a diagnostic line into a BuildError with a file relative to /task.
func parse(line string) (api.BuildError, bool) {
	m := diagnostic.FindStringSubmatch(line)
	if m == nil {
		return api.BuildError{}, false
	}
	n, err := strconv.Atoi(m[2])
	if err != nil || n < 1 {
		return api.BuildError{}, false
	}
	be := api.BuildError{File: strings.TrimPrefix(strings.TrimPrefix(m[1], runtime.TaskDir+"/"), "./"), Line: n, Message: m[4]}
	if m[3] != "" {
		if c, err := strconv.Atoi(m[3]); err == nil && c > 0 {
			be.Column = c
		}
	}
	return be, true
}
