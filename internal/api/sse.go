package api

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
)

// maxEventBytes bounds one server-sent event.
const maxEventBytes = 16 << 20

// ServerEvent is one server-sent event (text/event-stream).
type ServerEvent struct {
	// Name is the `event:` field ("message" when absent).
	Name string
	// Data is the concatenation of the `data:` lines, joined with "\n".
	Data []byte
	// ID is the `id:` field.
	ID string
}

// EventStream reads server-sent events from a response body.
type EventStream struct {
	body io.ReadCloser
	r    *bufio.Reader
}

// NewEventStream wraps body; Close closes it.
func NewEventStream(body io.ReadCloser) *EventStream {
	return &EventStream{body: body, r: bufio.NewReaderSize(body, 64<<10)}
}

// Close closes the underlying body.
func (s *EventStream) Close() error { return s.body.Close() }

// Next returns the next event. It returns io.EOF when the stream ends cleanly between events.
func (s *EventStream) Next() (ServerEvent, error) {
	var ev ServerEvent
	var data bytes.Buffer
	hasData := false
	size := 0
	for {
		line, err := s.r.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			return ServerEvent{}, fmt.Errorf("server-sent event line exceeds %d bytes", s.r.Size())
		}
		if err != nil && (len(line) == 0 || !errors.Is(err, io.EOF)) {
			if errors.Is(err, io.EOF) && (hasData || ev.Name != "") {
				return ServerEvent{}, io.ErrUnexpectedEOF
			}
			return ServerEvent{}, err
		}
		size += len(line)
		if size > maxEventBytes {
			return ServerEvent{}, fmt.Errorf("server-sent event exceeds %d bytes", maxEventBytes)
		}
		line = bytes.TrimRight(line, "\r\n")
		if len(line) == 0 {
			if hasData || ev.Name != "" {
				if ev.Name == "" {
					ev.Name = "message"
				}
				ev.Data = bytes.Clone(data.Bytes())
				return ev, nil
			}
			if err != nil {
				return ServerEvent{}, io.EOF
			}
			continue
		}
		if line[0] == ':' {
			continue
		}
		field, value, _ := bytes.Cut(line, []byte(":"))
		value = bytes.TrimPrefix(value, []byte(" "))
		switch string(field) {
		case "event":
			ev.Name = string(value)
		case "data":
			if hasData {
				data.WriteByte('\n')
			}
			data.Write(value)
			hasData = true
		case "id":
			ev.ID = string(value)
		}
	}
}
