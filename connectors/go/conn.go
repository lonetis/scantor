package scantor

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strconv"
	"sync"
)

// conn is one connector process's side of the connector protocol: fd 3 carries runtime requests and
// replies to connector requests, fd 4 everything the connector sends (docs/protocol.md §2).
type conn struct {
	task   *task
	models *taskModels
	in     *bufio.Reader
	out    io.Writer
	stderr io.Writer

	wmu          sync.Mutex // one writer at a time, whole lines only
	maxLineBytes int
	limits       welcomeLimits

	mu        sync.Mutex
	nextID    int
	current   *call
	files     map[string]chan fileReply
	streams   map[string]*templateStream
	requests  chan *call
	stopOnce  sync.Once
	stopped   chan struct{}
	failOnce  sync.Once
	writeFail chan struct{}
}

type fileReply struct {
	ref FileRef
	err *wireError
}

// serve speaks the protocol on in/out until shutdown and returns the process exit code: 0 after
// shutdown or end of input, 1 after a reported handshake failure or a broken output pipe.
func serve(t *task, in io.Reader, out io.Writer, stderr io.Writer) int {
	c := &conn{
		task:         t,
		in:           bufio.NewReaderSize(in, 64<<10),
		out:          out,
		stderr:       stderr,
		maxLineBytes: defaultMaxLineBytes,
		files:        map[string]chan fileReply{},
		streams:      map[string]*templateStream{},
		requests:     make(chan *call, 1),
		stopped:      make(chan struct{}),
		writeFail:    make(chan struct{}),
	}
	if code, ok := c.handshake(); !ok {
		return code
	}
	go c.readLoop()
	for {
		select {
		case cl := <-c.requests:
			c.handle(cl)
		case <-c.stopped:
			return 0
		case <-c.writeFail:
			return 1
		}
	}
}

// handshake performs hello → welcome → ready (docs/protocol.md §4). The definition is validated
// between welcome and ready, so incompatible protocols are reported before definition errors.
func (c *conn) handshake() (int, bool) {
	hello := helloMsg{
		Type:      "hello",
		ID:        "hello",
		Protocol:  protocolRange{Min: protocolVersion, Max: protocolVersion},
		Connector: connectorInfo{Language: "go", Version: Version, Runtime: runtime.Version()},
		PID:       os.Getpid(),
	}
	if err := c.send(hello); err != nil {
		fmt.Fprintf(c.stderr, "scantor: cannot write hello: %v\n", err)
		return 1, false
	}
	line, err := c.readLine()
	if errors.Is(err, io.EOF) {
		return 0, false
	}
	if err != nil {
		fmt.Fprintf(c.stderr, "scantor: reading welcome: %v\n", err)
		return 1, false
	}
	var msg inbound
	if err := json.Unmarshal(line, &msg); err != nil {
		fmt.Fprintf(c.stderr, "scantor: invalid welcome: %v\n", err)
		return 1, false
	}
	switch {
	case msg.Type == "error" && msg.Error != nil:
		fmt.Fprintf(c.stderr, "scantor: the runtime rejected the connector: %s\n", msg.Error.Message)
		return 1, false
	case msg.Type != "welcome":
		fmt.Fprintf(c.stderr, "scantor: expected welcome, got %q\n", msg.Type)
		return 1, false
	}
	if msg.Limits != nil {
		c.limits = *msg.Limits
		if msg.Limits.MaxLineBytes > 0 {
			c.maxLineBytes = int(msg.Limits.MaxLineBytes)
		}
	}
	models, err := c.task.prepare()
	if err != nil {
		c.post(errorMsg{Type: "error", ID: "hello", Error: wireError{
			Type:    "validation",
			Message: truncateRunes("invalid task definition: "+err.Error(), maxErrorMessage),
		}})
		fmt.Fprintf(c.stderr, "scantor: invalid task definition: %v\n", err)
		return 1, false
	}
	c.models = models
	if err := c.send(idMsg{Type: "ready", ID: "hello"}); err != nil {
		fmt.Fprintf(c.stderr, "scantor: cannot write ready: %v\n", err)
		return 1, false
	}
	return 0, true
}

// readLoop reads fd 3 independently of writes to fd 4, so cancel and template messages arrive while
// a write blocks on a full pipe (docs/protocol.md §6.1).
func (c *conn) readLoop() {
	for {
		line, err := c.readLine()
		if err != nil {
			if !errors.Is(err, io.EOF) {
				fmt.Fprintf(c.stderr, "scantor: reading requests: %v\n", err)
			}
			c.stop("end of input")
			return
		}
		var msg inbound
		if err := json.Unmarshal(line, &msg); err != nil {
			fmt.Fprintf(c.stderr, "scantor: ignoring an invalid protocol line: %v\n", err)
			continue
		}
		c.dispatch(&msg)
	}
}

func (c *conn) dispatch(msg *inbound) {
	switch msg.Type {
	case "describe", "schedule", "run":
		c.accept(msg)
	case "cancel":
		c.mu.Lock()
		cur := c.current
		c.mu.Unlock()
		if cur != nil && cur.id == msg.ID {
			cur.cancel(fmt.Errorf("cancelled: %s", msg.Reason))
		}
	case "shutdown":
		c.stop("shutdown")
	case "fileRef", "templateItem", "templateDone", "error":
		c.route(msg)
	case "welcome":
		// A repeated welcome changes nothing.
	default:
		if msg.ID != "" {
			c.post(errorMsg{Type: "error", ID: msg.ID, Error: wireError{
				Type: "validation", Message: truncateRunes("unsupported request "+msg.Type, maxErrorMessage),
			}})
		}
	}
}

// accept registers a runtime request as the in-flight call. Protocol v1 allows one at a time.
func (c *conn) accept(msg *inbound) {
	c.mu.Lock()
	if c.current != nil {
		busy := c.current.id
		c.mu.Unlock()
		c.post(errorMsg{Type: "error", ID: msg.ID, Error: wireError{
			Type: "validation", Message: fmt.Sprintf("request %s rejected: request %s is in flight", msg.ID, busy),
		}})
		return
	}
	cl := newCall(c, msg)
	c.current = cl
	c.mu.Unlock()
	c.requests <- cl
}

// route delivers replies to connector-initiated requests (file, template).
func (c *conn) route(msg *inbound) {
	c.mu.Lock()
	fileCh, isFile := c.files[msg.ID]
	if isFile {
		delete(c.files, msg.ID)
	}
	stream := c.streams[msg.ID]
	c.mu.Unlock()
	switch {
	case isFile:
		reply := fileReply{err: msg.Error}
		if msg.Type == "fileRef" && msg.FileRef != nil {
			reply.ref = *msg.FileRef
		} else if reply.err == nil {
			reply.err = &wireError{Type: "platform", Message: "unexpected " + msg.Type + " reply to a file request"}
		}
		fileCh <- reply
	case stream != nil:
		stream.push(msg)
	default:
		fmt.Fprintf(c.stderr, "scantor: ignoring %s for unknown id %q\n", msg.Type, msg.ID)
	}
}

// stop ends the process after the current request (shutdown or end of fd 3).
func (c *conn) stop(reason string) {
	c.stopOnce.Do(func() {
		c.mu.Lock()
		cur := c.current
		c.mu.Unlock()
		if cur != nil {
			cur.cancel(fmt.Errorf("cancelled: %s", reason))
		}
		close(c.stopped)
	})
}

// newID returns a fresh connector request id.
func (c *conn) newID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.nextID++
	return "c" + strconv.Itoa(c.nextID)
}

var errLineTooLong = errors.New("message exceeds the protocol line limit")

// send writes one message as one line. A failed write means the runtime is gone: serve exits.
func (c *conn) send(v any) error {
	line, err := marshalJSON(v)
	if err != nil {
		return err
	}
	if len(line)+1 > c.maxLineBytes {
		return fmt.Errorf("%w (%d bytes, limit %d)", errLineTooLong, len(line)+1, c.maxLineBytes)
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if _, err := c.out.Write(append(line, '\n')); err != nil {
		c.failOnce.Do(func() {
			fmt.Fprintf(c.stderr, "scantor: writing to the runtime: %v\n", err)
			close(c.writeFail)
		})
		return err
	}
	return nil
}

// post sends a message whose failure needs no handling at the call site: a broken pipe already ends
// serve, and an overlong line is reported on stderr.
func (c *conn) post(v any) {
	if err := c.send(v); errors.Is(err, errLineTooLong) {
		fmt.Fprintf(c.stderr, "scantor: dropped a message: %v\n", err)
	}
}

// readLine reads one line of fd 3 without its newline; overlong lines are discarded.
func (c *conn) readLine() ([]byte, error) {
	var line []byte
	overlong := false
	for {
		chunk, err := c.in.ReadSlice('\n')
		if !overlong {
			if len(line)+len(chunk) > c.maxLineBytes {
				overlong, line = true, nil
			} else {
				line = append(line, chunk...)
			}
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if err != nil {
			if errors.Is(err, io.EOF) && len(line) > 0 && !overlong {
				return line, nil
			}
			return nil, err
		}
		if overlong {
			fmt.Fprintln(c.stderr, "scantor: discarded an overlong protocol line")
			line, overlong = nil, false
			continue
		}
		return line[:len(line)-1], nil
	}
}

// deadlineCause is the cancellation cause when the connector's deadline timer fires.
var deadlineCause = errors.New("cancelled: deadline exceeded")
