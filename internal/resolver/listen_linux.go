//go:build linux

package resolver

import (
	"net/netip"
	"os"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// udpReceiveBuffer is the receive buffer the resolver asks for (the kernel caps it at
// net.core.rmem_max): bursts of worker queries must not overflow the default of about 208 KiB.
const udpReceiveBuffer = 4 << 20

// listenControl sets SO_REUSEPORT, so a replacement resolver binds the same address while the old one
// still serves, and the UDP receive buffer.
func listenControl(network, _ string, c syscall.RawConn) error {
	var opErr error
	err := c.Control(func(fd uintptr) {
		opErr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEPORT, 1)
		if opErr == nil && strings.HasPrefix(network, "udp") {
			// Best effort: a smaller buffer still works.
			_ = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_RCVBUF, udpReceiveBuffer)
		}
	})
	if err != nil {
		return err
	}
	return opErr
}

// Steering targets of the reuseport group (SO_ATTACH_REUSEPORT_CBPF returns an index into the group;
// handover.go).
const (
	// steerNone is out of range: the kernel falls back to hashing.
	steerNone uint32 = 0xffffffff
	// steerFirst sends every new datagram and connection to the socket at index 0, the older of two
	// resolvers.
	steerFirst uint32 = 0
	// steerSecond sends them to the socket at index 1, the newer of two resolvers.
	steerSecond uint32 = 1
)

// steer attaches a one-instruction classic BPF program "ret #target" to the reuseport group of c.
func steer(c syscall.Conn, target uint32) error {
	raw, err := c.SyscallConn()
	if err != nil {
		return err
	}
	filter := []unix.SockFilter{{Code: unix.BPF_RET | unix.BPF_K, K: target}}
	prog := unix.SockFprog{Len: 1, Filter: &filter[0]}
	var opErr error
	err = raw.Control(func(fd uintptr) {
		opErr = unix.SetsockoptSockFprog(int(fd), unix.SOL_SOCKET, unix.SO_ATTACH_REUSEPORT_CBPF, &prog)
	})
	if err != nil {
		return err
	}
	return opErr
}

// procNet are the socket tables of the resolver's network namespace (the host's).
var procNet = map[string]string{"udp": "/proc/net/udp", "tcp": "/proc/net/tcp"}

// boundSockets returns the inodes of the sockets bound to addr: every UDP socket, or the listening
// TCP sockets.
func boundSockets(network string, addr netip.AddrPort) (map[uint64]bool, error) {
	data, err := os.ReadFile(procNet[network])
	if err != nil {
		return nil, err
	}
	return parseProcNet(data, addr, network == "tcp"), nil
}

// socketInode returns the inode of the socket behind c (the inode column of /proc/net).
func socketInode(c syscall.Conn) (uint64, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return 0, err
	}
	var st unix.Stat_t
	var opErr error
	err = raw.Control(func(fd uintptr) {
		opErr = unix.Fstat(int(fd), &st)
	})
	if err != nil {
		return 0, err
	}
	return st.Ino, opErr
}
