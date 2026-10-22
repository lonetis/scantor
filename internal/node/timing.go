package node

import (
	"context"
	"math"
	"math/rand/v2"
	"time"
)

// timings are the fixed intervals and backoffs of docs/nodes.md. Tests shrink them.
type timings struct {
	// reconcileEvery is the upper bound between two reconcile passes (§6).
	reconcileEvery time.Duration
	// egressEvery re-applies the egress deny list (§9).
	egressEvery time.Duration
	// gcEvery runs the image GC (§8); emergencyGCEvery bounds the emergency GC.
	gcEvery          time.Duration
	emergencyGCEvery time.Duration
	// statusDebounce delays a status report after local state changes (§7.1).
	statusDebounce time.Duration
	// apiBackoffMin and apiBackoffMax bound the backoff of failed API calls (§5.2, §7.4).
	apiBackoffMin time.Duration
	apiBackoffMax time.Duration
	// unauthorizedRetry is the hello interval in unauthorized mode and after a 401 hello (§5.2, §7.4).
	unauthorizedRetry time.Duration
	// defaultOfflineAfter is the unauthorized window when the orchestrator's value is unknown (§7.4).
	defaultOfflineAfter time.Duration
	// incompatibleRetry is the hello interval after 426 (§5.2).
	incompatibleRetry time.Duration
	// exitZeroDelay is the restart delay after a clean exit; crashBase/crashMax bound the crash backoff;
	// crashReset is the uptime after which the crash counter resets (§6.5).
	exitZeroDelay time.Duration
	crashBase     time.Duration
	crashMax      time.Duration
	crashReset    time.Duration
	// failureBase and failureMax bound the retries of failed pulls and creates (§10.1).
	failureBase time.Duration
	failureMax  time.Duration
	// recheck is the delay of a step that waits for a transient Docker state.
	recheck time.Duration
	// shutdownGrace bounds in-flight Docker calls at shutdown; finalStatusTimeout bounds the last
	// status (§7.5).
	shutdownGrace      time.Duration
	finalStatusTimeout time.Duration
	// logRequestMemory is how long answered log request ids are remembered (§7.3).
	logRequestMemory time.Duration
	// removedReports is how many status reports repeat a removed worker (§7.1).
	removedReports int
	// networkRetry re-checks a missing worker network.
	networkRetry time.Duration
	// helperTimeout bounds one egress helper run.
	helperTimeout time.Duration
}

func defaultTimings() timings {
	return timings{
		reconcileEvery:      5 * time.Second,
		egressEvery:         10 * time.Minute,
		gcEvery:             10 * time.Minute,
		emergencyGCEvery:    5 * time.Minute,
		statusDebounce:      time.Second,
		apiBackoffMin:       time.Second,
		apiBackoffMax:       30 * time.Second,
		unauthorizedRetry:   60 * time.Second,
		defaultOfflineAfter: 60 * time.Second,
		incompatibleRetry:   5 * time.Minute,
		exitZeroDelay:       10 * time.Second,
		crashBase:           5 * time.Second,
		crashMax:            5 * time.Minute,
		crashReset:          10 * time.Minute,
		failureBase:         10 * time.Second,
		failureMax:          5 * time.Minute,
		recheck:             time.Second,
		shutdownGrace:       10 * time.Second,
		finalStatusTimeout:  2 * time.Second,
		logRequestMemory:    10 * time.Minute,
		removedReports:      3,
		networkRetry:        30 * time.Second,
		helperTimeout:       2 * time.Minute,
	}
}

// expBackoff returns min(base × 2^(n−1), maxDelay) for the n-th consecutive failure (n ≥ 1).
func expBackoff(base, maxDelay time.Duration, n int) time.Duration {
	if n < 1 {
		n = 1
	}
	d := float64(base) * math.Pow(2, float64(n-1))
	if d > float64(maxDelay) || math.IsInf(d, 1) {
		return maxDelay
	}
	return time.Duration(d)
}

// jitter scales d by a uniform factor in [1−frac, 1+frac].
func jitter(d time.Duration, frac float64) time.Duration {
	f := 1 - frac + 2*frac*rand.Float64() //nolint:gosec // backoff jitter needs no cryptographic randomness
	return time.Duration(float64(d) * f)
}

// backoff is the exponential backoff of a retried API call: 1 s doubling up to 30 s with ±20 % jitter.
type backoff struct {
	min, max time.Duration
	n        int
}

func (b *backoff) next() time.Duration {
	b.n++
	return jitter(expBackoff(b.min, b.max, b.n), 0.2)
}

func (b *backoff) reset() { b.n = 0 }

// sleep waits for d or until ctx ends; it reports whether the full duration elapsed.
func sleep(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
