// Package tranco implements the template tranco (docs/templates.md §9.5): the domains of a Tranco
// research top list with their exact rank. Resolve turns `latest` and dates into a concrete,
// immutable list id; the stream reads `GET {base}/download/<id>/<offset + limit>`.
package tranco

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
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/lonetis/scantor/internal/templates/core"
	"github.com/lonetis/scantor/internal/templates/fetch"
)

// Name is the template name.
const Name = "tranco"

// MaxRank is the length of every Tranco list served by /download/<id>/<n>.
const MaxRank = 1_000_000

// APIInterval spaces requests to Tranco's /api/* endpoints (upstream rate limit of one per second).
const APIInterval = time.Second

var (
	idPattern   = regexp.MustCompile(`^[0-9A-Z]{4,6}$`)
	datePattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)
)

// Template is the tranco template. One instance spaces its /api/* requests process-wide.
type Template struct {
	api *fetch.Spacer
}

// New returns the tranco template with the upstream API spacing.
func New() *Template { return NewWithAPIInterval(APIInterval) }

// NewWithAPIInterval returns the tranco template with a different /api/* spacing (tests).
func NewWithAPIInterval(d time.Duration) *Template { return &Template{api: fetch.NewSpacer(d)} }

// Config is the scan config.
type Config struct {
	List       string `json:"list"`
	Subdomains bool   `json:"subdomains"`
	Offset     int64  `json:"offset"`
	Limit      int64  `json:"limit"`
}

// AnalysisConfig is one item of the stream.
type AnalysisConfig struct {
	Domain string `json:"domain"`
	Rank   int64  `json:"rank"`
}

type provenance struct {
	ListID    string `json:"listId"`
	Date      string `json:"date"`
	SourceURL string `json:"sourceUrl"`
	SHA256    string `json:"sha256"`
	FetchedAt string `json:"fetchedAt"`
}

// Name returns "tranco".
func (*Template) Name() string { return Name }

// Validate checks the window offset + limit ≤ 1 000 000 and that a date is a calendar date.
func (*Template) Validate(cfg json.RawMessage) []core.Issue {
	var c Config
	if err := core.DecodeConfig(cfg, &c); err != nil {
		return []core.Issue{{Message: err.Error()}}
	}
	return issues(c)
}

func issues(c Config) []core.Issue {
	var out []core.Issue
	if datePattern.MatchString(c.List) {
		if _, err := time.Parse(time.DateOnly, c.List); err != nil {
			out = append(out, core.Issue{Path: "/list", Message: fmt.Sprintf("%s is not a valid date", c.List)})
		}
	}
	switch {
	case c.Offset < 0 || c.Offset >= MaxRank:
		out = append(out, core.Issue{Path: "/offset", Message: "must be between 0 and 999999"})
	case c.Limit < 1 || c.Limit > MaxRank:
		out = append(out, core.Issue{Path: "/limit", Message: "must be between 1 and 1000000"})
	case c.Offset+c.Limit > MaxRank:
		out = append(out, core.Issue{Path: "/limit", Message: fmt.Sprintf("offset + limit must be ≤ %d (offset %d, limit %d)", MaxRank, c.Offset, c.Limit)})
	}
	return out
}

// Estimate is `limit`, exact: every Tranco list has 1 000 000 ranks.
func (*Template) Estimate(cfg json.RawMessage, _ core.Env) (core.Estimate, error) {
	c, err := parse(cfg)
	if err != nil {
		return core.Estimate{}, err
	}
	return core.Estimate{ExpectedTotal: core.Total(c.Limit), Exact: true}, nil
}

// Resolve pins the list id, downloads the top offset + limit domains and records their provenance.
func (t *Template) Resolve(ctx context.Context, env core.Env, cfg json.RawMessage) (core.Resolution, error) {
	c, err := parse(cfg)
	if err != nil {
		return core.Resolution{}, err
	}
	base, err := env.DataSource(core.DataSourceTranco)
	if err != nil {
		return core.Resolution{}, err
	}
	listID, date, err := t.resolveList(ctx, env, base, c)
	if err != nil {
		return core.Resolution{}, err
	}
	c.List = listID
	sourceURL := downloadURL(base, c)
	file, err := download(ctx, env, sourceURL)
	if err != nil {
		return core.Resolution{}, err
	}
	rows, err := scan(file, c.Offset+c.Limit, nil)
	if err != nil {
		return core.Resolution{}, err
	}
	resolved, err := core.EncodeItem(c)
	if err != nil {
		return core.Resolution{}, core.Platformf(false, err, "encode the resolved scan config: %v", err)
	}
	prov, err := core.ProvenanceMap(provenance{
		ListID: listID, Date: date, SourceURL: sourceURL, SHA256: file.SHA256, FetchedAt: core.FormatTime(file.FetchedAt),
	})
	if err != nil {
		return core.Resolution{}, core.Platformf(false, err, "encode the provenance: %v", err)
	}
	total := min(c.Limit, max(0, rows-c.Offset))
	return core.Resolution{ScanConfig: resolved, Provenance: prov, ExpectedTotal: core.Total(total)}, nil
}

// Stream yields ranks offset + 1 … offset + limit in rank order.
func (*Template) Stream(ctx context.Context, env core.Env, res core.Resolution) iter.Seq2[json.RawMessage, error] {
	return func(yield func(json.RawMessage, error) bool) {
		c, err := parse(res.ScanConfig)
		if err != nil {
			yield(nil, err)
			return
		}
		if !idPattern.MatchString(c.List) {
			yield(nil, core.Validationf("the resolution has no concrete Tranco list id (list %q)", c.List))
			return
		}
		var prov provenance
		if err := core.DecodeProvenance(res.Provenance, &prov); err != nil {
			yield(nil, err)
			return
		}
		base, err := env.DataSource(core.DataSourceTranco)
		if err != nil {
			yield(nil, err)
			return
		}
		file, err := download(ctx, env, downloadURL(base, c))
		if err != nil {
			yield(nil, err)
			return
		}
		if file.SHA256 != prov.SHA256 {
			yield(nil, core.Validationf("tranco content changed since resolution (list %s)", c.List))
			return
		}
		stopped := false
		_, err = scan(file, c.Offset+c.Limit, func(rank int64, domain string) bool {
			if rank <= c.Offset {
				return true
			}
			if err := ctx.Err(); err != nil {
				yield(nil, err)
				stopped = true
				return false
			}
			item, err := core.EncodeItem(AnalysisConfig{Domain: domain, Rank: rank})
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
	if c.List != "latest" && !datePattern.MatchString(c.List) && !idPattern.MatchString(c.List) {
		return Config{}, core.ValidationAt("/list", "list must be latest, a date YYYY-MM-DD or a Tranco list id")
	}
	if is := issues(c); len(is) > 0 {
		return Config{}, core.IssuesError(is)
	}
	return c, nil
}

func downloadURL(base string, c Config) string {
	return fmt.Sprintf("%s/download/%s/%d", base, c.List, c.Offset+c.Limit)
}

// metadata is the response of /api/lists/date/latest and /api/lists/id/<id>.
type metadata struct {
	ListID        string `json:"list_id"`
	Available     *bool  `json:"available"`
	Failed        *bool  `json:"failed"`
	Configuration struct {
		EndDate string `json:"endDate"`
	} `json:"configuration"`
}

// resolveList returns the concrete list id and its date.
func (t *Template) resolveList(ctx context.Context, env core.Env, base string, c Config) (string, string, error) {
	subdomains := strconv.FormatBool(c.Subdomains)
	switch {
	case c.List == "latest":
		meta, err := t.metadata(ctx, env, base+"/api/lists/date/latest?subdomains="+subdomains, "")
		if err != nil {
			return "", "", err
		}
		return meta.ListID, meta.Configuration.EndDate, nil
	case datePattern.MatchString(c.List):
		id, err := dailyListID(ctx, env, base, c.List, subdomains)
		return id, c.List, err
	default:
		meta, err := t.metadata(ctx, env, base+"/api/lists/id/"+c.List, c.List)
		if err != nil {
			return "", "", err
		}
		return meta.ListID, meta.Configuration.EndDate, nil
	}
}

// metadata fetches list metadata; id is empty for latest.
func (t *Template) metadata(ctx context.Context, env core.Env, url, id string) (*metadata, error) {
	resp, err := fetch.Text(ctx, env, fetch.Request{URL: url, Spacer: t.api})
	if err != nil {
		return nil, err
	}
	if id != "" && resp.StatusCode == http.StatusNotFound {
		return nil, core.ValidationAt("/list", "unknown Tranco list id %s", id)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, core.Platformf(true, nil, "GET %s: %s", url, resp.Status)
	}
	var meta metadata
	if err := json.Unmarshal(resp.Body, &meta); err != nil {
		return nil, core.Platformf(true, err, "unexpected Tranco metadata from %s: %v", url, err)
	}
	if !idPattern.MatchString(meta.ListID) || (id != "" && meta.ListID != id) {
		return nil, core.Platformf(true, nil, "unexpected Tranco metadata from %s: list_id %q", url, meta.ListID)
	}
	if _, err := time.Parse(time.DateOnly, meta.Configuration.EndDate); err != nil {
		return nil, core.Platformf(true, nil, "unexpected Tranco metadata from %s: endDate %q", url, meta.Configuration.EndDate)
	}
	unavailable := (meta.Failed != nil && *meta.Failed) || (meta.Available != nil && !*meta.Available)
	if unavailable {
		if id == "" {
			return nil, core.Platformf(true, nil, "the latest Tranco list %s is not available", meta.ListID)
		}
		return nil, core.ValidationAt("/list", "Tranco list %s is not available", id)
	}
	return &meta, nil
}

// dailyListID resolves the daily list of a date. Tranco answers 503 with the body null for a date
// without a list (before its generation at about 22:00 UTC, or before the first lists).
func dailyListID(ctx context.Context, env core.Env, base, date, subdomains string) (string, error) {
	url := base + "/daily_list_id?date=" + date + "&subdomains=" + subdomains
	isNull := func(body []byte) bool { return string(bytes.TrimSpace(body)) == "null" }
	resp, err := fetch.Text(ctx, env, fetch.Request{
		URL:   url,
		Final: func(status int, body []byte) bool { return status == http.StatusServiceUnavailable && isNull(body) },
	})
	if err != nil {
		return "", err
	}
	if resp.StatusCode == http.StatusServiceUnavailable || (resp.StatusCode == http.StatusOK && isNull(resp.Body)) {
		return "", core.ValidationAt("/list", "no Tranco list for %s", date)
	}
	if resp.StatusCode != http.StatusOK {
		return "", core.Platformf(true, nil, "GET %s: %s", url, resp.Status)
	}
	id := string(bytes.TrimSpace(resp.Body))
	if !idPattern.MatchString(id) {
		return "", core.Platformf(true, nil, "unexpected Tranco list id %q from %s", truncate(id, 64), url)
	}
	return id, nil
}

func download(ctx context.Context, env core.Env, url string) (*fetch.File, error) {
	file, err := fetch.Download(ctx, env, fetch.Request{URL: url})
	var serr *fetch.StatusError
	if errors.As(err, &serr) {
		return nil, core.Platformf(true, err, "%s", serr.Error())
	}
	return file, err
}

// scan reads the rows `rank,domain` of a downloaded CSV (no header, CRLF), checking that ranks are 1,
// 2, 3, …, and calls fn for each of the first max rows (fn may be nil; it returns false to stop). It
// returns the number of rows read.
func scan(file *fetch.File, maxRows int64, fn func(rank int64, domain string) bool) (int64, error) {
	f, err := file.Open()
	if err != nil {
		return 0, err
	}
	defer func() { _ = f.Close() }()
	return scanRows(f, maxRows, fn)
}

func scanRows(r io.Reader, maxRows int64, fn func(rank int64, domain string) bool) (int64, error) {
	var rows int64
	for line, err := range core.Lines(r, core.MaxLineBytes) {
		if err != nil {
			if errors.Is(err, core.ErrLineTooLong) {
				return rows, formatError(line.Number)
			}
			return rows, core.Platformf(true, err, "read Tranco CSV: %v", err)
		}
		if len(line.Text) == 0 {
			continue
		}
		if rows >= maxRows {
			break
		}
		rankText, domain, ok := bytes.Cut(line.Text, []byte(","))
		rank, perr := strconv.ParseInt(string(rankText), 10, 64)
		if !ok || perr != nil || rank != rows+1 || len(domain) == 0 || utf8.RuneCount(domain) > 253 || !utf8.Valid(domain) {
			return rows, formatError(line.Number)
		}
		rows++
		if fn != nil && !fn(rank, string(domain)) {
			return rows, nil
		}
	}
	return rows, nil
}

func formatError(line int64) error {
	return core.Platformf(true, nil, "unexpected Tranco CSV at line %d", line)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
