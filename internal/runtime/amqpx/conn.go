// Package amqpx is the runtime's AMQP layer on amqp091-go v1.16.0 (docs/runtime.md §6): one connection
// per worker with reconnects (the library's recovery stays disabled), connection-blocked tracking, the
// shared confirm publisher with mandatory publishes and return correlation, and the slot consumers
// (one channel each, prefetch 1). The runtime never declares, binds or rejects anything; a passive declare only
// reads the depth of the scan queue (Queue).
package amqpx

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/url"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/version"
)

// Reconnect backoff (docs/runtime.md §6.6): 1 s → 30 s, ×2, full jitter.
const (
	reconnectInitial = time.Second
	reconnectMax     = 30 * time.Second
	dialTimeout      = 30 * time.Second
)

// ErrAccessRefused means the broker refused the credentials: the per-scan user no longer exists (the scan
// was cancelled or became terminal) or was not recreated yet (docs/runtime.md §6.6).
var ErrAccessRefused = errors.New("the broker refused the scan's credentials (ACCESS_REFUSED)")

// ErrClosed is returned after Close.
var ErrClosed = errors.New("AMQP connection closed")

// Config configures a connection.
type Config struct {
	URL      string
	VHost    string
	Username string
	Password string
	// Heartbeat is amqp.heartbeatSeconds.
	Heartbeat time.Duration
	// ConnectionName is scantor-runtime/<role>/<workerId>.
	ConnectionName string
	// Policy applies the transport rule to amqp:// peers and TLS to amqps://.
	Policy api.Policy
	Logger *slog.Logger
	// OnAccessRefused is called on every reconnect attempt refused with ACCESS_REFUSED, with the duration
	// of the current refusal streak.
	OnAccessRefused func(streak time.Duration)
	// OnReconnect is called after every successful reconnect (not the first connect).
	OnReconnect func()
}

// Conn is one AMQP connection with reconnects.
type Conn struct {
	cfg    Config
	logger *slog.Logger

	mu           sync.Mutex
	conn         *amqp.Connection
	gen          uint64
	connected    chan struct{} // closed while connected
	lost         chan struct{} // closed when the current generation was lost
	blocked      bool
	unblocked    chan struct{} // closed while not blocked
	closed       bool
	refusedSince time.Time
	runDone      chan struct{}
	changed      chan struct{} // closed and replaced on every connect, loss, block and unblock
}

// Dial connects for the first time. ACCESS_REFUSED is returned as ErrAccessRefused; refused transport as
// api.ErrPlaintextRefused.
func Dial(ctx context.Context, cfg Config) (*Conn, error) {
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.DiscardHandler)
	}
	if err := cfg.Policy.CheckTransport(ctx, cfg.URL); err != nil {
		return nil, err
	}
	c := &Conn{
		cfg: cfg, logger: cfg.Logger, connected: make(chan struct{}), lost: make(chan struct{}),
		unblocked: make(chan struct{}), runDone: make(chan struct{}), changed: make(chan struct{}),
	}
	close(c.unblocked)
	conn, err := c.dial()
	if err != nil {
		return nil, err
	}
	c.install(conn)
	return c, nil
}

func (c *Conn) dial() (*amqp.Connection, error) {
	u, err := url.Parse(c.cfg.URL)
	if err != nil {
		return nil, fmt.Errorf("invalid AMQP URL: %w", err)
	}
	var tlsConfig *tls.Config
	if u.Scheme == "amqps" {
		if tlsConfig, err = c.cfg.Policy.TLSConfig(); err != nil {
			return nil, err
		}
	}
	base := &net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}
	plain := c.cfg.Policy.PlaintextDialer(base)
	dialFn := func(network, addr string) (net.Conn, error) {
		ctx, cancel := context.WithTimeout(context.Background(), dialTimeout)
		defer cancel()
		var conn net.Conn
		var err error
		if u.Scheme == "amqps" {
			conn, err = base.DialContext(ctx, network, addr)
		} else {
			conn, err = plain(ctx, network, addr)
		}
		if err != nil {
			return nil, err
		}
		// Heartbeats start after the handshake; bound TLS and AMQP handshaking meanwhile.
		if err := conn.SetDeadline(time.Now().Add(dialTimeout)); err != nil {
			_ = conn.Close()
			return nil, err
		}
		return conn, nil
	}
	cfg := amqp.Config{
		SASL:            []amqp.Authentication{&amqp.PlainAuth{Username: c.cfg.Username, Password: c.cfg.Password}},
		Vhost:           c.cfg.VHost,
		Heartbeat:       c.cfg.Heartbeat,
		TLSClientConfig: tlsConfig,
		Properties:      amqp.Table{"connection_name": c.cfg.ConnectionName, "product": "scantor-runtime", "version": version.Version},
		Dial:            dialFn,
	}
	conn, err := amqp.DialConfig(u.String(), cfg)
	if err != nil {
		if IsAccessRefused(err) {
			return nil, fmt.Errorf("%w: %v", ErrAccessRefused, err)
		}
		return nil, fmt.Errorf("connect to the broker: %w", err)
	}
	return conn, nil
}

// IsAccessRefused reports whether err is the broker's ACCESS_REFUSED (403).
func IsAccessRefused(err error) bool {
	if errors.Is(err, ErrAccessRefused) {
		return true
	}
	var ae *amqp.Error
	return errors.As(err, &ae) && ae.Code == amqp.AccessRefused
}

// IsNotFound reports whether err is the broker's NOT_FOUND (404), for example a missing queue.
func IsNotFound(err error) bool {
	var ae *amqp.Error
	return errors.As(err, &ae) && ae.Code == amqp.NotFound
}

// install makes conn the current connection and watches it.
func (c *Conn) install(conn *amqp.Connection) {
	closeCh := conn.NotifyClose(make(chan *amqp.Error, 1))
	blockCh := conn.NotifyBlocked(make(chan amqp.Blocking, 4))
	c.mu.Lock()
	c.conn = conn
	c.gen++
	gen := c.gen
	close(c.connected)
	c.lost = make(chan struct{})
	c.refusedSince = time.Time{}
	c.setBlockedLocked(false)
	c.signalLocked()
	c.mu.Unlock()
	go c.watch(gen, closeCh, blockCh)
}

func (c *Conn) watch(gen uint64, closeCh <-chan *amqp.Error, blockCh <-chan amqp.Blocking) {
	for {
		select {
		case b, ok := <-blockCh:
			if !ok {
				blockCh = nil
				continue
			}
			c.mu.Lock()
			if c.gen == gen {
				c.setBlockedLocked(b.Active)
			}
			c.mu.Unlock()
			if b.Active {
				c.logger.Warn("the broker blocked publishing (resource alarm)", "reason", b.Reason)
			} else {
				c.logger.Info("the broker unblocked publishing")
			}
		case amqpErr, ok := <-closeCh:
			c.mu.Lock()
			if c.gen == gen {
				c.connected = make(chan struct{})
				close(c.lost)
				c.setBlockedLocked(false)
				c.signalLocked()
			}
			closed := c.closed
			c.mu.Unlock()
			if !closed {
				c.logger.Warn("AMQP connection lost", "err", errOrNil(amqpErr, ok))
			}
			return
		}
	}
}

func errOrNil(e *amqp.Error, ok bool) any {
	if !ok || e == nil {
		return "closed"
	}
	return e.Error()
}

func (c *Conn) setBlockedLocked(blocked bool) {
	if blocked == c.blocked {
		return
	}
	c.blocked = blocked
	if blocked {
		c.unblocked = make(chan struct{})
	} else {
		close(c.unblocked)
	}
	c.signalLocked()
}

// signalLocked wakes everyone waiting on Changed.
func (c *Conn) signalLocked() {
	close(c.changed)
	c.changed = make(chan struct{})
}

// Changed returns a channel that is closed at the next change of the connection state (connected,
// lost, blocked, unblocked, closed).
func (c *Conn) Changed() <-chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.changed
}

// Run reconnects after every connection loss until ctx ends or Close is called.
func (c *Conn) Run(ctx context.Context) {
	defer close(c.runDone)
	for {
		c.mu.Lock()
		lost, closed := c.lost, c.closed
		c.mu.Unlock()
		if closed {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-lost:
		}
		if !c.reconnect(ctx) {
			return
		}
		if c.cfg.OnReconnect != nil {
			c.cfg.OnReconnect()
		}
	}
}

func (c *Conn) reconnect(ctx context.Context) bool {
	for attempt := 1; ; attempt++ {
		delay := backoff(attempt)
		select {
		case <-ctx.Done():
			return false
		case <-time.After(delay):
		}
		c.mu.Lock()
		closed := c.closed
		c.mu.Unlock()
		if closed {
			return false
		}
		conn, err := c.dial()
		if err == nil {
			c.install(conn)
			c.logger.Info("AMQP connection re-established", "attempt", attempt)
			return true
		}
		if IsAccessRefused(err) {
			c.mu.Lock()
			if c.refusedSince.IsZero() {
				c.refusedSince = time.Now()
			}
			streak := time.Since(c.refusedSince)
			c.mu.Unlock()
			c.logger.Warn("AMQP reconnect refused (ACCESS_REFUSED)", "streak", streak.Round(time.Second))
			if c.cfg.OnAccessRefused != nil {
				c.cfg.OnAccessRefused(streak)
			}
			continue
		}
		c.mu.Lock()
		c.refusedSince = time.Time{}
		c.mu.Unlock()
		c.logger.Warn("AMQP reconnect failed", "attempt", attempt, "err", err)
	}
}

func backoff(attempt int) time.Duration {
	d := reconnectInitial << min(attempt-1, 10)
	d = min(d, reconnectMax)
	return time.Duration(rand.Float64() * float64(d)) //nolint:gosec // backoff jitter needs no cryptographic randomness
}

// Wait returns the current connection and its generation, waiting until one is established.
func (c *Conn) Wait(ctx context.Context) (*amqp.Connection, uint64, error) {
	for {
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return nil, 0, ErrClosed
		}
		connected := c.connected
		select {
		case <-connected:
			conn, gen := c.conn, c.gen
			c.mu.Unlock()
			return conn, gen, nil
		default:
		}
		c.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, 0, ctx.Err()
		case <-connected:
		}
	}
}

// Connected reports whether a connection is established.
func (c *Conn) Connected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	select {
	case <-c.connected:
		return !c.closed
	default:
		return false
	}
}

// Lost returns a channel that is closed when generation gen of the connection is lost (immediately for
// an older generation).
func (c *Conn) Lost(gen uint64) <-chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	if gen != c.gen {
		ch := make(chan struct{})
		close(ch)
		return ch
	}
	return c.lost
}

// Blocked reports whether the broker currently blocks publishing (docs/runtime.md §6.5).
func (c *Conn) Blocked() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.blocked
}

// Unblocked returns a channel that is closed while publishing is not blocked.
func (c *Conn) Unblocked() <-chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.unblocked
}

// WaitUnblocked waits until publishing is not blocked.
func (c *Conn) WaitUnblocked(ctx context.Context) error {
	select {
	case <-c.Unblocked():
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close closes the connection and stops reconnecting.
func (c *Conn) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	conn := c.conn
	c.signalLocked()
	c.mu.Unlock()
	if conn == nil || conn.IsClosed() {
		return nil
	}
	return conn.Close()
}
