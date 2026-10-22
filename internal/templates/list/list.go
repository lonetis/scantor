// Package list implements the template list (docs/templates.md §9.2): one analysis per item of an
// inline list and/or an uploaded newline-separated file. Items are trimmed and empty items skipped;
// `index` is the 0-based position in the combined sequence before `offset`.
package list

import (
	"context"
	"encoding/json"
	"errors"
	"iter"

	"github.com/lonetis/scantor/internal/templates/core"
	"github.com/lonetis/scantor/internal/templates/fetch"
)

// Name is the template name.
const Name = "list"

// Template is the list template.
type Template struct{}

// New returns the list template.
func New() *Template { return &Template{} }

// Config is the scan config.
type Config struct {
	Items  []string `json:"items"`
	Upload *string  `json:"upload"`
	Offset int64    `json:"offset"`
	Limit  *int64   `json:"limit"`
}

// AnalysisConfig is one item of the stream.
type AnalysisConfig struct {
	Index int64  `json:"index"`
	Item  string `json:"item"`
}

type provenance struct {
	InlineItems int64             `json:"inlineItems"`
	Upload      *uploadProvenance `json:"upload"`
}

type uploadProvenance struct {
	ID     string `json:"id"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
	Lines  int64  `json:"lines"`
}

// Name returns "list".
func (*Template) Name() string { return Name }

// Validate has nothing to check beyond the schema; an unknown upload is data-dependent and reported
// by Estimate and Resolve at /upload.
func (*Template) Validate(json.RawMessage) []core.Issue { return nil }

// Estimate is min(limit, max(0, inline items + upload lines − offset)), exact.
func (*Template) Estimate(cfg json.RawMessage, env core.Env) (core.Estimate, error) {
	c, err := parse(cfg)
	if err != nil {
		return core.Estimate{}, err
	}
	total := countInline(c.Items)
	if c.Upload != nil {
		u, err := upload(env, *c.Upload)
		if err != nil {
			return core.Estimate{}, err
		}
		total += u.Lines
	}
	return core.Estimate{ExpectedTotal: core.Total(window(c, total)), Exact: true}, nil
}

// Resolve downloads the upload (if any), verifies it against the upload record and counts its items.
// Uploads are immutable, so nothing needs pinning.
func (*Template) Resolve(ctx context.Context, env core.Env, cfg json.RawMessage) (core.Resolution, error) {
	c, err := parse(cfg)
	if err != nil {
		return core.Resolution{}, err
	}
	prov := provenance{InlineItems: countInline(c.Items)}
	total := prov.InlineItems
	if c.Upload != nil {
		u, err := upload(env, *c.Upload)
		if err != nil {
			return core.Resolution{}, err
		}
		file, err := download(ctx, env, *c.Upload, u)
		if err != nil {
			return core.Resolution{}, err
		}
		if u.SHA256 != "" && file.SHA256 != u.SHA256 {
			return core.Resolution{}, core.ValidationAt("/upload", "upload %s does not match its recorded sha256", *c.Upload)
		}
		lines, err := countUpload(*c.Upload, file)
		if err != nil {
			return core.Resolution{}, err
		}
		prov.Upload = &uploadProvenance{ID: *c.Upload, SHA256: file.SHA256, Bytes: file.Size, Lines: lines}
		total += lines
	}
	resolved, err := core.EncodeItem(c)
	if err != nil {
		return core.Resolution{}, core.Platformf(false, err, "encode the resolved scan config: %v", err)
	}
	provMap, err := core.ProvenanceMap(prov)
	if err != nil {
		return core.Resolution{}, core.Platformf(false, err, "encode the provenance: %v", err)
	}
	return core.Resolution{ScanConfig: resolved, Provenance: provMap, ExpectedTotal: core.Total(window(c, total))}, nil
}

// Stream yields the inline items, then the upload's items, from index offset on, at most limit.
func (*Template) Stream(ctx context.Context, env core.Env, res core.Resolution) iter.Seq2[json.RawMessage, error] {
	return func(yield func(json.RawMessage, error) bool) {
		c, err := parse(res.ScanConfig)
		if err != nil {
			yield(nil, err)
			return
		}
		var prov provenance
		if err := core.DecodeProvenance(res.Provenance, &prov); err != nil {
			yield(nil, err)
			return
		}
		e := emitter{ctx: ctx, cfg: c, yield: yield}
		for _, item := range c.Items {
			if t := Trim(item); t != "" && !e.emit(t) {
				return
			}
		}
		if c.Upload == nil || e.full() {
			return
		}
		if prov.Upload == nil || prov.Upload.ID != *c.Upload {
			yield(nil, core.Validationf("the resolution does not match the scan config (upload %s)", *c.Upload))
			return
		}
		u, err := upload(env, *c.Upload)
		if err != nil {
			yield(nil, err)
			return
		}
		file, err := download(ctx, env, *c.Upload, u)
		if err != nil {
			yield(nil, err)
			return
		}
		if file.SHA256 != prov.Upload.SHA256 {
			yield(nil, core.Validationf("upload %s content changed since resolution", *c.Upload))
			return
		}
		f, err := file.Open()
		if err != nil {
			yield(nil, err)
			return
		}
		defer func() { _ = f.Close() }()
		err = forEachItem(f, func(_ int64, item []byte) bool { return e.emit(string(item)) })
		if err != nil && !e.stopped {
			yield(nil, itemError(*c.Upload, err))
		}
	}
}

// emitter applies offset and limit to the combined sequence and stops on a consumer stop, a full
// window or a cancelled context.
type emitter struct {
	ctx     context.Context
	cfg     Config
	yield   func(json.RawMessage, error) bool
	index   int64
	emitted int64
	stopped bool
}

func (e *emitter) full() bool { return e.cfg.Limit != nil && e.emitted >= *e.cfg.Limit }

// emit handles the next item and reports whether iteration continues.
func (e *emitter) emit(item string) bool {
	index := e.index
	e.index++
	if index < e.cfg.Offset {
		return true
	}
	if err := e.ctx.Err(); err != nil {
		e.yield(nil, err)
		e.stopped = true
		return false
	}
	raw, err := core.EncodeItem(AnalysisConfig{Index: index, Item: item})
	if !e.yield(raw, err) || err != nil {
		e.stopped = true
		return false
	}
	e.emitted++
	return !e.full()
}

func parse(raw json.RawMessage) (Config, error) {
	var c Config
	if err := core.DecodeConfig(raw, &c); err != nil {
		return Config{}, err
	}
	if c.Items == nil {
		c.Items = []string{}
	}
	switch {
	case c.Offset < 0:
		return Config{}, core.ValidationAt("/offset", "offset must be ≥ 0")
	case c.Limit != nil && *c.Limit < 1:
		return Config{}, core.ValidationAt("/limit", "limit must be ≥ 1")
	}
	return c, nil
}

func countInline(items []string) int64 {
	var n int64
	for _, item := range items {
		if Trim(item) != "" {
			n++
		}
	}
	return n
}

// window applies offset and limit to a combined count.
func window(c Config, total int64) int64 {
	n := max(0, total-c.Offset)
	if c.Limit != nil {
		n = min(n, *c.Limit)
	}
	return n
}

func upload(env core.Env, id string) (core.Upload, error) {
	u, ok := env.Uploads[id]
	if !ok {
		return core.Upload{}, core.ValidationAt("/upload", "unknown upload %s", id)
	}
	return u, nil
}

// download fetches an upload through its presigned URL. The URL never appears in messages (its query
// carries a signature), and the caps are the recorded size when it is known.
func download(ctx context.Context, env core.Env, id string, u core.Upload) (*fetch.File, error) {
	if u.URL == "" {
		return nil, core.ValidationAt("/upload", "upload %s is not available here", id)
	}
	req := fetch.Request{URL: u.URL, Label: "upload " + id}
	if u.Bytes > 0 {
		req.MaxBytes, req.MaxDecoded = u.Bytes, u.Bytes
	}
	file, err := fetch.Download(ctx, env, req)
	var serr *fetch.StatusError
	if errors.As(err, &serr) {
		if serr.StatusCode == 404 {
			return nil, core.ValidationAt("/upload", "upload %s is not available (%s)", id, serr.Status)
		}
		// 403 is an expired or invalid presigned URL: a restarted scheduler gets fresh URLs.
		return nil, core.Platformf(true, err, "%s", serr.Error())
	}
	return file, err
}

func countUpload(id string, file *fetch.File) (int64, error) {
	f, err := file.Open()
	if err != nil {
		return 0, err
	}
	defer func() { _ = f.Close() }()
	var n int64
	err = forEachItem(f, func(int64, []byte) bool { n++; return true })
	if err != nil {
		return 0, itemError(id, err)
	}
	return n, nil
}

func itemError(id string, err error) error {
	var tooLong *errItemTooLong
	if errors.As(err, &tooLong) {
		return core.ValidationAt("/upload", "line %d of upload exceeds %d bytes", tooLong.line, MaxItemBytes)
	}
	return core.Platformf(true, err, "read upload %s: %v", id, err)
}
