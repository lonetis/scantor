package list

import (
	"bufio"
	"errors"
	"io"
)

// MaxItemBytes is the longest item (after trimming) of an uploaded list.
const MaxItemBytes = 4096

// isSpace reports whether b is removed by trimming: ASCII whitespace (space, \t, \n, \v, \f, \r). The
// orchestrator counts the `lines` of an upload with the same set (docs/data-model.md §4.10), and the
// estimate must match the stream exactly. Multi-byte UTF-8 sequences never contain these bytes.
func isSpace(b byte) bool {
	switch b {
	case ' ', '\t', '\n', '\v', '\f', '\r':
		return true
	}
	return false
}

func trimBytes(b []byte) []byte {
	start, end := 0, len(b)
	for start < end && isSpace(b[start]) {
		start++
	}
	for end > start && isSpace(b[end-1]) {
		end--
	}
	return b[start:end]
}

// Trim removes leading and trailing whitespace (isSpace).
func Trim(s string) string { return string(trimBytes([]byte(s))) }

// errItemTooLong reports a line whose trimmed content exceeds MaxItemBytes.
type errItemTooLong struct{ line int64 }

func (e *errItemTooLong) Error() string { return "line too long" }

// forEachItem calls fn with the 1-based line number and the trimmed content of every non-empty
// line of r (split on "\n"). A trimmed line longer than MaxItemBytes stops with *errItemTooLong.
// Lines of any raw length are handled in bounded memory. fn returns false to stop early.
func forEachItem(r io.Reader, fn func(line int64, item []byte) bool) error {
	br := bufio.NewReaderSize(r, 64<<10)
	var n int64
	for {
		raw, err := br.ReadSlice('\n')
		var item []byte
		switch {
		case errors.Is(err, bufio.ErrBufferFull):
			n++
			// A raw line longer than the buffer: trim it chunk by chunk.
			t := &trimmer{}
			t.feed(raw)
			for errors.Is(err, bufio.ErrBufferFull) {
				raw, err = br.ReadSlice('\n')
				t.feed(raw)
			}
			if t.tooLong {
				return &errItemTooLong{line: n}
			}
			item = t.content
		case len(raw) > 0:
			n++
			item = trimBytes(raw)
			if len(item) > MaxItemBytes {
				return &errItemTooLong{line: n}
			}
		}
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		if len(item) > 0 && !fn(n, item) {
			return nil
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
	}
}

// trimmer trims a line that arrives in chunks while keeping at most about 2 × MaxItemBytes in memory:
// content holds the text up to the last non-space byte, ws the whitespace after it.
type trimmer struct {
	started    bool
	content    []byte
	ws         []byte
	wsOverflow bool
	tooLong    bool
}

func (t *trimmer) feed(chunk []byte) {
	for _, b := range chunk {
		if t.tooLong {
			return
		}
		t.byte(b)
	}
}

func (t *trimmer) byte(b byte) {
	if isSpace(b) {
		if !t.started || t.wsOverflow {
			return
		}
		t.ws = append(t.ws, b)
		if len(t.ws) > MaxItemBytes {
			// Any later non-space byte makes the item too long; until then this may be trailing space.
			t.wsOverflow, t.ws = true, nil
		}
		return
	}
	t.started = true
	if t.wsOverflow || len(t.content)+len(t.ws)+1 > MaxItemBytes {
		t.tooLong = true
		return
	}
	t.content = append(append(t.content, t.ws...), b)
	t.ws = t.ws[:0]
}
