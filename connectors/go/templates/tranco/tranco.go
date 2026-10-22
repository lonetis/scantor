// Package tranco is the typed proxy of the template tranco: domains of a Tranco research top list
// (https://tranco-list.eu) with their exact rank. "latest" and dates are resolved to a concrete,
// immutable list id before the first analysis is published.
package tranco

import (
	"iter"

	scantor "github.com/lonetis/scantor/connectors/go"
	"github.com/lonetis/scantor/connectors/go/internal/proxy"
)

// ScanConfig selects the list and the window. Zero values mean the defaults.
type ScanConfig struct {
	// List is "latest", a date YYYY-MM-DD (the daily list of that date) or a Tranco list id.
	List string `json:"list,omitempty" jsonschema:"pattern=^(latest|[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9A-Z]{4\\,6})$,default=latest,description=latest\\, a date YYYY-MM-DD (the daily list of that date) or a Tranco list id."`
	// Subdomains selects the daily list that includes subdomains (only for latest and dates).
	Subdomains bool `json:"subdomains,omitempty" jsonschema:"default=false,description=Use the daily list that includes subdomains (only for latest and dates)."`
	// Offset skips this many top entries (Offset + Limit ≤ 1000000).
	Offset int `json:"offset,omitempty" jsonschema:"minimum=0,maximum=999999,default=0,description=Skip this many top entries (offset + limit ≤ 1000000)."`
	// Limit is the number of domains.
	Limit int `json:"limit,omitempty" jsonschema:"minimum=1,maximum=1000000,default=1000,description=Number of domains."`
}

// AnalysisConfig is one list entry.
type AnalysisConfig struct {
	// Domain is the registrable domain as listed (no scheme, no www.).
	Domain string `json:"domain" jsonschema:"required,minLength=1,maxLength=253,description=Registrable domain as listed (no scheme\\, no www.)."`
	// Rank is the 1-based Tranco rank.
	Rank int `json:"rank" jsonschema:"required,minimum=1,maximum=1000000,description=1-based Tranco rank."`
}

// Schedule yields the domains of the list in rank order. Pass it unwrapped
// (scantor.Serve(tranco.Schedule, run)) or iterate it inside a custom schedule; the task config
// argument is ignored.
func Schedule[TC any](ctx scantor.Context, scanConfig ScanConfig, _ TC) iter.Seq2[AnalysisConfig, error] {
	return proxy.Schedule[AnalysisConfig](ctx, "tranco", scanConfig)
}
