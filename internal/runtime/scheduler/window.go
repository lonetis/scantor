package scheduler

import (
	"cmp"
	"context"
	"log/slog"
	"math/rand/v2"
	"slices"
	"sync"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/amqpx"
)

// Window bounds (docs/runtime.md §11.4).
const (
	WindowItems = 512
	WindowBytes = 8 << 20
)

// Publisher sends analysis messages through the shared confirm publisher (amqpx.Publisher).
type Publisher interface {
	Send(ctx context.Context, pub amqpx.Publication) amqpx.Confirmation
}

type entryState int

const (
	statePending entryState = iota
	stateNacked
	stateReturned
)

type entry struct {
	seq   int64
	hash  string
	body  []byte
	state entryState
	gen   int
}

// window holds the published items until their confirms and tracks the contiguous confirmed prefix
// (docs/runtime.md §11.4, §11.5). Nacked items put the window into backpressure: after
// backpressureWaitMs ± 20 % only the nacked seqs are republished, in seq order, and no new item enters
// while any seq is nacked. Returned items (no queue bound) are handled the same way after a state poll.
type window struct {
	pub      Publisher
	exchange string
	key      string
	wait     time.Duration
	pollNow  func()
	log      *slog.Logger
	ctx      context.Context // publishing; cancelled on stop and fencing

	mu           sync.Mutex
	changed      chan struct{}
	pending      map[int64]*entry
	bytes        int
	beyond       map[int64]string // confirmed seqs beyond the prefix → hash
	confirmed    int64
	tailHash     *string
	held         int // pending entries that are nacked or returned
	published    int64
	backpressure bool
	looping      bool
	gen          int
}

func newWindow(ctx context.Context, pub Publisher, exchange, key string, wait time.Duration, pollNow func(), log *slog.Logger, cp api.Checkpoint) *window {
	return &window{
		pub: pub, exchange: exchange, key: key, wait: wait, pollNow: pollNow, log: log, ctx: ctx,
		changed: make(chan struct{}), pending: map[int64]*entry{}, beyond: map[int64]string{},
		confirmed: cp.Confirmed, tailHash: cp.TailHash, published: cp.Confirmed,
	}
}

func (w *window) signalLocked() {
	close(w.changed)
	w.changed = make(chan struct{})
}

// waitRoom waits until a new item may enter: fewer than 512 items and 8 MiB in flight and nothing nacked
// or returned.
func (w *window) waitRoom(ctx context.Context) error {
	for {
		w.mu.Lock()
		room := len(w.pending) < WindowItems && w.bytes < WindowBytes && w.held == 0
		changed := w.changed
		w.mu.Unlock()
		if room {
			return nil
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// waitEmpty waits until every published item is confirmed; it reports false when ctx ended first.
func (w *window) waitEmpty(ctx context.Context) bool {
	for {
		w.mu.Lock()
		empty := len(w.pending) == 0
		changed := w.changed
		w.mu.Unlock()
		if empty {
			return true
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return false
		}
	}
}

// add publishes item seq (the scheduler pulls the next item only after Send returned, so a blocked or
// disconnected broker pauses the generator).
func (w *window) add(seq int64, hash string, body []byte) {
	w.mu.Lock()
	e := &entry{seq: seq, hash: hash, body: body, gen: w.gen}
	w.pending[seq] = e
	w.bytes += len(body)
	w.published = max(w.published, seq+1)
	w.mu.Unlock()
	w.send(e)
}

func (w *window) send(e *entry) {
	conf := w.pub.Send(w.ctx, amqpx.Publication{Exchange: w.exchange, RoutingKey: w.key, Type: runtime.TypeAnalysis, Body: e.body})
	go func() { w.result(e, conf.Wait(w.ctx)) }()
}

func (w *window) result(e *entry, out amqpx.Outcome) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if e.gen != w.gen || w.pending[e.seq] != e {
		return // superseded by a restart
	}
	switch out {
	case amqpx.Confirmed:
		delete(w.pending, e.seq)
		w.bytes -= len(e.body)
		w.confirmLocked(e.seq, e.hash)
	case amqpx.Nacked, amqpx.Returned:
		if out == amqpx.Nacked {
			e.state = stateNacked
		} else {
			e.state = stateReturned
			w.log.Warn("analysis message returned as unroutable: the scan queue is missing; polling state", "seq", e.seq)
			if w.pollNow != nil {
				w.pollNow()
			}
		}
		w.held++
		if !w.looping {
			w.looping = true
			go w.backpressureLoop(w.gen)
		}
	case amqpx.Unconfirmed:
		if w.ctx.Err() == nil {
			go w.send(e) // after a reconnect; duplicates are harmless
		}
	}
	w.signalLocked()
}

// confirmLocked advances the contiguous prefix past seq once every earlier seq is confirmed.
func (w *window) confirmLocked(seq int64, hash string) {
	if seq < w.confirmed {
		return
	}
	if seq != w.confirmed {
		w.beyond[seq] = hash
		return
	}
	w.confirmed++
	h := hash
	for {
		next, ok := w.beyond[w.confirmed]
		if !ok {
			break
		}
		delete(w.beyond, w.confirmed)
		w.confirmed++
		h = next
	}
	w.tailHash = &h
}

// backpressureLoop republishes nacked and returned items in seq order after the backpressure wait,
// until none is left.
func (w *window) backpressureLoop(gen int) {
	for {
		w.mu.Lock()
		if w.gen != gen || w.held == 0 {
			w.looping, w.backpressure = false, false
			w.signalLocked()
			w.mu.Unlock()
			return
		}
		w.backpressure = true
		w.mu.Unlock()
		wait := time.Duration(float64(w.wait) * (0.8 + 0.4*rand.Float64())) //nolint:gosec // jitter
		select {
		case <-time.After(wait):
		case <-w.ctx.Done():
			w.mu.Lock()
			w.looping = false
			w.mu.Unlock()
			return
		}
		w.mu.Lock()
		if w.gen != gen {
			w.looping = false
			w.mu.Unlock()
			return
		}
		var again []*entry
		for _, e := range w.pending {
			if e.state != statePending {
				e.state = statePending
				again = append(again, e)
			}
		}
		w.held = 0
		w.mu.Unlock()
		slices.SortFunc(again, func(a, b *entry) int { return cmp.Compare(a.seq, b.seq) })
		for _, e := range again {
			w.send(e)
		}
		// Wait for the republished confirms before deciding whether to wait again.
		for _, e := range again {
			for {
				w.mu.Lock()
				settled := w.pending[e.seq] != e || e.state != statePending || w.gen != gen
				changed := w.changed
				w.mu.Unlock()
				if settled {
					break
				}
				select {
				case <-changed:
				case <-w.ctx.Done():
					w.mu.Lock()
					w.looping = false
					w.mu.Unlock()
					return
				}
			}
		}
	}
}

// reset forgets the items in flight (a restart regenerates them from the confirmed prefix); late
// confirms of the old generation are ignored.
func (w *window) reset() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.gen++
	w.pending = map[int64]*entry{}
	w.beyond = map[int64]string{}
	w.bytes, w.held = 0, 0
	w.backpressure = false
	w.signalLocked()
}

// checkpoint returns the confirmed prefix and the hash of its last item.
func (w *window) checkpoint() api.Checkpoint {
	w.mu.Lock()
	defer w.mu.Unlock()
	return api.Checkpoint{Confirmed: w.confirmed, TailHash: w.tailHash}
}

// progress returns the scheduler part of a state poll.
func (w *window) progress() api.SchedulerProgress {
	w.mu.Lock()
	defer w.mu.Unlock()
	return api.SchedulerProgress{Published: w.published, Confirmed: w.confirmed, Nacked: int64(w.held), Backpressure: w.backpressure}
}
