package scerr

import (
	"math"
	"math/rand/v2"
	"time"

	"github.com/lonetis/scantor/internal/api"
)

// MinRetryDelay is the floor of every retry delivery time (docs/runtime.md §10.2): a future-dated publish
// is accepted even by a full queue, and jitter cannot produce sub-second delays.
const MinRetryDelay = time.Second

// Policy is the retry policy of a scan's settings (docs/runtime.md §10).
type Policy struct {
	Backoff     api.Backoff
	MaxAttempts int
	// MaxDelay caps every delay (local mode: 2 s, docs/runtime.md §15.2); 0 means no cap.
	MaxDelay time.Duration
	// Rand returns a uniform value in [0, 1); nil uses math/rand.
	Rand func() float64
}

// Retry reports whether a failure of the given (1-based) attempt is retried: the error is retryable,
// not cancelled, and attempts are left. Otherwise the failure is final.
func (p Policy) Retry(e ScantorError, attempt int) bool {
	return e.Retryable && e.Type != api.ErrorCancelled && attempt < p.MaxAttempts
}

// Delay returns the delay before the attempt after failed attempt n (docs/runtime.md §10.1):
// min(maxMs, initialMs × factor^(n−1)), uniform in [delay/2, delay] with jitter; a `retry` error with
// delayMs uses clamp(delayMs, 1000, maxMs) without jitter.
func (p Policy) Delay(e ScantorError, n int) time.Duration {
	maxDelay := time.Duration(p.Backoff.MaxMs) * time.Millisecond
	var d time.Duration
	if e.Type == api.ErrorRetry && e.DelayMs != nil {
		d = min(max(time.Duration(*e.DelayMs)*time.Millisecond, MinRetryDelay), max(maxDelay, MinRetryDelay))
	} else {
		factor := p.Backoff.Factor
		if factor < 1 {
			factor = 1
		}
		raw := float64(p.Backoff.InitialMs) * math.Pow(factor, float64(max(n, 1)-1))
		if maxMs := float64(p.Backoff.MaxMs); raw > maxMs {
			raw = maxMs
		}
		d = time.Duration(raw * float64(time.Millisecond))
		if p.Backoff.Jitter {
			d = time.Duration(float64(d) * (0.5 + 0.5*p.rand()))
		}
	}
	if p.MaxDelay > 0 && d > p.MaxDelay {
		d = p.MaxDelay
	}
	return max(d, 0)
}

// DeliveryTime returns the x-opt-delivery-time of a retry republish: clamp(now + delay, now + 1 s,
// now + backoff.maxMs), where now is the server-corrected clock; the 1 s floor wins over a smaller
// maximum.
func (p Policy) DeliveryTime(now time.Time, delay time.Duration) time.Time {
	maxDelay := time.Duration(p.Backoff.MaxMs) * time.Millisecond
	d := min(delay, maxDelay)
	d = max(d, MinRetryDelay)
	return now.Add(d)
}

func (p Policy) rand() float64 {
	if p.Rand != nil {
		return p.Rand()
	}
	return rand.Float64() //nolint:gosec // backoff jitter needs no cryptographic randomness
}
