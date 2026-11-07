package crux

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/templates/core"
	"github.com/lonetis/scantor/internal/templates/templatestest"
)

func fake(t *testing.T, lists []templatestest.CruxList, now time.Time) core.Env {
	t.Helper()
	srv := httptest.NewServer(templatestest.NewCrux("/crux", lists))
	t.Cleanup(srv.Close)
	return core.Env{DataSources: map[string]string{"crux": srv.URL + "/crux"}, TmpDir: t.TempDir(), Now: func() time.Time { return now }}
}

func rows(spec ...any) []templatestest.CruxRow {
	var out []templatestest.CruxRow
	for i := 0; i < len(spec); i += 2 {
		out = append(out, templatestest.CruxRow{Origin: spec[i].(string), Rank: int64(spec[i+1].(int))})
	}
	return out
}

func TestLatestProbesFourMonths(t *testing.T) {
	lists := []templatestest.CruxList{
		{Country: "global", Month: "202607", Rows: rows("https://old.example", 1000)},
		{Country: "global", Month: "202608", Rows: rows("https://a.example", 1000, "http://b.example", 5000)},
		{Country: "de", Month: "202606", Rows: rows("https://de.example", 1000)},
	}
	env := fake(t, lists, time.Date(2026, 10, 3, 0, 0, 0, 0, time.UTC))
	res, err := New().Resolve(context.Background(), env, json.RawMessage(`{"country":"global","month":"latest","bucket":5000}`))
	if err != nil {
		t.Fatal(err)
	}
	if string(res.ScanConfig) != `{"source":"crux-top-lists","country":"global","month":"202608","bucket":5000}` || *res.ExpectedTotal != 2 {
		t.Fatalf("%s %d", res.ScanConfig, *res.ExpectedTotal)
	}
	items, err := templatestest.Collect(context.Background(), New(), env, res)
	if err != nil || len(items) != 2 || string(items[1]) != `{"origin":"http://b.example","rank":5000}` {
		t.Fatalf("%s %v", items, err)
	}
	// de has only 202606: four months before 202610 are 202610…202607.
	_, err = New().Resolve(context.Background(), env, json.RawMessage(`{"country":"de","month":"latest","bucket":1000}`))
	if e, ok := core.AsError(err); !ok || e.Type != api.ErrorValidation || e.Message != "no CrUX list for de in the last 4 months" {
		t.Fatalf("err %v", err)
	}
	_, err = New().Resolve(context.Background(), env, json.RawMessage(`{"country":"de","month":"202605","bucket":1000}`))
	if e, ok := core.AsError(err); !ok || e.Type != api.ErrorValidation || e.Message != "CrUX list de 202605 not found" {
		t.Fatalf("err %v", err)
	}
}

func TestMonthBoundaryAcrossYears(t *testing.T) {
	lists := []templatestest.CruxList{{Country: "global", Month: "202510", Rows: rows("https://a.example", 1000)}}
	env := fake(t, lists, time.Date(2026, 1, 15, 0, 0, 0, 0, time.UTC))
	res, err := New().Resolve(context.Background(), env, json.RawMessage(`{"country":"global","month":"latest","bucket":1000}`))
	if err != nil || !strings.Contains(string(res.ScanConfig), `"202510"`) {
		t.Fatalf("%s %v", res.ScanConfig, err)
	}
}

func TestMalformedCSV(t *testing.T) {
	cases := map[string]string{
		"origin,rank\nhttps://a,5000\nhttps://b,1000\n": "unexpected CrUX CSV at line 3",
		"origin,rank\nhttps://a,1001\n":                 "unexpected CrUX CSV at line 2",
		"origin,rank\nhttps://a\n":                      "unexpected CrUX CSV at line 2",
		"origin,rank\n,1000\n":                          "unexpected CrUX CSV at line 2",
		"rank,origin\n":                                 "unexpected CrUX CSV header",
		"":                                              "the file is empty",
	}
	for csv, want := range cases {
		s := rowReader{bucket: 1000000}
		err := s.read(strings.NewReader(csv), "", true, nil)
		e, ok := core.AsError(err)
		if !ok || e.Type != api.ErrorPlatform || !e.Retryable || !strings.Contains(e.Message, want) {
			t.Errorf("%q: err %v, want %q", csv, err, want)
		}
	}
	// Rows after the bucket are not read, so a defect there does not matter; CRLF is tolerated.
	s := rowReader{bucket: 1000}
	err := s.read(strings.NewReader("origin,rank\r\nhttps://a,1000\r\n\nhttps://b,5000\r\nbroken\n"), "", true, nil)
	if err != nil || s.count != 1 || !s.done {
		t.Fatalf("%+v %v", s, err)
	}
}

func TestChunksContinueTheList(t *testing.T) {
	s := rowReader{bucket: 5000}
	if err := s.read(strings.NewReader("origin,rank\nhttps://a,1000\n"), "202609_1.csv", true, nil); err != nil || s.done {
		t.Fatalf("%+v %v", s, err)
	}
	// Later chunks have no header, and ranks stay non-decreasing across chunks.
	err := s.read(strings.NewReader("origin,rank\n"), "202609_2.csv", false, nil)
	if e, ok := core.AsError(err); !ok || e.Message != "unexpected CrUX CSV at line 1 of 202609_2.csv" {
		t.Fatalf("header in chunk 2: %v", err)
	}
	s = rowReader{bucket: 5000}
	_ = s.read(strings.NewReader("origin,rank\nhttps://a,5000\n"), "202609_1.csv", true, nil)
	err = s.read(strings.NewReader("https://b,1000\n"), "202609_2.csv", false, nil)
	if e, ok := core.AsError(err); !ok || e.Message != "unexpected CrUX CSV at line 1 of 202609_2.csv" {
		t.Fatalf("decreasing rank across chunks: %v", err)
	}
	if err := s.read(strings.NewReader(""), "202609_1.csv", true, nil); err == nil || !strings.Contains(err.Error(), "unexpected CrUX CSV of 202609_1.csv: the file is empty") {
		t.Fatalf("empty first chunk: %v", err)
	}
}

func TestValidateBucketPerSource(t *testing.T) {
	for cfg, want := range map[string]int{
		`{"source":"crux-top-lists","country":"global","month":"latest","bucket":1000000}`: 0,
		`{"source":"crux-top-lists","country":"global","month":"latest","bucket":5000000}`: 1,
		`{"source":"crux-cache","country":"global","month":"latest","bucket":50000000}`:    0,
	} {
		if issues := New().Validate(json.RawMessage(cfg)); len(issues) != want || (want == 1 && issues[0].Path != "/bucket") {
			t.Errorf("%s: issues %v", cfg, issues)
		}
	}
	est, err := New().Estimate(json.RawMessage(`{"source":"crux-cache","country":"global","month":"latest","bucket":50000000}`), core.Env{})
	if err != nil || *est.ExpectedTotal != CacheEstimateCap || est.Exact {
		t.Fatalf("%+v %v", est, err)
	}
	est, err = New().Estimate(json.RawMessage(`{"source":"crux-cache","country":"global","month":"latest","bucket":10000000}`), core.Env{})
	if err != nil || *est.ExpectedTotal != 10000000 {
		t.Fatalf("%+v %v", est, err)
	}
}

// A resolution stored before the source field existed streams from crux-top-lists.
func TestResolutionWithoutSource(t *testing.T) {
	lists := []templatestest.CruxList{{Country: "global", Month: "202608", Rows: rows("https://a.example", 1000, "https://b.example", 5000)}}
	env := fake(t, lists, time.Date(2026, 10, 3, 0, 0, 0, 0, time.UTC))
	res, err := New().Resolve(context.Background(), env, json.RawMessage(`{"country":"global","month":"latest","bucket":1000}`))
	if err != nil {
		t.Fatal(err)
	}
	if string(res.ScanConfig) != `{"source":"crux-top-lists","country":"global","month":"202608","bucket":1000}` {
		t.Fatalf("%s", res.ScanConfig)
	}
	res.ScanConfig = json.RawMessage(`{"country":"global","month":"202608","bucket":1000}`)
	items, err := templatestest.Collect(context.Background(), New(), env, res)
	if err != nil || len(items) != 1 || string(items[0]) != `{"origin":"https://a.example","rank":1000}` {
		t.Fatalf("%s %v", items, err)
	}
}

func TestCacheChunkGoneOnResume(t *testing.T) {
	now := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	ds := templatestest.DefaultDataSet(now)
	srv := httptest.NewServer(templatestest.NewHandler(ds))
	defer srv.Close()
	env := core.Env{DataSources: map[string]string{"cruxCache": srv.URL + "/crux-cache"}, TmpDir: t.TempDir()}
	res, err := New().Resolve(context.Background(), env, json.RawMessage(`{"source":"crux-cache","country":"de","month":"latest","bucket":1000}`))
	if err != nil {
		t.Fatal(err)
	}
	var prov cacheProvenance
	if err := core.DecodeProvenance(res.Provenance, &prov); err != nil || len(prov.Chunks) != 2 {
		t.Fatalf("%+v %v", prov, err)
	}
	// The stored resolution names a chunk the dataset no longer has.
	prov.Chunks[1].Filename = "202601_9.csv"
	if res.Provenance, err = core.ProvenanceMap(prov); err != nil {
		t.Fatal(err)
	}
	_, err = templatestest.Collect(context.Background(), New(), env, res)
	if e, ok := core.AsError(err); !ok || e.Type != api.ErrorValidation || e.Retryable || !strings.Contains(e.Message, "changed since resolution") {
		t.Fatalf("err %v", err)
	}
}

func TestContentEncodedGzipHashesTheSame(t *testing.T) {
	const csv = "origin,rank\nhttps://a.example,1000\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			return
		}
		// A server that serves the CSV with Content-Encoding gzip instead of a .gz file.
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write(templatestest.Gzip([]byte(csv)))
	}))
	defer srv.Close()
	env := core.Env{DataSources: map[string]string{"crux": srv.URL}, TmpDir: t.TempDir()}
	res, err := New().Resolve(context.Background(), env, json.RawMessage(`{"country":"global","month":"202609","bucket":1000}`))
	if err != nil {
		t.Fatal(err)
	}
	var prov topListsProvenance
	if err := core.DecodeProvenance(res.Provenance, &prov); err != nil {
		t.Fatal(err)
	}
	if prov.SHA256 != sha(csv) || prov.SourceURL != srv.URL+"/data/global/202609.csv.gz" {
		t.Fatalf("%+v", prov)
	}
}

func sha(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func TestFixturesServerDataSet(t *testing.T) {
	now := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	srv := httptest.NewServer(templatestest.NewHandler(templatestest.DefaultDataSet(now)))
	defer srv.Close()
	env := core.Env{
		DataSources: map[string]string{"crux": srv.URL + "/crux", "cruxCache": srv.URL + "/crux-cache"},
		TmpDir:      t.TempDir(),
		Now:         func() time.Time { return now },
	}
	for _, tc := range []struct {
		cfg  string
		want int64
	}{
		{`{"country":"global","month":"latest","bucket":1000}`, 1000},
		{`{"country":"de","month":"latest","bucket":10000}`, 1500},
		{`{"country":"us","month":"202608","bucket":5000}`, 1400},
		// crux-cache: chunks of 600 rows; latest is the newest month of the manifest (202609).
		{`{"source":"crux-cache","country":"global","month":"latest","bucket":1000}`, 1000},
		{`{"source":"crux-cache","country":"de","month":"202608","bucket":10000}`, 1500},
		{`{"source":"crux-cache","country":"us","month":"latest","bucket":50000000}`, 1550},
	} {
		res, err := New().Resolve(context.Background(), env, json.RawMessage(tc.cfg))
		if err != nil {
			t.Fatalf("%s: %v", tc.cfg, err)
		}
		items, err := templatestest.Collect(context.Background(), New(), env, res)
		if err != nil || int64(len(items)) != tc.want || *res.ExpectedTotal != tc.want {
			t.Fatalf("%s: %d items, expected total %d, err %v", tc.cfg, len(items), *res.ExpectedTotal, err)
		}
	}
}
