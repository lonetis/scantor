package node

import (
	"bytes"
	"context"
	"fmt"
	"strconv"
	"unicode/utf8"

	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/client"
)

// Log tails of worker containers: the 4 KiB tail of an exit (docs/nodes.md §6.5) and the on-demand tails
// of logRequests (§7.3). Worker logs never leave the node otherwise.

const (
	// exitTailLines and exitTailBytes bound lastExit.logTail.
	exitTailLines = 200
	exitTailBytes = 4096
	// minRequestLines is the minimum line count of an on-demand tail; tailBytes/64 lines are asked for
	// otherwise.
	minRequestLines = 200
	// maxRequestBytes bounds an on-demand tail regardless of the requested tailBytes: getWorkerLogs
	// accepts at most 262144 (docs/api.md §4.13), and the JSON-escaped text must stay below the 2 MiB
	// body limit of the node API.
	maxRequestBytes = 256 << 10
	// maxMessageBytes bounds error messages reported in a status.
	maxMessageBytes = 1024
)

// logTail is a log excerpt.
type logTail struct {
	text string
	// truncated is true when older output was cut off (by the byte or the line limit).
	truncated bool
}

// containerLogTail fetches the last lines of a container's stdout and stderr (interleaved in the order
// Docker returns them) and keeps the last maxBytes bytes, cut at a UTF-8 boundary.
func containerLogTail(ctx context.Context, docker client.APIClient, containerID string, lines, maxBytes int) (logTail, error) {
	rc, err := docker.ContainerLogs(ctx, containerID, client.ContainerLogsOptions{
		ShowStdout: true, ShowStderr: true, Tail: strconv.Itoa(lines),
	})
	if err != nil {
		return logTail{}, fmt.Errorf("container logs: %w", err)
	}
	defer rc.Close()
	buf := &tailWriter{max: maxBytes}
	if _, err := stdcopy.StdCopy(buf, buf, rc); err != nil {
		return logTail{}, fmt.Errorf("read container logs: %w", err)
	}
	text, cut := tailUTF8(buf.bytes(), maxBytes)
	return logTail{
		text:      string(text),
		truncated: cut || buf.dropped || bytes.Count(buf.bytes(), []byte{'\n'}) >= lines,
	}, nil
}

// tailWriter keeps the last max bytes written to it (plus slack, so it trims rarely).
type tailWriter struct {
	max     int
	buf     []byte
	dropped bool
}

func (w *tailWriter) Write(p []byte) (int, error) {
	w.buf = append(w.buf, p...)
	if limit := 2*w.max + 4096; len(w.buf) > limit {
		keep := w.max + 4 // a few extra bytes so the UTF-8 cut can find a boundary
		w.buf = append(w.buf[:0], w.buf[len(w.buf)-keep:]...)
		w.dropped = true
	}
	return len(p), nil
}

func (w *tailWriter) bytes() []byte { return w.buf }

// tailUTF8 returns the last n bytes of b, moved forward to the next UTF-8 boundary, and whether
// anything was cut.
func tailUTF8(b []byte, n int) ([]byte, bool) {
	if n < 0 {
		n = 0
	}
	if len(b) <= n {
		return b, false
	}
	start := len(b) - n
	for start < len(b) && !utf8.RuneStart(b[start]) {
		start++
	}
	return b[start:], true
}

// truncateUTF8 returns s cut to at most n bytes at a UTF-8 boundary (keeping the beginning).
func truncateUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	end := n
	for end > 0 && !utf8.RuneStart(s[end]) {
		end--
	}
	return s[:end]
}

// requestLines returns the line count of an on-demand tail: max(200, tailBytes/64).
func requestLines(tailBytes int) int {
	return max(minRequestLines, tailBytes/64)
}
