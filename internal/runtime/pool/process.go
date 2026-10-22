// Package pool manages connector processes (docs/runtime.md §7, docs/protocol.md §10): command templates,
// the connector environment, spawning over fds 3/4 with an own process group, the hello → welcome →
// ready handshake, routing of connector messages to the request in flight, output capture, protocol
// violation detection, graceful shutdown and process-group termination.
//
// A Process runs at most one runtime request (describe, schedule, run) at a time. The request is a Call:
// its consumer reads Events (connector messages addressed to it, a protocol violation, or the process's
// exit) and answers connector requests with Send. Log messages are rendered into the output stream
// (`[<level>] <message> key=value`, stream stderr) and reach the same Sink as stdout and stderr lines.
package pool

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/lonetis/scantor/internal/protocol"
	"github.com/lonetis/scantor/internal/runtime/logtail"
)

// Output streams of a connector process.
const (
	StreamStdout = "stdout"
	StreamStderr = "stderr"
)

// StderrTailBytes is how much stderr is kept for spawn failures and crash reports (docs/runtime.md §7.5).
const StderrTailBytes = 4 << 10

// Timers of the process lifecycle.
const (
	// writeTimeout bounds one write to fd 3; a connector that stops reading its requests is broken.
	writeTimeout = 60 * time.Second
	// drainTimeout bounds how long output pipes may stay open after the leader exited, before the
	// remaining group is killed and the pipes are closed.
	drainTimeout = 2 * time.Second
)

// Sink receives every output line of a process: stdout and stderr lines and rendered log messages.
type Sink func(stream, line string)

// Options configure Spawn.
type Options struct {
	// Argv is the command (ParseCommand). Argv[0] is executed unless Path is set.
	Argv []string
	// Path is the resolved executable (ResolveExecutable); empty means Argv[0].
	Path string
	// Env is the complete environment (ConnectorEnv).
	Env []string
	// Dir is the working directory (/task).
	Dir string
	// TmpDir is the per-process TMPDIR (/tmp/scantor/proc-<slot>-<gen>): created (0700) before the start
	// and removed when the process is gone. Empty means none.
	TmpDir string
	// Mode is the welcome mode: worker, local or describe.
	Mode string
	// RuntimeVersion is announced in welcome.
	RuntimeVersion string
	// Limits are announced in welcome; MaxLineBytes is always the protocol constant.
	Limits protocol.Limits
	// Debug disables the hello and ready timeouts (`scantor dev debug`).
	Debug bool
	// Output receives output that is not attributed to a request (and, while no request sink is set,
	// everything). Nil discards it.
	Output Sink
	// Logger receives the process's own diagnostics.
	Logger *slog.Logger
	// Validator validates every line against the protocol schemas; nil uses the embedded schemas.
	Validator *protocol.Validator
	// HelloTimeout and ReadyTimeout override the protocol timers (tests); 0 uses the protocol values.
	HelloTimeout, ReadyTimeout time.Duration
}

// ExitStatus describes how a process ended.
type ExitStatus struct {
	// Code is the exit code, or -1 when the process was killed by a signal.
	Code int
	// Signal is the terminating signal name (SIGKILL), empty for a normal exit.
	Signal string
	// KilledByRuntime is true when the runtime killed the process group.
	KilledByRuntime bool
}

func (s ExitStatus) String() string {
	if s.Signal != "" {
		return "killed by " + s.Signal
	}
	return "exit code " + strconv.Itoa(s.Code)
}

// SpawnError is a failed spawn: the command could not start, the process exited or violated the protocol
// before ready, a handshake timer expired, there is no common protocol version, or the connector reported
// a handshake error (docs/runtime.md §7.5).
type SpawnError struct {
	Reason string
	// Connector is the connector's handshake error (taskError for an import failure, validation for an
	// invalid definition).
	Connector *protocol.ErrorObject
	// Unsupported is true when there is no common protocol version.
	Unsupported bool
	// Exit is set when the process ended.
	Exit *ExitStatus
	// StderrTail is the last 4 KiB of the process's stderr.
	StderrTail string
}

func (e *SpawnError) Error() string {
	if e.Connector != nil {
		return e.Reason + ": " + e.Connector.Message
	}
	return e.Reason
}

// ErrBusy is returned when a request is started while another one is in flight.
var ErrBusy = errors.New("connector process already has a request in flight")

// ErrNotReady is returned when a request is started on a process that is not ready (dead or violated).
var ErrNotReady = errors.New("connector process is not ready")

type procState int

const (
	stateHandshake procState = iota
	stateReady
	stateBroken // violated the protocol or was killed; no new requests
)

// Process is one running connector process.
type Process struct {
	opts   Options
	logger *slog.Logger
	cmd    *exec.Cmd
	pid    int

	in      *os.File // write end of the runtime → connector pipe (the child's fd 3)
	enc     *protocol.Encoder
	out     *os.File // read end of the connector → runtime pipe (the child's fd 4)
	stdout  *outputPipe
	stderr  *outputPipe
	outputs sync.WaitGroup

	hello   protocol.Hello
	version int

	mu         sync.Mutex
	state      procState
	call       *Call
	lastID     string
	seq        int
	connIDs    map[string]bool
	violated   bool
	violation  error // the violation of the request in flight
	hs         chan protocol.Message
	inClosed   bool
	requestOut atomic.Pointer[Sink]

	stderrTail *logtail.Buffer
	killed     atomic.Bool
	exited     chan struct{} // closed when the leader was reaped
	exit       ExitStatus
	done       chan struct{} // closed when the process is gone and all its output was read
}

// Spawn starts a connector process and performs the handshake (hello → welcome → ready). On failure the
// process group is killed and reaped and a *SpawnError is returned.
func Spawn(ctx context.Context, opts Options) (*Process, error) {
	if len(opts.Argv) == 0 {
		return nil, &SpawnError{Reason: "connector command is empty"}
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	if opts.Validator == nil {
		v, err := protocol.DefaultValidator()
		if err != nil {
			return nil, fmt.Errorf("protocol schemas: %w", err)
		}
		opts.Validator = v
	}
	p := &Process{
		opts: opts, logger: opts.Logger, connIDs: map[string]bool{}, hs: make(chan protocol.Message, 4),
		stderrTail: logtail.NewBuffer(StderrTailBytes), exited: make(chan struct{}), done: make(chan struct{}),
	}
	if opts.TmpDir != "" {
		if err := os.MkdirAll(opts.TmpDir, 0o700); err != nil {
			return nil, &SpawnError{Reason: "cannot create the process directory: " + err.Error()}
		}
	}
	if err := p.start(); err != nil {
		p.removeTmpDir()
		return nil, &SpawnError{Reason: "cannot start the connector: " + err.Error()}
	}
	if err := p.handshake(ctx); err != nil {
		p.Kill()
		<-p.done
		var se *SpawnError
		if errors.As(err, &se) {
			if se.Exit == nil {
				st := p.ExitStatus()
				se.Exit = &st
			}
			se.StderrTail = p.stderrTail.Tail(StderrTailBytes)
			return nil, se
		}
		return nil, err
	}
	return p, nil
}

func (p *Process) start() error {
	toChildR, toChildW, err := os.Pipe()
	if err != nil {
		return err
	}
	fromChildR, fromChildW, err := os.Pipe()
	if err != nil {
		closeAll(toChildR, toChildW)
		return err
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		closeAll(toChildR, toChildW, fromChildR, fromChildW)
		return err
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		closeAll(toChildR, toChildW, fromChildR, fromChildW, stdoutR, stdoutW)
		return err
	}
	path := p.opts.Path
	if path == "" {
		path = p.opts.Argv[0]
	}
	cmd := &exec.Cmd{
		Path:        path,
		Args:        p.opts.Argv,
		Env:         p.opts.Env,
		Dir:         p.opts.Dir,
		Stdout:      stdoutW,
		Stderr:      stderrW,
		ExtraFiles:  []*os.File{toChildR, fromChildW}, // fd 3, fd 4
		SysProcAttr: sysProcAttr(),
	}
	if err := cmd.Start(); err != nil {
		closeAll(toChildR, toChildW, fromChildR, fromChildW, stdoutR, stdoutW, stderrR, stderrW)
		return err
	}
	closeAll(toChildR, fromChildW, stdoutW, stderrW)
	p.cmd, p.pid = cmd, cmd.Process.Pid
	p.in, p.out = toChildW, fromChildR
	p.enc = protocol.NewEncoder(&deadlineWriter{f: toChildW})
	p.logger = p.logger.With("pid", p.pid)
	if err := raiseOOMScore(p.pid); err != nil {
		p.logger.Warn("cannot raise oom_score_adj of the connector process", "err", err)
	}
	p.stdout = &outputPipe{f: stdoutR}
	p.stderr = &outputPipe{f: stderrR}
	p.outputs.Add(2)
	go p.readOutput(p.stdout, StreamStdout)
	go p.readOutput(p.stderr, StreamStderr)
	go p.wait()
	go p.readMessages()
	return nil
}

func closeAll(files ...*os.File) {
	for _, f := range files {
		_ = f.Close()
	}
}

// wait reaps the leader, kills what is left of its group and, if output pipes stay open (inherited by
// processes that left the group), closes them after drainTimeout.
func (p *Process) wait() {
	err := p.cmd.Wait()
	st := ExitStatus{KilledByRuntime: p.killed.Load()}
	var ee *exec.ExitError
	switch {
	case err == nil:
		st.Code = 0
	case errors.As(err, &ee):
		st.Code = ee.ExitCode()
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			st.Code, st.Signal = -1, unix.SignalName(ws.Signal())
		}
	default:
		st.Code = -1
	}
	p.mu.Lock()
	p.exit = st
	p.mu.Unlock()
	close(p.exited)
	_ = syscall.Kill(-p.pid, syscall.SIGKILL) // stragglers of the group; the leader is gone
	timer := time.NewTimer(drainTimeout)
	defer timer.Stop()
	select {
	case <-p.done:
	case <-timer.C:
		p.logger.Warn("connector output pipes stayed open after exit; closing them")
		_ = p.out.Close()
		_ = p.stdout.f.Close()
		_ = p.stderr.f.Close()
	}
}

// PID returns the process id (also the process group id).
func (p *Process) PID() int { return p.pid }

// Hello returns the connector's hello message.
func (p *Process) Hello() protocol.Hello { return p.hello }

// ProtocolVersion returns the negotiated protocol version.
func (p *Process) ProtocolVersion() int { return p.version }

// Done is closed when the process has exited and all of its output was read.
func (p *Process) Done() <-chan struct{} { return p.done }

// Exited is closed when the leader process was reaped.
func (p *Process) Exited() <-chan struct{} { return p.exited }

// ExitStatus returns how the process ended; valid after Exited is closed.
func (p *Process) ExitStatus() ExitStatus {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.exit
}

// StderrTail returns the last 4 KiB of stderr.
func (p *Process) StderrTail() string { return p.stderrTail.Tail(StderrTailBytes) }

// Usable reports whether the process can take a request: ready, alive and without a violation.
func (p *Process) Usable() bool {
	select {
	case <-p.exited:
		return false
	default:
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.state == stateReady
}

// SetSink attributes output to a request: while set, every output line goes to s instead of
// Options.Output. ClearSink restores the default.
func (p *Process) SetSink(s Sink) { p.requestOut.Store(&s) }

// ClearSink removes the request sink.
func (p *Process) ClearSink() { p.requestOut.Store(nil) }

func (p *Process) emit(stream, line string) {
	if s := p.requestOut.Load(); s != nil {
		(*s)(stream, line)
		return
	}
	if p.opts.Output != nil {
		p.opts.Output(stream, line)
	}
}

// Kill kills the whole process group with SIGKILL (docs/protocol.md §10.4) without waiting.
func (p *Process) Kill() {
	p.killed.Store(true)
	p.mu.Lock()
	if p.state != stateBroken {
		p.state = stateBroken
	}
	p.mu.Unlock()
	_ = syscall.Kill(-p.pid, syscall.SIGKILL)
	p.closeInput()
}

// Shutdown ends an idle process gracefully: `shutdown {graceMs}`, close fd 3, wait up to grace for the
// exit, then kill the process group. It returns when the process is gone.
func (p *Process) Shutdown(grace time.Duration) {
	select {
	case <-p.done:
		return
	default:
	}
	p.mu.Lock()
	p.seq++
	id := "x" + strconv.Itoa(p.seq)
	usable := p.state == stateReady && p.call == nil
	p.mu.Unlock()
	if usable {
		if err := p.enc.Encode(protocol.Shutdown{ID: id, GraceMs: grace.Milliseconds()}); err != nil {
			p.logger.Debug("cannot send shutdown", "err", err)
		}
	}
	p.closeInput()
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case <-p.exited:
	case <-timer.C:
		p.Kill()
	}
	<-p.done
}

func (p *Process) closeInput() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.inClosed {
		p.inClosed = true
		_ = p.in.Close()
	}
}

// Flush waits (at most max) until stdout and stderr output written so far has reached the sink, so a
// reply's log tail includes the lines the connector printed before the reply.
func (p *Process) Flush(max time.Duration) {
	deadline := time.Now().Add(max)
	for time.Now().Before(deadline) {
		if p.stdout.drained() && p.stderr.drained() {
			return
		}
		select {
		case <-p.done:
			return
		case <-time.After(2 * time.Millisecond):
		}
	}
}

// handshake performs hello → welcome → ready (docs/protocol.md §4).
func (p *Process) handshake(ctx context.Context) error {
	helloTimeout, readyTimeout := protocol.HelloTimeout, protocol.ReadyTimeout
	if p.opts.HelloTimeout > 0 {
		helloTimeout = p.opts.HelloTimeout
	}
	if p.opts.ReadyTimeout > 0 {
		readyTimeout = p.opts.ReadyTimeout
	}
	msg, err := p.awaitHandshake(ctx, helloTimeout, "hello")
	if err != nil {
		return err
	}
	hello, ok := msg.(protocol.Hello)
	if !ok {
		return &SpawnError{Reason: fmt.Sprintf("protocol violation: the connector sent %s before hello", msg.MessageType())}
	}
	p.hello = hello
	v, ok := protocol.Negotiate(hello.Protocol)
	if !ok {
		message := fmt.Sprintf("connector protocol %d..%d is not supported by runtime %s (protocol %d..%d); publish a new revision to rebuild the task on a current base image",
			hello.Protocol.Min, hello.Protocol.Max, p.opts.RuntimeVersion, protocol.MinVersion, protocol.Version)
		_ = p.enc.Encode(protocol.Error{ID: protocol.HelloID, Error: protocol.ErrorObject{Type: protocol.ErrorValidation, Message: message}})
		return &SpawnError{Reason: message, Unsupported: true}
	}
	p.version = v
	limits := p.opts.Limits
	limits.MaxLineBytes = protocol.MaxLineBytes
	welcome := protocol.Welcome{
		ID: protocol.HelloID, ProtocolVersion: v, Mode: p.opts.Mode,
		Runtime: protocol.RuntimeInfo{Version: p.opts.RuntimeVersion}, Limits: limits,
		CancelGraceMs: protocol.CancelGrace.Milliseconds(),
	}
	if err := p.enc.Encode(welcome); err != nil {
		return &SpawnError{Reason: "cannot send welcome: " + err.Error()}
	}
	msg, err = p.awaitHandshake(ctx, readyTimeout, "ready")
	if err != nil {
		return err
	}
	switch m := msg.(type) {
	case protocol.Ready:
		p.mu.Lock()
		p.state = stateReady
		p.mu.Unlock()
		return nil
	case protocol.Error:
		obj := m.Error
		return &SpawnError{Reason: "the connector failed to load the task", Connector: &obj}
	default:
		return &SpawnError{Reason: fmt.Sprintf("protocol violation: the connector sent %s instead of ready", msg.MessageType())}
	}
}

func (p *Process) awaitHandshake(ctx context.Context, timeout time.Duration, what string) (protocol.Message, error) {
	var timeoutC <-chan time.Time
	if !p.opts.Debug {
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		timeoutC = timer.C
	}
	select {
	case msg, ok := <-p.hs:
		if !ok {
			return nil, p.endedBeforeReady()
		}
		if e, isErr := msg.(protocol.Error); isErr && what == "hello" {
			obj := e.Error
			return nil, &SpawnError{Reason: "the connector failed before hello", Connector: &obj}
		}
		return msg, nil
	case <-timeoutC:
		return nil, &SpawnError{Reason: fmt.Sprintf("connector did not send %s within %s", what, timeout)}
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// endedBeforeReady explains why the handshake channel closed: a violation or the process's exit.
func (p *Process) endedBeforeReady() error {
	p.mu.Lock()
	violated := p.violated
	p.mu.Unlock()
	if violated {
		return &SpawnError{Reason: "protocol violation during the handshake"}
	}
	<-p.exited
	st := p.ExitStatus()
	return &SpawnError{Reason: "connector exited before ready (" + st.String() + ")", Exit: &st}
}

// Describe starts a describe request.
func (p *Process) Describe() (*Call, error) {
	return p.startCall(KindDescribe, "d", func(id string) protocol.Message { return protocol.Describe{ID: id} })
}

// Schedule starts a schedule request.
func (p *Process) Schedule(ctx protocol.Ctx, scanConfig, taskConfig json.RawMessage) (*Call, error) {
	return p.startCall(KindSchedule, "s", func(id string) protocol.Message {
		return protocol.Schedule{ID: id, Ctx: ctx, ScanConfig: scanConfig, TaskConfig: taskConfig}
	})
}

// Run starts a run request.
func (p *Process) Run(ctx protocol.Ctx, analysisConfig, taskConfig json.RawMessage) (*Call, error) {
	return p.startCall(KindRun, "r", func(id string) protocol.Message {
		return protocol.Run{ID: id, Ctx: ctx, AnalysisConfig: analysisConfig, TaskConfig: taskConfig}
	})
}

func (p *Process) startCall(kind, prefix string, build func(id string) protocol.Message) (*Call, error) {
	p.mu.Lock()
	if p.state != stateReady {
		p.mu.Unlock()
		return nil, ErrNotReady
	}
	if p.call != nil {
		p.mu.Unlock()
		return nil, ErrBusy
	}
	p.seq++
	c := &Call{p: p, ID: prefix + strconv.Itoa(p.seq), Kind: kind, events: make(chan Event), ended: make(chan struct{}), templates: map[string]bool{}}
	p.call = c
	p.mu.Unlock()
	if err := p.send(build(c.ID)); err != nil {
		c.End()
		return nil, err
	}
	return c, nil
}

func (p *Process) send(msg protocol.Message) error {
	if err := p.enc.Encode(msg); err != nil {
		return fmt.Errorf("send %s to the connector: %w", msg.MessageType(), err)
	}
	return nil
}

// readMessages reads fd 4 until EOF, validating and routing every line.
func (p *Process) readMessages() {
	dec := protocol.NewDecoder(p.out)
	for {
		line, err := dec.ReadLine()
		if err != nil {
			switch {
			case errors.Is(err, io.EOF), errors.Is(err, os.ErrClosed):
			case errors.Is(err, protocol.ErrLineTooLong):
				p.violate(fmt.Errorf("line exceeds %d bytes", protocol.MaxLineBytes))
				continue
			default:
				p.violate(err)
			}
			break
		}
		if p.isViolated() {
			continue // drain until the killed group closes the pipe
		}
		if err := protocol.CheckFraming(line, protocol.MaxLineBytes); err != nil {
			p.violate(err)
			continue
		}
		if err := p.opts.Validator.ValidateLine(protocol.ConnectorToRuntime, line); err != nil {
			p.violate(err)
			continue
		}
		msg, err := protocol.Unmarshal(line)
		if err != nil {
			p.violate(err)
			continue
		}
		p.route(msg)
	}
	p.outputs.Wait()
	<-p.exited
	p.mu.Lock()
	call := p.call
	st := p.exit
	violation := p.violation
	if p.state == stateHandshake {
		close(p.hs)
	}
	p.state = stateBroken
	p.mu.Unlock()
	p.removeTmpDir()
	if call != nil {
		// The request learns how it ended (the violation first) whenever its consumer reads next; the
		// process is gone either way, so Done does not wait for that.
		go func() {
			if violation != nil {
				call.deliver(Event{Violation: violation})
			}
			call.deliver(Event{Exit: &st})
		}()
	}
	close(p.done)
}

func (p *Process) removeTmpDir() {
	if p.opts.TmpDir == "" {
		return
	}
	if err := os.RemoveAll(p.opts.TmpDir); err != nil {
		p.logger.Warn("cannot remove the process directory", "dir", p.opts.TmpDir, "err", err)
	}
}

func (p *Process) isViolated() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.violated
}

// violate records a protocol violation (docs/protocol.md §7.3) and kills the process group; the request
// in flight receives the violation when the process is gone.
func (p *Process) violate(err error) {
	p.mu.Lock()
	if p.violated {
		p.mu.Unlock()
		return
	}
	p.violated = true
	if p.call != nil {
		p.violation = err
	}
	handshake := p.state == stateHandshake
	if handshake {
		close(p.hs)
		p.state = stateBroken
	}
	p.mu.Unlock()
	p.logger.Warn("connector protocol violation", "err", err)
	p.Kill()
}

// route dispatches one valid connector message (docs/protocol.md §3, §7.3).
func (p *Process) route(msg protocol.Message) {
	p.mu.Lock()
	if p.state == stateHandshake {
		p.mu.Unlock()
		switch m := msg.(type) {
		case protocol.Hello, protocol.Ready:
			p.handshakeMessage(msg)
		case protocol.Error:
			if m.ID != protocol.HelloID {
				p.violate(fmt.Errorf("error with id %q during the handshake", m.ID))
				return
			}
			p.handshakeMessage(msg)
		case protocol.Log:
			p.emitLog(m, false)
		default:
			p.violate(fmt.Errorf("%s during the handshake", msg.MessageType()))
		}
		return
	}
	call := p.call
	deliver, err := p.classify(call, msg)
	p.mu.Unlock()
	if err != nil {
		p.violate(err)
		return
	}
	if log, ok := msg.(protocol.Log); ok {
		p.emitLog(log, log.Parent != nil && call != nil && *log.Parent == call.ID)
		return
	}
	if deliver {
		call.deliver(Event{Msg: msg})
	}
}

// handshakeMessage queues a handshake message for Spawn. The handshake reads at most two, so a connector
// that floods handshake messages is a violation instead of a blocked reader.
func (p *Process) handshakeMessage(msg protocol.Message) {
	select {
	case p.hs <- msg:
	default:
		p.violate(fmt.Errorf("unexpected %s during the handshake", msg.MessageType()))
	}
}

// classify decides (under p.mu) whether msg goes to the call, is dropped, or violates the protocol.
func (p *Process) classify(c *Call, msg protocol.Message) (bool, error) {
	isCurrent := func(id string) bool { return c != nil && id == c.ID }
	reply := func(id string, kinds ...string) (bool, error) {
		if !isCurrent(id) {
			return false, fmt.Errorf("%s for unknown or finished request %q", msg.MessageType(), id)
		}
		if c.replied {
			return false, fmt.Errorf("second reply to request %q", id)
		}
		for _, k := range kinds {
			if c.Kind == k {
				return true, nil
			}
		}
		return false, fmt.Errorf("%s is not a reply to %s", msg.MessageType(), c.Kind)
	}
	newConnectorID := func(id string) error {
		if p.connIDs[id] {
			return fmt.Errorf("connector request id %q reused", id)
		}
		p.connIDs[id] = true
		return nil
	}
	switch m := msg.(type) {
	case protocol.Hello, protocol.Ready:
		return false, fmt.Errorf("%s after the handshake", msg.MessageType())
	case protocol.Description:
		ok, err := reply(m.ID, KindDescribe)
		if ok {
			c.replied = true
		}
		return ok, err
	case protocol.Analysis:
		return reply(m.ID, KindSchedule)
	case protocol.Done:
		ok, err := reply(m.ID, KindSchedule)
		if ok {
			c.replied = true
		}
		return ok, err
	case protocol.Result:
		ok, err := reply(m.ID, KindRun)
		if ok {
			c.replied = true
		}
		return ok, err
	case protocol.Error:
		ok, err := reply(m.ID, KindDescribe, KindSchedule, KindRun)
		if ok {
			c.replied = true
		}
		return ok, err
	case protocol.File:
		if !isCurrent(m.Parent) {
			return false, fmt.Errorf("file request with parent %q, which is not the request in flight", m.Parent)
		}
		return true, newConnectorID(m.ID)
	case protocol.Template:
		if !isCurrent(m.Parent) {
			return false, fmt.Errorf("template request with parent %q, which is not the request in flight", m.Parent)
		}
		if err := newConnectorID(m.ID); err != nil {
			return false, err
		}
		c.templates[m.ID] = true
		return true, nil
	case protocol.TemplateCredit:
		return c.templateMessage(m.ID, msg)
	case protocol.TemplateCancel:
		return c.templateMessage(m.ID, msg)
	case protocol.Log:
		if m.Parent == nil || isCurrent(*m.Parent) || *m.Parent == p.lastID {
			return false, nil
		}
		return false, fmt.Errorf("log with parent %q, which is not the request in flight", *m.Parent)
	case protocol.Progress:
		switch {
		case isCurrent(m.Parent):
			return c.Kind == KindRun, nil // progress outside a run is ignored
		case m.Parent == p.lastID:
			return false, nil
		default:
			return false, fmt.Errorf("progress with parent %q, which is not the request in flight", m.Parent)
		}
	default:
		return false, fmt.Errorf("unexpected %s from the connector", msg.MessageType())
	}
}

// emitLog renders a log message into the output stream: "[<level>] <message>" plus " key=value" per
// field, on the stderr stream. Only logs of the request in flight are attributed to it; the others go
// to the default output.
func (p *Process) emitLog(m protocol.Log, attributed bool) {
	var b strings.Builder
	b.WriteString("[" + m.Level + "] " + m.Message)
	for _, kv := range orderedFields(m.Fields) {
		b.WriteString(" " + kv)
	}
	for _, line := range strings.Split(b.String(), "\n") {
		switch {
		case attributed:
			p.emit(StreamStderr, line)
		case p.opts.Output != nil:
			p.opts.Output(StreamStderr, line)
		}
	}
}

// orderedFields renders the members of a JSON object as key=value in their original order; string values
// are written as is, others as compact JSON.
func orderedFields(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil
	}
	var out []string
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return out
		}
		key, _ := tok.(string)
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return out
		}
		var s string
		if json.Unmarshal(v, &s) == nil {
			out = append(out, key+"="+s)
			continue
		}
		var compact bytes.Buffer
		if json.Compact(&compact, v) == nil {
			out = append(out, key+"="+compact.String())
		}
	}
	return out
}

func (p *Process) readOutput(pipe *outputPipe, stream string) {
	defer p.outputs.Done()
	err := logtail.SplitLines(pipe, func(line string) {
		if stream == StreamStderr {
			p.stderrTail.WriteString(line + "\n")
		}
		p.emit(stream, line)
	})
	if err != nil && !errors.Is(err, os.ErrClosed) {
		p.logger.Debug("reading connector output", "stream", stream, "err", err)
	}
	pipe.finished.Store(true)
}

// outputPipe is a stdout/stderr pipe whose reader reports when it is blocked waiting for new data.
type outputPipe struct {
	f        *os.File
	reading  atomic.Bool
	finished atomic.Bool
}

func (o *outputPipe) Read(b []byte) (int, error) {
	o.reading.Store(true)
	defer o.reading.Store(false)
	return o.f.Read(b)
}

// drained reports whether everything written to the pipe so far was read and handed to the sink: the
// reader is blocked in Read (so every complete buffered line was emitted) and the pipe is empty.
func (o *outputPipe) drained() bool {
	if o.finished.Load() {
		return true
	}
	if !o.reading.Load() {
		return false
	}
	// SyscallConn keeps the descriptor in non-blocking mode (Fd would switch it to blocking).
	rc, err := o.f.SyscallConn()
	if err != nil {
		return true
	}
	pending := 0
	if cerr := rc.Control(func(fd uintptr) {
		n, ierr := unix.IoctlGetInt(int(fd), fionread)
		if ierr == nil {
			pending = n
		}
	}); cerr != nil {
		return true
	}
	return pending == 0
}

// deadlineWriter writes to a pipe with a per-write deadline.
type deadlineWriter struct{ f *os.File }

func (w *deadlineWriter) Write(b []byte) (int, error) {
	if err := w.f.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil && !errors.Is(err, os.ErrNoDeadline) {
		return 0, err
	}
	return w.f.Write(b)
}
