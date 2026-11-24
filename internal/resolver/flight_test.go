package resolver

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var (
	clientA = netip.MustParseAddr("10.10.0.2")
	clientB = netip.MustParseAddr("10.10.0.3")
)

func deadlineCtx(t *testing.T, d time.Duration) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	t.Cleanup(cancel)
	return ctx
}

func TestFlightsShareOneLookup(t *testing.T) {
	g := newFlights(8, &counters{})
	var calls atomic.Int32
	release := make(chan struct{})
	lookup := func(context.Context) *entry {
		calls.Add(1)
		<-release
		return &entry{rcode: 0}
	}
	var wg sync.WaitGroup
	results := make(chan *entry, 10)
	for i := range 10 {
		client := clientA
		if i%2 == 1 {
			client = clientB
		}
		wg.Go(func() {
			e, err := g.do(deadlineCtx(t, 2*time.Second), context.Background(), flightKey{"a.test.", 1}, client, lookup)
			if err != nil {
				t.Error(err)
			}
			results <- e
		})
	}
	eventually(t, time.Second, func() bool { return g.waiting.Load() == 10 })
	close(release)
	wg.Wait()
	close(results)
	var first *entry
	for e := range results {
		if first == nil {
			first = e
		}
		if e != first {
			t.Error("waiters got different entries")
		}
	}
	if calls.Load() != 1 {
		t.Errorf("lookup ran %d times", calls.Load())
	}
	if g.pending() != 0 {
		t.Errorf("%d flights left", g.pending())
	}
}

func TestFlightWithoutSlotIsDroppedWhenItsClientsLeave(t *testing.T) {
	stats := &counters{}
	g := newFlights(1, stats)
	release := make(chan struct{})
	// The only slot is busy.
	go func() {
		_, _ = g.do(deadlineCtx(t, 5*time.Second), context.Background(), flightKey{"busy.test.", 1}, clientA,
			func(context.Context) *entry { <-release; return &entry{} })
	}()
	eventually(t, time.Second, func() bool { return stats.inflight.Load() == 1 })
	var ran atomic.Bool
	start := time.Now()
	_, err := g.do(deadlineCtx(t, 100*time.Millisecond), context.Background(), flightKey{"late.test.", 1}, clientB,
		func(context.Context) *entry { ran.Store(true); return &entry{} })
	if !errors.Is(err, errDeadline) && !errors.Is(err, errOverloaded) {
		t.Errorf("err = %v", err)
	}
	if time.Since(start) > time.Second {
		t.Error("the client waited past its deadline")
	}
	close(release)
	eventually(t, time.Second, func() bool { return g.pending() == 0 })
	time.Sleep(50 * time.Millisecond)
	if ran.Load() {
		t.Error("a lookup nobody waits for started")
	}
}

func TestStartedLookupOutlivesItsClient(t *testing.T) {
	g := newFlights(4, &counters{})
	done := make(chan struct{})
	start := time.Now()
	_, err := g.do(deadlineCtx(t, 100*time.Millisecond), context.Background(), flightKey{"slow.test.", 1}, clientA,
		func(ctx context.Context) *entry {
			time.Sleep(300 * time.Millisecond)
			close(done)
			return &entry{}
		})
	if !errors.Is(err, errDeadline) || time.Since(start) > 250*time.Millisecond {
		t.Errorf("err = %v after %v", err, time.Since(start))
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Error("the detached lookup did not finish")
	}
	// An abandoned flight never answers a later client of the same question.
	e, err := g.do(deadlineCtx(t, time.Second), context.Background(), flightKey{"slow.test.", 1}, clientA,
		func(context.Context) *entry { return &entry{rcode: 3} })
	if err != nil || e.rcode != 3 {
		t.Errorf("later client: %v, %v", e, err)
	}
}

func TestFlightCaps(t *testing.T) {
	stats := &counters{}
	g := newFlights(8, stats) // per client 16, pending 16, waiting 64
	release := make(chan struct{})
	block := func(context.Context) *entry { <-release; return &entry{} }
	var wg sync.WaitGroup
	for i := range 16 {
		wg.Go(func() {
			_, _ = g.do(deadlineCtx(t, 5*time.Second), context.Background(), flightKey{fmt.Sprintf("a%d.test.", i), 1}, clientA, block)
		})
	}
	eventually(t, time.Second, func() bool { return g.pending() == 16 })
	// The client's cap is reached: SERVFAIL at once.
	if _, err := g.do(deadlineCtx(t, time.Second), context.Background(), flightKey{"more.test.", 1}, clientA, block); !errors.Is(err, errOverloaded) {
		t.Errorf("per-client cap: %v", err)
	}
	// Another client can still join existing flights, but no new flight exceeds the pending cap.
	if _, err := g.do(deadlineCtx(t, time.Second), context.Background(), flightKey{"other.test.", 1}, clientB, block); !errors.Is(err, errOverloaded) {
		t.Errorf("pending cap: %v", err)
	}
	joined := make(chan error, 1)
	go func() {
		_, err := g.do(deadlineCtx(t, 5*time.Second), context.Background(), flightKey{"a0.test.", 1}, clientB, block)
		joined <- err
	}()
	close(release)
	if err := <-joined; err != nil {
		t.Errorf("joining an existing flight: %v", err)
	}
	wg.Wait()
	// The waiting cap counts clients, not flights.
	g2 := newFlights(1, &counters{}) // waiting cap 8
	release2 := make(chan struct{})
	for range 8 {
		wg.Go(func() {
			_, _ = g2.do(deadlineCtx(t, 5*time.Second), context.Background(), flightKey{"same.test.", 1}, clientA,
				func(context.Context) *entry { <-release2; return &entry{} })
		})
	}
	eventually(t, time.Second, func() bool { return g2.waiting.Load() == 8 })
	if _, err := g2.do(deadlineCtx(t, time.Second), context.Background(), flightKey{"same.test.", 1}, clientB, block); !errors.Is(err, errOverloaded) {
		t.Errorf("waiting cap: %v", err)
	}
	close(release2)
	wg.Wait()
}

// TestOneClientCannotHoldTheWaitingCap: a client that joins its own flights again and again waits for
// at most perClientWaiting answers (max(64, 8 × maxLookups / 16)); every other client still gets its
// lookups.
func TestOneClientCannotHoldTheWaitingCap(t *testing.T) {
	g := newFlights(1024, &counters{}) // waiting cap 8192, per client 512, per client flights 256
	if g.perClientWaiting != 512 || newFlights(8, &counters{}).perClientWaiting != 64 {
		t.Fatalf("per-client waiting caps %d, %d", g.perClientWaiting, newFlights(8, &counters{}).perClientWaiting)
	}
	release := make(chan struct{})
	block := func(context.Context) *entry { <-release; return &entry{} }
	var wg sync.WaitGroup
	// 64 flights of client A, each joined 8 times by A: 512 waiting answers.
	for i := range 512 {
		wg.Go(func() {
			_, _ = g.do(deadlineCtx(t, 20*time.Second), context.Background(), flightKey{fmt.Sprintf("a%d.test.", i%64), 1}, clientA, block)
		})
	}
	eventually(t, 10*time.Second, func() bool { return g.waiting.Load() == 512 })
	if _, err := g.do(deadlineCtx(t, time.Second), context.Background(), flightKey{"a0.test.", 1}, clientA, block); !errors.Is(err, errOverloaded) {
		t.Errorf("client A beyond its waiting cap: %v", err)
	}
	done := make(chan error, 2)
	go func() {
		_, err := g.do(deadlineCtx(t, 20*time.Second), context.Background(), flightKey{"a0.test.", 1}, clientB, block)
		done <- err
	}()
	go func() {
		_, err := g.do(deadlineCtx(t, 20*time.Second), context.Background(), flightKey{"b.test.", 1}, clientB, block)
		done <- err
	}()
	eventually(t, 10*time.Second, func() bool { return g.waiting.Load() == 514 })
	close(release)
	for range 2 {
		if err := <-done; err != nil {
			t.Errorf("client B: %v", err)
		}
	}
	wg.Wait()
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.waiters) != 0 || len(g.clients) != 0 {
		t.Errorf("waiters %v, clients %v left after every answer", g.waiters, g.clients)
	}
}
