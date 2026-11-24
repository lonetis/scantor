package resolver

import (
	"errors"
	"io"
	"net"
	"net/netip"
	"slices"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/zmap/dns"
)

// fakeListener returns the queued connections and errors, then net.ErrClosed.
type fakeListener struct {
	queue []any // net.Conn or error
}

func (l *fakeListener) Accept() (net.Conn, error) {
	if len(l.queue) == 0 {
		return nil, net.ErrClosed
	}
	next := l.queue[0]
	l.queue = l.queue[1:]
	if err, ok := next.(error); ok {
		return nil, err
	}
	return next.(net.Conn), nil
}

func (*fakeListener) Close() error   { return nil }
func (*fakeListener) Addr() net.Addr { return &net.TCPAddr{IP: net.IPv4(10, 10, 0, 1), Port: 53} }

// fakeConn is an accepted connection from a client address.
type fakeConn struct {
	net.Conn
	from   netip.Addr
	closed atomic.Bool
}

func (c *fakeConn) RemoteAddr() net.Addr {
	return net.TCPAddrFromAddrPort(netip.AddrPortFrom(c.from, 40000))
}
func (c *fakeConn) Close() error { c.closed.Store(true); return nil }

func TestTCPLimiterAdmitsClientsWithinTheCaps(t *testing.T) {
	client := netip.MustParseAddr("10.10.0.2")
	other := netip.MustParseAddr("10.10.0.3")
	stranger := netip.MustParseAddr("192.0.2.9")
	conns := []*fakeConn{{from: stranger}, {from: client}, {from: client}, {from: client}, {from: other}, {from: other}}
	ln := &fakeListener{}
	for _, c := range conns {
		ln.queue = append(ln.queue, c)
	}
	stats := &counters{}
	l := newTCPLimiter(ln, func(a netip.Addr) bool { return a != stranger }, stats)
	l.max, l.perClient = 3, 2
	var admitted []net.Conn
	for {
		c, err := l.Accept()
		if err != nil {
			if !errors.Is(err, net.ErrClosed) {
				t.Fatal(err)
			}
			break
		}
		admitted = append(admitted, c)
	}
	// The stranger is closed at accept, the third connection of client over its cap, the second of
	// other over the global cap.
	if len(admitted) != 3 || !conns[0].closed.Load() || !conns[3].closed.Load() || !conns[5].closed.Load() || conns[1].closed.Load() {
		t.Errorf("admitted %d connections", len(admitted))
	}
	if stats.tcpRejected.Load() != 3 {
		t.Errorf("tcpRejected = %d", stats.tcpRejected.Load())
	}
	// Closing a connection frees its place, once.
	_ = admitted[0].Close()
	_ = admitted[0].Close()
	if l.open != 2 || l.byClient[client] != 1 {
		t.Errorf("after a close: open %d, client %d", l.open, l.byClient[client])
	}
	ln.queue = append(ln.queue, &fakeConn{from: client}, &fakeConn{from: client})
	if _, err := l.Accept(); err != nil {
		t.Errorf("a freed place was not reused: %v", err)
	}
	if _, err := l.Accept(); !errors.Is(err, net.ErrClosed) {
		t.Errorf("over the cap again: %v", err)
	}
}

func TestTCPLimiterBacksOffAfterAcceptErrors(t *testing.T) {
	c := &fakeConn{from: netip.MustParseAddr("10.10.0.2")}
	ln := &fakeListener{queue: []any{
		&net.OpError{Op: "accept", Err: syscall.EMFILE},
		&net.OpError{Op: "accept", Err: syscall.EMFILE},
		&net.OpError{Op: "accept", Err: syscall.ENFILE},
		&net.OpError{Op: "accept", Err: syscall.ECONNABORTED},
		c,
	}}
	l := newTCPLimiter(ln, func(netip.Addr) bool { return true }, &counters{})
	var waits []time.Duration
	l.wait = func(d time.Duration) { waits = append(waits, d) }
	got, err := l.Accept()
	if err != nil || got.(*limitedConn).Conn != c {
		t.Fatalf("Accept = %v, %v", got, err)
	}
	want := []time.Duration{5 * time.Millisecond, 10 * time.Millisecond, 20 * time.Millisecond, 40 * time.Millisecond}
	if !slices.Equal(waits, want) {
		t.Errorf("pauses = %v, want %v", waits, want)
	}
	// The pause is capped, and an error that does not pass returns.
	l.wait = func(d time.Duration) { waits = append(waits, d) }
	waits = nil
	for range 12 {
		ln.queue = append(ln.queue, &net.OpError{Op: "accept", Err: syscall.EMFILE})
	}
	ln.queue = append(ln.queue, errors.New("broken"))
	if _, err := l.Accept(); err == nil || err.Error() != "broken" {
		t.Errorf("Accept = %v", err)
	}
	if waits[len(waits)-1] != acceptBackoffMax {
		t.Errorf("last pause %v", waits[len(waits)-1])
	}
}

// TestClientTCPConnectionsAreBounded runs a resolver and opens TCP connections from one client: at
// most maxTCPConnsPerClient stay open, a connection answers at most maxTCPQueriesPerConn queries, and
// an idle connection is closed after tcpIdleTimeout.
func TestClientTCPConnectionsAreBounded(t *testing.T) {
	r, srv := newRunning(t, tweaks{})
	var open []net.Conn
	t.Cleanup(func() {
		for _, c := range open {
			_ = c.Close()
		}
	})
	for range maxTCPConnsPerClient {
		c, err := net.Dial("tcp4", srv.addr)
		if err != nil {
			t.Fatal(err)
		}
		open = append(open, c)
	}
	extra, err := net.Dial("tcp4", srv.addr)
	if err != nil {
		t.Fatal(err)
	}
	defer extra.Close()
	_ = extra.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := extra.Read(make([]byte, 1)); !errors.Is(err, io.EOF) && !errors.Is(err, syscall.ECONNRESET) {
		t.Errorf("connection over the per-client cap: %v", err)
	}
	eventually(t, time.Second, func() bool { return r.h.s.stats.tcpRejected.Load() == 1 })
	if n := r.h.s.tcpConns.Load().openConns(); n != maxTCPConnsPerClient {
		t.Errorf("%d connections open", n)
	}
	for _, c := range open {
		_ = c.Close()
	}
	open = nil
	// The server notices the closes when it reads from the connections.
	eventually(t, 2*time.Second, func() bool { return r.h.s.tcpConns.Load().openConns() == 0 })

	// One connection answers maxTCPQueriesPerConn queries, then closes.
	c, err := net.Dial("tcp4", srv.addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	conn := &dns.Conn{Conn: c}
	answered := 0
	for range maxTCPQueriesPerConn + 1 {
		_ = conn.SetDeadline(time.Now().Add(time.Second))
		if err := conn.WriteMsg(newQuery(ProbeName, dns.TypeTXT)); err != nil {
			break
		}
		if _, err := conn.ReadMsg(); err != nil {
			break
		}
		answered++
	}
	if answered != maxTCPQueriesPerConn {
		t.Errorf("one connection answered %d queries", answered)
	}

	// An idle connection is closed after the idle timeout.
	idle, err := net.Dial("tcp4", srv.addr)
	if err != nil {
		t.Fatal(err)
	}
	defer idle.Close()
	start := time.Now()
	_ = idle.SetReadDeadline(start.Add(3 * tcpIdleTimeout))
	if _, err := idle.Read(make([]byte, 1)); !errors.Is(err, io.EOF) && !errors.Is(err, syscall.ECONNRESET) {
		t.Errorf("idle connection: %v", err)
	}
	if elapsed := time.Since(start); elapsed > tcpIdleTimeout+time.Second {
		t.Errorf("an idle connection stayed open for %v", elapsed)
	}
}
