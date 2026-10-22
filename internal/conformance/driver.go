package conformance

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/lonetis/scantor/internal/protocol"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/pool"
)

// conn is one connector process driven by the harness: the runtime's side of the protocol with raw
// access, so cases can send what the real runtime never would (unknown fields and types, errors to
// hello). Every line the connector writes on fd 4 is checked for framing and validated against
// message.schema.json#/$defs/connectorToRuntime (P1).
type conn struct {
	h      *H
	cmd    *exec.Cmd
	in     *os.File // the child's fd 3
	out    *os.File // the child's fd 4
	stdout *capture
	stderr *capture
	msgs   chan message
	exited chan struct{}
	status syscall.WaitStatus

	gate   sync.Mutex // held while reading fd 4 is paused
	paused bool
	encMu  sync.Mutex
	seq    int
}

// message is one connector line.
type message struct {
	msg  protocol.Message
	line []byte
}

// capture collects a stdout or stderr pipe.
type capture struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (c *capture) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.buf.Len() < 4<<20 {
		c.buf.Write(p)
	}
	return len(p), nil
}

func (c *capture) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.String()
}

// spawnOptions select how a connector is started.
type spawnOptions struct {
	// noFDs starts the connector without fds 3/4 and without the protocol variables (H5).
	noFDs bool
	// entry replaces the fixture's entry.
	entry string
}

// spawn starts the fixture's connector exactly as docs/protocol.md §10.2 describes.
func (h *H) spawn(opts spawnOptions) (*conn, error) {
	entry := h.cfg.Entry
	if opts.entry != "" {
		entry = opts.entry
	}
	argv, err := pool.ParseCommand(h.cfg.ConnectorCmd, entry)
	if err != nil {
		return nil, fmt.Errorf("invalid %s: %w", runtime.EnvConnectorCmd, err)
	}
	exe, err := pool.ResolveExecutable(argv[0], h.cfg.TaskDir, h.cfg.Environ)
	if err != nil {
		return nil, err
	}
	h.procs++
	tmp := fmt.Sprintf("%s/proc-0-%d", h.cfg.WorkRoot, h.procs)
	if err := os.MkdirAll(tmp, 0o700); err != nil {
		return nil, err
	}
	c := &conn{h: h, stdout: &capture{}, stderr: &capture{}, msgs: make(chan message), exited: make(chan struct{})}
	env := pool.ConnectorEnv(h.cfg.Environ, tmp, 0)
	devnull, err := os.Open(os.DevNull)
	if err != nil {
		return nil, err
	}
	defer devnull.Close()
	c.cmd = &exec.Cmd{Path: exe, Args: argv, Dir: h.cfg.TaskDir, Stdin: devnull, Stdout: c.stdout, Stderr: c.stderr, SysProcAttr: &syscall.SysProcAttr{Setpgid: true}}
	if opts.noFDs {
		c.cmd.Env = withoutProtocolEnv(env)
		if err := c.cmd.Start(); err != nil {
			return nil, err
		}
		go c.wait()
		h.cleanup(c.kill)
		close(c.msgs)
		return c, nil
	}
	toChild, toChildW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	fromChildR, fromChild, err := os.Pipe()
	if err != nil {
		_ = toChild.Close()
		_ = toChildW.Close()
		return nil, err
	}
	c.cmd.Env = env
	c.cmd.ExtraFiles = []*os.File{toChild, fromChild}
	if err := c.cmd.Start(); err != nil {
		for _, f := range []*os.File{toChild, toChildW, fromChildR, fromChild} {
			_ = f.Close()
		}
		return nil, err
	}
	_ = toChild.Close()
	_ = fromChild.Close()
	c.in, c.out = toChildW, fromChildR
	go c.wait()
	go c.read()
	h.cleanup(c.kill)
	return c, nil
}

func withoutProtocolEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		if !strings.HasPrefix(kv, "SCANTOR_PROTOCOL_") {
			out = append(out, kv)
		}
	}
	return out
}

func (c *conn) pid() int { return c.cmd.Process.Pid }

func (c *conn) wait() {
	_ = c.cmd.Wait()
	if ws, ok := c.cmd.ProcessState.Sys().(syscall.WaitStatus); ok {
		c.status = ws
	}
	close(c.exited)
}

// read reads fd 4 while not paused, checks every line (P1) and hands it to recv.
func (c *conn) read() {
	defer close(c.msgs)
	dec := protocol.NewDecoder(c.out)
	for {
		c.gate.Lock()
		c.gate.Unlock() //nolint:staticcheck // the lock is the pause gate (S5)
		line, err := dec.ReadLine()
		switch {
		case errors.Is(err, io.EOF), errors.Is(err, os.ErrClosed):
			return
		case errors.Is(err, protocol.ErrLineTooLong):
			c.h.failf("P1: a line on fd 4 exceeds %d bytes", protocol.MaxLineBytes)
			continue
		case err != nil:
			c.h.failf("P1: reading fd 4: %v", err)
			return
		}
		if err := protocol.CheckFraming(line, protocol.MaxLineBytes); err != nil {
			c.h.failf("P1: %v: %s", err, excerpt(line))
			continue
		}
		if err := c.h.validator.ValidateLine(protocol.ConnectorToRuntime, line); err != nil {
			c.h.failf("P1: %v: %s", err, excerpt(line))
			continue
		}
		msg, err := protocol.Unmarshal(line)
		if err != nil {
			c.h.failf("P1: %v: %s", err, excerpt(line))
			continue
		}
		c.msgs <- message{msg: msg, line: line}
	}
}

func excerpt(line []byte) string {
	s := strings.TrimRight(string(line), "\n")
	if len(s) > 300 {
		return s[:300] + "…"
	}
	return s
}

// pause stops reading fd 4 (the connector's writes block once the pipe is full); resume continues.
func (c *conn) pause() {
	c.gate.Lock()
	c.paused = true
}

func (c *conn) resume() {
	if c.paused {
		c.paused = false
		c.gate.Unlock()
	}
}

// errTimeout and errClosed are the failures of recv.
var (
	errTimeout = errors.New("timed out waiting for a message")
	errClosed  = errors.New("the connector closed fd 4")
)

// recv returns the next message within timeout.
func (c *conn) recv(timeout time.Duration) (protocol.Message, error) {
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case m, ok := <-c.msgs:
		if !ok {
			return nil, errClosed
		}
		return m.msg, nil
	case <-t.C:
		return nil, errTimeout
	}
}

// send writes one message.
func (c *conn) send(msg protocol.Message) error {
	b, err := protocol.Marshal(msg)
	if err != nil {
		return err
	}
	return c.sendLine(b)
}

// sendRaw writes an arbitrary JSON object (unknown fields or types).
func (c *conn) sendRaw(v map[string]any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.sendLine(b)
}

func (c *conn) sendLine(b []byte) error {
	c.encMu.Lock()
	defer c.encMu.Unlock()
	_, err := c.in.Write(append(b, '\n'))
	return err
}

// with returns msg marshalled with extra fields added (P2).
func with(msg protocol.Message, extra map[string]any) map[string]any {
	b, _ := protocol.Marshal(msg)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func (c *conn) nextID(prefix string) string {
	c.seq++
	return fmt.Sprintf("%s%d", prefix, c.seq)
}

// waitExit waits up to timeout for the process to exit and returns its exit code (-1 for a signal).
func (c *conn) waitExit(timeout time.Duration) (int, bool) {
	select {
	case <-c.exited:
		if c.status.Signaled() {
			return -1, true
		}
		return c.status.ExitStatus(), true
	case <-time.After(timeout):
		return 0, false
	}
}

// kill kills the process group and waits for the leader.
func (c *conn) kill() {
	c.resume()
	_ = syscall.Kill(-c.pid(), syscall.SIGKILL)
	if c.in != nil {
		_ = c.in.Close()
	}
	<-c.exited
}

// groupGone reports whether no process of the connector's group remains.
func (c *conn) groupGone() bool {
	return errors.Is(syscall.Kill(-c.pid(), 0), syscall.ESRCH)
}

// handshake performs hello → welcome → ready (docs/protocol.md §4) and checks hello (H1).
func (c *conn) handshake(extraWelcome map[string]any) (protocol.Hello, error) {
	m, err := c.recv(protocol.HelloTimeout)
	if err != nil {
		return protocol.Hello{}, fmt.Errorf("no hello: %w (stderr: %s)", err, tail(c.stderr.String()))
	}
	hello, ok := m.(protocol.Hello)
	if !ok {
		return protocol.Hello{}, fmt.Errorf("the first message is %s, not hello", m.MessageType())
	}
	if _, ok := protocol.Negotiate(hello.Protocol); !ok {
		return hello, fmt.Errorf("hello protocol %d..%d has no version in common with %d..%d", hello.Protocol.Min, hello.Protocol.Max, protocol.MinVersion, protocol.Version)
	}
	welcome := protocol.Welcome{
		ID: protocol.HelloID, ProtocolVersion: protocol.Version, Mode: protocol.ModeWorker,
		Runtime: protocol.RuntimeInfo{Version: "conformance"}, Limits: runtime.DefaultLimits(), CancelGraceMs: protocol.CancelGrace.Milliseconds(),
	}
	if extraWelcome != nil {
		err = c.sendRaw(with(welcome, extraWelcome))
	} else {
		err = c.send(welcome)
	}
	if err != nil {
		return hello, err
	}
	m, err = c.recv(protocol.ReadyTimeout)
	if err != nil {
		return hello, fmt.Errorf("no ready: %w (stderr: %s)", err, tail(c.stderr.String()))
	}
	switch r := m.(type) {
	case protocol.Ready:
		if r.ID != protocol.HelloID {
			return hello, fmt.Errorf("ready has id %q", r.ID)
		}
		return hello, nil
	case protocol.Error:
		return hello, fmt.Errorf("the connector failed to load the task: %s %s", r.Error.Type, r.Error.Message)
	default:
		return hello, fmt.Errorf("%s instead of ready", m.MessageType())
	}
}

func tail(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 2000 {
		return "…" + s[len(s)-2000:]
	}
	return s
}
