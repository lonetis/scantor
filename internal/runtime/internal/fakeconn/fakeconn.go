// Package fakeconn is a scripted connector for the runtime's unit tests. A test binary re-executes itself
// as the connector: TestMain calls Main when Active reports that the process was started as one.
//
// Handshake behaviour comes from SCANTOR_FAKECONN (ok, nohello, badversion, importerror, invalid,
// exitbeforeready, garbage); the schedule kind from SCANTOR_FAKECONN_SCHEDULE ("custom" or a template
// name). Run behaviour follows analysisConfig.mode, schedule behaviour follows the scan config.
package fakeconn

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lonetis/scantor/internal/protocol"
)

// Environment of the fake connector.
const (
	EnvMode     = "SCANTOR_FAKECONN"
	EnvSchedule = "SCANTOR_FAKECONN_SCHEDULE"
)

// Active reports whether this process was started as the fake connector.
func Active() bool { return os.Getenv(EnvMode) != "" }

// Command returns the argv and extra environment that start the current test binary as the fake
// connector with the given handshake mode.
func Command(mode string) (argv []string, env []string) {
	exe, err := os.Executable()
	if err != nil {
		panic(err)
	}
	return []string{exe, "-test.run=^$"}, []string{EnvMode + "=" + mode}
}

type conn struct {
	enc     *protocol.Encoder
	mu      sync.Mutex
	waiters map[string]chan protocol.Message // connector request id → replies
	cancels map[string]chan string           // runtime request id → cancel reasons
	seq     int
}

// Main runs the fake connector and exits.
func Main() {
	in := os.NewFile(3, "fd3")
	out := os.NewFile(4, "fd4")
	c := &conn{enc: protocol.NewEncoder(out), waiters: map[string]chan protocol.Message{}, cancels: map[string]chan string{}}
	mode := os.Getenv(EnvMode)
	switch mode {
	case "nohello":
		time.Sleep(time.Hour)
	case "garbage":
		_, _ = out.Write([]byte("this is not json\n"))
		time.Sleep(time.Hour)
	case "exitbeforeready":
		fmt.Fprintln(os.Stderr, "Traceback: cannot import")
		os.Exit(3)
	}
	fmt.Println("importing fake")
	fmt.Fprintln(os.Stderr, "importing fake")
	proto := protocol.ProtocolRange{Min: 1, Max: 1}
	if mode == "badversion" {
		proto = protocol.ProtocolRange{Min: 5, Max: 6}
	}
	c.send(protocol.Hello{ID: "hello", Protocol: proto, Connector: protocol.ConnectorInfo{Language: "python", Version: "0.0.1"}, PID: os.Getpid()})
	dec := protocol.NewDecoder(in)
	msg, _, err := dec.Decode()
	if err != nil {
		os.Exit(1)
	}
	if _, ok := msg.(protocol.Welcome); !ok {
		os.Exit(1)
	}
	switch mode {
	case "importerror":
		c.send(protocol.Error{ID: "hello", Error: protocol.ErrorObject{Type: "taskError", Message: "RuntimeError: boom at import", Stack: "Traceback\n  File \"/task/main.py\", line 1\n"}})
		os.Exit(1)
	case "invalid":
		c.send(protocol.Error{ID: "hello", Error: protocol.ErrorObject{Type: "validation", Message: "module has no task"}})
		os.Exit(1)
	}
	c.send(protocol.Ready{ID: "hello"})
	for {
		msg, _, err := dec.Decode()
		if err != nil {
			os.Exit(0)
		}
		switch m := msg.(type) {
		case protocol.Describe:
			c.describe(m)
		case protocol.Run:
			c.startRequest(m.ID, func(cancel <-chan string) { c.run(m, cancel) })
		case protocol.Schedule:
			c.startRequest(m.ID, func(cancel <-chan string) { c.schedule(m, cancel) })
		case protocol.Cancel:
			c.mu.Lock()
			ch := c.cancels[m.ID]
			c.mu.Unlock()
			if ch != nil {
				ch <- m.Reason
			}
		case protocol.Shutdown:
			os.Exit(0)
		case protocol.FileRef:
			c.reply(m.ID, m)
		case protocol.Error:
			c.reply(m.ID, m)
		case protocol.TemplateItem:
			c.reply(m.ID, m)
		case protocol.TemplateDone:
			c.reply(m.ID, m)
		}
	}
}

func (c *conn) send(m protocol.Message) {
	if err := c.enc.Encode(m); err != nil {
		os.Exit(9)
	}
}

func (c *conn) nextID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.seq++
	return "c" + strconv.Itoa(c.seq)
}

func (c *conn) wait(id string) chan protocol.Message {
	ch := make(chan protocol.Message, 512)
	c.mu.Lock()
	c.waiters[id] = ch
	c.mu.Unlock()
	return ch
}

func (c *conn) reply(id string, m protocol.Message) {
	c.mu.Lock()
	ch := c.waiters[id]
	c.mu.Unlock()
	if ch != nil {
		ch <- m
	}
}

func (c *conn) startRequest(id string, fn func(cancel <-chan string)) {
	cancel := make(chan string, 2)
	c.mu.Lock()
	c.cancels[id] = cancel
	c.mu.Unlock()
	go fn(cancel)
}

func (c *conn) describe(m protocol.Describe) {
	schedule := protocol.ScheduleInfo{Kind: "template", Template: "single"}
	if s := os.Getenv(EnvSchedule); s == "custom" {
		schedule = protocol.ScheduleInfo{Kind: "custom"}
	} else if s != "" {
		schedule = protocol.ScheduleInfo{Kind: "template", Template: s}
	}
	closed := json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)
	c.send(protocol.Description{
		ID: m.ID,
		Schemas: protocol.Schemas{
			TaskConfig:     json.RawMessage(`{"type":"object","properties":{"greeting":{"type":"string","default":"Hello"},"apiToken":{"type":"string","writeOnly":true,"default":"x"}},"additionalProperties":false}`),
			ScanConfig:     closed,
			AnalysisConfig: json.RawMessage(`{"type":"object","properties":{"name":{"type":"string","default":"world"},"mode":{"type":"string","default":"ok"}},"additionalProperties":false}`),
			Result:         json.RawMessage(`{"type":"object","properties":{"text":{"type":"string"},"files":{"type":"array","items":{"$ref":"#/$defs/FileRef"}}},"$defs":{"FileRef":{"type":"object","x-scantor":"file","properties":{"id":{"type":"string"}}}}}`),
		},
		Schedule: schedule,
		Warnings: []string{"fake warning"},
	})
}

type runConfig struct {
	Mode    string         `json:"mode"`
	Name    string         `json:"name"`
	SleepMs int            `json:"sleepMs"`
	Bytes   int            `json:"bytes"`
	DelayMs *int64         `json:"delayMs"`
	Files   []fileSpec     `json:"files"`
	Extra   map[string]any `json:"extra"`
	// FailAttempts and FailWith drive mode flaky: attempts up to FailAttempts fail ("throw", the default, or
	// "exit") after SleepMs; later attempts succeed at once.
	FailAttempts int    `json:"failAttempts"`
	FailWith     string `json:"failWith"`
	// ExitAfterReply makes the connector exit right after its result, as an idle process that dies would.
	ExitAfterReply bool `json:"exitAfterReply"`
}

type fileSpec struct {
	Name        string  `json:"name"`
	Content     string  `json:"content"`
	ContentType *string `json:"contentType"`
	Path        string  `json:"path"` // registers this path instead of a file in filesDir
}

func (c *conn) run(m protocol.Run, cancel <-chan string) {
	var cfg runConfig
	_ = json.Unmarshal(m.AnalysisConfig, &cfg)
	fail := func(typ, msg string) {
		c.send(protocol.Error{ID: m.ID, Error: protocol.ErrorObject{Type: typ, Message: msg, Stack: "  File \"/task/main.py\", line 7, in run\n"}})
	}
	sleep := func(d time.Duration) bool { // false when cancelled
		select {
		case <-time.After(d):
			return true
		case reason := <-cancel:
			fail("cancelled", "cancelled: "+reason)
			return false
		}
	}
	result := map[string]any{"text": "Hello, " + cfg.Name + "!", "seq": m.Ctx.Seq, "attempt": m.Ctx.Attempt}
	switch cfg.Mode {
	case "fatal":
		fail("fatal", "fatal requested")
		return
	case "retry":
		c.send(protocol.Error{ID: m.ID, Error: protocol.ErrorObject{Type: "retry", Message: "retry requested", DelayMs: cfg.DelayMs}})
		return
	case "throw":
		fail("taskError", "boom")
		return
	case "flaky":
		if m.Ctx.Attempt <= max(cfg.FailAttempts, 1) {
			if !sleep(time.Duration(cfg.SleepMs) * time.Millisecond) {
				return
			}
			if cfg.FailWith == "exit" {
				os.Exit(3)
			}
			fail("taskError", "flaky attempt "+strconv.Itoa(m.Ctx.Attempt))
			return
		}
	case "validation":
		c.send(protocol.Error{ID: m.ID, Error: protocol.ErrorObject{Type: "validation", Message: "analysis config is invalid", Details: json.RawMessage(`{"issues":[{"path":"/name","message":"bad"}]}`)}})
		return
	case "claimTimeout":
		fail("timeout", "I claim a timeout")
		return
	case "sleep":
		if !sleep(time.Duration(cfg.SleepMs) * time.Millisecond) {
			return
		}
	case "sleepUncooperative":
		time.Sleep(time.Duration(cfg.SleepMs) * time.Millisecond)
	case "deadline":
		if m.Ctx.DeadlineMs != nil {
			time.Sleep(time.Until(time.UnixMilli(*m.Ctx.DeadlineMs)))
			fail("cancelled", "deadline reached")
			return
		}
	case "exit":
		os.Exit(3)
	case "garbage":
		_, _ = os.NewFile(4, "fd4").Write([]byte("{not json\n"))
		time.Sleep(time.Hour)
	case "doubleReply":
		c.send(protocol.Result{ID: m.ID, Result: mustJSON(result)})
	case "badResult":
		c.send(protocol.Result{ID: m.ID, Result: json.RawMessage(`[1,2]`)})
		return
	case "oversized":
		result["text"] = strings.Repeat("x", cfg.Bytes)
	case "stdout":
		fmt.Println(`{"type":"result","id":"r0","result":{}}`)
		fmt.Fprintln(os.Stderr, "noise")
	case "log":
		p := m.ID
		c.send(protocol.Log{Parent: &p, Level: "info", Message: "hello", Fields: json.RawMessage(`{"n":1,"s":"x"}`)})
	case "progress":
		f, msg := 0.5, "half"
		c.send(protocol.Progress{Parent: m.ID, Fraction: &f, Message: &msg})
		if !sleep(time.Duration(cfg.SleepMs) * time.Millisecond) {
			return
		}
	case "child":
		cmd := exec.Command("sleep", "300")
		if err := cmd.Start(); err != nil {
			fail("taskError", err.Error())
			return
		}
		fmt.Fprintln(os.Stderr, "child pid "+strconv.Itoa(cmd.Process.Pid))
		time.Sleep(time.Hour)
	case "template":
		id := c.nextID()
		replies := c.wait(id)
		c.send(protocol.Template{ID: id, Parent: m.ID, Template: "range", ScanConfig: json.RawMessage(`{}`), Credit: 10})
		r := <-replies
		if e, ok := r.(protocol.Error); ok {
			fail(e.Error.Type, e.Error.Message)
			return
		}
	case "file":
		var refs []any
		for _, f := range cfg.Files {
			id := c.nextID()
			replies := c.wait(id)
			path := f.Path
			if path == "" {
				path = filepath.Join(*m.Ctx.FilesDir, id+"-"+f.Name)
				if err := os.WriteFile(path, []byte(f.Content), 0o600); err != nil {
					fail("taskError", err.Error())
					return
				}
			}
			c.send(protocol.File{ID: id, Parent: m.ID, Name: f.Name, Path: path, ContentType: f.ContentType})
			switch r := (<-replies).(type) {
			case protocol.FileRef:
				refs = append(refs, r.FileRef)
			case protocol.Error:
				c.send(protocol.Error{ID: m.ID, Error: r.Error})
				return
			}
		}
		result["files"] = refs
	}
	c.send(protocol.Result{ID: m.ID, Result: mustJSON(result)})
	if cfg.ExitAfterReply {
		os.Exit(0)
	}
}

type scheduleConfig struct {
	Count     int            `json:"count"`
	FailAt    *int           `json:"failAt"`
	FatalAt   *int           `json:"fatalAt"`
	Hang      bool           `json:"hang"`
	BadCount  bool           `json:"badCount"`
	Wrap      *wrapConfig    `json:"wrap"`
	ItemBytes int            `json:"itemBytes"`
	Extra     map[string]any `json:"extra"`
}

type wrapConfig struct {
	Template   string          `json:"template"`
	ScanConfig json.RawMessage `json:"scanConfig"`
	Credit     int             `json:"credit"`
	StopAfter  int             `json:"stopAfter"`
}

func (c *conn) schedule(m protocol.Schedule, cancel <-chan string) {
	var cfg scheduleConfig
	_ = json.Unmarshal(m.ScanConfig, &cfg)
	cancelled := func() bool {
		select {
		case reason := <-cancel:
			c.send(protocol.Error{ID: m.ID, Error: protocol.ErrorObject{Type: "cancelled", Message: "cancelled: " + reason}})
			return true
		default:
			return false
		}
	}
	if cfg.Hang {
		reason := <-cancel
		c.send(protocol.Error{ID: m.ID, Error: protocol.ErrorObject{Type: "cancelled", Message: "cancelled: " + reason}})
		return
	}
	if cfg.Wrap != nil {
		c.wrapped(m, cfg.Wrap, cancel)
		return
	}
	pad := strings.Repeat("p", cfg.ItemBytes)
	for i := 0; i < cfg.Count; i++ {
		if cancelled() {
			return
		}
		if cfg.FailAt != nil && *cfg.FailAt == i {
			c.send(protocol.Error{ID: m.ID, Error: protocol.ErrorObject{Type: "taskError", Message: "boom at " + strconv.Itoa(i)}})
			return
		}
		if cfg.FatalAt != nil && *cfg.FatalAt == i {
			c.send(protocol.Error{ID: m.ID, Error: protocol.ErrorObject{Type: "fatal", Message: "fatal at " + strconv.Itoa(i)}})
			return
		}
		item := map[string]any{"n": i}
		if pad != "" {
			item["pad"] = pad
		}
		c.send(protocol.Analysis{ID: m.ID, Config: mustJSON(item)})
	}
	count := int64(cfg.Count)
	if cfg.BadCount {
		count++
	}
	c.send(protocol.Done{ID: m.ID, Count: count})
}

func (c *conn) wrapped(m protocol.Schedule, w *wrapConfig, cancel <-chan string) {
	id := c.nextID()
	replies := c.wait(id)
	credit := w.Credit
	if credit == 0 {
		credit = 256
	}
	c.send(protocol.Template{ID: id, Parent: m.ID, Template: w.Template, ScanConfig: w.ScanConfig, Credit: credit})
	batch := min(128, credit)
	allowance := credit
	consumed, sent := 0, 0
	for {
		select {
		case reason := <-cancel:
			c.send(protocol.Error{ID: m.ID, Error: protocol.ErrorObject{Type: "cancelled", Message: "cancelled: " + reason}})
			return
		case r := <-replies:
			switch r := r.(type) {
			case protocol.TemplateItem:
				consumed++
				if consumed > allowance {
					fmt.Fprintf(os.Stderr, "template allowance violated: item %d of %d\n", consumed, allowance)
					os.Exit(7)
				}
				c.send(protocol.Analysis{ID: m.ID, Config: r.Config})
				sent++
				if w.StopAfter > 0 && sent >= w.StopAfter {
					c.send(protocol.TemplateCancel{ID: id})
					for r := range replies {
						if _, ok := r.(protocol.TemplateDone); ok {
							break
						}
					}
					c.send(protocol.Done{ID: m.ID, Count: int64(sent)})
					return
				}
				if consumed%batch == 0 {
					allowance += batch
					c.send(protocol.TemplateCredit{ID: id, Credit: batch})
				}
			case protocol.TemplateDone:
				c.send(protocol.Done{ID: m.ID, Count: int64(sent)})
				return
			case protocol.Error:
				typ := "taskError"
				if r.Error.Type == "validation" {
					typ = "validation"
				}
				c.send(protocol.Error{ID: m.ID, Error: protocol.ErrorObject{Type: typ, Message: r.Error.Message}})
				return
			}
		}
	}
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

// ReadLines is a helper for tests that inspect files: it returns the lines of path.
func ReadLines(path string) ([]string, error) {
	f, err := os.Open(path) //nolint:gosec // test helper
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var lines []string
	s := bufio.NewScanner(f)
	for s.Scan() {
		lines = append(lines, s.Text())
	}
	return lines, s.Err()
}
