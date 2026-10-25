package scantor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"iter"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// errCallEnded is returned to user code that keeps working after its call was answered (for example
// a goroutine that outlives a cancelled run).
var errCallEnded = &Error{Type: "validation", Message: "the call has already ended"}

// call is one runtime request (describe, schedule or run) and the Context handed to user code.
type call struct {
	conn *conn
	id   string
	kind string
	msg  *inbound
	wire wireContext

	context.Context
	cancelCause context.CancelCauseFunc
	stopTimer   context.CancelFunc

	mu        sync.Mutex // orders messages of this call against its final reply
	ended     bool
	fileCount int
	fileSeq   int
}

func newCall(c *conn, msg *inbound) *call {
	cl := &call{conn: c, id: msg.ID, kind: msg.Type, msg: msg}
	if msg.Ctx != nil {
		cl.wire = *msg.Ctx
	}
	ctx, cancel := context.WithCancelCause(context.Background())
	cl.cancelCause = cancel
	cl.stopTimer = func() {}
	if cl.wire.DeadlineMs != nil {
		ctx, cl.stopTimer = context.WithDeadlineCause(ctx, time.UnixMilli(*cl.wire.DeadlineMs), errDeadline)
	}
	cl.Context = ctx
	return cl
}

func (cl *call) cancel(cause error) { cl.cancelCause(cause) }

// emit sends a message that belongs to this call; after the final reply it is dropped.
func (cl *call) emit(v any) error {
	cl.mu.Lock()
	defer cl.mu.Unlock()
	if cl.ended {
		return errCallEnded
	}
	return cl.conn.send(v)
}

// finish sends the final reply of the call. The process is marked free before the reply is written,
// because the runtime may send the next request as soon as it reads the reply.
func (cl *call) finish(v any) {
	c := cl.conn
	c.mu.Lock()
	if c.current == cl {
		c.current = nil
	}
	c.mu.Unlock()
	cl.mu.Lock()
	if !cl.ended {
		cl.ended = true
		if err := c.send(v); errors.Is(err, errLineTooLong) {
			c.post(errorMsg{Type: "error", ID: cl.id, Error: wireError{
				Type:    "validation",
				Message: "the reply exceeds the protocol line limit; store large data with ctx.Files()",
			}})
		}
	}
	cl.mu.Unlock()
	cl.stopTimer()
	cl.cancelCause(errCallEnded)
}

func (cl *call) fail(err error) {
	cl.finish(errorMsg{Type: "error", ID: cl.id, Error: toWireError(err)})
}

// Context implementation.

func (cl *call) ScanID() string { return cl.wire.ScanID }

func (cl *call) AnalysisID() string {
	if cl.wire.AnalysisID == nil {
		return ""
	}
	return *cl.wire.AnalysisID
}

func (cl *call) Seq() int64 {
	if cl.wire.Seq == nil {
		return -1
	}
	return *cl.wire.Seq
}

func (cl *call) Attempt() int   { return cl.wire.Attempt }
func (cl *call) TmpDir() string { return cl.wire.TmpDir }
func (cl *call) Files() Files   { return (*callFiles)(cl) }

func (cl *call) Log(level Level, msg string, kv ...any) {
	switch level {
	case LevelDebug, LevelInfo, LevelWarning, LevelError:
	default:
		level = LevelInfo
	}
	parent := cl.id
	m := logMsg{Type: "log", Parent: &parent, Level: level, Message: truncateRunes(msg, maxLogMessage), Fields: logFields(kv)}
	if err := cl.emit(m); errors.Is(err, errCallEnded) {
		// Output of a goroutine that outlived its call still reaches the worker log.
		m.Parent = nil
		cl.conn.post(m)
	}
}

func (cl *call) Progress(fraction float64, message string) {
	if cl.kind != "run" {
		return
	}
	m := progressMsg{Type: "progress", Parent: cl.id}
	if fraction >= 0 && !math.IsNaN(fraction) {
		f := math.Min(fraction, 1)
		m.Fraction = &f
	}
	if message != "" {
		msg := truncateRunes(message, maxProgressMessage)
		m.Message = &msg
	}
	// Progress is best effort: after the call ended it is dropped, and write failures end serve.
	_ = cl.emit(m)
}

// logFields turns alternating keys and values into the JSON object of a log message.
func logFields(kv []any) *object {
	if len(kv) == 0 {
		return nil
	}
	fields := newObject()
	for i := 0; i < len(kv); i += 2 {
		if i+1 == len(kv) {
			fields.set("!BADKEY", jsonSafe(kv[i]))
			break
		}
		key, ok := kv[i].(string)
		if !ok {
			key = fmt.Sprint(kv[i])
		}
		fields.set(key, jsonSafe(kv[i+1]))
	}
	if raw, err := json.Marshal(fields); err != nil || len(raw) > maxLogFields {
		truncated := newObject()
		truncated.set("fieldsTruncated", true)
		return truncated
	}
	return fields
}

// jsonSafe returns v when it encodes as JSON, else its text form.
func jsonSafe(v any) any {
	if err, ok := v.(error); ok {
		return err.Error()
	}
	if _, err := json.Marshal(v); err != nil {
		return fmt.Sprint(v)
	}
	return v
}

// callFiles implements Files on a call.
type callFiles call

var diskNameChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func (f *callFiles) Put(name string, data []byte, contentType string) (FileRef, error) {
	cl := (*call)(f)
	path, err := cl.newFilePath(name, contentType, int64(len(data)))
	if err != nil {
		return FileRef{}, err
	}
	if err := writeNewFile(path, func(w io.Writer) error { _, err := w.Write(data); return err }); err != nil {
		return FileRef{}, fmt.Errorf("write file %s: %w", name, err)
	}
	return cl.registerFile(name, path, contentType)
}

func (f *callFiles) PutFile(name, path, contentType string) (FileRef, error) {
	cl := (*call)(f)
	src, err := os.Open(path) //nolint:gosec // the task's own file, which it asks to store
	if err != nil {
		return FileRef{}, fmt.Errorf("file %s: %w", name, err)
	}
	defer src.Close()
	info, err := src.Stat()
	if err != nil {
		return FileRef{}, fmt.Errorf("file %s: %w", name, err)
	}
	if !info.Mode().IsRegular() {
		return FileRef{}, &Error{Type: "validation", Message: fmt.Sprintf("file %s: %s is not a regular file", name, path)}
	}
	dest, err := cl.newFilePath(name, contentType, info.Size())
	if err != nil {
		return FileRef{}, err
	}
	if err := writeNewFile(dest, func(w io.Writer) error { _, err := io.Copy(w, src); return err }); err != nil {
		return FileRef{}, fmt.Errorf("copy file %s: %w", name, err)
	}
	return cl.registerFile(name, dest, contentType)
}

// newFilePath checks the name, the content type and the limits early (the runtime enforces them again)
// and returns a fresh path inside ctx.filesDir.
func (cl *call) newFilePath(name, contentType string, size int64) (string, error) {
	if cl.kind != "run" || cl.wire.FilesDir == nil || *cl.wire.FilesDir == "" {
		return "", &Error{Type: "validation", Message: "files are only available in run"}
	}
	if err := checkFileName(name); err != nil {
		return "", err
	}
	if utf8.RuneCountInString(contentType) > 255 {
		return "", &Error{Type: "validation", Message: fmt.Sprintf("file %s: the content type is longer than 255 characters", name)}
	}
	limits := cl.conn.limits
	if limits.MaxFileBytes > 0 && size > limits.MaxFileBytes {
		return "", &Error{Type: "validation", Message: fmt.Sprintf("file %s is %d bytes; the limit is %d", name, size, limits.MaxFileBytes)}
	}
	cl.mu.Lock()
	defer cl.mu.Unlock()
	if limits.MaxFilesPerAnalysis > 0 && int64(cl.fileCount) >= limits.MaxFilesPerAnalysis {
		return "", &Error{Type: "validation", Message: fmt.Sprintf("file %s: at most %d files per analysis", name, limits.MaxFilesPerAnalysis)}
	}
	cl.fileCount++
	cl.fileSeq++
	disk := diskNameChars.ReplaceAllString(name, "_")
	if len(disk) > 100 {
		disk = disk[:100]
	}
	return filepath.Join(*cl.wire.FilesDir, strconv.Itoa(cl.fileSeq)+"-"+disk), nil
}

func checkFileName(name string) error {
	n := utf8.RuneCountInString(name)
	switch {
	case n < 1 || n > 255:
		return &Error{Type: "validation", Message: fmt.Sprintf("file name %q must be 1–255 characters", name)}
	case strings.ContainsAny(name, "/\\\x00"):
		return &Error{Type: "validation", Message: fmt.Sprintf("file name %q must not contain /, \\ or NUL", name)}
	case !utf8.ValidString(name):
		return &Error{Type: "validation", Message: fmt.Sprintf("file name %q is not valid UTF-8", name)}
	}
	return nil
}

func writeNewFile(path string, write func(io.Writer) error) error {
	// The mode the Python and JS connectors get from their defaults (0666 and the usual umask).
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644) //nolint:gosec // see above
	if err != nil {
		return err
	}
	if err := write(f); err != nil {
		_ = f.Close() // the write error is the one to report
		return err
	}
	return f.Close()
}

// registerFile sends a file request and waits for the runtime's FileRef.
func (cl *call) registerFile(name, path, contentType string) (FileRef, error) {
	c := cl.conn
	id := c.newID()
	reply := make(chan fileReply, 1)
	c.mu.Lock()
	c.files[id] = reply
	c.mu.Unlock()
	var ct *string
	if contentType != "" {
		ct = &contentType
	}
	if err := cl.emit(fileMsg{Type: "file", ID: id, Parent: cl.id, Name: name, Path: path, ContentType: ct}); err != nil {
		c.mu.Lock()
		delete(c.files, id)
		c.mu.Unlock()
		return FileRef{}, err
	}
	select {
	case r := <-reply:
		if r.err != nil {
			return FileRef{}, runtimeError(r.err)
		}
		return r.ref, nil
	case <-cl.Done():
		return FileRef{}, context.Cause(cl)
	}
}

// runtimeError turns a runtime → connector error into the Error user code sees.
func runtimeError(w *wireError) *Error {
	e := &Error{Type: w.Type, Message: w.Message}
	if w.Retryable != nil {
		e.Retryable = *w.Retryable
	}
	return e
}

// StreamTemplate runs a wrapped template call: it sends a template request and streams the items
// under credit-based flow control (docs/protocol.md §5.8, §6.2). Template proxies reach it through an
// interface assertion on the Context; it is not part of the Context interface.
func (cl *call) StreamTemplate(name string, scanConfig any) iter.Seq2[json.RawMessage, error] {
	return func(yield func(json.RawMessage, error) bool) {
		if cl.kind != "schedule" {
			yield(nil, &Error{Type: "validation", Message: "templates can only be iterated in schedule"})
			return
		}
		raw, err := json.Marshal(scanConfig)
		if err != nil || len(raw) == 0 || raw[0] != '{' {
			yield(nil, &Error{Type: "validation", Message: fmt.Sprintf("the %s scan config must encode as a JSON object", name)})
			return
		}
		c := cl.conn
		s := c.openStream()
		defer c.closeStream(s.id)
		if err := cl.emit(templateMsg{Type: "template", ID: s.id, Parent: cl.id, Template: name, ScanConfig: raw, Credit: initialCredit}); err != nil {
			yield(nil, err)
			return
		}
		consumed := 0
		for {
			msg, ok := s.next(cl)
			if !ok {
				yield(nil, context.Cause(cl))
				return
			}
			switch msg.Type {
			case "templateItem":
				consumed++
				if consumed%creditBatch == 0 {
					if err := cl.emit(creditMsg{Type: "templateCredit", ID: s.id, Credit: creditBatch}); err != nil {
						yield(nil, err)
						return
					}
				}
				if !yield(msg.Config, nil) {
					if cl.emit(idMsg{Type: "templateCancel", ID: s.id}) == nil {
						s.awaitEnd(cl)
					}
					return
				}
			case "templateDone":
				return
			case "error":
				if msg.Error == nil {
					yield(nil, &Error{Type: "platform", Message: "template stream failed"})
				} else {
					yield(nil, runtimeError(msg.Error))
				}
				return
			}
		}
	}
}

// DecodeTemplateItem parses a template item with the native model of target's type.
func (cl *call) DecodeTemplateItem(raw json.RawMessage, target any) error {
	ptr := reflect.TypeOf(target)
	if ptr == nil || ptr.Kind() != reflect.Pointer {
		return &Error{Type: "validation", Message: "template items decode into a pointer"}
	}
	m, err := modelFor(ptr.Elem(), inputMode)
	if err != nil {
		return &Error{Type: "validation", Message: err.Error()}
	}
	return m.decodeInto(raw, target, "template item")
}

// templateStream buffers the items of one template stream. The reader never blocks on it: the
// credit allowance bounds what the runtime sends.
type templateStream struct {
	id     string
	mu     sync.Mutex
	queue  []*inbound
	signal chan struct{}
}

func (c *conn) openStream() *templateStream {
	s := &templateStream{id: c.newID(), signal: make(chan struct{}, 1)}
	c.mu.Lock()
	c.streams[s.id] = s
	c.mu.Unlock()
	return s
}

func (c *conn) closeStream(id string) {
	c.mu.Lock()
	delete(c.streams, id)
	c.mu.Unlock()
}

func (s *templateStream) push(msg *inbound) {
	s.mu.Lock()
	s.queue = append(s.queue, msg)
	s.mu.Unlock()
	select {
	case s.signal <- struct{}{}:
	default:
	}
}

// next returns the next message of the stream, or false when ctx ends first.
func (s *templateStream) next(ctx context.Context) (*inbound, bool) {
	for {
		s.mu.Lock()
		if len(s.queue) > 0 {
			msg := s.queue[0]
			s.queue = s.queue[1:]
			s.mu.Unlock()
			return msg, true
		}
		s.mu.Unlock()
		select {
		case <-s.signal:
		case <-ctx.Done():
			return nil, false
		}
	}
}

// awaitEnd discards items after a templateCancel until templateDone (or an error) arrives.
func (s *templateStream) awaitEnd(ctx context.Context) {
	for {
		msg, ok := s.next(ctx)
		if !ok || msg.Type == "templateDone" || msg.Type == "error" {
			return
		}
	}
}

func truncateRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return string(r[:max-1]) + "…"
}

// truncateTail keeps the end of s (stacks are most useful at their end).
func truncateTail(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return "…" + string(r[len(r)-max+1:])
}
