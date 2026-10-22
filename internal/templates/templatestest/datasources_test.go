package templatestest

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type response struct {
	status      int
	contentType string
	body        []byte
}

func get(t *testing.T, method, url string) response {
	t.Helper()
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response{status: resp.StatusCode, contentType: resp.Header.Get("Content-Type"), body: body}
}

func gunzip(t *testing.T, data []byte) string {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

// TestHandlerServesTheUpstreamEndpoints checks the fixtures-server handler against the endpoints of
// docs/templates.md §9.5–§9.6 (paths, query strings, content types, line endings, gzip).
func TestHandlerServesTheUpstreamEndpoints(t *testing.T) {
	now := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	srv := httptest.NewServer(NewHandler(DefaultDataSet(now)))
	defer srv.Close()
	tranco, crux := srv.URL+"/tranco", srv.URL+"/crux"
	yesterday := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	id := TrancoListID(yesterday, false)

	latest := get(t, http.MethodGet, tranco+"/api/lists/date/latest?subdomains=false")
	var meta struct {
		ListID        string `json:"list_id"`
		Available     bool   `json:"available"`
		Configuration struct {
			EndDate string `json:"endDate"`
		} `json:"configuration"`
	}
	if err := json.Unmarshal(latest.body, &meta); err != nil || latest.status != 200 || latest.contentType != "application/json" {
		t.Fatalf("latest: %d %s %s (%v)", latest.status, latest.contentType, latest.body, err)
	}
	if meta.ListID != id || meta.Configuration.EndDate != "2026-10-20" || !meta.Available {
		t.Fatalf("latest metadata %+v, want list %s of 2026-10-20", meta, id)
	}
	if sub := get(t, http.MethodGet, tranco+"/api/lists/date/latest?subdomains=true"); !strings.Contains(string(sub.body), TrancoListID(yesterday, true)) {
		t.Fatalf("latest with subdomains: %s", sub.body)
	}
	if byID := get(t, http.MethodGet, tranco+"/api/lists/id/"+id); byID.status != 200 || !strings.Contains(string(byID.body), `"endDate":"2026-10-20"`) {
		t.Fatalf("by id: %d %s", byID.status, byID.body)
	}
	if unknown := get(t, http.MethodGet, tranco+"/api/lists/id/ZZZZZ"); unknown.status != 404 {
		t.Fatalf("unknown id: %d", unknown.status)
	}

	daily := get(t, http.MethodGet, tranco+"/daily_list_id?date=2026-10-20&subdomains=false")
	if daily.status != 200 || string(daily.body) != id || daily.contentType != "text/plain" {
		t.Fatalf("daily_list_id: %d %s %q", daily.status, daily.contentType, daily.body)
	}
	if none := get(t, http.MethodGet, tranco+"/daily_list_id?date=2026-10-21&subdomains=false"); none.status != 503 || string(none.body) != "null" {
		t.Fatalf("daily_list_id without a list: %d %q", none.status, none.body)
	}

	csv := get(t, http.MethodGet, tranco+"/download/"+id+"/3")
	if csv.status != 200 || csv.contentType != "text/csv; charset=utf-8" || string(csv.body) != "1,site1.example\r\n2,site2.example\r\n3,site3.example\r\n" {
		t.Fatalf("download: %d %s %q", csv.status, csv.contentType, csv.body)
	}
	if beyond := get(t, http.MethodGet, tranco+"/download/"+id+"/5000"); strings.Count(string(beyond.body), "\r\n") != 1000 {
		t.Fatalf("download beyond the list length: %d rows", strings.Count(string(beyond.body), "\r\n"))
	}

	month := crux + "/data/global/202609.csv.gz"
	file := get(t, http.MethodGet, month)
	if file.status != 200 || file.contentType != "application/octet-stream" {
		t.Fatalf("crux file: %d %s", file.status, file.contentType)
	}
	text := gunzip(t, file.body)
	if !strings.HasPrefix(text, "origin,rank\nhttps://site1.example,1000\n") || strings.Contains(text, "\r") || strings.Count(text, "\n") != 1501 {
		t.Fatalf("crux CSV: %q…", text[:min(len(text), 80)])
	}
	if head := get(t, http.MethodHead, month); head.status != 200 || len(head.body) != 0 {
		t.Fatalf("HEAD probe: %d %d bytes", head.status, len(head.body))
	}
	if current := get(t, http.MethodHead, crux+"/data/global/202610.csv.gz"); current.status != 404 {
		t.Fatalf("unpublished month: %d", current.status)
	}
	if country := get(t, http.MethodGet, crux+"/data/country/de/202608.csv.gz"); country.status != 200 || !strings.Contains(gunzip(t, country.body), "https://site1.de.example,1000\n") {
		t.Fatalf("country file: %d", country.status)
	}
	if health := get(t, http.MethodGet, srv.URL+"/healthz"); health.status != 200 {
		t.Fatalf("healthz: %d", health.status)
	}
}

func TestTrancoRateLimit(t *testing.T) {
	srv := httptest.NewServer(NewTranco("", []TrancoList{{ID: "AAAA", Date: "2026-10-20", Domains: []string{"a.example"}}}, time.Hour))
	defer srv.Close()
	if first := get(t, http.MethodGet, srv.URL+"/api/lists/id/AAAA"); first.status != 200 {
		t.Fatalf("first: %d", first.status)
	}
	if second := get(t, http.MethodGet, srv.URL+"/api/lists/id/AAAA"); second.status != 429 {
		t.Fatalf("second /api request within the interval: %d", second.status)
	}
	if download := get(t, http.MethodGet, srv.URL+"/download/AAAA/1"); download.status != 200 {
		t.Fatalf("downloads are not rate limited: %d", download.status)
	}
}

func TestRoutes(t *testing.T) {
	routes := NewRoutes("/tranco", []Route{
		{Method: "GET", Path: "/daily_list_id?date=2026-10-20&subdomains=false", Status: 200, ContentType: "text/plain", Body: "X5Y7N"},
		{Method: "GET", Path: "/api/lists/id/X5Y7N", Status: 200, ContentType: "application/json", Body: `{"download": "${tranco}/download/X5Y7N/10"}`},
		{Method: "GET", Path: "/f.csv.gz", Status: 200, ContentType: "application/octet-stream", Body: "origin,rank\n", Encoding: "gzip"},
	}, map[string]string{"tranco": "https://fixtures/tranco"})
	srv := httptest.NewServer(routes)
	defer srv.Close()
	base := srv.URL + "/tranco"

	if r := get(t, http.MethodGet, base+"/daily_list_id?date=2026-10-20&subdomains=false"); r.status != 200 || string(r.body) != "X5Y7N" {
		t.Fatalf("exact query: %d %q", r.status, r.body)
	}
	if r := get(t, http.MethodGet, base+"/daily_list_id?subdomains=false&date=2026-10-20"); r.status != 404 {
		t.Fatalf("a different query string must not match: %d", r.status)
	}
	if r := get(t, http.MethodGet, base+"/api/lists/id/X5Y7N"); string(r.body) != `{"download": "https://fixtures/tranco/download/X5Y7N/10"}` {
		t.Fatalf("placeholder: %s", r.body)
	}
	if r := get(t, http.MethodHead, base+"/f.csv.gz"); r.status != 200 || len(r.body) != 0 {
		t.Fatalf("HEAD of a GET route: %d", r.status)
	}
	if r := get(t, http.MethodGet, base+"/f.csv.gz"); gunzip(t, r.body) != "origin,rank\n" {
		t.Fatalf("gzip route: %q", r.body)
	}
	if r := get(t, http.MethodPost, base+"/f.csv.gz"); r.status != 404 {
		t.Fatalf("other methods: %d", r.status)
	}
	want := []string{
		"GET /tranco/daily_list_id?date=2026-10-20&subdomains=false",
		"GET /tranco/daily_list_id?subdomains=false&date=2026-10-20",
		"GET /tranco/api/lists/id/X5Y7N",
		"HEAD /tranco/f.csv.gz",
		"GET /tranco/f.csv.gz",
		"POST /tranco/f.csv.gz",
	}
	if got := routes.Requests(); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("requests:\n%s", strings.Join(got, "\n"))
	}
}

func TestDefaultDataSetIsDeterministic(t *testing.T) {
	now := time.Date(2026, 1, 2, 3, 0, 0, 0, time.UTC)
	a, err := json.Marshal(DefaultDataSet(now))
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(DefaultDataSet(now.Add(time.Hour)))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, b) {
		t.Fatal("the data set changes within a day")
	}
	ids := map[string]bool{}
	for _, l := range DefaultDataSet(now).Tranco {
		if ids[l.ID] || len(l.ID) < 4 || len(l.ID) > 6 || strings.ToUpper(l.ID) != l.ID {
			t.Fatalf("list id %q is duplicate or malformed", l.ID)
		}
		ids[l.ID] = true
	}
	months := map[string]bool{}
	for _, l := range DefaultDataSet(now).Crux {
		months[l.Month] = true
	}
	if !months["202512"] || !months["202511"] {
		t.Fatalf("CrUX months across the year boundary: %v", months)
	}
}
