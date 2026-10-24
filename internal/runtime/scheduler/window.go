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
	// depthWait is the pause between reads of the scan queue's ready count while the queue holds the
	// scheduler's share, ± 20 %.
	depthWait = 250 * time.Millisecond
)

// Publisher sends analysis messages through the shared confirm publisher (amqpx.Publisher).
type Publisher interface {
	Send(ctx context.Context, pub amqpx.Publication) amqpx.Confirmation
}

// QueueDepth reads the ready count of the scan queue (amqpx.Queue).
type QueueDepth interface {
	ReadyCount(ctx context.Context) (int, error)
}

// shareOf returns the ready messages the scheduler keeps in a scan queue with x-max-length maxLength: half of
// it, so that retries, which count toward the limit while they are delayed, fit into the other half
// (docs/runtime.md §11.4). 0 disables the share; only the broker's limit applies then.
func shareOf(maxLength int64) int {
	if maxLength <= 0 {
		return 0
	}
	return int(max(maxLength/2, 1))
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
// (docs/runtime.md §11.4, §11.5). New items enter only while the scan queue's ready messages plus the items
// in flight stay within the scheduler's share of the queue (half of x-max-length); once the share is used up,
// the window reads the ready count again every depthWait ± 20 % and opens when a fifth of the share is free.
// Nacked items put the window into backpressure: after backpressureWaitMs ± 20 % only the nacked seqs are
// republished, in seq order, and no new item enters while any seq is nacked. Returned items (no queue bound)
// are handled the same way after a state poll.
type window struct {
	pub      Publisher
	depth    QueueDepth
	share    int // ready plus in-flight messages the scheduler keeps in the queue; 0: no share
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
	credit       int  // items that may still enter before the ready count is read again
	full         bool // the queue holds the scheduler's share: waiting for room
}

func newWindow(ctx context.Context, pub Publisher, depth QueueDepth, share int, exchange, key string, wait time.Duration, pollNow func(), log *slog.Logger, cp api.Checkpoint) *window {
	if depth == nil {
		share = 0
	}
	return &window{
		pub: pub, depth: depth, share: share, exchange: exchange, key: key, wait: wait, pollNow: pollNow, log: log, ctx: ctx,
		changed: make(chan struct{}), pending: map[int64]*entry{}, beyond: map[int64]string{},
		confirmed: cp.Confirmed, tailHash: cp.TailHash, published: cp.Confirmed,
	}
}

func (w *window) signalLocked() {
	close(w.changed)
	w.changed = make(chan struct{})
}

// waitRoom waits until a new item may enter: fewer than 512 items and 8 MiB in flight, nothing nacked or
// returned, and room within the scheduler's share of the queue.
func (w *window) waitRoom(ctx context.Context) error {
	for {
		w.mu.Lock()
		room := len(w.pending) < WindowItems && w.bytes < WindowBytes && w.held == 0
		measure := room && w.share > 0 && w.credit <= 0
		changed := w.changed
		w.mu.Unlock()
		switch {
		case measure:
			if err := w.waitShare(ctx); err != nil {
				return err
			}
		case room:
			return nil
		default:
			select {
			case <-changed:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
}

// waitShare reads the queue's ready count until the scheduler's share has room for at least a fifth of it, and
// grants that room as credit. A missing queue (cancelled or terminal scan) makes it poll state and keep
// waiting; any other failure to read the count grants one window, so the broker's limit alone applies.
func (w *window) waitShare(ctx context.Context) error {
	resume := max(w.share/5, 1)
	for {
		// Items in flight before the read: an item confirmed while the broker counted may be in neither number.
		// Nothing enters the window meanwhile, so this count also covers every item the count may miss.
		w.mu.Lock()
		inFlight := len(w.pending)
		w.mu.Unlock()
		ready, err := w.depth.ReadyCount(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		wait := time.Duration(float64(depthWait) * (0.8 + 0.4*rand.Float64())) //nolint:gosec // jitter
		room := w.share - ready - inFlight
		w.mu.Lock()
		switch {
		case err == nil && room >= resume:
			if w.full {
				w.log.Info("the scan queue has room again", "ready", ready, "share", w.share)
			}
			w.credit, w.full = room, false
			w.mu.Unlock()
			return nil
		case err == nil:
			if !w.full {
				w.log.Info("the scan queue holds the scheduler's share; waiting for room", "ready", ready, "inFlight", inFlight, "share", w.share)
			}
			w.full = true
		case amqpx.IsNotFound(err):
			if !w.full {
				w.log.Warn("the scan queue does not exist; polling state", "err", err)
			}
			w.full = true
			wait = w.wait
			if w.pollNow != nil {
				w.pollNow()
			}
		default:
			w.log.Warn("cannot read the scan queue's ready count; publishing up to the broker's limit", "err", err)
			w.credit, w.full = WindowItems, false
			w.mu.Unlock()
			return nil
		}
		w.mu.Unlock()
		select {
		case <-time.After(wait):
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
	w.credit--
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
	w.credit, w.full = 0, false
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
	return api.SchedulerProgress{Published: w.published, Confirmed: w.confirmed, Nacked: int64(w.held), Backpressure: w.backpressure || w.full}
}
