package conformance

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/lonetis/scantor/internal/protocol"
)

// ExecConfig is the environment of `scantor conformance exec` inside a fixture container.
type ExecConfig struct {
	Language     string
	Fixture      string
	Entry        string
	ConnectorCmd string
	Environ      []string
	TaskDir      string
	// WorkRoot holds per-process and per-call directories.
	WorkRoot string
}

// H is the harness of one case run: the case's checks record failures here.
type H struct {
	cfg       ExecConfig
	validator *protocol.Validator
	procs     int
	calls     int

	mu       sync.Mutex
	failures []string
	checks   int
	cleanups []func()
}

func (h *H) failf(format string, args ...any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.failures = append(h.failures, fmt.Sprintf(format, args...))
}

// check records a check and a failure when cond is false.
func (h *H) check(cond bool, format string, args ...any) bool {
	h.mu.Lock()
	h.checks++
	h.mu.Unlock()
	if !cond {
		h.failf(format, args...)
	}
	return cond
}

func (h *H) cleanup(fn func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.cleanups = append(h.cleanups, fn)
}

func (h *H) close() {
	h.mu.Lock()
	fns := h.cleanups
	h.cleanups = nil
	h.mu.Unlock()
	for i := len(fns) - 1; i >= 0; i-- {
		fns[i]()
	}
}

// ready spawns the connector and completes the handshake.
func (h *H) ready() (*conn, error) { return h.readyEntry("") }

// readyEntry is ready with another entry than the fixture's (Go template-models binaries).
func (h *H) readyEntry(entry string) (*conn, error) {
	c, err := h.spawn(spawnOptions{entry: entry})
	if err != nil {
		return nil, err
	}
	if _, err := c.handshake(nil); err != nil {
		return nil, err
	}
	return c, nil
}

// callDirs creates the tmpDir and filesDir of one call.
func (h *H) callDirs() (string, string, error) {
	h.calls++
	dir := filepath.Join(h.cfg.WorkRoot, fmt.Sprintf("x-%d", h.calls))
	tmp, files := filepath.Join(dir, "tmp"), filepath.Join(dir, "files")
	for _, d := range []string{tmp, files} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return "", "", err
		}
	}
	return tmp, files, nil
}

// runOpts configure one run request.
type runOpts struct {
	analysisConfig any
	taskConfig     any
	// deadline is the ctx deadline (0: one minute from now; negative: none).
	deadline time.Duration
	// extra adds fields to the run message (P2).
	extra map[string]any
	// onFile answers a file request; nil registers it like the runtime.
	onFile func(protocol.File, *runOutcome) protocol.Message
	// cancelAfter sends cancel with cancelReason after this delay (C1, C2).
	cancelAfter  time.Duration
	cancelReason string
	// timeout bounds the wait for the reply.
	timeout time.Duration
}

// runOutcome is everything one run produced.
type runOutcome struct {
	id       string
	ctx      protocol.Ctx
	reply    protocol.Message // Result or Error; nil when the process ended first
	logs     []protocol.Log
	progress []protocol.Progress
	files    []protocol.File
	refs     []protocol.FileRefObject
	order    []string // message types in arrival order
	replied  time.Time
	sent     time.Time
}

// result returns the decoded result, or nil.
func (o *runOutcome) result() map[string]any {
	r, ok := o.reply.(protocol.Result)
	if !ok {
		return nil
	}
	var m map[string]any
	_ = json.Unmarshal(r.Result, &m)
	return m
}

// errorObject returns the error reply, or nil.
func (o *runOutcome) errorObject() *protocol.ErrorObject {
	e, ok := o.reply.(protocol.Error)
	if !ok {
		return nil
	}
	return &e.Error
}

func (o *runOutcome) describe() string {
	switch r := o.reply.(type) {
	case protocol.Result:
		return "result " + excerpt(r.Result)
	case protocol.Error:
		return fmt.Sprintf("error %s: %s", r.Error.Type, r.Error.Message)
	default:
		return "no reply"
	}
}

// rawJSON encodes a config; nil (also a nil map) is the empty object.
func rawJSON(v any) json.RawMessage {
	if r, ok := v.(json.RawMessage); ok {
		return r
	}
	b, err := json.Marshal(v)
	if err != nil || string(b) == "null" {
		return json.RawMessage(`{}`)
	}
	return b
}

// run sends one run request and collects its messages until the reply (P4: the reply carries the run's
// id; connector requests carry it as parent).
func (c *conn) run(o runOpts) (*runOutcome, error) {
	tmp, files, err := c.h.callDirs()
	if err != nil {
		return nil, err
	}
	out := &runOutcome{id: c.nextID("r")}
	seq, round := int64(7), 1
	aid, eid := "conformance-scan-7", uuid.NewString()
	ctx := protocol.Ctx{ScanID: "conformance-scan", AnalysisID: &aid, Seq: &seq, Round: &round, Attempt: 1, ExecutionID: &eid, TmpDir: tmp, FilesDir: &files}
	switch {
	case o.deadline == 0:
		ms := time.Now().Add(time.Minute).UnixMilli()
		ctx.DeadlineMs = &ms
	case o.deadline > 0:
		ms := time.Now().Add(o.deadline).UnixMilli()
		ctx.DeadlineMs = &ms
	}
	out.ctx = ctx
	msg := protocol.Run{ID: out.id, Ctx: ctx, AnalysisConfig: rawJSON(o.analysisConfig), TaskConfig: rawJSON(o.taskConfig)}
	out.sent = time.Now()
	if o.extra != nil {
		err = c.sendRaw(with(msg, o.extra))
	} else {
		err = c.send(msg)
	}
	if err != nil {
		return out, err
	}
	timeout := o.timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	var cancelAt <-chan time.Time
	if o.cancelAfter > 0 {
		t := time.NewTimer(o.cancelAfter)
		defer t.Stop()
		cancelAt = t.C
	}
	for {
		var m protocol.Message
		select {
		case <-cancelAt:
			cancelAt = nil
			if err := c.send(protocol.Cancel{ID: out.id, Reason: o.cancelReason}); err != nil {
				return out, err
			}
			continue
		case mm, ok := <-c.msgs:
			if !ok {
				return out, errClosed
			}
			m = mm.msg
		case <-deadline.C:
			return out, errTimeout
		}
		out.order = append(out.order, m.MessageType())
		switch v := m.(type) {
		case protocol.Result:
			c.h.check(v.ID == out.id, "P4: result id %q, want %q", v.ID, out.id)
			out.reply, out.replied = v, time.Now()
			return out, nil
		case protocol.Error:
			c.h.check(v.ID == out.id, "P4: error id %q, want %q", v.ID, out.id)
			out.reply, out.replied = v, time.Now()
			return out, nil
		case protocol.Log:
			out.logs = append(out.logs, v)
		case protocol.Progress:
			out.progress = append(out.progress, v)
		case protocol.File:
			c.h.check(v.Parent == out.id, "file parent %q, want the run id %q", v.Parent, out.id)
			out.files = append(out.files, v)
			reply := c.registerFile(v, out)
			if o.onFile != nil {
				reply = o.onFile(v, out)
			}
			if err := c.send(reply); err != nil {
				return out, err
			}
		default:
			c.h.failf("unexpected %s during a run", m.MessageType())
		}
	}
}

// registerFile answers a file request as the runtime does: hash the content and return a FileRef.
func (c *conn) registerFile(m protocol.File, out *runOutcome) protocol.Message {
	f, err := os.Open(m.Path)
	if err != nil {
		f := false
		return protocol.Error{ID: m.ID, Error: protocol.ErrorObject{Type: protocol.ErrorValidation, Message: err.Error(), Retryable: &f}}
	}
	defer f.Close()
	h := sha256.New()
	n, _ := io.Copy(h, f)
	ct := "application/octet-stream"
	if m.ContentType != nil {
		ct = *m.ContentType
	}
	ref := protocol.FileRefObject{ID: uuid.NewString(), Name: m.Name, Size: n, SHA256: hex.EncodeToString(h.Sum(nil)), ContentType: ct}
	out.refs = append(out.refs, ref)
	return protocol.FileRef{ID: m.ID, FileRef: ref}
}

// describeTask sends describe and returns the description.
func (c *conn) describeTask() (protocol.Description, error) {
	id := c.nextID("d")
	if err := c.send(protocol.Describe{ID: id}); err != nil {
		return protocol.Description{}, err
	}
	m, err := c.recv(protocol.DescriptionTimeout)
	if err != nil {
		return protocol.Description{}, err
	}
	switch v := m.(type) {
	case protocol.Description:
		c.h.check(v.ID == id, "P4: description id %q, want %q", v.ID, id)
		return v, nil
	case protocol.Error:
		return protocol.Description{}, fmt.Errorf("describe failed: %s %s", v.Error.Type, v.Error.Message)
	}
	return protocol.Description{}, fmt.Errorf("%s instead of description", m.MessageType())
}

// templateServer answers the template requests of one schedule like the runtime: items only within
// the allowance (initial credit plus every templateCredit), templateDone after the last item or a
// templateCancel.
type templateServer struct {
	// items produces the items of a request (the harness's stand-in for the native template).
	items func(t protocol.Template) ([]json.RawMessage, *protocol.ErrorObject)
}

// scheduleOpts configure one schedule request.
type scheduleOpts struct {
	scanConfig any
	templates  *templateServer
	// onItem is called with the schedule id and the item count after every analysis item (S5 pauses
	// reading here).
	onItem func(id string, n int)
	// cancelAfterItems sends cancel with cancelReason after this many items.
	cancelAfterItems int
	cancelReason     string
	timeout          time.Duration
}

// scheduleOutcome is everything one schedule produced.
type scheduleOutcome struct {
	id         string
	items      []json.RawMessage
	reply      protocol.Message // Done or Error
	requests   []protocol.Template
	cancels    []protocol.TemplateCancel
	sentItems  map[string]int
	allowances map[string]int
}

// schedule sends a schedule request and serves it to the end.
func (c *conn) schedule(o scheduleOpts) (*scheduleOutcome, error) {
	tmp, _, err := c.h.callDirs()
	if err != nil {
		return nil, err
	}
	out := &scheduleOutcome{id: c.nextID("s"), sentItems: map[string]int{}, allowances: map[string]int{}}
	ctx := protocol.Ctx{ScanID: "conformance-scan", Attempt: 1, TmpDir: tmp}
	if err := c.send(protocol.Schedule{ID: out.id, Ctx: ctx, ScanConfig: rawJSON(o.scanConfig), TaskConfig: json.RawMessage(`{}`)}); err != nil {
		return out, err
	}
	timeout := o.timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	pending := map[string][]json.RawMessage{} // template id → items not sent yet
	done := map[string]bool{}
	flush := func(id string) error {
		for len(pending[id]) > 0 && out.sentItems[id] < out.allowances[id] {
			item := pending[id][0]
			pending[id] = pending[id][1:]
			if err := c.send(protocol.TemplateItem{ID: id, Config: item}); err != nil {
				return err
			}
			out.sentItems[id]++
		}
		if len(pending[id]) == 0 && !done[id] {
			done[id] = true
			return c.send(protocol.TemplateDone{ID: id, Count: int64(out.sentItems[id])})
		}
		return nil
	}
	deadline := time.Now().Add(timeout)
	for {
		m, err := c.recv(max(time.Until(deadline), time.Millisecond))
		if err != nil {
			return out, err
		}
		switch v := m.(type) {
		case protocol.Analysis:
			c.h.check(v.ID == out.id, "P4: analysis id %q, want %q", v.ID, out.id)
			out.items = append(out.items, v.Config)
			if o.onItem != nil {
				o.onItem(out.id, len(out.items))
			}
			if o.cancelAfterItems > 0 && len(out.items) == o.cancelAfterItems {
				if err := c.send(protocol.Cancel{ID: out.id, Reason: o.cancelReason}); err != nil {
					return out, err
				}
			}
		case protocol.Done:
			c.h.check(v.ID == out.id, "P4: done id %q, want %q", v.ID, out.id)
			out.reply = v
			return out, nil
		case protocol.Error:
			c.h.check(v.ID == out.id, "P4: error id %q, want %q", v.ID, out.id)
			out.reply = v
			return out, nil
		case protocol.Template:
			c.h.check(v.Parent == out.id, "template parent %q, want the schedule id %q", v.Parent, out.id)
			out.requests = append(out.requests, v)
			out.allowances[v.ID] = v.Credit
			if o.templates == nil {
				c.h.failf("unexpected template request %s", v.Template)
				f := false
				_ = c.send(protocol.Error{ID: v.ID, Error: protocol.ErrorObject{Type: protocol.ErrorValidation, Message: "no templates in this case", Retryable: &f}})
				continue
			}
			items, failure := o.templates.items(v)
			if failure != nil {
				done[v.ID] = true
				if err := c.send(protocol.Error{ID: v.ID, Error: *failure}); err != nil {
					return out, err
				}
				continue
			}
			pending[v.ID] = items
			if err := flush(v.ID); err != nil {
				return out, err
			}
		case protocol.TemplateCredit:
			out.allowances[v.ID] += v.Credit
			if !done[v.ID] {
				if err := flush(v.ID); err != nil {
					return out, err
				}
			}
		case protocol.TemplateCancel:
			out.cancels = append(out.cancels, v)
			if !done[v.ID] {
				done[v.ID] = true
				pending[v.ID] = nil
				if err := c.send(protocol.TemplateDone{ID: v.ID, Count: int64(out.sentItems[v.ID])}); err != nil {
					return out, err
				}
			}
		case protocol.Log:
		default:
			c.h.failf("unexpected %s during a schedule", m.MessageType())
		}
	}
}

func (o *scheduleOutcome) errorObject() *protocol.ErrorObject {
	if e, ok := o.reply.(protocol.Error); ok {
		return &e.Error
	}
	return nil
}

func (o *scheduleOutcome) done() (int64, bool) {
	if d, ok := o.reply.(protocol.Done); ok {
		return d.Count, true
	}
	return 0, false
}

func (o *scheduleOutcome) describe() string {
	switch r := o.reply.(type) {
	case protocol.Done:
		return fmt.Sprintf("done %d after %d items", r.Count, len(o.items))
	case protocol.Error:
		return fmt.Sprintf("error %s: %s after %d items", r.Error.Type, r.Error.Message, len(o.items))
	default:
		return fmt.Sprintf("no reply after %d items", len(o.items))
	}
}

func containsFold(s, sub string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(sub))
}
