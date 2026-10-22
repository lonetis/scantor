package logtail

import (
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestBufferKeepsTheEnd(t *testing.T) {
	b := NewBuffer(10)
	b.WriteString("hello ")
	b.WriteString("world, ")
	b.WriteString("again")
	data, total := b.Bytes()
	if string(data) != "rld, again" || total != 18 {
		t.Fatalf("got %q (%d)", data, total)
	}
	b.WriteString(strings.Repeat("x", 25))
	if data, total := b.Bytes(); string(data) != strings.Repeat("x", 10) || total != 43 {
		t.Fatalf("got %q (%d)", data, total)
	}
	b.Reset()
	if data, total := b.Bytes(); len(data) != 0 || total != 0 {
		t.Fatal("reset")
	}
}

func TestTail(t *testing.T) {
	b := NewBuffer(32 << 10)
	b.WriteString("short\n")
	if got := b.Tail(4096); got != "short\n" {
		t.Fatalf("untruncated tail %q", got)
	}
	b.Reset()
	b.WriteString(strings.Repeat("ä", 5000)) // 10000 bytes
	got := b.Tail(4096)
	if len(got) > 4096 || !utf8.ValidString(got) {
		t.Fatalf("tail of %d bytes, valid %v", len(got), utf8.ValidString(got))
	}
	prefix, rest, ok := strings.Cut(got, "]\n")
	if !ok || !strings.HasPrefix(prefix, "…[") {
		t.Fatalf("no truncation marker: %.40q", got)
	}
	if want := "…[" + itoa(10000-len(rest)) + " bytes truncated"; prefix != want {
		t.Fatalf("marker %q, want %q", prefix, want)
	}
	// Bytes dropped by the ring itself are counted too.
	small := NewBuffer(40)
	small.WriteString(strings.Repeat("a", 100))
	if got := small.Tail(40); got != "…[84 bytes truncated]\n"+strings.Repeat("a", 16) {
		t.Fatalf("ring tail %q", got)
	}
}

func itoa(n int) string { return strconv.Itoa(n) }

func TestSplitLines(t *testing.T) {
	long := strings.Repeat("é", MaxLineBytes) // 2 × MaxLineBytes bytes
	in := "a\r\nb\n\n" + long + "\nlast"
	var lines []string
	if err := SplitLines(strings.NewReader(in), func(l string) { lines = append(lines, l) }); err != nil {
		t.Fatal(err)
	}
	if lines[0] != "a" || lines[1] != "b" || lines[2] != "" || lines[len(lines)-1] != "last" {
		t.Fatalf("lines %q", lines[:3])
	}
	joined := strings.Join(lines[3:len(lines)-1], "")
	if joined != long {
		t.Fatal("long line not preserved")
	}
	for _, l := range lines {
		if len(l) > MaxLineBytes || !utf8.ValidString(l) {
			t.Fatalf("chunk of %d bytes", len(l))
		}
	}
}

func TestRateLimiter(t *testing.T) {
	now := time.Unix(0, 0)
	l := NewRateLimiter(100)
	l.now = func() time.Time { return now }
	if !l.Allow(60) || !l.Allow(40) || l.Allow(1) {
		t.Fatal("burst accounting")
	}
	now = now.Add(500 * time.Millisecond)
	if !l.Allow(50) || l.Allow(10) {
		t.Fatal("refill accounting")
	}
	if n := l.DroppedReport(time.Minute); n != 2 {
		t.Fatalf("dropped %d", n)
	}
	l.Allow(1000)
	if n := l.DroppedReport(time.Minute); n != 0 {
		t.Fatal("reported twice within the interval")
	}
}
