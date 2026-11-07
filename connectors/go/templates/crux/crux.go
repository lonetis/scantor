// Package crux is the typed proxy of the template crux: origins of a Chrome UX Report list up to a rank
// bucket, globally or for one country, from zakird/crux-top-lists (the default, up to rank 1M) or
// lonetis/crux-cache (every origin CrUX tracks). "latest" is resolved to a concrete month before the
// first analysis is published.
package crux

import (
	"iter"

	scantor "github.com/lonetis/scantor/connectors/go"
	"github.com/lonetis/scantor/connectors/go/internal/proxy"
)

// Sources of ScanConfig.Source.
const (
	SourceTopLists = "crux-top-lists"
	SourceCache    = "crux-cache"
)

// ScanConfig selects the list. Zero values mean the defaults.
type ScanConfig struct {
	// Source is where the list comes from: SourceTopLists (zakird/crux-top-lists: rank buckets up to
	// 1000000, country lists from 202501) or SourceCache (lonetis/crux-cache: every origin and bucket,
	// the countries it publishes).
	Source string `json:"source,omitempty" jsonschema:"enum=crux-top-lists,enum=crux-cache,default=crux-top-lists,description=Where the list comes from: crux-top-lists (zakird/crux-top-lists: rank buckets up to 1000000\\, country lists from 202501) or crux-cache (lonetis/crux-cache: every origin and bucket\\, the countries it publishes)."`
	// Country is "global" or a lowercase ISO 3166-1 alpha-2 country code (crux-top-lists has country
	// lists from 202501, crux-cache only the countries it publishes).
	Country string `json:"country,omitempty" jsonschema:"pattern=^(global|[a-z]{2})$,default=global,description=global or a lowercase ISO 3166-1 alpha-2 country code (crux-top-lists has country lists from 202501\\, crux-cache only the countries it publishes)."`
	// Month is "latest" or a month YYYYMM.
	Month string `json:"month,omitempty" jsonschema:"pattern=^(latest|[0-9]{4}(0[1-9]|1[0-2]))$,default=latest,description=latest or a month YYYYMM."`
	// Bucket includes origins with rank bucket ≤ this value (the cap of the scan); buckets above
	// 1000000 need SourceCache.
	Bucket int `json:"bucket,omitempty" jsonschema:"enum=1000,enum=5000,enum=10000,enum=50000,enum=100000,enum=500000,enum=1000000,enum=5000000,enum=10000000,enum=50000000,default=1000,description=Include origins with rank bucket ≤ this value (the cap of the scan); buckets above 1000000 need source crux-cache."`
}

// AnalysisConfig is one origin.
type AnalysisConfig struct {
	// Origin is the origin as listed (scheme + host, no trailing slash; http and https occur).
	Origin string `json:"origin" jsonschema:"required,minLength=1,maxLength=2048,description=Origin as listed (scheme + host\\, no trailing slash; http and https occur)."`
	// Rank is the CrUX rank bucket of the origin.
	Rank int `json:"rank" jsonschema:"required,enum=1000,enum=5000,enum=10000,enum=50000,enum=100000,enum=500000,enum=1000000,enum=5000000,enum=10000000,enum=50000000,description=CrUX rank bucket of the origin."`
}

// Schedule yields the origins of the list in file order. Pass it unwrapped
// (scantor.Serve(crux.Schedule, run)) or iterate it inside a custom schedule; the task config argument
// is ignored.
func Schedule[TC any](ctx scantor.Context, scanConfig ScanConfig, _ TC) iter.Seq2[AnalysisConfig, error] {
	return proxy.Schedule[AnalysisConfig](ctx, "crux", scanConfig)
}
