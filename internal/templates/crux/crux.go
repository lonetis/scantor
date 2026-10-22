// Package crux implements the template crux (docs/templates.md §9.6): the origins of a Chrome UX
// Report top list from zakird/crux-top-lists up to a rank bucket, globally or for one country.
// Resolve turns `latest` into a concrete month by probing the current UTC month and the three before
// it; the stream reads `{base}/data/global/<YYYYMM>.csv.gz` or `{base}/data/country/<cc>/<YYYYMM>.csv.gz`.
package crux

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"iter"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/lonetis/scantor/internal/templates/core"
	"github.com/lonetis/scantor/internal/templates/fetch"
)

// Name is the template name.
const Name = "crux"

// Global is the country value of the global list.
const Global = "global"

// LatestMonths is how many months `latest` probes, newest first (CrUX publishes a month on the second
// Tuesday of the following month).
const LatestMonths = 4

// Buckets are the CrUX rank buckets of lists up to one million origins.
var Buckets = []int64{1000, 5000, 10000, 50000, 100000, 500000, 1000000}

var (
	countryPattern = regexp.MustCompile(`^(global|[a-z]{2})$`)
	monthPattern   = regexp.MustCompile(`^[0-9]{4}(0[1-9]|1[0-2])$`)
)

// Template is the crux template.
type Template struct{}

// New returns the crux template.
func New() *Template { return &Template{} }

// Config is the scan config.
type Config struct {
	Country string `json:"country"`
	Month   string `json:"month"`
	Bucket  int64  `json:"bucket"`
}

// AnalysisConfig is one item of the stream.
type AnalysisConfig struct {
	Origin string `json:"origin"`
	Rank   int64  `json:"rank"`
}

type provenance struct {
	Country   string `json:"country"`
	Month     string `json:"month"`
	SourceURL string `json:"sourceUrl"`
	SHA256    string `json:"sha256"`
	FetchedAt string `json:"fetchedAt"`
}

// Name returns "crux".
func (*Template) Name() string { return Name }

// Validate has nothing to check beyond the schema; unpublished months are found by Resolve.
func (*Template) Validate(json.RawMessage) []core.Issue { return nil }

// Estimate is `bucket`, an upper bound: country lists may be shorter.
func (*Template) Estimate(cfg json.RawMessage, _ core.Env) (core.Estimate, error) {
	c, err := parse(cfg)
	if err != nil {
		return core.Estimate{}, err
	}
	return core.Estimate{ExpectedTotal: core.Total(c.Bucket), Exact: false}, nil
}

// Resolve pins the month, downloads the list and counts the origins within the bucket.
func (*Template) Resolve(ctx context.Context, env core.Env, cfg json.RawMessage) (core.Resolution, error) {
	c, err := parse(cfg)
	if err != nil {
		return core.Resolution{}, err
	}
	base, err := env.DataSource(core.DataSourceCrux)
	if err != nil {
		return core.Resolution{}, err
	}
	if c.Month == "latest" {
		if c.Month, err = latestMonth(ctx, env, base, c.Country); err != nil {
			return core.Resolution{}, err
		}
	}
	sourceURL := listURL(base, c.Country, c.Month)
	file, err := download(ctx, env, sourceURL, c)
	if err != nil {
		return core.Resolution{}, err
	}
	total, err := scan(file, c.Bucket, nil)
	if err != nil {
		return core.Resolution{}, err
	}
	resolved, err := core.EncodeItem(c)
	if err != nil {
		return core.Resolution{}, core.Platformf(false, err, "encode the resolved scan config: %v", err)
	}
	prov, err := core.ProvenanceMap(provenance{
		Country: c.Country, Month: c.Month, SourceURL: sourceURL, SHA256: file.SHA256, FetchedAt: core.FormatTime(file.FetchedAt),
	})
	if err != nil {
		return core.Resolution{}, core.Platformf(false, err, "encode the provenance: %v", err)
	}
	return core.Resolution{ScanConfig: resolved, Provenance: prov, ExpectedTotal: core.Total(total)}, nil
}

// Stream yields the rows in file order until the first rank greater than `bucket`.
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
		var prov provenance
		if err := core.DecodeProvenance(res.Provenance, &prov); err != nil {
			yield(nil, err)
			return
		}
		base, err := env.DataSource(core.DataSourceCrux)
		if err != nil {
			yield(nil, err)
			return
		}
		file, err := download(ctx, env, listURL(base, c.Country, c.Month), c)
		if err != nil {
			yield(nil, err)
			return
		}
		if file.SHA256 != prov.SHA256 {
			yield(nil, core.Validationf("crux content changed since resolution (%s %s)", c.Country, c.Month))
			return
		}
		stopped := false
		_, err = scan(file, c.Bucket, func(origin string, rank int64) bool {
			if err := ctx.Err(); err != nil {
				yield(nil, err)
				stopped = true
				return false
			}
			item, err := core.EncodeItem(AnalysisConfig{Origin: origin, Rank: rank})
			if !yield(item, err) || err != nil {
				stopped = true
				return false
			}
			return true
		})
		if err != nil && !stopped {
			yield(nil, err)
		}
	}
}

func parse(raw json.RawMessage) (Config, error) {
	var c Config
	if err := core.DecodeConfig(raw, &c); err != nil {
		return Config{}, err
	}
	switch {
	case !countryPattern.MatchString(c.Country):
		return Config{}, core.ValidationAt("/country", "country must be global or a lowercase ISO 3166-1 alpha-2 code")
	case c.Month != "latest" && !monthPattern.MatchString(c.Month):
		return Config{}, core.ValidationAt("/month", "month must be latest or YYYYMM")
	case !slices.Contains(Buckets, c.Bucket):
		return Config{}, core.ValidationAt("/bucket", "bucket must be one of %v", Buckets)
	}
	return c, nil
}

func listURL(base, country, month string) string {
	if country == Global {
		return fmt.Sprintf("%s/data/global/%s.csv.gz", base, month)
	}
	return fmt.Sprintf("%s/data/country/%s/%s.csv.gz", base, country, month)
}

// latestMonth probes the current UTC month and the three before it, newest first.
func latestMonth(ctx context.Context, env core.Env, base, country string) (string, error) {
	now := env.Clock().UTC()
	for i := range LatestMonths {
		month := time.Date(now.Year(), now.Month()-time.Month(i), 1, 0, 0, 0, 0, time.UTC).Format("200601")
		url := listURL(base, country, month)
		resp, err := fetch.Head(ctx, env, fetch.Request{URL: url})
		if err != nil {
			return "", err
		}
		switch resp.StatusCode {
		case http.StatusOK:
			return month, nil
		case http.StatusNotFound:
			continue
		default:
			return "", core.Platformf(true, nil, "HEAD %s: %s", url, resp.Status)
		}
	}
	return "", core.ValidationAt("/month", "no CrUX list for %s in the last %d months", country, LatestMonths)
}

func download(ctx context.Context, env core.Env, url string, c Config) (*fetch.File, error) {
	file, err := fetch.Download(ctx, env, fetch.Request{URL: url, Gunzip: true})
	var serr *fetch.StatusError
	if errors.As(err, &serr) {
		if serr.StatusCode == http.StatusNotFound {
			return nil, core.ValidationAt("/month", "CrUX list %s %s not found", c.Country, c.Month)
		}
		return nil, core.Platformf(true, err, "%s", serr.Error())
	}
	return file, err
}

func scan(file *fetch.File, bucket int64, fn func(origin string, rank int64) bool) (int64, error) {
	f, err := file.Open()
	if err != nil {
		return 0, err
	}
	defer func() { _ = f.Close() }()
	return scanRows(f, bucket, fn)
}

// scanRows reads a decoded CrUX CSV (header origin,rank, LF), checking that ranks are valid buckets
// in non-decreasing order, and calls fn (may be nil; returns false to stop) for every row up to the
// first rank above bucket. It returns the number of rows within the bucket.
func scanRows(r io.Reader, bucket int64, fn func(origin string, rank int64) bool) (int64, error) {
	var count, prev int64
	header := false
	for line, err := range core.Lines(r, core.MaxLineBytes) {
		if err != nil {
			if errors.Is(err, core.ErrLineTooLong) {
				return count, formatError(line.Number)
			}
			return count, core.Platformf(true, err, "read CrUX CSV: %v", err)
		}
		if !header {
			if string(line.Text) != "origin,rank" {
				return count, core.Platformf(true, nil, "unexpected CrUX CSV header %q", truncate(string(line.Text), 64))
			}
			header = true
			continue
		}
		if len(line.Text) == 0 {
			continue
		}
		i := bytes.LastIndexByte(line.Text, ',')
		if i <= 0 {
			return count, formatError(line.Number)
		}
		origin := line.Text[:i]
		rank, perr := strconv.ParseInt(string(line.Text[i+1:]), 10, 64)
		if perr != nil || !slices.Contains(Buckets, rank) || rank < prev || !utf8.Valid(origin) || utf8.RuneCount(origin) > 2048 {
			return count, formatError(line.Number)
		}
		prev = rank
		if rank > bucket {
			break
		}
		count++
		if fn != nil && !fn(string(origin), rank) {
			return count, nil
		}
	}
	if !header {
		return count, core.Platformf(true, nil, "unexpected CrUX CSV: the file is empty")
	}
	return count, nil
}

func formatError(line int64) error {
	return core.Platformf(true, nil, "unexpected CrUX CSV at line %d", line)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
