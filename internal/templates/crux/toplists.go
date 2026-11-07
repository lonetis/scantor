package crux

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/lonetis/scantor/internal/templates/core"
	"github.com/lonetis/scantor/internal/templates/fetch"
)

// The source crux-top-lists (zakird/crux-top-lists): `{base}/data/global/<YYYYMM>.csv.gz` or
// `{base}/data/country/<cc>/<YYYYMM>.csv.gz`, one gzip CSV per list and month.

// LatestMonths is how many months `latest` probes on crux-top-lists, newest first (CrUX publishes a
// month on the second Tuesday of the following month).
const LatestMonths = 4

// topListsProvenance is the provenance of a crux-top-lists resolution. It has no `source` field: it is
// the provenance of resolutions stored before crux-cache existed.
type topListsProvenance struct {
	Country   string `json:"country"`
	Month     string `json:"month"`
	SourceURL string `json:"sourceUrl"`
	SHA256    string `json:"sha256"`
	FetchedAt string `json:"fetchedAt"`
}

func resolveTopLists(ctx context.Context, env core.Env, c Config) (core.Resolution, error) {
	base, err := env.DataSource(core.DataSourceCrux)
	if err != nil {
		return core.Resolution{}, err
	}
	if c.Month == "latest" {
		if c.Month, err = latestTopListsMonth(ctx, env, base, c.Country); err != nil {
			return core.Resolution{}, err
		}
	}
	sourceURL := topListsURL(base, c.Country, c.Month)
	file, err := downloadTopList(ctx, env, sourceURL, c)
	if err != nil {
		return core.Resolution{}, err
	}
	s := rowReader{bucket: c.Bucket}
	if err := s.readFile(file, "", true, nil); err != nil {
		return core.Resolution{}, err
	}
	prov, err := core.ProvenanceMap(topListsProvenance{
		Country: c.Country, Month: c.Month, SourceURL: sourceURL, SHA256: file.SHA256, FetchedAt: core.FormatTime(file.FetchedAt),
	})
	if err != nil {
		return core.Resolution{}, core.Platformf(false, err, "encode the provenance: %v", err)
	}
	return resolution(c, prov, s.count)
}

func streamTopLists(ctx context.Context, env core.Env, c Config, provenance map[string]any, yield func(json.RawMessage, error) bool) {
	var prov topListsProvenance
	if err := core.DecodeProvenance(provenance, &prov); err != nil {
		yield(nil, err)
		return
	}
	base, err := env.DataSource(core.DataSourceCrux)
	if err != nil {
		yield(nil, err)
		return
	}
	file, err := downloadTopList(ctx, env, topListsURL(base, c.Country, c.Month), c)
	if err != nil {
		yield(nil, err)
		return
	}
	if file.SHA256 != prov.SHA256 {
		yield(nil, core.Validationf("crux content changed since resolution (%s %s)", c.Country, c.Month))
		return
	}
	s := rowReader{bucket: c.Bucket}
	if err := s.readFile(file, "", true, emit(ctx, yield)); err != nil {
		yield(nil, err)
	}
}

// resolution is the resolution of a config with a concrete month.
func resolution(c Config, prov map[string]any, total int64) (core.Resolution, error) {
	resolved, err := core.EncodeItem(c)
	if err != nil {
		return core.Resolution{}, core.Platformf(false, err, "encode the resolved scan config: %v", err)
	}
	return core.Resolution{ScanConfig: resolved, Provenance: prov, ExpectedTotal: core.Total(total)}, nil
}

func topListsURL(base, country, month string) string {
	if country == Global {
		return fmt.Sprintf("%s/data/global/%s.csv.gz", base, month)
	}
	return fmt.Sprintf("%s/data/country/%s/%s.csv.gz", base, country, month)
}

// latestTopListsMonth probes the current UTC month and the three before it, newest first.
func latestTopListsMonth(ctx context.Context, env core.Env, base, country string) (string, error) {
	now := env.Clock().UTC()
	for i := range LatestMonths {
		month := time.Date(now.Year(), now.Month()-time.Month(i), 1, 0, 0, 0, 0, time.UTC).Format("200601")
		url := topListsURL(base, country, month)
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

func downloadTopList(ctx context.Context, env core.Env, url string, c Config) (*fetch.File, error) {
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
