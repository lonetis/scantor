package crux

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"

	"github.com/lonetis/scantor/internal/templates/core"
	"github.com/lonetis/scantor/internal/templates/fetch"
)

// The source crux-cache (lonetis/crux-cache): one dataset per list (`global` or a country) with a
// manifest `{base}/data/<dataset>/manifest.json` that lists the months and their CSV chunks
// `{base}/data/<dataset>/<filename>`. The chunks of a month are uncompressed, at most a few tens of
// MB each, sorted by rank bucket, and only the first has the header line, so a month is read chunk by
// chunk (a global month is about 700 MB) and never assembled into one file. Resolve records the hash of
// every chunk it read; Stream verifies each chunk before yielding its rows.

// cacheProvenance is the provenance of a crux-cache resolution.
type cacheProvenance struct {
	Source    string       `json:"source"`
	Country   string       `json:"country"`
	Month     string       `json:"month"`
	SourceURL string       `json:"sourceUrl"` // the dataset's manifest
	Chunks    []cacheChunk `json:"chunks"`    // the chunks read, in order
	FetchedAt string       `json:"fetchedAt"`
}

// cacheChunk is one chunk read at resolution.
type cacheChunk struct {
	Filename string `json:"filename"`
	SHA256   string `json:"sha256"` // hex SHA-256 of the decoded chunk
}

// manifest is the part of a dataset manifest the template reads (upstream field names).
type manifest struct {
	Summary struct {
		LatestMonth string `json:"latest_month"`
	} `json:"summary"`
	Months map[string]struct {
		Chunks []manifestChunk `json:"chunks"`
	} `json:"months"`
}

type manifestChunk struct {
	Chunk    int    `json:"chunk"` // 1-based position in the month
	Filename string `json:"filename"`
}

// chunkFilename bounds the chunk names of a manifest: they become URL path segments.
var chunkFilename = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

func resolveCache(ctx context.Context, env core.Env, c Config) (core.Resolution, error) {
	base, err := env.DataSource(core.DataSourceCruxCache)
	if err != nil {
		return core.Resolution{}, err
	}
	manifestURL := cacheURL(base, c.Country, "manifest.json")
	m, err := readManifest(ctx, env, manifestURL, c.Country)
	if err != nil {
		return core.Resolution{}, err
	}
	if c.Month == "latest" {
		c.Month = m.Summary.LatestMonth
		if !monthPattern.MatchString(c.Month) {
			return core.Resolution{}, core.ValidationAt("/month", "no CrUX list for %s in crux-cache", c.Country)
		}
	}
	chunks, err := monthChunks(m, c)
	if err != nil {
		return core.Resolution{}, err
	}
	s := rowReader{bucket: c.Bucket}
	prov := cacheProvenance{Source: SourceCache, Country: c.Country, Month: c.Month, SourceURL: manifestURL}
	for i, name := range chunks {
		file, err := downloadChunk(ctx, env, base, c, name, false)
		if err != nil {
			return core.Resolution{}, err
		}
		if i == 0 {
			prov.FetchedAt = core.FormatTime(file.FetchedAt)
		}
		prov.Chunks = append(prov.Chunks, cacheChunk{Filename: name, SHA256: file.SHA256})
		if err := s.readFile(file, name, i == 0, nil); err != nil {
			return core.Resolution{}, err
		}
		if s.done {
			break
		}
	}
	provMap, err := core.ProvenanceMap(prov)
	if err != nil {
		return core.Resolution{}, core.Platformf(false, err, "encode the provenance: %v", err)
	}
	return resolution(c, provMap, s.count)
}

func streamCache(ctx context.Context, env core.Env, c Config, provenance map[string]any, yield func(json.RawMessage, error) bool) {
	var prov cacheProvenance
	if err := core.DecodeProvenance(provenance, &prov); err != nil {
		yield(nil, err)
		return
	}
	if len(prov.Chunks) == 0 {
		yield(nil, core.Validationf("the resolution records no crux-cache chunks (%s %s)", c.Country, c.Month))
		return
	}
	base, err := env.DataSource(core.DataSourceCruxCache)
	if err != nil {
		yield(nil, err)
		return
	}
	s := rowReader{bucket: c.Bucket}
	fn := emit(ctx, yield)
	for i, chunk := range prov.Chunks {
		if !chunkFilename.MatchString(chunk.Filename) {
			yield(nil, core.Validationf("the resolution records an invalid crux-cache chunk name %q", truncate(chunk.Filename, 64)))
			return
		}
		file, err := downloadChunk(ctx, env, base, c, chunk.Filename, true)
		if err != nil {
			yield(nil, err)
			return
		}
		if file.SHA256 != chunk.SHA256 {
			yield(nil, core.Validationf("crux-cache content changed since resolution (%s %s, %s)", c.Country, c.Month, chunk.Filename))
			return
		}
		if err := s.readFile(file, chunk.Filename, i == 0, fn); err != nil {
			yield(nil, err)
			return
		}
		if s.done {
			return
		}
	}
}

func cacheURL(base, dataset, file string) string {
	return fmt.Sprintf("%s/data/%s/%s", base, dataset, file)
}

// readManifest downloads and parses a dataset manifest; a missing dataset is a validation error.
func readManifest(ctx context.Context, env core.Env, url, country string) (*manifest, error) {
	resp, err := fetch.Text(ctx, env, fetch.Request{URL: url})
	if err != nil {
		return nil, err
	}
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return nil, core.ValidationAt("/country", "no crux-cache dataset for %s", country)
	case resp.StatusCode < 200 || resp.StatusCode > 299:
		return nil, core.Platformf(true, nil, "GET %s: %s", url, resp.Status)
	}
	var m manifest
	if err := json.Unmarshal(resp.Body, &m); err != nil {
		return nil, core.Platformf(true, err, "unexpected crux-cache manifest %s: %v", url, err)
	}
	return &m, nil
}

// monthChunks returns the chunk names of a month in chunk order.
func monthChunks(m *manifest, c Config) ([]string, error) {
	month, ok := m.Months[c.Month]
	if !ok {
		return nil, core.ValidationAt("/month", "CrUX list %s %s not found", c.Country, c.Month)
	}
	chunks := slices.Clone(month.Chunks)
	slices.SortFunc(chunks, func(a, b manifestChunk) int { return a.Chunk - b.Chunk })
	if len(chunks) == 0 {
		return nil, core.Platformf(true, nil, "unexpected crux-cache manifest: month %s of %s has no chunks", c.Month, c.Country)
	}
	names := make([]string, len(chunks))
	for i, ch := range chunks {
		if ch.Chunk != i+1 || !chunkFilename.MatchString(ch.Filename) {
			return nil, core.Platformf(true, nil, "unexpected crux-cache manifest: month %s of %s has an invalid chunk list", c.Month, c.Country)
		}
		names[i] = ch.Filename
	}
	return names, nil
}

// downloadChunk downloads one chunk. At resolution the manifest has just listed the chunk, so a
// missing one is an upstream defect (retryable); when streaming a stored resolution it means the
// month changed since.
func downloadChunk(ctx context.Context, env core.Env, base string, c Config, name string, streaming bool) (*fetch.File, error) {
	file, err := fetch.Download(ctx, env, fetch.Request{URL: cacheURL(base, c.Country, name)})
	var serr *fetch.StatusError
	if errors.As(err, &serr) {
		if streaming && serr.StatusCode == http.StatusNotFound {
			return nil, core.Validationf("crux-cache content changed since resolution (%s %s, %s is gone)", c.Country, c.Month, name)
		}
		return nil, core.Platformf(true, err, "%s", serr.Error())
	}
	return file, err
}
