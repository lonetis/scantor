package tranco

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/templates/core"
	"github.com/lonetis/scantor/internal/templates/templatestest"
)

func fake(t *testing.T, apiInterval time.Duration) (*httptest.Server, core.Env) {
	t.Helper()
	lists := []templatestest.TrancoList{
		{ID: "AAAA", Date: "2026-10-19", Domains: []string{"a.example", "b.example", "c.example"}},
		{ID: "BBBB", Date: "2026-10-20", Domains: []string{"google.com", "cloudflare.com", "microsoft.com"}},
		{ID: "CCCC", Date: "2026-10-20", Subdomains: true, Domains: []string{"www.google.com", "mail.google.com"}},
	}
	srv := httptest.NewServer(templatestest.NewTranco("/tranco", lists, apiInterval))
	t.Cleanup(srv.Close)
	return srv, core.Env{DataSources: map[string]string{"tranco": srv.URL + "/tranco"}, TmpDir: t.TempDir()}
}

func resolve(t *testing.T, tmpl *Template, env core.Env, cfg string) (core.Resolution, []string, error) {
	t.Helper()
	res, err := tmpl.Resolve(context.Background(), env, json.RawMessage(cfg))
	if err != nil {
		return res, nil, err
	}
	items, err := templatestest.Collect(context.Background(), tmpl, env, res)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	out := make([]string, len(items))
	for i, item := range items {
		out[i] = string(item)
	}
	return res, out, nil
}

func TestResolveAgainstTheUpstreamFake(t *testing.T) {
	_, env := fake(t, 0)
	cases := []struct {
		cfg, list, date string
		items           []string
	}{
		{`{"list":"latest","subdomains":false,"offset":0,"limit":2}`, "BBBB", "2026-10-20",
			[]string{`{"domain":"google.com","rank":1}`, `{"domain":"cloudflare.com","rank":2}`}},
		{`{"list":"latest","subdomains":true,"offset":1,"limit":5}`, "CCCC", "2026-10-20",
			[]string{`{"domain":"mail.google.com","rank":2}`}},
		{`{"list":"2026-10-19","subdomains":false,"offset":2,"limit":1}`, "AAAA", "2026-10-19",
			[]string{`{"domain":"c.example","rank":3}`}},
		{`{"list":"AAAA","subdomains":true,"offset":3,"limit":1}`, "AAAA", "2026-10-19", []string{}},
	}
	for _, tc := range cases {
		res, items, err := resolve(t, NewWithAPIInterval(0), env, tc.cfg)
		if err != nil {
			t.Fatalf("%s: %v", tc.cfg, err)
		}
		var prov provenance
		if err := core.DecodeProvenance(res.Provenance, &prov); err != nil {
			t.Fatal(err)
		}
		if prov.ListID != tc.list || prov.Date != tc.date || !strings.HasSuffix(prov.SourceURL, fmt.Sprintf("/tranco/download/%s/%d", tc.list, offsetLimit(t, tc.cfg))) {
			t.Fatalf("%s: provenance %+v", tc.cfg, prov)
		}
		if fmt.Sprint(items) != fmt.Sprint(tc.items) || *res.ExpectedTotal != int64(len(tc.items)) {
			t.Fatalf("%s: items %v (expected total %d), want %v", tc.cfg, items, *res.ExpectedTotal, tc.items)
		}
	}
}

func offsetLimit(t *testing.T, cfg string) int64 {
	t.Helper()
	var c Config
	if err := json.Unmarshal([]byte(cfg), &c); err != nil {
		t.Fatal(err)
	}
	return c.Offset + c.Limit
}

func TestUnavailableInputs(t *testing.T) {
	_, env := fake(t, 0)
	for cfg, want := range map[string]string{
		`{"list":"ZZZZ","subdomains":false,"offset":0,"limit":1}`:       "unknown Tranco list id ZZZZ",
		`{"list":"2026-10-21","subdomains":false,"offset":0,"limit":1}`: "no Tranco list for 2026-10-21",
		`{"list":"2026-10-19","subdomains":true,"offset":0,"limit":1}`:  "no Tranco list for 2026-10-19",
	} {
		_, err := NewWithAPIInterval(0).Resolve(context.Background(), env, json.RawMessage(cfg))
		e, ok := core.AsError(err)
		if !ok || e.Type != api.ErrorValidation || e.Retryable || e.Message != want || core.ErrorPath(e) != "/list" {
			t.Errorf("%s: err %v, want %q", cfg, err, want)
		}
	}
}

func TestAPISpacing(t *testing.T) {
	// The fake answers 429 to /api/* requests closer than 300 ms; the template spaces them.
	_, env := fake(t, 300*time.Millisecond)
	tmpl := NewWithAPIInterval(300 * time.Millisecond)
	for range 3 {
		if _, err := tmpl.Resolve(context.Background(), env, json.RawMessage(`{"list":"latest","subdomains":false,"offset":0,"limit":1}`)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMalformedCSV(t *testing.T) {
	for csv, line := range map[string]int64{
		"1,a\r\n3,b\r\n":     2,
		"1,a\r\n2\r\n":       2,
		"x,a\r\n":            1,
		"1,\r\n":             1,
		"\r\n0,a\r\n":        2,
		"1,a\r\n2,b\xff\r\n": 2,
	} {
		_, err := scanRows(strings.NewReader(csv), 10, nil)
		e, ok := core.AsError(err)
		if !ok || e.Type != api.ErrorPlatform || !e.Retryable || e.Message != fmt.Sprintf("unexpected Tranco CSV at line %d", line) {
			t.Errorf("%q: err %v, want line %d", csv, err, line)
		}
	}
	rows, err := scanRows(strings.NewReader("1,a\n\n2,b,c\r\n3,c\r\n"), 2, nil)
	if err != nil || rows != 2 {
		t.Fatalf("rows %d err %v", rows, err)
	}
}

func TestRetriedDownloadFailure(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path == "/daily_list_id" {
			_, _ = w.Write([]byte("ABCD"))
			return
		}
		http.Error(w, "nope", http.StatusForbidden)
	}))
	defer srv.Close()
	env := core.Env{DataSources: map[string]string{"tranco": srv.URL}, TmpDir: t.TempDir()}
	_, err := NewWithAPIInterval(0).Resolve(context.Background(), env, json.RawMessage(`{"list":"2026-10-01","subdomains":false,"offset":0,"limit":1}`))
	e, ok := core.AsError(err)
	if !ok || e.Type != api.ErrorPlatform || !e.Retryable || !strings.Contains(e.Message, "403") {
		t.Fatalf("err %v", err)
	}
}

func TestValidate(t *testing.T) {
	cases := map[string]string{
		`{"list":"latest","subdomains":false,"offset":999999,"limit":1}`: "",
		`{"list":"latest","subdomains":false,"offset":999999,"limit":2}`: "/limit",
		`{"list":"2026-02-30","subdomains":false,"offset":0,"limit":1}`:  "/list",
	}
	for cfg, path := range cases {
		issues := New().Validate(json.RawMessage(cfg))
		if (path == "") != (len(issues) == 0) || (path != "" && issues[0].Path != path) {
			t.Errorf("%s: issues %v, want %q", cfg, issues, path)
		}
	}
}
