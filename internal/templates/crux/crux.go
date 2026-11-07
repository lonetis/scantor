// Package crux implements the template crux (docs/templates.md §9.6): the origins of a Chrome UX
// Report list up to a rank bucket, globally or for one country, from one of two sources:
//
//   - crux-top-lists (the default): zakird/crux-top-lists, one gzip file per list and month with the
//     origins up to rank 1M. Resolve turns `latest` into a concrete month by probing the current UTC
//     month and the three before it (toplists.go).
//   - crux-cache: lonetis/crux-cache, every origin of CrUX (about 18M globally) as monthly datasets of
//     CSV chunks described by a manifest. Resolve reads `latest` from the manifest and records the hash
//     of every chunk it read (cache.go).
//
// Both sources are CSVs of `origin,rank` rows ordered by rank bucket (csv.go).
package crux

import (
	"context"
	"encoding/json"
	"iter"
	"regexp"
	"slices"

	"github.com/lonetis/scantor/internal/templates/core"
)

// Name is the template name.
const Name = "crux"

// Global is the country value of the global list.
const Global = "global"

// Sources of the scan config field `source`.
const (
	SourceTopLists = "crux-top-lists"
	SourceCache    = "crux-cache"
)

// Buckets are the CrUX rank buckets. crux-top-lists stops at TopListsMaxBucket; crux-cache has every
// bucket, 50M being every origin CrUX tracks.
var Buckets = []int64{1000, 5000, 10000, 50000, 100000, 500000, 1000000, 5000000, 10000000, 50000000}

// TopListsMaxBucket is the deepest bucket of crux-top-lists.
const TopListsMaxBucket = 1000000

// CacheEstimateCap bounds the crux-cache estimate. CrUX tracks about 18 million origins (2026), so the
// bucket 50M ("every origin") would otherwise estimate 50 million analyses and be refused against the
// default SCANTOR_MAX_ANALYSES_PER_SCAN; Resolve counts exactly and the scheduler enforces the maximum
// while streaming.
const CacheEstimateCap = 20_000_000

var (
	countryPattern = regexp.MustCompile(`^(global|[a-z]{2})$`)
	monthPattern   = regexp.MustCompile(`^[0-9]{4}(0[1-9]|1[0-2])$`)
)

// Template is the crux template.
type Template struct{}

// New returns the crux template.
func New() *Template { return &Template{} }

// Config is the scan config. An empty Source (a resolution stored before the field existed) is
// crux-top-lists.
type Config struct {
	Source  string `json:"source"`
	Country string `json:"country"`
	Month   string `json:"month"`
	Bucket  int64  `json:"bucket"`
}

// AnalysisConfig is one item of the stream.
type AnalysisConfig struct {
	Origin string `json:"origin"`
	Rank   int64  `json:"rank"`
}

// Name returns "crux".
func (*Template) Name() string { return Name }

// Validate rejects buckets the source does not have; unpublished months are found by Resolve.
func (*Template) Validate(cfg json.RawMessage) []core.Issue {
	var c Config
	if err := core.DecodeConfig(cfg, &c); err != nil {
		return []core.Issue{{Message: err.Error()}}
	}
	if issue, ok := bucketIssue(c); ok {
		return []core.Issue{issue}
	}
	return nil
}

func bucketIssue(c Config) (core.Issue, bool) {
	if source(c) == SourceTopLists && c.Bucket > TopListsMaxBucket {
		return core.Issue{Path: "/bucket", Message: "buckets above 1000000 need source crux-cache (crux-top-lists stops at 1000000)"}, true
	}
	return core.Issue{}, false
}

// Estimate is `bucket`, an upper bound: lists may be shorter. For crux-cache it is capped at
// CacheEstimateCap.
func (*Template) Estimate(cfg json.RawMessage, _ core.Env) (core.Estimate, error) {
	c, err := parse(cfg)
	if err != nil {
		return core.Estimate{}, err
	}
	total := c.Bucket
	if c.Source == SourceCache {
		total = min(total, CacheEstimateCap)
	}
	return core.Estimate{ExpectedTotal: core.Total(total), Exact: false}, nil
}

// Resolve pins the month, downloads the list and counts the origins within the bucket.
func (*Template) Resolve(ctx context.Context, env core.Env, cfg json.RawMessage) (core.Resolution, error) {
	c, err := parse(cfg)
	if err != nil {
		return core.Resolution{}, err
	}
	if c.Source == SourceCache {
		return resolveCache(ctx, env, c)
	}
	return resolveTopLists(ctx, env, c)
}

// Stream yields the rows in list order until the first rank greater than `bucket`.
func (*Template) Stream(ctx context.Context, env core.Env, res core.Resolution) iter.Seq2[json.RawMessage, error] {
	return func(yield func(json.RawMessage, error) bool) {
		c, err := parse(res.ScanConfig)
		if err != nil {
			yield(nil, err)
			return
		}
		if !monthPattern.MatchString(c.Month) {
			yield(nil, core.Validationf("the resolution has no concrete CrUX month (month %q)", c.Month))
			return
		}
		if c.Source == SourceCache {
			streamCache(ctx, env, c, res.Provenance, yield)
			return
		}
		streamTopLists(ctx, env, c, res.Provenance, yield)
	}
}

func parse(raw json.RawMessage) (Config, error) {
	var c Config
	if err := core.DecodeConfig(raw, &c); err != nil {
		return Config{}, err
	}
	c.Source = source(c)
	switch {
	case c.Source != SourceTopLists && c.Source != SourceCache:
		return Config{}, core.ValidationAt("/source", "source must be %s or %s", SourceTopLists, SourceCache)
	case !countryPattern.MatchString(c.Country):
		return Config{}, core.ValidationAt("/country", "country must be global or a lowercase ISO 3166-1 alpha-2 code")
	case c.Month != "latest" && !monthPattern.MatchString(c.Month):
		return Config{}, core.ValidationAt("/month", "month must be latest or YYYYMM")
	case !slices.Contains(Buckets, c.Bucket):
		return Config{}, core.ValidationAt("/bucket", "bucket must be one of %v", Buckets)
	}
	if issue, ok := bucketIssue(c); ok {
		return Config{}, core.ValidationAt(issue.Path, "%s", issue.Message)
	}
	return c, nil
}

func source(c Config) string {
	if c.Source == "" {
		return SourceTopLists
	}
	return c.Source
}

// emit streams the rows of a scan as analysis configs; it reports false when the consumer stopped or
// the context ended (after yielding the context's error).
func emit(ctx context.Context, yield func(json.RawMessage, error) bool) func(origin string, rank int64) bool {
	return func(origin string, rank int64) bool {
		if err := ctx.Err(); err != nil {
			yield(nil, err)
			return false
		}
		item, err := core.EncodeItem(AnalysisConfig{Origin: origin, Rank: rank})
		if !yield(item, err) || err != nil {
			return false
		}
		return true
	}
}
