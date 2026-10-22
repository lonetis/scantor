// Package single is the typed proxy of the template single: exactly one analysis with an empty
// analysis config. It is the schedule of tasks that define none (scantor.ServeRun).
package single

import (
	"iter"

	scantor "github.com/lonetis/scantor/connectors/go"
	"github.com/lonetis/scantor/connectors/go/internal/proxy"
)

// ScanConfig has no parameters.
type ScanConfig = scantor.Empty

// AnalysisConfig has no parameters.
type AnalysisConfig = scantor.Empty

// Schedule yields one empty analysis config. Pass it unwrapped (scantor.Serve(single.Schedule, run))
// or iterate it inside a custom schedule; the task config argument is ignored.
func Schedule[TC any](ctx scantor.Context, scanConfig ScanConfig, _ TC) iter.Seq2[AnalysisConfig, error] {
	return proxy.Schedule[AnalysisConfig](ctx, "single", scanConfig)
}
