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
	if string(res.ScanConfig) != `{"country":"global","month":"202608","bucket":5000}` || *res.ExpectedTotal != 2 {
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
		_, err := scanRows(strings.NewReader(csv), 1000000, nil)
		e, ok := core.AsError(err)
		if !ok || e.Type != api.ErrorPlatform || !e.Retryable || !strings.Contains(e.Message, want) {
			t.Errorf("%q: err %v, want %q", csv, err, want)
		}
	}
	// Rows after the bucket are not read, so a defect there does not matter; CRLF is tolerated.
	n, err := scanRows(strings.NewReader("origin,rank\r\nhttps://a,1000\r\n\nhttps://b,5000\r\nbroken\n"), 1000, nil)
	if err != nil || n != 1 {
		t.Fatalf("%d %v", n, err)
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
	var prov provenance
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
	env := core.Env{DataSources: map[string]string{"crux": srv.URL + "/crux"}, TmpDir: t.TempDir(), Now: func() time.Time { return now }}
	for _, tc := range []struct {
		cfg  string
		want int64
	}{
		{`{"country":"global","month":"latest","bucket":1000}`, 1000},
		{`{"country":"de","month":"latest","bucket":10000}`, 1500},
		{`{"country":"us","month":"202608","bucket":5000}`, 1400},
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
