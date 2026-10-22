package core

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"iter"
)

// MaxLineBytes bounds a line of a data-source CSV (Tranco, CrUX).
const MaxLineBytes = 64 << 10

// ErrLineTooLong is returned by Lines for a line longer than its maximum.
var ErrLineTooLong = errors.New("line too long")

// Line is one line of Lines: its 1-based number and its text without the line terminator. Text is
// only valid until the next iteration.
type Line struct {
	Number int64
	Text   []byte
}

// Lines iterates the lines of r, split on "\n" with one trailing "\r" removed (LF and CRLF files). A
// final line without a terminator is included. A line longer than maxBytes ends the iteration with
// an error wrapping ErrLineTooLong; read errors end it with the error.
func Lines(r io.Reader, maxBytes int) iter.Seq2[Line, error] {
	return func(yield func(Line, error) bool) {
		br := bufio.NewReaderSize(r, maxBytes+2)
		var n int64
		for {
			raw, err := br.ReadSlice('\n')
			if errors.Is(err, bufio.ErrBufferFull) {
				yield(Line{Number: n + 1}, fmt.Errorf("line %d: %w", n+1, ErrLineTooLong))
				return
			}
			if len(raw) > 0 {
				n++
				text := bytes.TrimSuffix(bytes.TrimSuffix(raw, []byte("\n")), []byte("\r"))
				if len(text) > maxBytes {
					yield(Line{Number: n}, fmt.Errorf("line %d: %w", n, ErrLineTooLong))
					return
				}
				if !yield(Line{Number: n, Text: text}, nil) {
					return
				}
			}
			if errors.Is(err, io.EOF) {
				return
			}
			if err != nil {
				yield(Line{Number: n + 1}, err)
				return
			}
		}
	}
}
