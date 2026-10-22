package bootstrap

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/lonetis/scantor/internal/api"
)

// warnEvery bounds the warnings about failing state polls (docs/runtime.md §5.1).
const warnEvery = time.Minute

// Poller runs the state-poll loop (docs/runtime.md §5.1): every nextPollMs of the last response
// (initially intervals.statePollMs) ± statePollJitter it sends POST /api/runtime/state with the request
// Build returns and passes the response to Handle. Failures keep the last known state (Handle is not
// called) and are logged at warn once per minute; a 401 is handed to Handle as a stop.
type Poller struct {
	Client *Client
	// Interval and Jitter come from bootstrap intervals.
	Interval time.Duration
	Jitter   float64
	Build    func() api.RuntimeStateRequest
	Handle   func(*api.RuntimeStateResponse)
	Logger   *slog.Logger

	now      chan struct{}
	mu       sync.Mutex
	next     time.Duration
	lastWarn time.Time
	lastOK   time.Time
}

// stopResponse is what a 401 means for the runtime.
var stopResponse = api.RuntimeStateResponse{Action: api.ActionStop}

// Run polls until ctx ends.
func (p *Poller) Run(ctx context.Context) {
	p.init()
	for {
		timer := time.NewTimer(p.delay())
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		case <-p.now:
			timer.Stop()
		}
		p.Poll(ctx)
	}
}

func (p *Poller) init() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.now == nil {
		p.now = make(chan struct{}, 1)
	}
	if p.next == 0 {
		p.next = p.Interval
	}
	if p.Logger == nil {
		p.Logger = slog.New(slog.DiscardHandler)
	}
}

// PollNow makes the loop poll at once (for example after a returned publish or a 404 on consume).
func (p *Poller) PollNow() {
	p.init()
	select {
	case p.now <- struct{}{}:
	default:
	}
}

// Poll sends one state poll now and handles its response. It reports whether the poll succeeded.
func (p *Poller) Poll(ctx context.Context) bool {
	p.init()
	resp, err := p.Client.State(ctx, p.Build())
	switch {
	case err == nil:
		p.mu.Lock()
		if resp.NextPollMs > 0 {
			p.next = time.Duration(resp.NextPollMs) * time.Millisecond
		}
		p.lastOK = time.Now()
		p.mu.Unlock()
		p.Handle(resp)
		return true
	case errors.Is(err, ErrUnauthorized):
		r := stopResponse
		p.Handle(&r)
		return true
	case ctx.Err() != nil:
		return false
	default:
		p.mu.Lock()
		warn := time.Since(p.lastWarn) >= warnEvery
		if warn {
			p.lastWarn = time.Now()
		}
		p.mu.Unlock()
		if warn {
			p.Logger.Warn("state poll failed; keeping the last known state", "err", err)
		}
		return false
	}
}

// LastSuccess returns the time of the last successful poll (zero before the first).
func (p *Poller) LastSuccess() time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.lastOK
}

func (p *Poller) delay() time.Duration {
	p.mu.Lock()
	defer p.mu.Unlock()
	d := float64(p.next)
	if p.Jitter > 0 {
		d *= 1 - p.Jitter + 2*p.Jitter*rand.Float64() //nolint:gosec // jitter needs no cryptographic randomness
	}
	return time.Duration(d)
}
