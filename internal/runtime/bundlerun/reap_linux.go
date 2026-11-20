//go:build linux

package bundlerun

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

// reapPoll reaps orphans even when a SIGCHLD was coalesced away.
const reapPoll = time.Second

// Reap makes bundle mode a proper PID 1 (docs/runtime.md §15.7): a bundle image runs without docker run
// --init, so when this process is PID 1 it starts /proc/self/exe with args as its child, forwards SIGINT,
// SIGTERM, SIGHUP and SIGQUIT to it, reaps every orphan the connectors leave and returns the child's exit
// code (128 + signal when a signal ended it). handled is false when this process is not PID 1: it then
// runs the bundle itself.
func Reap(args []string) (code int, handled bool) {
	if os.Getpid() != 1 {
		return 0, false
	}
	signals := make(chan os.Signal, 16)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGQUIT, syscall.SIGCHLD)
	defer signal.Stop(signals)
	cmd := exec.Command("/proc/self/exe", args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "cannot start the bundle run: %v\n", err)
		return 3, true
	}
	child := cmd.Process.Pid
	poll := time.NewTicker(reapPoll)
	defer poll.Stop()
	for {
		select {
		case sig := <-signals:
			if sig != syscall.SIGCHLD {
				_ = cmd.Process.Signal(sig)
				continue
			}
		case <-poll.C:
		}
		if code, exited := reapAll(child); exited {
			return code, true
		}
	}
}

// reapAll waits for every exited child without blocking and reports the exit code of child once it exited.
func reapAll(child int) (int, bool) {
	for {
		var status syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if err != nil || pid <= 0 {
			return 0, false
		}
		if pid != child {
			continue
		}
		switch {
		case status.Exited():
			return status.ExitStatus(), true
		case status.Signaled():
			return 128 + int(status.Signal()), true
		}
	}
}
