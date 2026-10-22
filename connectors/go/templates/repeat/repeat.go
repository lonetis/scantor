// Package repeat is the typed proxy of the template repeat: times analyses whose config is only the
// 0-based iteration number.
package repeat

import (
	"iter"

	scantor "github.com/lonetis/scantor/connectors/go"
	"github.com/lonetis/scantor/connectors/go/internal/proxy"
)

// ScanConfig is the number of analyses.
type ScanConfig struct {
	// Times is the number of analyses (0 means the default 1).
	Times int64 `json:"times,omitempty" jsonschema:"minimum=1,maximum=9007199254740991,default=1,description=Number of analyses."`
}

// AnalysisConfig is one iteration.
type AnalysisConfig struct {
	// Iteration is the 0-based iteration.
	Iteration int64 `json:"iteration" jsonschema:"required,minimum=0,maximum=9007199254740991,description=0-based iteration."`
}

// Schedule yields times analysis configs. Pass it unwrapped (scantor.Serve(repeat.Schedule, run)) or
// iterate it inside a custom schedule; the task config argument is ignored.
func Schedule[TC any](ctx scantor.Context, scanConfig ScanConfig, _ TC) iter.Seq2[AnalysisConfig, error] {
	return proxy.Schedule[AnalysisConfig](ctx, "repeat", scanConfig)
}
