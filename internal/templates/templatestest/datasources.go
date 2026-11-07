package templatestest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// TrancoList is one Tranco list of the fake.
type TrancoList struct {
	ID         string   `json:"id"`         // [0-9A-Z]{4,6}
	Date       string   `json:"date"`       // YYYY-MM-DD: configuration.endDate and the daily_list_id date
	Subdomains bool     `json:"subdomains"` // the daily list variant including subdomains
	Domains    []string `json:"domains"`    // in rank order (rank = index + 1)
}

// Tranco fakes https://tranco-list.eu below a path prefix:
//
//	GET /api/lists/date/latest?subdomains=<bool>   metadata JSON of the newest list of the variant
//	GET /api/lists/date/<YYYYMMDD>?subdomains=…   metadata JSON; 404 {"available": false}
//	GET /api/lists/id/<id>                          metadata JSON; 404 when unknown
//	GET /daily_list_id?date=<YYYY-MM-DD>&subdomains=<bool>   text/plain id; 503 "null" when none
//	GET /download/<id>/<n>, /download/<id>/full     text/csv "rank,domain" rows, CRLF, no header
//
// HEAD is answered like GET without a body. With an API interval, /api/* requests closer together
// than the interval get 429 (the upstream rate limit).
type Tranco struct {
	prefix      string
	lists       []TrancoList
	apiInterval time.Duration

	mu      sync.Mutex
	lastAPI time.Time
}

// NewTranco returns the Tranco fake for lists below prefix ("" or for example "/tranco").
// apiInterval > 0 enforces the upstream /api/* rate limit.
func NewTranco(prefix string, lists []TrancoList, apiInterval time.Duration) *Tranco {
	return &Tranco{prefix: strings.TrimSuffix(prefix, "/"), lists: lists, apiInterval: apiInterval}
}

var (
	trancoDatePath     = regexp.MustCompile(`^/api/lists/date/([0-9]{8})$`)
	trancoIDPath       = regexp.MustCompile(`^/api/lists/id/([0-9A-Z]+)$`)
	trancoDownloadPath = regexp.MustCompile(`^/download/([0-9A-Z]+)/([0-9]+|full)$`)
)

func (h *Tranco) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p, ok := strings.CutPrefix(r.URL.Path, h.prefix)
	if !ok || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		http.NotFound(w, r)
		return
	}
	q := r.URL.Query()
	subdomains := q.Get("subdomains") == "true"
	if strings.HasPrefix(p, "/api/") && !h.allowAPI() {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = fmt.Fprint(w, "<html><head><title>429 Too Many Requests</title></head><body><center><h1>429 Too Many Requests</h1></center><hr><center>nginx</center></body></html>\n")
		return
	}
	switch {
	case p == "/api/lists/date/latest":
		var latest *TrancoList
		for i := range h.lists {
			l := &h.lists[i]
			if l.Subdomains == subdomains && (latest == nil || l.Date > latest.Date) {
				latest = l
			}
		}
		h.metadata(w, r, latest)
	case trancoDatePath.MatchString(p):
		date := trancoDatePath.FindStringSubmatch(p)[1]
		h.metadata(w, r, h.byDate(date[:4]+"-"+date[4:6]+"-"+date[6:], subdomains))
	case trancoIDPath.MatchString(p):
		h.metadata(w, r, h.byID(trancoIDPath.FindStringSubmatch(p)[1]))
	case p == "/daily_list_id":
		l := h.byDate(q.Get("date"), subdomains)
		w.Header().Set("Content-Type", "text/plain")
		if l == nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = fmt.Fprint(w, "null")
			return
		}
		_, _ = fmt.Fprint(w, l.ID)
	case trancoDownloadPath.MatchString(p):
		m := trancoDownloadPath.FindStringSubmatch(p)
		l := h.byID(m[1])
		n := len(l.domainsOrNil())
		if m[2] != "full" {
			v, err := strconv.Atoi(m[2])
			if err != nil || v < 1 || v > 1_000_000 {
				l = nil
			}
			n = min(n, v)
		}
		if l == nil {
			http.NotFound(w, r)
			return
		}
		var body bytes.Buffer
		for i, d := range l.Domains[:n] {
			fmt.Fprintf(&body, "%d,%s\r\n", i+1, d)
		}
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf("Attachment;filename=tranco_%s.csv", l.ID))
		_, _ = w.Write(body.Bytes())
	default:
		http.NotFound(w, r)
	}
}

func (l *TrancoList) domainsOrNil() []string {
	if l == nil {
		return nil
	}
	return l.Domains
}

func (h *Tranco) allowAPI() bool {
	if h.apiInterval <= 0 {
		return true
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now()
	if !h.lastAPI.IsZero() && now.Sub(h.lastAPI) < h.apiInterval {
		return false
	}
	h.lastAPI = now
	return true
}

func (h *Tranco) byDate(date string, subdomains bool) *TrancoList {
	for i := range h.lists {
		if h.lists[i].Date == date && h.lists[i].Subdomains == subdomains {
			return &h.lists[i]
		}
	}
	return nil
}

func (h *Tranco) byID(id string) *TrancoList {
	for i := range h.lists {
		if h.lists[i].ID == id {
			return &h.lists[i]
		}
	}
	return nil
}

// metadata writes the upstream metadata JSON of l, or 404 {"available": false}.
func (h *Tranco) metadata(w http.ResponseWriter, r *http.Request, l *TrancoList) {
	w.Header().Set("Content-Type", "application/json")
	if l == nil {
		w.WriteHeader(http.StatusNotFound)
		_, _ = fmt.Fprint(w, `{"available": false}`)
		return
	}
	end, err := time.Parse(time.DateOnly, l.Date)
	if err != nil {
		http.Error(w, "invalid list date", http.StatusInternalServerError)
		return
	}
	config := map[string]any{
		"providers":         []string{"crux", "farsight", "majestic", "radar", "umbrella"},
		"endDate":           l.Date,
		"isDailyList":       true,
		"combinationMethod": "dowdall",
		"listPrefix":        "1000000",
		"startDate":         end.AddDate(0, 0, -29).Format(time.DateOnly),
		"filterTLD":         "false",
	}
	if !l.Subdomains {
		config["filterPLD"] = "on"
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"list_id":       l.ID,
		"available":     true,
		"failed":        false,
		"download":      fmt.Sprintf("%s%s/download/%s/1000000", origin(r), h.prefix, l.ID),
		"created_on":    l.Date + "T22:00:02.703082",
		"configuration": config,
	})
}

// origin is the scheme and host the request was addressed to.
func origin(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// CruxRow is one row of a CrUX list.
type CruxRow struct {
	Origin string `json:"origin"`
	Rank   int64  `json:"rank"`
}

// CruxList is one month of one CrUX list.
type CruxList struct {
	Country string    `json:"country"` // "global" or a lowercase ISO 3166-1 alpha-2 code
	Month   string    `json:"month"`   // YYYYMM
	Rows    []CruxRow `json:"rows"`    // file order (by bucket)
}

// Crux fakes https://raw.githubusercontent.com/zakird/crux-top-lists/main below a path prefix:
// GET and HEAD of /data/global/<YYYYMM>.csv.gz, /data/global/current.csv.gz and
// /data/country/<cc>/<YYYYMM>.csv.gz, served as application/octet-stream gzip files of
// "origin,rank" CSVs with LF line endings.
type Crux struct {
	prefix string
	files  map[string][]byte // path → gzip bytes
}

// NewCrux returns the CrUX fake for lists below prefix ("" or for example "/crux").
func NewCrux(prefix string, lists []CruxList) *Crux {
	h := &Crux{prefix: strings.TrimSuffix(prefix, "/"), files: map[string][]byte{}}
	latestGlobal := ""
	for _, l := range lists {
		var csv bytes.Buffer
		csv.WriteString("origin,rank\n")
		for _, row := range l.Rows {
			fmt.Fprintf(&csv, "%s,%d\n", row.Origin, row.Rank)
		}
		gz := Gzip(csv.Bytes())
		if l.Country == "global" {
			h.files[fmt.Sprintf("/data/global/%s.csv.gz", l.Month)] = gz
			if l.Month > latestGlobal {
				latestGlobal = l.Month
				h.files["/data/global/current.csv.gz"] = gz
			}
		} else {
			h.files[fmt.Sprintf("/data/country/%s/%s.csv.gz", l.Country, l.Month)] = gz
		}
	}
	return h
}

func (h *Crux) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p, ok := strings.CutPrefix(r.URL.Path, h.prefix)
	body, found := h.files[p]
	if !ok || !found || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	if r.Method == http.MethodGet {
		_, _ = w.Write(body)
	}
}

// CruxCache fakes https://raw.githubusercontent.com/lonetis/crux-cache/main below a path prefix:
// GET and HEAD of /data/<dataset>/manifest.json (the dataset's months and their chunks) and
// /data/<dataset>/<YYYYMM>_<n>.csv (uncompressed "origin,rank" CSV chunks with LF line endings, the
// header only in chunk 1), both served as text/plain like raw GitHub files. A list's dataset is its
// Country; its rows are split into chunks of chunkRows rows.
type CruxCache struct {
	prefix string
	files  map[string][]byte // path → content
}

// cruxCacheChunk and cruxCacheMonth are manifest entries in the upstream format.
type cruxCacheChunk struct {
	Chunk    int    `json:"chunk"`
	Filename string `json:"filename"`
	Size     int    `json:"size"`
	Origins  int    `json:"origins"`
}

type cruxCacheMonth struct {
	Year        int              `json:"year"`
	Month       int              `json:"month"`
	Chunks      []cruxCacheChunk `json:"chunks"`
	TotalChunks int              `json:"total_chunks"`
	TotalSize   int              `json:"total_size"`
	Origins     int              `json:"origins"`
}

// NewCruxCache returns the crux-cache fake for lists below prefix ("" or for example "/crux-cache").
func NewCruxCache(prefix string, lists []CruxList, chunkRows int) *CruxCache {
	h := &CruxCache{prefix: strings.TrimSuffix(prefix, "/"), files: map[string][]byte{}}
	chunkRows = max(chunkRows, 1)
	months := map[string]map[string]cruxCacheMonth{} // dataset → month → entry
	for _, l := range lists {
		if months[l.Country] == nil {
			months[l.Country] = map[string]cruxCacheMonth{}
		}
		year, _ := strconv.Atoi(l.Month[:4])
		month, _ := strconv.Atoi(l.Month[4:])
		entry := cruxCacheMonth{Year: year, Month: month, Origins: len(l.Rows)}
		for start := 0; start == 0 || start < len(l.Rows); start += chunkRows {
			var csv bytes.Buffer
			if start == 0 {
				csv.WriteString("origin,rank\n")
			}
			end := min(start+chunkRows, len(l.Rows))
			for _, row := range l.Rows[start:end] {
				fmt.Fprintf(&csv, "%s,%d\n", row.Origin, row.Rank)
			}
			n := len(entry.Chunks) + 1
			name := fmt.Sprintf("%s_%d.csv", l.Month, n)
			h.files[fmt.Sprintf("/data/%s/%s", l.Country, name)] = csv.Bytes()
			entry.Chunks = append(entry.Chunks, cruxCacheChunk{Chunk: n, Filename: name, Size: csv.Len(), Origins: end - start})
			entry.TotalSize += csv.Len()
		}
		entry.TotalChunks = len(entry.Chunks)
		months[l.Country][l.Month] = entry
	}
	for dataset, byMonth := range months {
		names := make([]string, 0, len(byMonth))
		total := 0
		for month, entry := range byMonth {
			names = append(names, month)
			total += entry.TotalSize
		}
		slices.Sort(names)
		manifest, _ := json.MarshalIndent(map[string]any{
			"name": "Cached Chrome User Experience Report - " + dataset,
			"summary": map[string]any{
				"total_months": len(names), "total_size": total, "earliest_month": names[0], "latest_month": names[len(names)-1],
			},
			"months": byMonth,
		}, "", "  ")
		h.files[fmt.Sprintf("/data/%s/manifest.json", dataset)] = manifest
	}
	return h
}

func (h *CruxCache) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p, ok := strings.CutPrefix(r.URL.Path, h.prefix)
	body, found := h.files[p]
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if !ok || !found || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = fmt.Fprint(w, "404: Not Found")
		return
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	if r.Method == http.MethodGet {
		_, _ = w.Write(body)
	}
}

// Uploads serves uploaded lists at presigned-style URLs: GET <prefix>/<id>?X-Amz-…, any query.
type Uploads struct {
	prefix  string
	content map[string][]byte
}

// NewUploads returns the upload fake below prefix (for example "/uploads").
func NewUploads(prefix string, content map[string][]byte) *Uploads {
	return &Uploads{prefix: strings.TrimSuffix(prefix, "/"), content: content}
}

// URL returns the presigned-style URL of an upload for a server at base.
func (h *Uploads) URL(base, id string) string {
	return fmt.Sprintf("%s%s/%s?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-Signature=fixture", base, h.prefix, id)
}

func (h *Uploads) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	id, ok := strings.CutPrefix(r.URL.Path, h.prefix+"/")
	body, found := h.content[id]
	if !ok || !found || r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	_, _ = w.Write(body)
}

// DataSet is the content of the data-source fakes.
type DataSet struct {
	Tranco    []TrancoList `json:"tranco"`
	Crux      []CruxList   `json:"crux"`
	CruxCache []CruxList   `json:"cruxCache"`
	// CruxCacheChunkRows is the number of rows per crux-cache chunk.
	CruxCacheChunkRows int `json:"cruxCacheChunkRows"`
}

// NewHandler serves a DataSet like the fixtures server: Tranco below /tranco, CrUX below /crux,
// crux-cache below /crux-cache, and GET /healthz. Point SCANTOR_TRANCO_URL at <origin>/tranco,
// SCANTOR_CRUX_URL at <origin>/crux and SCANTOR_CRUX_CACHE_URL at <origin>/crux-cache.
func NewHandler(ds DataSet) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/tranco/", NewTranco("/tranco", ds.Tranco, 0))
	mux.Handle("/crux/", NewCrux("/crux", ds.Crux))
	mux.Handle("/crux-cache/", NewCruxCache("/crux-cache", ds.CruxCache, ds.CruxCacheChunkRows))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = fmt.Fprint(w, "ok\n")
	})
	return mux
}

// DefaultDataSet returns small deterministic lists relative to now:
//
//   - Tranco: daily lists of the three days before now (UTC), both variants, 1000 domains each
//     (siteN.example, www.siteN.example for the subdomain variant); `latest` is yesterday's list and a
//     date without a list (today) answers 503 "null".
//   - CrUX: the two months before now's month for global, de and us: 1000 origins in bucket 1000, 400
//     in 5000 and 100 in 10000 (every tenth origin is http://).
//   - crux-cache: the same months and datasets with the same buckets plus 50 origins in bucket
//     5000000, on hosts siteN.cache.example (siteN.cache.<cc>.example), in chunks of 600 rows, so
//     bucket 1000 ends inside chunk 2.
func DefaultDataSet(now time.Time) DataSet {
	now = now.UTC()
	var ds DataSet
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	for back := 1; back <= 3; back++ {
		day := today.AddDate(0, 0, -back)
		for _, sub := range []bool{false, true} {
			domains := make([]string, 1000)
			for i := range domains {
				domains[i] = fmt.Sprintf("site%d.example", i+1)
				if sub {
					domains[i] = "www." + domains[i]
				}
			}
			ds.Tranco = append(ds.Tranco, TrancoList{ID: TrancoListID(day, sub), Date: day.Format(time.DateOnly), Subdomains: sub, Domains: domains})
		}
	}
	first := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	topLists := []cruxBucket{{1000, 1000}, {5000, 400}, {10000, 100}}
	cache := append(slices.Clone(topLists), cruxBucket{5000000, 50})
	for back := 1; back <= 2; back++ {
		month := first.AddDate(0, -back, 0).Format("200601")
		for _, country := range []string{"global", "de", "us"} {
			host := "example"
			if country != "global" {
				host = country + ".example"
			}
			ds.Crux = append(ds.Crux, CruxList{Country: country, Month: month, Rows: cruxRows(host, topLists)})
			ds.CruxCache = append(ds.CruxCache, CruxList{Country: country, Month: month, Rows: cruxRows("cache."+host, cache)})
		}
	}
	ds.CruxCacheChunkRows = 600
	slices.SortFunc(ds.Tranco, func(a, b TrancoList) int { return strings.Compare(a.ID, b.ID) })
	return ds
}

// cruxBucket is a number of rows in one rank bucket.
type cruxBucket struct{ rank, count int64 }

// cruxRows returns the rows of a fixture list: the n-th origin (1-based) is <scheme>://site<n>.<host>,
// with http for every tenth and https otherwise.
func cruxRows(host string, buckets []cruxBucket) []CruxRow {
	var rows []CruxRow
	n := 0
	for _, bucket := range buckets {
		for range bucket.count {
			n++
			scheme := "https"
			if n%10 == 0 {
				scheme = "http"
			}
			rows = append(rows, CruxRow{Origin: fmt.Sprintf("%s://site%d.%s", scheme, n, host), Rank: bucket.rank})
		}
	}
	return rows
}

// TrancoListID returns a deterministic list id ([0-9A-Z]{4,6}) for a date and variant.
func TrancoListID(day time.Time, subdomains bool) string {
	days := int64(day.Sub(time.Date(2019, 1, 1, 0, 0, 0, 0, time.UTC)).Hours() / 24)
	n := 36*36*36 + days*2
	if subdomains {
		n++
	}
	return strings.ToUpper(strconv.FormatInt(max(n, 36*36*36), 36))
}
