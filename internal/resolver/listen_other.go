//go:build !linux

package resolver

import (
	"errors"
	"net/netip"
	"syscall"
)

// The resolver runs only in Linux containers; elsewhere (a developer's macOS) the package builds for
// tests without SO_REUSEPORT, reuseport steering and the socket tables of /proc/net.

func listenControl(string, string, syscall.RawConn) error { return nil }

const (
	steerNone   uint32 = 0xffffffff
	steerFirst  uint32 = 0
	steerSecond uint32 = 1
)

var errNoSteering = errors.New("reuseport steering needs Linux")

func steer(syscall.Conn, uint32) error { return errNoSteering }

func boundSockets(string, netip.AddrPort) (map[uint64]bool, error) { return nil, errNoSteering }

func socketInode(syscall.Conn) (uint64, error) { return 0, errNoSteering }
