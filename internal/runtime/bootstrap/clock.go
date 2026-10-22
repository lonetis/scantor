package bootstrap

import (
	"sync"
	"time"

	"github.com/lonetis/scantor/internal/api"
)

// Clock is the server-corrected clock (docs/runtime.md §5.2). Every timestamp the runtime produces uses
// Now; durations use the monotonic clock.
type Clock struct {
	mu     sync.Mutex
	offset time.Duration
	have   bool
	now    func() time.Time
}

// Thresholds of the offset estimate.
const (
	maxSampleRTT = 2 * time.Second
	ewmaAlpha    = 0.2
)

// NewClock returns a clock without an offset.
func NewClock() *Clock { return &Clock{now: time.Now} }

// Observe adds a sample from a response carrying serverTime (epoch ms); sent and received are the local
// times around the request. The first sample sets the offset; later samples with an rtt of at most 2 s
// update it as an EWMA (α = 0.2); slower samples are discarded.
func (c *Clock) Observe(serverTimeMs int64, sent, received time.Time) {
	if serverTimeMs <= 0 {
		return
	}
	sample := api.ClockOffset(serverTimeMs, sent, received)
	c.mu.Lock()
	defer c.mu.Unlock()
	switch {
	case !c.have:
		c.offset, c.have = sample, true
	case received.Sub(sent) <= maxSampleRTT:
		c.offset = time.Duration((1-ewmaAlpha)*float64(c.offset) + ewmaAlpha*float64(sample))
	}
}

// Now returns the local time plus the offset.
func (c *Clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now().Add(c.offset)
}

// Offset returns the current offset.
func (c *Clock) Offset() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.offset
}
