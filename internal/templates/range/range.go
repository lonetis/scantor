// Package ranges implements the template range (docs/templates.md §9.3): one analysis per integer of
// start, start + step, … up to but excluding end (Python range semantics). Its directory is
// internal/templates/range; the package is named ranges because range is a Go keyword.
package ranges

import (
	"context"
	"encoding/json"
	"iter"

	"github.com/lonetis/scantor/internal/templates/core"
)

// Name is the template name.
const Name = "range"

// Bound is the largest magnitude of start, end and step (2^53 − 1, exact in every connector).
const Bound = 1<<53 - 1

// Template is the range template.
type Template struct{}

// New returns the range template.
func New() *Template { return &Template{} }

// Config is the scan config.
type Config struct {
	Start int64 `json:"start"`
	End   int64 `json:"end"`
	Step  int64 `json:"step"`
}

// AnalysisConfig is one item of the stream.
type AnalysisConfig struct {
	Value int64 `json:"value"`
}

// Name returns "range".
func (*Template) Name() string { return Name }

// Validate rejects step 0.
func (*Template) Validate(cfg json.RawMessage) []core.Issue {
	var c Config
	if err := core.DecodeConfig(cfg, &c); err != nil {
		return []core.Issue{{Message: err.Error()}}
	}
	return issues(c)
}

func issues(c Config) []core.Issue {
	var out []core.Issue
	for _, f := range []struct {
		path string
		v    int64
	}{{"/start", c.Start}, {"/end", c.End}, {"/step", c.Step}} {
		if f.v > Bound || f.v < -Bound {
			out = append(out, core.Issue{Path: f.path, Message: "must be within ±9007199254740991"})
		}
	}
	if c.Step == 0 {
		out = append(out, core.Issue{Path: "/step", Message: "must not be 0"})
	}
	return out
}

// Count returns len(range(start, end, step)) = max(0, ceil((end − start) / step)) for step ≠ 0.
func Count(c Config) int64 {
	switch {
	case c.Step > 0 && c.End > c.Start:
		return (c.End - c.Start + c.Step - 1) / c.Step
	case c.Step < 0 && c.End < c.Start:
		return (c.Start - c.End - c.Step - 1) / -c.Step
	default:
		return 0
	}
}

// Estimate is the exact count.
func (*Template) Estimate(cfg json.RawMessage, _ core.Env) (core.Estimate, error) {
	c, err := parse(cfg)
	if err != nil {
		return core.Estimate{}, err
	}
	return core.Estimate{ExpectedTotal: core.Total(Count(c)), Exact: true}, nil
}

// Resolve records the effective config with empty provenance.
func (*Template) Resolve(_ context.Context, _ core.Env, cfg json.RawMessage) (core.Resolution, error) {
	c, err := parse(cfg)
	if err != nil {
		return core.Resolution{}, err
	}
	resolved, err := core.EncodeItem(c)
	if err != nil {
		return core.Resolution{}, core.Platformf(false, err, "encode the resolved scan config: %v", err)
	}
	return core.Resolution{ScanConfig: resolved, Provenance: map[string]any{}, ExpectedTotal: core.Total(Count(c))}, nil
}

// Stream yields start, start + step, … while < end (step > 0) or > end (step < 0).
func (*Template) Stream(ctx context.Context, _ core.Env, res core.Resolution) iter.Seq2[json.RawMessage, error] {
	return func(yield func(json.RawMessage, error) bool) {
		c, err := parse(res.ScanConfig)
		if err != nil {
			yield(nil, err)
			return
		}
		// |start| and |step| are below 2^53, so start + i·step never overflows int64.
		v := c.Start
		for range Count(c) {
			if err := ctx.Err(); err != nil {
				yield(nil, err)
				return
			}
			item, err := core.EncodeItem(AnalysisConfig{Value: v})
			if !yield(item, err) || err != nil {
				return
			}
			v += c.Step
		}
	}
}

func parse(raw json.RawMessage) (Config, error) {
	var c Config
	if err := core.DecodeConfig(raw, &c); err != nil {
		return Config{}, err
	}
	if is := issues(c); len(is) > 0 {
		return Config{}, core.IssuesError(is)
	}
	return c, nil
}
