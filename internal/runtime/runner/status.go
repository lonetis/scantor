package runner

import (
	"context"
	"sync"
	"time"

	"github.com/lonetis/scantor/internal/api"
)

// Redelivered status batching (docs/runtime.md §8.2).
const (
	statusWindow  = 20 * time.Millisecond
	statusMaxSeqs = api.MaxStatusSeqs
)

// StatusFunc asks the orchestrator for the stored status of seqs (one try).
type StatusFunc func(ctx context.Context, seqs []int64) (*api.AnalysesStatusResponse, error)

type statusWaiter struct {
	seq int64
	ch  chan *api.AnalysisStatusItem // nil item: unknown (run the analysis)
}

// statusBatcher coalesces the status checks of all slots within a 20 ms window into one call of at most
// 1000 seqs.
type statusBatcher struct {
	// ctx bounds every call (the worker's abort context); each call also has its own 5 s timeout.
	ctx     context.Context
	fetch   StatusFunc
	mu      sync.Mutex
	pending []statusWaiter
	timer   *time.Timer
}

func newStatusBatcher(ctx context.Context, fetch StatusFunc) *statusBatcher {
	return &statusBatcher{ctx: ctx, fetch: fetch}
}

// Lookup returns the stored status of seq, or nil when it is unknown or the call failed.
func (b *statusBatcher) Lookup(ctx context.Context, seq int64) *api.AnalysisStatusItem {
	w := statusWaiter{seq: seq, ch: make(chan *api.AnalysisStatusItem, 1)}
	b.mu.Lock()
	b.pending = append(b.pending, w)
	switch {
	case len(b.pending) >= statusMaxSeqs:
		batch := b.pending
		b.pending = nil
		if b.timer != nil {
			b.timer.Stop()
			b.timer = nil
		}
		go b.flush(b.ctx, batch)
	case b.timer == nil:
		b.timer = time.AfterFunc(statusWindow, func() {
			b.mu.Lock()
			batch := b.pending
			b.pending, b.timer = nil, nil
			b.mu.Unlock()
			b.flush(b.ctx, batch)
		})
	}
	b.mu.Unlock()
	select {
	case item := <-w.ch:
		return item
	case <-ctx.Done():
		return nil
	}
}

func (b *statusBatcher) flush(ctx context.Context, batch []statusWaiter) {
	if len(batch) == 0 {
		return
	}
	seqs := make([]int64, 0, len(batch))
	seen := map[int64]bool{}
	for _, w := range batch {
		if !seen[w.seq] {
			seen[w.seq] = true
			seqs = append(seqs, w.seq)
		}
	}
	items := map[int64]*api.AnalysisStatusItem{}
	resp, err := b.fetch(ctx, seqs)
	if err == nil {
		for i := range resp.Items {
			items[resp.Items[i].Seq] = &resp.Items[i]
		}
	}
	for _, w := range batch {
		w.ch <- items[w.seq]
	}
}

// alreadyFinal applies the skip rule (docs/api.md §8.4): the stored round is newer, or equal with a final
// status.
func alreadyFinal(item *api.AnalysisStatusItem, round int) bool {
	if item == nil || item.Round == nil || item.Status == nil {
		return false
	}
	switch {
	case *item.Round > round:
		return true
	case *item.Round == round:
		return *item.Status == "succeeded" || *item.Status == "failed"
	}
	return false
}
