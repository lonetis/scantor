// Package logtail captures connector output (docs/runtime.md §13): a ring buffer that keeps the last N
// bytes of an analysis's output, rendering of bounded tails, a splitter that turns output streams into
// lines of at most MaxLineBytes, and the rate limit of output mirrored into the runtime log.
package logtail

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"time"
	"unicode/utf8"
)

// MaxLineBytes is the longest captured output line; longer lines are split (docs/protocol.md §8).
const MaxLineBytes = 16 << 10

// Buffer keeps the last Cap bytes written to it. It is safe for concurrent use.
type Buffer struct {
	mu    sync.Mutex
	limit int
	data  []byte // ring storage, len ≤ limit
	start int    // index of the oldest byte when the ring is full
	total int64  // bytes written since the last Reset
}

// NewBuffer returns a buffer that keeps the last limit bytes.
func NewBuffer(limit int) *Buffer {
	return &Buffer{limit: max(limit, 0)}
}

// Write appends p, dropping the oldest bytes beyond the limit.
func (b *Buffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	written := len(p)
	b.total += int64(written)
	if b.limit == 0 {
		return written, nil
	}
	if len(p) >= b.limit {
		b.data = append(b.data[:0], p[len(p)-b.limit:]...)
		b.start = 0
		return written, nil
	}
	if room := b.limit - len(b.data); room > 0 {
		n := min(room, len(p))
		b.data = append(b.data, p[:n]...)
		p = p[n:]
	}
	for len(p) > 0 { // the ring is full: overwrite from start
		n := copy(b.data[b.start:], p)
		b.start = (b.start + n) % b.limit
		p = p[n:]
	}
	return written, nil
}

// WriteString appends s.
func (b *Buffer) WriteString(s string) { _, _ = b.Write([]byte(s)) }

// Reset empties the buffer.
func (b *Buffer) Reset() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.data, b.start, b.total = b.data[:0], 0, 0
}

// Bytes returns the kept bytes in order and the number of bytes written in total.
func (b *Buffer) Bytes() ([]byte, int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]byte, 0, len(b.data))
	out = append(out, b.data[b.start:]...)
	out = append(out, b.data[:b.start]...)
	return out, b.total
}

// Tail renders the end of the captured output in at most limit bytes (docs/runtime.md §13.1): the end is
// kept, the cut is at a rune boundary, and a truncated tail starts with "…[<n> bytes truncated]\n",
// where n counts every dropped byte.
func (b *Buffer) Tail(limit int) string {
	data, total := b.Bytes()
	return Render(data, total, limit)
}

// Render is Tail for bytes that are the end of a stream of total bytes.
func Render(data []byte, total int64, limit int) string {
	if limit <= 0 {
		return ""
	}
	if int64(len(data)) == total && len(data) <= limit {
		return string(data)
	}
	keep := len(data)
	var prefix string
	for range 3 { // the prefix length depends on the dropped count; converge
		prefix = fmt.Sprintf("…[%d bytes truncated]\n", total-int64(keep))
		keep = min(len(data), max(limit-len(prefix), 0))
		tail := data[len(data)-keep:]
		for len(tail) > 0 && !utf8.RuneStart(tail[0]) {
			tail = tail[1:]
		}
		keep = len(tail)
	}
	prefix = fmt.Sprintf("…[%d bytes truncated]\n", total-int64(keep))
	if len(prefix) > limit {
		return ""
	}
	return prefix + string(data[len(data)-keep:])
}

// SplitLines reads r until EOF and calls emit for every line without its newline; lines longer than
// MaxLineBytes are emitted in chunks cut at rune boundaries. Invalid UTF-8 is kept as is.
func SplitLines(r io.Reader, emit func(line string)) error {
	br := bufio.NewReaderSize(r, MaxLineBytes)
	var pending []byte
	for {
		chunk, err := br.ReadSlice('\n')
		pending = append(pending, chunk...)
		switch err { //nolint:errorlint // bufio returns these sentinels unwrapped
		case nil:
			emitChunks(trimNewline(pending), emit)
			pending = pending[:0]
		case bufio.ErrBufferFull:
			for len(pending) > MaxLineBytes {
				cut := runeCut(pending, MaxLineBytes)
				emit(string(pending[:cut]))
				pending = append(pending[:0], pending[cut:]...)
			}
		case io.EOF:
			if len(pending) > 0 {
				emitChunks(pending, emit)
			}
			return nil
		default:
			if len(pending) > 0 {
				emitChunks(pending, emit)
			}
			return err
		}
	}
}

func trimNewline(b []byte) []byte {
	if n := len(b); n > 0 && b[n-1] == '\n' {
		b = b[:n-1]
		if n := len(b); n > 0 && b[n-1] == '\r' {
			b = b[:n-1]
		}
	}
	return b
}

func emitChunks(b []byte, emit func(string)) {
	for len(b) > MaxLineBytes {
		cut := runeCut(b, MaxLineBytes)
		emit(string(b[:cut]))
		b = b[cut:]
	}
	emit(string(b))
}

// runeCut returns the largest cut ≤ n (n < len(b)) at a rune boundary, or n when there is none.
func runeCut(b []byte, n int) int {
	cut := n
	for cut > 0 && !utf8.RuneStart(b[cut]) {
		cut--
	}
	if cut == 0 {
		return n
	}
	return cut
}

// RateLimiter bounds the bytes per second of connector output mirrored into the runtime log
// (docs/runtime.md §13.2: 64 KiB/s per worker). Excess lines are dropped and counted.
type RateLimiter struct {
	mu       sync.Mutex
	rate     float64 // bytes per second
	burst    float64
	tokens   float64
	last     time.Time
	dropped  int64
	reported time.Time
	now      func() time.Time
}

// NewRateLimiter returns a limiter of bytesPerSecond with a one-second burst.
func NewRateLimiter(bytesPerSecond int) *RateLimiter {
	r := float64(bytesPerSecond)
	return &RateLimiter{rate: r, burst: r, tokens: r, now: time.Now}
}

// Allow reports whether a line of n bytes may be mirrored now; refused lines are counted as dropped.
func (l *RateLimiter) Allow(n int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if !l.last.IsZero() {
		l.tokens = min(l.burst, l.tokens+now.Sub(l.last).Seconds()*l.rate)
	}
	l.last = now
	if float64(n) <= l.tokens {
		l.tokens -= float64(n)
		return true
	}
	l.dropped++
	return false
}

// DroppedReport returns the number of dropped lines since the last report when at least interval has
// passed since then (a WARN line once per minute); otherwise 0.
func (l *RateLimiter) DroppedReport(interval time.Duration) int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if l.dropped == 0 || now.Sub(l.reported) < interval {
		return 0
	}
	n := l.dropped
	l.dropped, l.reported = 0, now
	return n
}

// Mirror writes connector output into the runtime log as `connector output` lines: at most
// bytesPerSecond per worker, each line at most MaxLineBytes, and a WARN with the dropped count once per
// interval (docs/runtime.md §13.2).
type Mirror struct {
	log      *slog.Logger
	limiter  *RateLimiter
	msg      string
	interval time.Duration
}

// Mirror defaults (docs/runtime.md §13.2).
const (
	MirrorBytesPerSecond = 64 << 10
	MirrorReportInterval = time.Minute
)

// NewMirror returns a mirror logging msg ("connector output", "dockerd output") with the default limits.
func NewMirror(log *slog.Logger, msg string) *Mirror {
	return &Mirror{log: log, limiter: NewRateLimiter(MirrorBytesPerSecond), msg: msg, interval: MirrorReportInterval}
}

// Sink returns a line sink that logs every line with attrs (correlation fields).
func (m *Mirror) Sink(attrs ...any) func(stream, line string) {
	return func(stream, line string) {
		if len(line) > MaxLineBytes {
			line = line[:MaxLineBytes]
		}
		if !m.limiter.Allow(len(line)) {
			return
		}
		m.log.Info(m.msg, append([]any{"stream", stream, "line", line}, attrs...)...)
	}
}

// ReportLoop warns about dropped lines once per interval until ctx ends or stop is closed.
func (m *Mirror) ReportLoop(ctx context.Context, stop <-chan struct{}) {
	t := time.NewTicker(m.interval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			if n := m.limiter.DroppedReport(m.interval); n > 0 {
				m.log.Warn("output exceeded 64 KiB/s; lines were dropped from the runtime log", "dropped", n)
			}
		case <-ctx.Done():
			return
		case <-stop:
			return
		}
	}
}
