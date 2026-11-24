package resolver

import (
	"errors"
	"net"
	"net/netip"
	"sync"
	"syscall"
	"time"
)

// Client TCP connections (docs/nodes.md §6.11). The ACL refuses each query of a non-client, but a TCP
// connection holds a file descriptor and a goroutine before its first query, so the listener closes a
// connection at accept when it does not come from a client or exceeds a connection cap, and the
// server closes idle and long-used connections early. Outbound queries keep the rest of the file
// descriptor limit.
const (
	// maxTCPConns bounds the client TCP connections open at once.
	maxTCPConns = 1024
	// maxTCPConnsPerClient bounds them per client address.
	maxTCPConnsPerClient = 32
	// tcpIdleTimeout closes a connection that sends no further query (also the wait for the first).
	tcpIdleTimeout = 2 * time.Second
	// maxTCPQueriesPerConn closes a connection after this many queries.
	maxTCPQueriesPerConn = 16
	// acceptBackoffMin and acceptBackoffMax bound the pause after a failed accept (out of file
	// descriptors), doubled on every further failure.
	acceptBackoffMin = 5 * time.Millisecond
	acceptBackoffMax = time.Second
)

// tcpLimiter is the client TCP listener: it closes connections of non-clients and over the caps at
// accept and pauses after accept errors.
type tcpLimiter struct {
	net.Listener
	allowed   func(netip.Addr) bool
	max       int
	perClient int
	stats     *counters
	// wait pauses after a failed accept (a test hook; time.Sleep otherwise).
	wait func(time.Duration)

	mu       sync.Mutex
	open     int
	byClient map[netip.Addr]int
}

func newTCPLimiter(ln net.Listener, allowed func(netip.Addr) bool, stats *counters) *tcpLimiter {
	return &tcpLimiter{
		Listener:  ln,
		allowed:   allowed,
		max:       maxTCPConns,
		perClient: maxTCPConnsPerClient,
		stats:     stats,
		wait:      time.Sleep,
		byClient:  make(map[netip.Addr]int),
	}
}

// Accept returns the next admitted client connection. It retries after an error that a later accept
// may not see (no file descriptor or kernel memory, a connection aborted before the accept), with a
// growing pause, and returns every other error (the listener closed).
func (l *tcpLimiter) Accept() (net.Conn, error) {
	var backoff time.Duration
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			if !retryableAccept(err) {
				return nil, err
			}
			backoff = min(max(2*backoff, acceptBackoffMin), acceptBackoffMax)
			l.wait(backoff)
			continue
		}
		backoff = 0
		var client netip.Addr
		if a, ok := c.RemoteAddr().(*net.TCPAddr); ok {
			client = a.AddrPort().Addr().Unmap()
		}
		if !l.allowed(client) || !l.admit(client) {
			_ = c.Close()
			l.stats.tcpRejected.Add(1)
			continue
		}
		return &limitedConn{Conn: c, release: func() { l.release(client) }}, nil
	}
}

// admit counts a connection of client unless a cap is reached.
func (l *tcpLimiter) admit(client netip.Addr) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.open >= l.max || l.byClient[client] >= l.perClient {
		return false
	}
	l.open++
	l.byClient[client]++
	return true
}

// openConns is the number of admitted connections not closed yet.
func (l *tcpLimiter) openConns() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.open
}

func (l *tcpLimiter) release(client netip.Addr) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.open--
	if l.byClient[client]--; l.byClient[client] <= 0 {
		delete(l.byClient, client)
	}
}

// retryableAccept reports whether an accept error leaves the listener usable.
func retryableAccept(err error) bool {
	return outOfResources(err) || errors.Is(err, syscall.ECONNABORTED) || errors.Is(err, syscall.EINTR) ||
		errors.Is(err, syscall.EPROTO)
}

// limitedConn is an admitted connection; closing it frees its place once.
type limitedConn struct {
	net.Conn
	once    sync.Once
	release func()
}

func (c *limitedConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(c.release)
	return err
}
