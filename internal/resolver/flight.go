package resolver

import (
	"context"
	"errors"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"
)

// Lookups are shared and bounded (docs/nodes.md §6.11): one flight per question however many clients
// ask it; a flight starts its lookup only with one of maxLookups slots, which it must get before its
// first client's deadline; one client IP starts at most perClient flights and waits for at most
// perClientWaiting answers (started or joined flights), so one client cannot hold the global caps;
// at most 8 × maxLookups clients wait and 2 × maxLookups flights exist. A started lookup runs
// detached from its clients within its budget and fills the cache.

var (
	// errOverloaded: a cap refused the question (answered SERVFAIL at once, never cached).
	errOverloaded = errors.New("resolver overloaded")
	// errDeadline: the client's deadline passed before the answer (SERVFAIL, never cached).
	errDeadline = errors.New("client deadline passed")
)

type flightKey struct {
	name  string
	qtype uint16
}

type flight struct {
	done    chan struct{}
	e       *entry // set before done is closed; nil when the flight got no slot
	waiters int    // guarded by flights.mu
	started bool   // guarded by flights.mu
	// abandoned: every client left before the flight got a slot (guarded by flights.mu); a new client
	// of the same question starts a new flight.
	abandoned bool
	cancel    context.CancelFunc
}

// flights is the singleflight group with the lookup slots.
type flights struct {
	slots            chan struct{}
	perClient        int
	perClientWaiting int
	maxWaiting       int64
	maxPending       int
	stats            *counters

	waiting atomic.Int64

	mu      sync.Mutex
	m       map[flightKey]*flight
	clients map[netip.Addr]int // flights started per client
	waiters map[netip.Addr]int // clients waiting per client IP
}

func newFlights(maxLookups int, stats *counters) *flights {
	maxWaiting := 8 * maxLookups
	return &flights{
		slots:            make(chan struct{}, maxLookups),
		perClient:        max(16, maxLookups/4),
		perClientWaiting: max(64, maxWaiting/16),
		maxWaiting:       int64(maxWaiting),
		maxPending:       2 * maxLookups,
		stats:            stats,
		m:                make(map[flightKey]*flight),
		clients:          make(map[netip.Addr]int),
		waiters:          make(map[netip.Addr]int),
	}
}

// do returns the answer to key for client: it joins the flight of key or starts one that runs lookup
// (with the context base, detached from the client) once it holds a slot. ctx carries the client's
// deadline.
func (g *flights) do(ctx context.Context, base context.Context, key flightKey, client netip.Addr, lookup func(context.Context) *entry) (*entry, error) {
	if g.waiting.Add(1) > g.maxWaiting {
		g.waiting.Add(-1)
		return nil, errOverloaded
	}
	defer g.waiting.Add(-1)
	g.mu.Lock()
	if g.waiters[client] >= g.perClientWaiting {
		g.mu.Unlock()
		return nil, errOverloaded
	}
	g.waiters[client]++
	defer func() {
		g.mu.Lock()
		if g.waiters[client]--; g.waiters[client] <= 0 {
			delete(g.waiters, client)
		}
		g.mu.Unlock()
	}()
	f := g.m[key]
	if f != nil && !f.abandoned {
		f.waiters++
	} else {
		if len(g.m) >= g.maxPending || g.clients[client] >= g.perClient {
			g.mu.Unlock()
			return nil, errOverloaded
		}
		deadline, ok := ctx.Deadline()
		if !ok {
			deadline = time.Now().Add(time.Minute)
		}
		slotCtx, cancel := context.WithDeadline(base, deadline)
		f = &flight{done: make(chan struct{}), waiters: 1, cancel: cancel}
		g.m[key] = f
		g.clients[client]++
		go g.run(slotCtx, base, key, client, f, lookup)
	}
	g.mu.Unlock()
	select {
	case <-f.done:
		if f.e == nil {
			return nil, errOverloaded
		}
		return f.e, nil
	case <-ctx.Done():
		g.mu.Lock()
		f.waiters--
		if f.waiters == 0 && !f.started {
			f.abandoned = true
			f.cancel() // nobody waits for a lookup that has not started: drop it
		}
		g.mu.Unlock()
		return nil, errDeadline
	}
}

// run waits for a slot (until the first client's deadline or until every client left), then runs the
// lookup and publishes its entry.
func (g *flights) run(slotCtx, base context.Context, key flightKey, client netip.Addr, f *flight, lookup func(context.Context) *entry) {
	defer f.cancel()
	got := false
	select {
	case g.slots <- struct{}{}:
		g.mu.Lock()
		if slotCtx.Err() == nil {
			f.started, got = true, true
		}
		g.mu.Unlock()
		if !got {
			<-g.slots
		}
	case <-slotCtx.Done():
	}
	var e *entry
	if got {
		g.stats.lookups.Add(1)
		g.stats.inflight.Add(1)
		e = lookup(base)
		g.stats.inflight.Add(-1)
		<-g.slots
	}
	g.mu.Lock()
	if g.m[key] == f {
		delete(g.m, key)
	}
	if g.clients[client]--; g.clients[client] <= 0 {
		delete(g.clients, client)
	}
	g.mu.Unlock()
	f.e = e
	close(f.done)
}

// pending is the number of flights (waiting for a slot or running).
func (g *flights) pending() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.m)
}
