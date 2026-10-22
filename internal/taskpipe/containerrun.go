package taskpipe

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/moby/moby/api/pkg/stdcopy"
	containertypes "github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/container"
)

// containerRun runs one container with the injected runtime to completion: create, inject, attach,
// start, stream its output line by line, wait (with an optional timeout), run afterExit and remove it
// with its anonymous volumes.
type containerRun struct {
	docker client.APIClient
	create client.ContainerCreateOptions
	bin    *container.Binary
	extra  []container.File
	// timeout kills the container after this duration; 0 means none.
	timeout time.Duration
	// stopGrace is the time between SIGTERM and SIGKILL when ctx is cancelled; 0 kills at once.
	stopGrace time.Duration
	// maxLine bounds one output line; longer lines are cut.
	maxLine int
	stdout  func(line []byte)
	stderr  func(line []byte)
	// afterExit runs after the container exited and before it is removed (CopyFromContainer).
	afterExit func(ctx context.Context, id string) error
}

// containerExit is how a container ended.
type containerExit struct {
	Code        int64
	TimedOut    bool
	Interrupted bool
}

// outputDrainTimeout bounds the wait for the last output after the container exited.
const outputDrainTimeout = 10 * time.Second

func (c containerRun) run(ctx context.Context) (exit containerExit, err error) {
	cleanupCtx := context.WithoutCancel(ctx)
	created, err := c.docker.ContainerCreate(ctx, c.create)
	if err != nil {
		return exit, fmt.Errorf("create container %s: %w", c.create.Name, err)
	}
	id := created.ID
	defer func() {
		if _, rmErr := c.docker.ContainerRemove(cleanupCtx, id, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true}); rmErr != nil && !container.IsNotFound(rmErr) {
			err = errors.Join(err, fmt.Errorf("remove container %s: %w", c.create.Name, rmErr))
		}
	}()
	if err := container.Inject(ctx, c.docker, id, c.bin, c.extra); err != nil {
		return exit, err
	}
	attached, err := c.docker.ContainerAttach(ctx, id, client.ContainerAttachOptions{Stream: true, Stdout: true, Stderr: true})
	if err != nil {
		return exit, fmt.Errorf("attach to container %s: %w", c.create.Name, err)
	}
	defer attached.Close()
	waitCtx, cancelWait := context.WithCancel(cleanupCtx)
	defer cancelWait()
	wait := c.docker.ContainerWait(waitCtx, id, client.ContainerWaitOptions{Condition: containertypes.WaitConditionNextExit})
	output := c.pump(attached.Reader)
	if _, err := c.docker.ContainerStart(ctx, id, client.ContainerStartOptions{}); err != nil {
		return exit, fmt.Errorf("start container %s: %w", c.create.Name, err)
	}

	var timeout <-chan time.Time
	if c.timeout > 0 {
		timer := time.NewTimer(c.timeout)
		defer timer.Stop()
		timeout = timer.C
	}
	done := ctx.Done()
	var grace <-chan time.Time
	for {
		select {
		case res := <-wait.Result:
			exit.Code = res.StatusCode
			c.drain(output)
			if c.afterExit != nil {
				if err := c.afterExit(cleanupCtx, id); err != nil {
					return exit, err
				}
			}
			return exit, nil
		case err := <-wait.Error:
			return exit, fmt.Errorf("wait for container %s: %w", c.create.Name, err)
		case <-timeout:
			exit.TimedOut, timeout = true, nil
			c.kill(cleanupCtx, id, "SIGKILL")
		case <-grace:
			grace = nil
			c.kill(cleanupCtx, id, "SIGKILL")
		case <-done:
			exit.Interrupted, done = true, nil
			if c.stopGrace <= 0 {
				c.kill(cleanupCtx, id, "SIGKILL")
				continue
			}
			c.kill(cleanupCtx, id, "SIGTERM")
			timer := time.NewTimer(c.stopGrace)
			defer timer.Stop()
			grace = timer.C
		}
	}
}

func (c containerRun) kill(ctx context.Context, id, signal string) {
	// A container that already exited cannot be signalled; the wait result follows either way.
	_, _ = c.docker.ContainerKill(ctx, id, client.ContainerKillOptions{Signal: signal})
}

// pump demultiplexes the attach stream into line callbacks; the returned channel closes when the
// stream ended.
func (c containerRun) pump(r io.Reader) <-chan struct{} {
	outR, outW := io.Pipe()
	errR, errW := io.Pipe()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); scanLines(outR, c.maxLine, c.stdout) }()
	go func() { defer wg.Done(); scanLines(errR, c.maxLine, c.stderr) }()
	done := make(chan struct{})
	go func() {
		_, err := stdcopy.StdCopy(outW, errW, r)
		outW.CloseWithError(err)
		errW.CloseWithError(err)
		wg.Wait()
		close(done)
	}()
	return done
}

func (c containerRun) drain(output <-chan struct{}) {
	select {
	case <-output:
	case <-time.After(outputDrainTimeout):
	}
}

// scanLines calls fn for every line of r (without the newline); lines longer than maxLine are cut. fn
// must not retain the slice. It consumes r to the end.
func scanLines(r io.Reader, maxLine int, fn func([]byte)) {
	br := bufio.NewReaderSize(r, 64<<10)
	var line []byte
	cut := false
	for {
		chunk, err := br.ReadSlice('\n')
		if !cut {
			line = append(line, chunk...)
			if maxLine > 0 && len(line) > maxLine {
				line, cut = line[:maxLine], true
			}
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if len(line) > 0 || err == nil {
			if fn != nil {
				fn(trimNewline(line))
			}
		}
		line, cut = line[:0], false
		if err != nil {
			_, _ = io.Copy(io.Discard, br)
			return
		}
	}
}

func trimNewline(b []byte) []byte {
	if n := len(b); n > 0 && b[n-1] == '\n' {
		b = b[:n-1]
		if n := len(b); n > 0 && b[n-1] == '\r' {
			b = b[:n-1]
		}
	}
	return b
}
