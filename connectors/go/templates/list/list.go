// Package list is the typed proxy of the template list: one analysis per item of an inline list
// and/or an uploaded newline-separated file, in order. Items are trimmed; empty items are skipped.
package list

import (
	"iter"

	scantor "github.com/lonetis/scantor/connectors/go"
	"github.com/lonetis/scantor/connectors/go/internal/proxy"
)

// ScanConfig selects the items.
type ScanConfig struct {
	// Items are inline items (trimmed; empty items skipped).
	Items []string `json:"items,omitempty" jsonschema:"maxItems=10000,minLength=1,maxLength=4096,default=[],description=Inline items (trimmed; empty items skipped)."`
	// Upload is the id of an uploaded list (POST /api/uploads, kind list); its non-empty lines follow
	// the inline items.
	Upload *string `json:"upload,omitempty" jsonschema:"format=uuid,default=null,description=Id of an uploaded list (POST /api/uploads\\, kind list); its non-empty lines follow the inline items." jsonschema_extras:"x-scantor=upload"`
	// Offset skips this many items of the combined sequence.
	Offset int64 `json:"offset,omitempty" jsonschema:"minimum=0,maximum=9007199254740991,default=0,description=Skip this many items of the combined sequence."`
	// Limit is the maximum number of analyses; nil means all.
	Limit *int64 `json:"limit,omitempty" jsonschema:"minimum=1,maximum=9007199254740991,default=null,description=At most this many analyses; null = all."`
}

// AnalysisConfig is one item.
type AnalysisConfig struct {
	// Item is the trimmed item.
	Item string `json:"item" jsonschema:"required,minLength=1,maxLength=4096,description=The trimmed item."`
	// Index is the 0-based position in the combined sequence (inline items, then upload lines),
	// before offset.
	Index int64 `json:"index" jsonschema:"required,minimum=0,maximum=9007199254740991,description=0-based position in the combined sequence (inline items\\, then upload lines)\\, before offset."`
}

// Schedule yields one analysis config per item. Pass it unwrapped (scantor.Serve(list.Schedule, run))
// or iterate it inside a custom schedule; the task config argument is ignored.
func Schedule[TC any](ctx scantor.Context, scanConfig ScanConfig, _ TC) iter.Seq2[AnalysisConfig, error] {
	return proxy.Schedule[AnalysisConfig](ctx, "list", scanConfig)
}
