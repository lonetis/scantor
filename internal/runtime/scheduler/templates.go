package scheduler

import (
	"context"
	"encoding/json"
	"iter"
	"strconv"
	"sync"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/protocol"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/pool"
	"github.com/lonetis/scantor/internal/runtime/scerr"
	"github.com/lonetis/scantor/internal/templates"
	"github.com/lonetis/scantor/internal/templates/core"
)

// Resolution keys (docs/runtime.md §11.1, §11.2).
const KeySchedule = api.ResolutionKeySchedule

// CallKey returns the resolution key of the n-th (0-based) wrapped template call of a schedule request.
func CallKey(n int) string { return "call:" + strconv.Itoa(n) }

// Recorder records a new resolution: the scheduler posts it to /api/runtime/scheduler/resolved (which
// may answer with an earlier resolution of another epoch), local mode emits a `resolved` event.
type Recorder func(ctx context.Context, key string, r api.Resolution) (api.Resolution, error)

// Resolutions resolves template scan configs once per key (docs/runtime.md §11.2): a stored resolution is
// always reused (resume); otherwise the template's resolve step runs and the result is recorded.
type Resolutions struct {
	Env    templates.Env
	Record Recorder
	Now    func() api.Time

	mu     sync.Mutex
	stored map[string]api.Resolution
}

// NewResolutions returns resolutions starting from the stored ones (bootstrap scheduler.resolved or the
// local spec's resolved).
func NewResolutions(env templates.Env, stored map[string]api.Resolution, record Recorder) *Resolutions {
	s := make(map[string]api.Resolution, len(stored))
	for k, v := range stored {
		s[k] = v
	}
	return &Resolutions{Env: env, Record: record, stored: s}
}

// Resolve returns the resolution of key for template def and its effective scan config.
func (r *Resolutions) Resolve(ctx context.Context, key string, def *templates.Definition, effective json.RawMessage) (templates.Resolution, error) {
	r.mu.Lock()
	stored, ok := r.stored[key]
	r.mu.Unlock()
	if ok {
		if err := sameTemplate(key, stored, def); err != nil {
			return templates.Resolution{}, err
		}
		return fromAPI(stored), nil
	}
	res, err := def.Resolve(ctx, r.Env, effective)
	if err != nil {
		return templates.Resolution{}, err
	}
	provenance, err := json.Marshal(nonNilMap(res.Provenance))
	if err != nil {
		return templates.Resolution{}, runtime.Platform(false, "cannot encode the provenance of %s: %v", def.Name(), err)
	}
	rec := api.Resolution{Template: def.Name(), ScanConfig: res.ScanConfig, Provenance: provenance, ExpectedTotal: res.ExpectedTotal}
	if r.Now != nil {
		rec.At = r.Now()
	}
	if r.Record != nil {
		kept, err := r.Record(ctx, key, rec)
		if err != nil {
			return templates.Resolution{}, err
		}
		if err := sameTemplate(key, kept, def); err != nil {
			return templates.Resolution{}, err
		}
		rec = kept
	}
	r.mu.Lock()
	r.stored[key] = rec
	r.mu.Unlock()
	return fromAPI(rec), nil
}

// sameTemplate rejects a stored resolution of another template under the same key: the n-th wrapped
// call of a deterministic schedule always uses the same template (docs/runtime.md §11.2, §11.3).
func sameTemplate(key string, stored api.Resolution, def *templates.Definition) error {
	if stored.Template == def.Name() {
		return nil
	}
	return runtime.Validation("schedule() is not deterministic: template call %s used template %s before and %s now", key, stored.Template, def.Name())
}

func nonNilMap(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

func fromAPI(r api.Resolution) templates.Resolution {
	var provenance map[string]any
	if len(r.Provenance) > 0 {
		_ = json.Unmarshal(r.Provenance, &provenance)
	}
	return templates.Resolution{ScanConfig: r.ScanConfig, Provenance: provenance, ExpectedTotal: r.ExpectedTotal}
}

// Effective applies the canonical defaults and checks of def to scanConfig (defence in depth for
// unwrapped templates, the only check for wrapped calls).
func Effective(def *templates.Definition, scanConfig json.RawMessage) (json.RawMessage, error) {
	effective, issues, err := def.Effective(scanConfig)
	if err != nil {
		return nil, runtime.Validation("invalid scan config for template %s: %v", def.Name(), err)
	}
	if len(issues) > 0 {
		return nil, core.IssuesError(issues)
	}
	return effective, nil
}

// TemplateServer serves the wrapped template calls of one connector schedule request
// (docs/protocol.md §5.8, §6.2): each `template` request is resolved with key call:<n> and streamed with
// credit-based flow control; `templateCancel` ends it with `templateDone`.
type TemplateServer struct {
	res *Resolutions
	log func(msg string, args ...any)

	mu      sync.Mutex
	call    *pool.Call
	n       int
	streams map[string]*stream
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

// NewTemplateServer returns a server resolving with res; log may be nil.
func NewTemplateServer(ctx context.Context, res *Resolutions, log func(msg string, args ...any)) *TemplateServer {
	ctx, cancel := context.WithCancel(ctx)
	if log == nil {
		log = func(string, ...any) {}
	}
	return &TemplateServer{res: res, log: log, streams: map[string]*stream{}, ctx: ctx, cancel: cancel}
}

func (t *TemplateServer) attach(call *pool.Call) {
	t.mu.Lock()
	t.call = call
	t.mu.Unlock()
}

type stream struct {
	id        string
	allowance int64
	cancelled bool
	wake      chan struct{}
}

func (s *stream) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Start begins serving a `template` request.
func (t *TemplateServer) Start(m protocol.Template) {
	t.mu.Lock()
	key := CallKey(t.n)
	t.n++
	st := &stream{id: m.ID, allowance: int64(m.Credit), wake: make(chan struct{}, 1)}
	t.streams[m.ID] = st
	call := t.call
	t.mu.Unlock()
	t.wg.Go(func() { t.serve(call, st, m, key) })
}

// Credit grants more items to the stream id.
func (t *TemplateServer) Credit(id string, n int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if st, ok := t.streams[id]; ok {
		st.allowance += int64(n)
		st.signal()
	}
}

// Cancel stops the stream id; it ends with templateDone.
func (t *TemplateServer) Cancel(id string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if st, ok := t.streams[id]; ok {
		st.cancelled = true
		st.signal()
	}
}

// Refuse answers a template request that arrives while the schedule is being abandoned.
func (t *TemplateServer) Refuse(id string) {
	t.mu.Lock()
	call := t.call
	t.mu.Unlock()
	if call != nil {
		f := false
		_ = call.Send(protocol.Error{ID: id, Error: protocol.ErrorObject{Type: protocol.ErrorValidation, Message: "the schedule is shutting down", Retryable: &f}})
		call.CloseTemplate(id)
	}
}

// Close cancels every open stream (the parent schedule ended) and waits for them.
func (t *TemplateServer) Close() {
	t.cancel()
	t.wg.Wait()
}

func (t *TemplateServer) serve(call *pool.Call, st *stream, m protocol.Template, key string) {
	defer func() {
		t.mu.Lock()
		delete(t.streams, st.id)
		t.mu.Unlock()
		call.CloseTemplate(st.id)
	}()
	fail := func(err error) {
		if t.ctx.Err() != nil {
			return // the schedule ended; nothing more is sent for it
		}
		e := scerr.FromError(err, api.PhaseSchedule, true)
		r := e.Retryable
		typ := protocol.ErrorPlatform
		if e.Type == api.ErrorValidation {
			typ = protocol.ErrorValidation
		}
		if err := call.Send(protocol.Error{ID: st.id, Error: protocol.ErrorObject{Type: typ, Message: scerr.TruncateMessage(e.Message, scerr.MaxMessageBytes), Retryable: &r}}); err != nil {
			t.log("cannot send a template error", "err", err)
		}
	}
	def, ok := templates.Lookup(m.Template)
	if !ok {
		fail(runtime.Validation("unknown template %q", m.Template))
		return
	}
	effective, err := Effective(def, m.ScanConfig)
	if err != nil {
		fail(err)
		return
	}
	res, err := t.res.Resolve(t.ctx, key, def, effective)
	if err != nil {
		fail(err)
		return
	}
	next, stop := iter.Pull2(def.Stream(t.ctx, t.res.Env, res))
	defer stop()
	var count int64
	for {
		t.mu.Lock()
		cancelled, allowed := st.cancelled, count < st.allowance
		t.mu.Unlock()
		if cancelled {
			break
		}
		if !allowed {
			select {
			case <-st.wake:
				continue
			case <-t.ctx.Done():
				return
			}
		}
		item, err, ok := next()
		if !ok {
			break
		}
		if err != nil {
			fail(err)
			return
		}
		if t.ctx.Err() != nil {
			return
		}
		if err := call.Send(protocol.TemplateItem{ID: st.id, Config: item}); err != nil {
			t.log("cannot send a template item", "err", err)
			return
		}
		count++
	}
	if t.ctx.Err() != nil {
		return
	}
	if err := call.Send(protocol.TemplateDone{ID: st.id, Count: count}); err != nil {
		t.log("cannot send templateDone", "err", err)
	}
}
