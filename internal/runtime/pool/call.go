package pool

import (
	"fmt"

	"github.com/lonetis/scantor/internal/protocol"
)

// Request kinds.
const (
	KindDescribe = "describe"
	KindSchedule = "schedule"
	KindRun      = "run"
)

// Event is one thing that happened to a request: a connector message addressed to it (Msg), a protocol
// violation of the process (Violation; the process group is being killed), or the end of the process
// (Exit; always the last event).
type Event struct {
	Msg       protocol.Message
	Violation error
	Exit      *ExitStatus
}

// Call is one runtime request in flight on a process.
type Call struct {
	p      *Process
	ID     string
	Kind   string
	events chan Event
	ended  chan struct{}

	// Guarded by p.mu.
	replied   bool
	templates map[string]bool // template stream id → open
}

// Events returns the events of the call. The channel is unbuffered: while the consumer does not read,
// the process's fd 4 is not read either (pipe backpressure, docs/protocol.md §6.1).
func (c *Call) Events() <-chan Event { return c.events }

// Process returns the process of the call.
func (c *Call) Process() *Process { return c.p }

// Send writes a message for this request to the connector (fileRef, error, templateItem, templateDone,
// cancel).
func (c *Call) Send(msg protocol.Message) error { return c.p.send(msg) }

// Cancel asks the connector to abort the request (docs/protocol.md §5.9).
func (c *Call) Cancel(reason string) error {
	return c.Send(protocol.Cancel{ID: c.ID, Reason: reason})
}

// CloseTemplate marks a template stream finished (after templateDone or error was sent); later credits
// and cancels for it are ignored.
func (c *Call) CloseTemplate(id string) {
	c.p.mu.Lock()
	defer c.p.mu.Unlock()
	if _, ok := c.templates[id]; ok {
		c.templates[id] = false
	}
}

// End finishes the call: the process becomes idle (if it is still usable), and messages for this request
// that arrive later are treated as the protocol requires (late replies are violations, late logs go to
// the runtime log).
func (c *Call) End() {
	c.p.mu.Lock()
	defer c.p.mu.Unlock()
	select {
	case <-c.ended:
		return
	default:
	}
	close(c.ended)
	if c.p.call == c {
		c.p.call = nil
		c.p.lastID = c.ID
	}
}

// deliver hands an event to the consumer unless the call has ended.
func (c *Call) deliver(ev Event) {
	select {
	case c.events <- ev:
	case <-c.ended:
	}
}

// templateMessage classifies templateCredit and templateCancel (under p.mu): open streams of the call
// receive them, finished streams ignore them (a credit can cross the runtime's templateDone), anything
// else is a violation.
func (c *Call) templateMessage(id string, msg protocol.Message) (bool, error) {
	if c == nil {
		return false, fmt.Errorf("%s for unknown template stream %q", msg.MessageType(), id)
	}
	open, known := c.templates[id]
	if !known {
		return false, fmt.Errorf("%s for unknown template stream %q", msg.MessageType(), id)
	}
	return open, nil
}
