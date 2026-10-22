// Package single implements the template single (docs/templates.md §9.1): exactly one analysis with an
// empty analysis config. It is the schedule of a task that defines none.
package single

import (
	"context"
	"encoding/json"
	"iter"

	"github.com/lonetis/scantor/internal/templates/core"
)

// Name is the template name.
const Name = "single"

// Template is the single template.
type Template struct{}

// New returns the single template.
func New() *Template { return &Template{} }

// config is the (empty) scan config; decoding rejects every key.
type config struct{}

// Name returns "single".
func (*Template) Name() string { return Name }

// Validate has nothing to check beyond the schema.
func (*Template) Validate(json.RawMessage) []core.Issue { return nil }

// Estimate is always exactly 1.
func (*Template) Estimate(cfg json.RawMessage, _ core.Env) (core.Estimate, error) {
	if err := core.DecodeConfig(cfg, &config{}); err != nil {
		return core.Estimate{}, err
	}
	return core.Estimate{ExpectedTotal: core.Total(1), Exact: true}, nil
}

// Resolve records the empty config with empty provenance and one expected analysis.
func (*Template) Resolve(_ context.Context, _ core.Env, cfg json.RawMessage) (core.Resolution, error) {
	if err := core.DecodeConfig(cfg, &config{}); err != nil {
		return core.Resolution{}, err
	}
	return core.Resolution{ScanConfig: json.RawMessage(`{}`), Provenance: map[string]any{}, ExpectedTotal: core.Total(1)}, nil
}

// Stream yields exactly one {}.
func (*Template) Stream(ctx context.Context, _ core.Env, res core.Resolution) iter.Seq2[json.RawMessage, error] {
	return func(yield func(json.RawMessage, error) bool) {
		if err := core.DecodeConfig(res.ScanConfig, &config{}); err != nil {
			yield(nil, err)
			return
		}
		if err := ctx.Err(); err != nil {
			yield(nil, err)
			return
		}
		yield(json.RawMessage(`{}`), nil)
	}
}
