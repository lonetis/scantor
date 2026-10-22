// Package describe is describe mode (`scantor runtime describe --entry <entry>`, docs/runtime.md §16,
// docs/tasks.md §7): it spawns the connector, performs the handshake, asks for the task description and
// turns it into the describe output (schemas/describe.schema.json), written as task-pipeline events.
package describe

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/protocol"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/pipeline"
	"github.com/lonetis/scantor/internal/runtime/pool"
	"github.com/lonetis/scantor/internal/version"
)

// Exit codes of describe mode.
const (
	ExitOK     = 0
	ExitFailed = 2
)

// Options configure Run.
type Options struct {
	Entry  string
	Config runtime.Config
	Stdout io.Writer
	// TaskDir is the working directory of the connector (runtime.TaskDir when empty; tests).
	TaskDir string
	// HelloTimeout and ReadyTimeout override the protocol timers (tests).
	HelloTimeout, ReadyTimeout time.Duration
}

// Run describes the task and returns the exit code: 0 with a result event, 2 with error events.
func Run(ctx context.Context, opts Options) int {
	ev := pipeline.New(opts.Stdout, api.BuildPhaseDescribe)
	code := run(ctx, opts, ev)
	if ev.Err() != nil {
		return ExitFailed
	}
	return code
}

func run(ctx context.Context, opts Options, ev *pipeline.Emitter) int {
	cfg := opts.Config
	if err := cfg.RequireConnector(); err != nil {
		ev.Errorf(err.Error())
		return ExitFailed
	}
	dir := opts.TaskDir
	if dir == "" {
		dir = runtime.TaskDir
	}
	argv, err := pool.ParseCommand(cfg.ConnectorCmd, opts.Entry)
	if err != nil {
		ev.Errorf(fmt.Sprintf("invalid %s: %v", runtime.EnvConnectorCmd, err))
		return ExitFailed
	}
	exe, err := pool.ResolveExecutable(argv[0], dir, cfg.Environ)
	if err != nil {
		ev.Errorf(fmt.Sprintf("the connector command %q cannot be started: %v", argv[0], err))
		return ExitFailed
	}
	if err := os.MkdirAll(cfg.WorkRoot, 0o700); err != nil {
		ev.Errorf(fmt.Sprintf("cannot create the work root %s: %v", cfg.WorkRoot, err))
		return ExitFailed
	}
	output := func(stream, line string) { ev.Log(stream, line) }
	p, err := pool.Spawn(ctx, pool.Options{
		Argv: argv, Path: exe, Env: pool.ConnectorEnv(cfg.Environ, cfg.WorkRoot+"/proc-0-0", 0), Dir: dir,
		TmpDir: cfg.WorkRoot + "/proc-0-0", Mode: protocol.ModeDescribe, RuntimeVersion: version.Version,
		Limits: runtime.DefaultLimits(), Output: output, HelloTimeout: opts.HelloTimeout, ReadyTimeout: opts.ReadyTimeout,
	})
	if err != nil {
		ev.Errorf(startFailure(err))
		return ExitFailed
	}
	defer func() {
		p.Shutdown(protocol.ShutdownGrace)
	}()
	desc, err := requestDescription(p)
	if err != nil {
		ev.Errorf("describe failed: " + err.Error())
		return ExitFailed
	}
	out, errs := Derive(Input{ProtocolVersion: p.ProtocolVersion(), Connector: p.Hello().Connector, Description: *desc})
	if len(errs) > 0 {
		for _, e := range errs {
			ev.Errorf(e)
		}
		return ExitFailed
	}
	ev.Result(map[string]any{"description": out})
	return ExitOK
}

// startFailure explains a failed start, with the connector's handshake error (message and stack) or the
// last 4 KiB of stderr (docs/runtime.md §16).
func startFailure(err error) string {
	var se *pool.SpawnError
	if !errors.As(err, &se) {
		return "the connector did not start: " + err.Error()
	}
	var b strings.Builder
	switch {
	case se.Unsupported:
		b.WriteString(se.Reason)
	case se.Connector != nil:
		b.WriteString("the task could not be loaded: " + se.Connector.Message)
		if se.Connector.Stack != "" {
			b.WriteString("\n" + se.Connector.Stack)
		}
	default:
		b.WriteString("the connector did not start: " + se.Reason)
	}
	if se.Connector == nil && strings.TrimSpace(se.StderrTail) != "" {
		b.WriteString("\n" + strings.TrimRight(se.StderrTail, "\n"))
	}
	return b.String()
}

// requestDescription sends describe and waits up to 60 s for the description.
func requestDescription(p *pool.Process) (*protocol.Description, error) {
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
			return nil, fmt.Errorf("protocol violation: %w", ev.Violation)
		case ev.Exit != nil:
			return nil, fmt.Errorf("the connector exited (%s)%s", ev.Exit, tail(p))
		}
		switch m := ev.Msg.(type) {
		case protocol.Description:
			return &m, nil
		case protocol.Error:
			msg := m.Error.Message
			if m.Error.Stack != "" {
				msg += "\n" + m.Error.Stack
			}
			return nil, errors.New(msg)
		}
		return nil, fmt.Errorf("unexpected %s message", ev.Msg.MessageType())
	case <-t.C:
		return nil, fmt.Errorf("the connector sent no description within %s", protocol.DescriptionTimeout)
	}
}

func tail(p *pool.Process) string {
	if t := strings.TrimSpace(p.StderrTail()); t != "" {
		return ":\n" + t
	}
	return ""
}
