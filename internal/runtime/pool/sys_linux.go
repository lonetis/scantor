//go:build linux

package pool

import (
	"fmt"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

// fionread is the ioctl that returns the number of unread bytes of a pipe.
const fionread = unix.TIOCINQ

// sysProcAttr makes the connector the leader of its own process group and kills it when the runtime
// dies (docs/runtime.md §7.1 step 3).
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}

// raiseOOMScore makes the kernel OOM killer prefer the process over the runtime (step 4). Raising the
// value needs no privilege.
func raiseOOMScore(pid int) error {
	return os.WriteFile(fmt.Sprintf("/proc/%d/oom_score_adj", pid), []byte("1000"), 0o600)
}
