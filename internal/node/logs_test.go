package node

import (
	"strings"
	"testing"
	"unicode/utf8"

	dcontainer "github.com/moby/moby/api/types/container"
)

func TestTailUTF8(t *testing.T) {
	cases := []struct {
		in   string
		n    int
		want string
		cut  bool
	}{
		{"hello", 10, "hello", false},
		{"hello", 3, "llo", true},
		{"aé", 1, "", true},   // the cut lands inside "é": skip to the next boundary
		{"aéb", 2, "b", true}, // same, keeping what follows
		{"aéb", 3, "éb", true},
		{"€€", 4, "€", true},
		{"x", -1, "", true},
	}
	for _, tc := range cases {
		got, cut := tailUTF8([]byte(tc.in), tc.n)
		if string(got) != tc.want || cut != tc.cut || !utf8.Valid(got) {
			t.Errorf("tailUTF8(%q, %d) = %q, %v; want %q, %v", tc.in, tc.n, got, cut, tc.want, tc.cut)
		}
	}
	if got := truncateUTF8("aé", 2); got != "a" {
		t.Errorf("truncateUTF8 = %q", got)
	}
}

func TestRequestLines(t *testing.T) {
	for tail, want := range map[int]int{0: 200, 64: 200, 12800: 200, 65536: 1024, 262144: 4096} {
		if got := requestLines(tail); got != want {
			t.Errorf("requestLines(%d) = %d, want max(200, tailBytes/64)", tail, got)
		}
	}
}

func TestContainerLogTail(t *testing.T) {
	docker := newFakeDocker()
	c := docker.addContainer("scantor-w-"+testWorker1, nil, dcontainer.StateExited)
	docker.logs[c.name] = strings.Repeat("é", 3000) + "\nlast line\n"
	tail, err := containerLogTail(t.Context(), docker, c.id, exitTailLines, exitTailBytes)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail.text) > exitTailBytes || !utf8.ValidString(tail.text) || !strings.HasSuffix(tail.text, "\nlast line\n") || !tail.truncated {
		t.Errorf("tail has %d bytes, valid=%v, truncated=%v", len(tail.text), utf8.ValidString(tail.text), tail.truncated)
	}
	docker.logs[c.name] = "short\n"
	tail, err = containerLogTail(t.Context(), docker, c.id, exitTailLines, exitTailBytes)
	if err != nil || tail.text != "short\n" || tail.truncated {
		t.Errorf("short tail = %+v, %v", tail, err)
	}
	// Large outputs are bounded while reading.
	w := &tailWriter{max: 10}
	for range 1000 {
		_, _ = w.Write([]byte("0123456789"))
	}
	if len(w.bytes()) > 2*10+4096 || !w.dropped {
		t.Errorf("tail writer holds %d bytes", len(w.bytes()))
	}
}
