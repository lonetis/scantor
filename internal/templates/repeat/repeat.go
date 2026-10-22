// Package repeat implements the template repeat (docs/templates.md §9.4): `times` analyses whose
// config is only the 0-based iteration number.
package repeat

import (
	"context"
	"encoding/json"
	"iter"

	"github.com/lonetis/scantor/internal/templates/core"
)

// Name is the template name.
const Name = "repeat"

// Template is the repeat template.
type Template struct{}

// New returns the repeat template.
func New() *Template { return &Template{} }

// Config is the scan config.
type Config struct {
	Times int64 `json:"times"`
}

// AnalysisConfig is one item of the stream.
type AnalysisConfig struct {
	Iteration int64 `json:"iteration"`
}

// Name returns "repeat".
func (*Template) Name() string { return Name }

// Validate has nothing to check beyond the schema (times ≥ 1).
func (*Template) Validate(json.RawMessage) []core.Issue { return nil }

// Estimate is exactly `times`.
func (*Template) Estimate(cfg json.RawMessage, _ core.Env) (core.Estimate, error) {
	c, err := parse(cfg)
	if err != nil {
		return core.Estimate{}, err
	}
	return core.Estimate{ExpectedTotal: core.Total(c.Times), Exact: true}, nil
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
	return core.Resolution{ScanConfig: resolved, Provenance: map[string]any{}, ExpectedTotal: core.Total(c.Times)}, nil
}

// Stream yields iteration 0 … times − 1.
func (*Template) Stream(ctx context.Context, _ core.Env, res core.Resolution) iter.Seq2[json.RawMessage, error] {
	return func(yield func(json.RawMessage, error) bool) {
		c, err := parse(res.ScanConfig)
		if err != nil {
			yield(nil, err)
			return
		}
		for i := range c.Times {
			if err := ctx.Err(); err != nil {
				yield(nil, err)
				return
			}
			item, err := core.EncodeItem(AnalysisConfig{Iteration: i})
			if !yield(item, err) || err != nil {
				return
			}
		}
	}
}

func parse(raw json.RawMessage) (Config, error) {
	var c Config
	if err := core.DecodeConfig(raw, &c); err != nil {
		return Config{}, err
	}
	if c.Times < 1 {
		return Config{}, core.ValidationAt("/times", "times must be ≥ 1")
	}
	return c, nil
}
