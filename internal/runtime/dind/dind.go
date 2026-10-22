// Package dind starts and stops the inner Docker daemon of Docker-in-Docker workers (SCANTOR_DIND=1,
// docs/runtime.md §4.4): dockerd runs in its own process group with stdin /dev/null, its output is
// mirrored into the runtime log (stream "dockerd") with the last 4 KiB kept, and the runtime waits until
// /var/run/docker.sock answers GET /_ping before any connector process starts.
package dind

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/lonetis/scantor/internal/runtime/logtail"
)

// Defaults of the inner daemon (docs/runtime.md §4.4, §17).
const (
	DefaultSocket = "/var/run/docker.sock"
	ReadyTimeout  = 60 * time.Second
	StopGrace     = 3 * time.Second
	pollInterval  = 250 * time.Millisecond
	tailBytes     = 4 << 10
)

// ErrMissing is returned when dockerd is not in PATH.
var ErrMissing = errors.New("SCANTOR_DIND=1 but dockerd is not installed in the task image; install Docker in the task's Dockerfile")

// Options configure Start.
type Options struct {
	// Environ is the environment of dockerd (the runtime's, which has PATH).
	Environ []string
	// Command overrides the dockerd command (tests); empty resolves "dockerd" in PATH.
	Command []string
	// Socket is the socket to wait for (DefaultSocket when empty).
	Socket string
	// Timeout bounds readiness (ReadyTimeout when 0).
	Timeout time.Duration
	Logger  *slog.Logger
}

// Daemon is a running inner dockerd.
type Daemon struct {
	cmd    *exec.Cmd
	tail   *logtail.Buffer
	exited chan struct{}
	mu     sync.Mutex
	err    error
	output sync.WaitGroup
	pipes  []*os.File
}

// outputDrain bounds the wait for dockerd's output after it exited (its children may keep the pipes).
const outputDrain = 2 * time.Second

// drainOutput waits for the output readers, closing the pipes when they stay open.
func (d *Daemon) drainOutput() {
	done := make(chan struct{})
	go func() {
		d.output.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(outputDrain):
		for _, f := range d.pipes {
			_ = f.Close()
		}
		<-done
	}
}

// Start starts dockerd and waits until its socket answers /_ping. On failure the process group is
// killed; the error carries the kept output (Tail).
func Start(ctx context.Context, opts Options) (*Daemon, error) {
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	argv := opts.Command
	if len(argv) == 0 {
		path, err := lookPath("dockerd", opts.Environ)
		if err != nil {
			return nil, ErrMissing
		}
		argv = []string{path}
	}
	socket := opts.Socket
	if socket == "" {
		socket = DefaultSocket
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = ReadyTimeout
	}
	devnull, err := os.Open(os.DevNull)
	if err != nil {
		return nil, err
	}
	defer devnull.Close()
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		_ = stdoutR.Close()
		_ = stdoutW.Close()
		return nil, err
	}
	d := &Daemon{tail: logtail.NewBuffer(tailBytes), exited: make(chan struct{})}
	d.cmd = &exec.Cmd{
		Path: argv[0], Args: argv, Env: opts.Environ, Stdin: devnull, Stdout: stdoutW, Stderr: stderrW,
		SysProcAttr: &syscall.SysProcAttr{Setpgid: true},
	}
	if err := d.cmd.Start(); err != nil {
		for _, f := range []*os.File{stdoutR, stdoutW, stderrR, stderrW} {
			_ = f.Close()
		}
		return nil, fmt.Errorf("start dockerd: %w", err)
	}
	_ = stdoutW.Close()
	_ = stderrW.Close()
	mirror := logtail.NewMirror(opts.Logger, "dockerd output")
	sink := mirror.Sink()
	d.pipes = []*os.File{stdoutR, stderrR}
	for _, r := range d.pipes {
		d.output.Go(func() {
			defer r.Close()
			_ = logtail.SplitLines(r, func(line string) {
				d.tail.WriteString(line + "\n")
				sink("dockerd", line)
			})
		})
	}
	go func() {
		err := d.cmd.Wait()
		d.mu.Lock()
		d.err = err
		d.mu.Unlock()
		close(d.exited)
	}()
	if err := d.waitReady(ctx, socket, timeout); err != nil {
		d.kill()
		return nil, err
	}
	return d, nil
}

// lookPath resolves name in the PATH of environ.
func lookPath(name string, environ []string) (string, error) {
	path := ""
	for i := len(environ) - 1; i >= 0; i-- {
		if v, ok := strings.CutPrefix(environ[i], "PATH="); ok {
			path = v
			break
		}
	}
	for _, dir := range strings.Split(path, ":") {
		if dir == "" {
			continue
		}
		p := dir + "/" + name
		if st, err := os.Stat(p); err == nil && !st.IsDir() && st.Mode().Perm()&0o111 != 0 {
			return p, nil
		}
	}
	return "", exec.ErrNotFound
}

// ReadyError is a dockerd that did not become ready.
type ReadyError struct {
	Message string
	Tail    string
}

func (e *ReadyError) Error() string { return e.Message }

func (d *Daemon) waitReady(ctx context.Context, socket string, timeout time.Duration) error {
	client := &http.Client{
		Timeout: 2 * time.Second,
		Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "unix", socket)
		}},
	}
	defer client.CloseIdleConnections()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	tick := time.NewTicker(pollInterval)
	defer tick.Stop()
	for {
		if ping(ctx, client) {
			return nil
		}
		select {
		case <-tick.C:
		case <-d.exited:
			d.drainOutput()
			return &ReadyError{Message: fmt.Sprintf("dockerd exited before it became ready (%s)", d.exitText()), Tail: d.Tail()}
		case <-deadline.C:
			return &ReadyError{Message: "dockerd did not become ready within " + humanDuration(timeout), Tail: d.Tail()}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// humanDuration writes whole seconds as "60 s" (the message of docs/runtime.md §4.4) and anything else
// in Go's form.
func humanDuration(d time.Duration) string {
	if d%time.Second == 0 {
		return fmt.Sprintf("%d s", d/time.Second)
	}
	return d.String()
}

func ping(ctx context.Context, client *http.Client) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/_ping", nil)
	if err != nil {
		return false
	}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// Exited is closed when dockerd exited.
func (d *Daemon) Exited() <-chan struct{} { return d.exited }

// ExitText describes how dockerd ended ("exit code 1").
func (d *Daemon) ExitText() string { return d.exitText() }

func (d *Daemon) exitText() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	var ee *exec.ExitError
	switch {
	case d.err == nil:
		return "exit code 0"
	case errors.As(d.err, &ee):
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			return "signal " + ws.Signal().String()
		}
		return fmt.Sprintf("exit code %d", ee.ExitCode())
	default:
		return d.err.Error()
	}
}

// Tail returns the last 4 KiB of dockerd's output.
func (d *Daemon) Tail() string { return d.tail.Tail(tailBytes) }

// Stop sends SIGTERM to dockerd and SIGKILL to its process group after 3 s (docs/runtime.md §4.4 step 6).
func (d *Daemon) Stop() {
	select {
	case <-d.exited:
		return
	default:
	}
	_ = syscall.Kill(d.cmd.Process.Pid, syscall.SIGTERM)
	select {
	case <-d.exited:
	case <-time.After(StopGrace):
	}
	d.kill()
}

func (d *Daemon) kill() {
	_ = syscall.Kill(-d.cmd.Process.Pid, syscall.SIGKILL)
	<-d.exited
	d.drainOutput()
}
