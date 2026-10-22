//go:build !linux

package pool

import "syscall"

// fionread is the BSD FIONREAD ioctl (_IOR('f', 127, int)): the number of unread bytes of a pipe.
const fionread = 0x4004667f

// sysProcAttr makes the connector the leader of its own process group. Outside linux (development
// hosts running the unit tests) there is no parent-death signal.
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

// raiseOOMScore is a no-op outside linux.
func raiseOOMScore(int) error { return nil }
