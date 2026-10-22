package protocol

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"
)

// ErrLineTooLong is returned for a line over the maximum line length; the decoder has discarded it up to
// the next newline.
var ErrLineTooLong = errors.New("protocol line exceeds the maximum line length")

// ErrUnterminatedLine is returned when the stream ends inside a line.
var ErrUnterminatedLine = errors.New("protocol stream ended inside a line")

// UnknownTypeError is returned for a well-formed line whose type is not a protocol v1 message type.
type UnknownTypeError struct{ Type string }

func (e *UnknownTypeError) Error() string { return fmt.Sprintf("unknown message type %q", e.Type) }

// SyntaxError is returned for a line that is not a JSON object with a string `type`.
type SyntaxError struct{ Err error }

func (e *SyntaxError) Error() string { return "invalid protocol line: " + e.Err.Error() }
func (e *SyntaxError) Unwrap() error { return e.Err }

var idPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,64}$`)

// ValidID reports whether id is a valid request id: 1–64 characters of [A-Za-z0-9._:-].
func ValidID(id string) bool { return idPattern.MatchString(id) }

// Marshal encodes msg as one JSON object with `type` as its first member, without a trailing newline
// and without HTML escaping.
func Marshal(msg Message) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(msg); err != nil {
		return nil, fmt.Errorf("encode %s: %w", msg.MessageType(), err)
	}
	body := bytes.TrimRight(buf.Bytes(), "\n")
	if len(body) < 2 || body[0] != '{' {
		return nil, fmt.Errorf("encode %s: not a JSON object", msg.MessageType())
	}
	out := make([]byte, 0, len(body)+len(msg.MessageType())+12)
	out = append(out, `{"type":`...)
	out = strconv.AppendQuote(out, msg.MessageType())
	if string(body) != "{}" {
		out = append(out, ',')
	}
	return append(out, body[1:]...), nil
}

// Unmarshal decodes one line (with or without its trailing newline) into the message type named by its
// `type` member. Unknown members are ignored.
func Unmarshal(line []byte) (Message, error) {
	line = bytes.TrimSuffix(line, []byte("\n"))
	var envelope struct {
		Type *string `json:"type"`
	}
	if err := json.Unmarshal(line, &envelope); err != nil {
		return nil, &SyntaxError{Err: err}
	}
	if envelope.Type == nil {
		return nil, &SyntaxError{Err: errors.New("missing type")}
	}
	msg := newMessage(*envelope.Type)
	if msg == nil {
		return nil, &UnknownTypeError{Type: *envelope.Type}
	}
	if err := json.Unmarshal(line, msg); err != nil {
		return nil, &SyntaxError{Err: fmt.Errorf("%s: %w", *envelope.Type, err)}
	}
	return deref(msg), nil
}

// deref returns the message value behind the pointer created by newMessage, so callers can switch on
// value types.
func deref(m Message) Message {
	switch v := m.(type) {
	case *Hello:
		return *v
	case *Welcome:
		return *v
	case *Ready:
		return *v
	case *Describe:
		return *v
	case *Description:
		return *v
	case *Schedule:
		return *v
	case *Analysis:
		return *v
	case *Done:
		return *v
	case *Run:
		return *v
	case *Result:
		return *v
	case *Error:
		return *v
	case *Cancel:
		return *v
	case *Shutdown:
		return *v
	case *File:
		return *v
	case *FileRef:
		return *v
	case *Log:
		return *v
	case *Progress:
		return *v
	case *Template:
		return *v
	case *TemplateItem:
		return *v
	case *TemplateCredit:
		return *v
	case *TemplateCancel:
		return *v
	case *TemplateDone:
		return *v
	}
	return m
}

// Encoder writes messages as NDJSON lines. Each line is written with a single Write call under a mutex,
// so concurrent senders never interleave partial lines.
type Encoder struct {
	mu           sync.Mutex
	w            io.Writer
	maxLineBytes int
}

// NewEncoder returns an encoder writing to w (fd 3 in the runtime, fd 4 in a connector) with the v1
// line limit.
func NewEncoder(w io.Writer) *Encoder { return &Encoder{w: w, maxLineBytes: MaxLineBytes} }

// Encode writes msg followed by a newline. A message whose line would exceed the line limit is not
// written.
func (e *Encoder) Encode(msg Message) error {
	b, err := Marshal(msg)
	if err != nil {
		return err
	}
	if len(b)+1 > e.maxLineBytes {
		return fmt.Errorf("encode %s: %w (%d bytes)", msg.MessageType(), ErrLineTooLong, len(b)+1)
	}
	b = append(b, '\n')
	e.mu.Lock()
	defer e.mu.Unlock()
	_, err = e.w.Write(b)
	if err != nil {
		return fmt.Errorf("write %s: %w", msg.MessageType(), err)
	}
	return nil
}

// Decoder reads NDJSON lines and decodes them into messages.
type Decoder struct {
	r            *bufio.Reader
	maxLineBytes int
}

// NewDecoder returns a decoder reading from r with the v1 line limit.
func NewDecoder(r io.Reader) *Decoder {
	return &Decoder{r: bufio.NewReaderSize(r, 64<<10), maxLineBytes: MaxLineBytes}
}

// ReadLine returns the next line including its newline. Lines over the limit are discarded up to the
// next newline and reported as ErrLineTooLong; the decoder stays usable. At the end of the stream it
// returns io.EOF, or ErrUnterminatedLine when the last line has no newline.
func (d *Decoder) ReadLine() ([]byte, error) {
	var line []byte
	for {
		chunk, err := d.r.ReadSlice('\n')
		if len(line)+len(chunk) > d.maxLineBytes {
			if err == nil {
				return nil, ErrLineTooLong
			}
			if errors.Is(err, bufio.ErrBufferFull) {
				if derr := d.discardLine(); derr != nil && !errors.Is(derr, io.EOF) {
					return nil, derr
				}
				return nil, ErrLineTooLong
			}
		}
		line = append(line, chunk...)
		switch {
		case err == nil:
			return line, nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF):
			if len(line) > 0 {
				return nil, ErrUnterminatedLine
			}
			return nil, io.EOF
		default:
			return nil, err
		}
	}
}

func (d *Decoder) discardLine() error {
	for {
		_, err := d.r.ReadSlice('\n')
		if err == nil {
			return nil
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return err
		}
	}
}

// Decode reads and decodes the next message. It returns the raw line together with the message (or
// the error), so callers can validate or log it.
func (d *Decoder) Decode() (Message, []byte, error) {
	line, err := d.ReadLine()
	if err != nil {
		return nil, nil, err
	}
	msg, err := Unmarshal(line)
	return msg, line, err
}

// CheckFraming checks the strict line framing of docs/protocol.md §2: valid UTF-8, exactly one
// trailing newline, no carriage return or other raw newline, at most maxLineBytes including the
// newline.
func CheckFraming(line []byte, maxLineBytes int) error {
	switch {
	case len(line) > maxLineBytes:
		return ErrLineTooLong
	case len(line) == 0 || line[len(line)-1] != '\n':
		return errors.New("line does not end with a newline")
	case bytes.IndexByte(line[:len(line)-1], '\n') >= 0:
		return errors.New("line contains more than one newline")
	case bytes.IndexByte(line, '\r') >= 0:
		return errors.New("line contains a carriage return")
	case !utf8.Valid(line):
		return errors.New("line is not valid UTF-8")
	case strings.TrimSpace(string(line)) == "":
		return errors.New("blank line")
	}
	return nil
}

// Negotiate picks the protocol version for a connector range: v = min(Version, max); there is no
// common version when v < max(MinVersion, min) (docs/protocol.md §4).
func Negotiate(connector ProtocolRange) (int, bool) {
	v := min(Version, connector.Max)
	if v < max(MinVersion, connector.Min) {
		return 0, false
	}
	return v, true
}

// SupportedVersions returns the value of SCANTOR_PROTOCOL_VERSIONS: the supported versions, comma
// separated ("1" or "3,4").
func SupportedVersions() string {
	parts := make([]string, 0, 2)
	for v := MinVersion; v <= Version; v++ {
		parts = append(parts, strconv.Itoa(v))
	}
	return strings.Join(parts, ",")
}
