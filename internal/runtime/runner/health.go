package runner

import (
	"sync"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/runtime/scerr"
)

// Unhealthy triggers (docs/runtime.md §12).
const (
	transientWindow    = 60 * time.Second
	transientThreshold = 3
	spawnThreshold     = 3
)

// Health tracks the worker's health state (docs/runtime.md §12): transient platform failures, spawn
// failures, exhausted holding budgets and low free space make the worker unhealthy; while unhealthy no
// slot consumes. It is safe for concurrent use.
type Health struct {
	mu            sync.Mutex
	transient     []time.Time
	spawnFailures int
	unhealthy     bool
	reason        scerr.ScantorError
	changed       func()
	now           func() time.Time
}

// NewHealth returns a healthy state; changed is called after every transition.
func NewHealth(changed func()) *Health {
	return &Health{changed: changed, now: time.Now}
}

// Healthy reports whether the worker is healthy.
func (h *Health) Healthy() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return !h.unhealthy
}

// Reason returns the error that made the worker unhealthy.
func (h *Health) Reason() (scerr.ScantorError, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.reason, h.unhealthy
}

// Transient records a transient platform failure (presign, PUT, publish) in phase; 3 within 60 s make
// the worker unhealthy.
func (h *Health) Transient(phase api.ErrorPhase, err error) {
	h.mu.Lock()
	now := h.now()
	kept := h.transient[:0]
	for _, t := range h.transient {
		if now.Sub(t) < transientWindow {
			kept = append(kept, t)
		}
	}
	h.transient = append(kept, now)
	trip := len(h.transient) >= transientThreshold
	h.mu.Unlock()
	if trip {
		h.trip(scerr.Newf(api.ErrorPlatform, phase, "%d transient platform failures within %s: %v", transientThreshold, transientWindow, err))
	}
}

// SpawnFailed records a failed respawn; 3 consecutive failures across the worker make it unhealthy.
func (h *Health) SpawnFailed(err error) {
	h.mu.Lock()
	h.spawnFailures++
	trip := h.spawnFailures >= spawnThreshold
	h.mu.Unlock()
	if trip {
		h.trip(scerr.Newf(api.ErrorPlatform, api.PhaseBootstrap, "%d consecutive connector spawn failures: %v", spawnThreshold, err))
	}
}

// SpawnSucceeded resets the spawn failure streak.
func (h *Health) SpawnSucceeded() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.spawnFailures = 0
}

// BudgetExhausted records a delivery given back because its holding budget ran out.
func (h *Health) BudgetExhausted(phase api.ErrorPhase, what string) {
	h.trip(scerr.Newf(api.ErrorPlatform, phase, "holding budget exhausted while %s; the analysis was given back", what))
}

// LowSpace records free space below limits.minFreeTmpBytes.
func (h *Health) LowSpace(free, minFree int64) {
	h.trip(scerr.Newf(api.ErrorPlatform, api.PhasePlatform, "only %d bytes free under /tmp/scantor; at least %d are required", free, minFree))
}

func (h *Health) trip(reason scerr.ScantorError) {
	h.mu.Lock()
	was := h.unhealthy
	h.unhealthy = true
	if !was {
		h.reason = reason
	}
	h.mu.Unlock()
	if !was && h.changed != nil {
		h.changed()
	}
}

// Recover marks the worker healthy again after a successful probe.
func (h *Health) Recover() {
	h.mu.Lock()
	was := h.unhealthy
	h.unhealthy = false
	h.transient = h.transient[:0]
	h.spawnFailures = 0
	h.mu.Unlock()
	if was && h.changed != nil {
		h.changed()
	}
}
