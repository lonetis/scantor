package crux

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"slices"
	"strconv"
	"unicode/utf8"

	"github.com/lonetis/scantor/internal/templates/core"
	"github.com/lonetis/scantor/internal/templates/fetch"
)

// rowReader reads decoded CrUX CSVs (`origin,rank`, LF or CRLF) of one list in order: one file for
// crux-top-lists, the chunks of a month for crux-cache, where only the first chunk has the header.
// Ranks must be valid buckets in non-decreasing order across all parts. Reading ends at the first rank
// above bucket.
type rowReader struct {
	bucket int64
	// count is the number of rows within the bucket read so far.
	count int64
	// done is set at the first rank above the bucket, or when fn stopped the reading.
	done bool
	prev int64
}

// read reads one part. name labels the part in error messages ("" for a single file); header says
// whether the part starts with the header line. fn (may be nil) is called for every row within the
// bucket and returns false to stop.
func (s *rowReader) read(r io.Reader, name string, header bool, fn func(origin string, rank int64) bool) error {
	needHeader := header
	for line, err := range core.Lines(r, core.MaxLineBytes) {
		if err != nil {
			if errors.Is(err, core.ErrLineTooLong) {
				return formatError(name, line.Number)
			}
			return core.Platformf(true, err, "read CrUX CSV: %v", err)
		}
		if needHeader {
			if string(line.Text) != "origin,rank" {
				return core.Platformf(true, nil, "unexpected CrUX CSV header %q%s", truncate(string(line.Text), 64), of(name))
			}
			needHeader = false
			continue
		}
		if len(line.Text) == 0 {
			continue
		}
		i := bytes.LastIndexByte(line.Text, ',')
		if i <= 0 {
			return formatError(name, line.Number)
		}
		origin := line.Text[:i]
		rank, perr := strconv.ParseInt(string(line.Text[i+1:]), 10, 64)
		if perr != nil || !slices.Contains(Buckets, rank) || rank < s.prev || !utf8.Valid(origin) || utf8.RuneCount(origin) > 2048 {
			return formatError(name, line.Number)
		}
		s.prev = rank
		if rank > s.bucket {
			s.done = true
			return nil
		}
		s.count++
		if fn != nil && !fn(string(origin), rank) {
			s.done = true
			return nil
		}
	}
	if needHeader {
		return core.Platformf(true, nil, "unexpected CrUX CSV%s: the file is empty", of(name))
	}
	return nil
}

// readFile reads one downloaded part.
func (s *rowReader) readFile(file *fetch.File, name string, header bool, fn func(origin string, rank int64) bool) error {
	f, err := file.Open()
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	return s.read(f, name, header, fn)
}

func formatError(name string, line int64) error {
	return core.Platformf(true, nil, "unexpected CrUX CSV at line %d%s", line, of(name))
}

// of is " of <name>" for a named part.
func of(name string) string {
	if name == "" {
		return ""
	}
	return fmt.Sprintf(" of %s", name)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
