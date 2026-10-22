// Package ranges is the typed proxy of the template range: one analysis per integer of start,
// start+step, … up to but excluding end (Python range semantics). Its import path ends in
// templates/range; the package is named ranges because range is a Go keyword.
package ranges

import (
	"iter"

	scantor "github.com/lonetis/scantor/connectors/go"
	"github.com/lonetis/scantor/connectors/go/internal/proxy"
)

// ScanConfig is the range. End has no omitempty because 0 is a valid end; a zero Step means the
// default 1 (0 itself is rejected).
type ScanConfig struct {
	// Start is the first value (inclusive).
	Start int64 `json:"start" jsonschema:"minimum=-9007199254740991,maximum=9007199254740991,default=0,description=First value (inclusive)."`
	// End is the bound (exclusive).
	End int64 `json:"end" jsonschema:"minimum=-9007199254740991,maximum=9007199254740991,default=10,description=Bound (exclusive)."`
	// Step is the increment; negative counts down.
	Step int64 `json:"step,omitempty" jsonschema:"minimum=-9007199254740991,maximum=9007199254740991,default=1,description=Increment; negative counts down; 0 is rejected."`
}

// AnalysisConfig is one integer.
type AnalysisConfig struct {
	// Value is the integer.
	Value int64 `json:"value" jsonschema:"required,minimum=-9007199254740991,maximum=9007199254740991,description=The integer."`
}

// Schedule yields one analysis config per integer. Pass it unwrapped
// (scantor.Serve(ranges.Schedule, run)) or iterate it inside a custom schedule; the task config
// argument is ignored.
func Schedule[TC any](ctx scantor.Context, scanConfig ScanConfig, _ TC) iter.Seq2[AnalysisConfig, error] {
	return proxy.Schedule[AnalysisConfig](ctx, "range", scanConfig)
}
