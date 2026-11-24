package resolver

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

// The hand-over between two resolvers on one address (docs/nodes.md §6.11). A replacement binds the
// address next to the serving resolver (SO_REUSEPORT), and the kernel spreads new datagrams and
// connections over the sockets of the group unless a steering program (SO_ATTACH_REUSEPORT_CBPF,
// shared by the group) picks one by its index. The kernel appends a socket that joins and moves the
// last socket into the place of one that leaves, so of the two resolvers a hand-over involves the
// older is at index 0 and the newer at index 1.
//
//   - A resolver that binds while another serves the address (a replacement) steers everything to
//     index 0, the serving resolver, until its own upstream check passes for the first time: a
//     replacement whose servers do not answer never takes a query.
//   - A resolver that stops steers new queries away from itself before it drains: to index 0 while
//     the resolver that served when it bound is still there (this one is the newer of the two),
//     otherwise to index 1 (the resolver that bound after it). The sockets of the group
//     (/proc/net/udp and /proc/net/tcp of the host's network namespace) tell which case applies;
//     without them the bind order decides.

// handover is the resolver's part in the reuseport group of its address.
type handover struct {
	log  *slog.Logger
	addr netip.AddrPort

	mu  sync.Mutex
	udp *net.UDPConn
	tcp *net.TCPListener
	// second: another socket served the address when this resolver bound.
	second bool
	// olderUDP and olderTCP are the inodes of the group's sockets when this resolver bound (nil:
	// unknown).
	olderUDP, olderTCP map[uint64]bool
	// steered: new queries go to the older resolver until the first upstream check passes.
	steered bool
}

// prepare runs right before a bind: it records whether another socket serves the address (a bind
// without SO_REUSEPORT fails with EADDRINUSE) and which sockets the group holds.
func (h *handover) prepare() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.second = addressServed(h.addr)
	h.olderUDP, h.olderTCP = nil, nil
	if older, err := boundSockets("udp", h.addr); err == nil {
		h.olderUDP = older
	}
	if older, err := boundSockets("tcp", h.addr); err == nil {
		h.olderTCP = older
	}
}

// bound takes the sockets of a successful bind. A resolver that bound second while its upstream check
// has not passed yet steers every new query to the first; otherwise it clears any program a departed
// resolver left in the group. upstreamOK is read under the lock, so a check that passes meanwhile
// either sees the steering in release or prevents it here.
func (h *handover) bound(udp *net.UDPConn, tcp *net.TCPListener, upstreamOK func() bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.udp, h.tcp = udp, tcp
	target := steerNone
	if h.second && !upstreamOK() {
		target, h.steered = steerFirst, true
		h.log.Info("another resolver serves the address: it takes every query until the upstream check passes", "listen", h.addr.String())
	}
	h.steerBoth(target)
}

// release ends the steering of bound once the upstream check passed (called after upstreamOK is set).
func (h *handover) release() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.steered {
		return
	}
	h.steered = false
	h.steerBoth(steerNone)
	h.log.Info("upstream check passes: taking queries", "listen", h.addr.String())
}

// depart steers new queries and connections away from this resolver before it drains.
func (h *handover) depart() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.udp == nil {
		return
	}
	for _, s := range []struct {
		network string
		conn    syscall.Conn
		older   map[uint64]bool
	}{{"udp", h.udp, h.olderUDP}, {"tcp", h.tcp, h.olderTCP}} {
		target, ok := h.departTarget(s.network, s.conn, s.older)
		if !ok {
			continue
		}
		if err := steer(s.conn, target); err != nil {
			h.log.Debug("steer new queries away", "network", s.network, "error", err)
		}
	}
}

// departTarget returns the index a departing resolver steers to; false when it is alone.
func (h *handover) departTarget(network string, conn syscall.Conn, older map[uint64]bool) (uint32, bool) {
	current, err := boundSockets(network, h.addr)
	self, ierr := socketInode(conn)
	if err != nil || ierr != nil || older == nil {
		if h.second {
			return steerFirst, true
		}
		return steerSecond, true
	}
	delete(current, self)
	return departIndex(current, older)
}

// departIndex decides where a departing resolver steers from the other sockets of its group and those
// that were there when it bound: to the first (index 0) while one of those is still there, else to the
// second (index 1); nowhere when no other socket is left.
func departIndex(others, older map[uint64]bool) (uint32, bool) {
	if len(others) == 0 {
		return 0, false
	}
	for ino := range others {
		if older[ino] {
			return steerFirst, true
		}
	}
	return steerSecond, true
}

func (h *handover) steerBoth(target uint32) {
	if err := steer(h.udp, target); err != nil {
		h.log.Debug("reuseport steering (udp)", "target", target, "error", err)
	}
	if err := steer(h.tcp, target); err != nil {
		h.log.Debug("reuseport steering (tcp)", "target", target, "error", err)
	}
}

// addressServed reports whether a socket is bound to addr: a UDP bind without SO_REUSEPORT fails with
// EADDRINUSE.
func addressServed(addr netip.AddrPort) bool {
	pc, err := net.ListenPacket("udp4", addr.String())
	if err != nil {
		return errors.Is(err, syscall.EADDRINUSE)
	}
	_ = pc.Close()
	return false
}

// parseProcNet returns the inodes of the sockets bound to addr in a /proc/net/udp or /proc/net/tcp
// table (listening: TCP sockets in state LISTEN only).
func parseProcNet(data []byte, addr netip.AddrPort, listening bool) map[uint64]bool {
	want := procNetAddr(addr)
	out := make(map[uint64]bool)
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		// sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode
		f := strings.Fields(sc.Text())
		if len(f) < 10 || f[1] != want || (listening && f[3] != "0A") {
			continue
		}
		if ino, err := strconv.ParseUint(f[9], 10, 64); err == nil && ino != 0 {
			out[ino] = true
		}
	}
	return out
}

// procNetAddr formats an IPv4 address and port the way /proc/net/{udp,tcp} list them: the address as
// a 32-bit number in the host's byte order and the port, both in upper-case hex.
func procNetAddr(addr netip.AddrPort) string {
	a := addr.Addr().Unmap().As4()
	return fmt.Sprintf("%08X:%04X", binary.NativeEndian.Uint32(a[:]), addr.Port())
}
