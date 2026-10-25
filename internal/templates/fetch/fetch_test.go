package fetch

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/templates/core"
)

func init() {
	// Keep the retry tests fast; the policy constants themselves are asserted in TestPolicyConstants.
	retryDelays = []time.Duration{10 * time.Millisecond, 20 * time.Millisecond}
}

func testEnv(t *testing.T) core.Env {
	t.Helper()
	return core.Env{TmpDir: t.TempDir(), Now: func() time.Time { return time.Date(2026, 10, 21, 10, 0, 3, 120e6, time.UTC) }}
}

func gz(t *testing.T, data string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(data)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func sha(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func TestPolicyConstants(t *testing.T) {
	if ConnectTimeout != 10*time.Second || RequestTimeout != 10*time.Minute || Attempts != 3 || MaxRedirects != 5 ||
		MaxRetryAfter != time.Minute || MaxDownloadBytes != 64<<20 || MaxDecodedBytes != 256<<20 {
		t.Fatal("the HTTP policy constants differ from docs/templates.md §7.2")
	}
}

func TestDownloadDecodesCachesAndHashes(t *testing.T) {
	const csv = "origin,rank\nhttps://a.example,1000\n"
	var hits atomic.Int32
	var agent atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		agent.Store(r.UserAgent())
		switch r.URL.Path {
		case "/file.csv.gz": // a gzip file, like raw.githubusercontent.com
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write(gz(t, csv))
		case "/encoded.csv.gz": // the same file already decoded by Content-Encoding
			if r.Header.Get("Accept-Encoding") != "gzip" {
				t.Errorf("Accept-Encoding = %q", r.Header.Get("Accept-Encoding"))
			}
			w.Header().Set("Content-Encoding", "gzip")
			_, _ = w.Write(gz(t, csv))
		}
	}))
	defer srv.Close()
	env := testEnv(t)
	for _, p := range []string{"/file.csv.gz", "/encoded.csv.gz"} {
		f, err := Download(context.Background(), env, Request{URL: srv.URL + p, Gunzip: true})
		if err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(f.Path)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != csv || f.SHA256 != sha(csv) || f.Size != int64(len(csv)) {
			t.Fatalf("%s: got %q sha %s size %d", p, data, f.SHA256, f.Size)
		}
		if core.FormatTime(f.FetchedAt) != "2026-10-21T10:00:03.120Z" {
			t.Fatalf("fetchedAt %v", f.FetchedAt)
		}
	}
	if !strings.HasPrefix(agent.Load().(string), "scantor/") || !strings.HasSuffix(agent.Load().(string), "(+https://github.com/lonetis/scantor)") {
		t.Fatalf("User-Agent %q", agent.Load())
	}
	// Cached: a second download of the same URL does not hit the server.
	before := hits.Load()
	if _, err := Download(context.Background(), env, Request{URL: srv.URL + "/file.csv.gz", Gunzip: true}); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != before {
		t.Fatal("the cached download was fetched again")
	}
	// Another scratch directory (a new scheduler) downloads again.
	if _, err := Download(context.Background(), testEnv(t), Request{URL: srv.URL + "/file.csv.gz", Gunzip: true}); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != before+1 {
		t.Fatal("a fresh TmpDir must download again")
	}
}

func TestConcurrentDownloadsShareOneRequest(t *testing.T) {
	var hits atomic.Int32
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		<-release
		_, _ = w.Write([]byte("1,a.example\r\n"))
	}))
	defer srv.Close()
	env := testEnv(t)
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			if _, err := Download(context.Background(), env, Request{URL: srv.URL + "/x"}); err != nil {
				t.Error(err)
			}
		})
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if hits.Load() != 1 {
		t.Fatalf("%d requests, want 1", hits.Load())
	}
}

// A caller that gives up stops waiting with its own error; the shared download goes on for the others
// and stops only when nobody waits any more.
func TestSharedDownloadOutlivesACancelledCaller(t *testing.T) {
	var hits atomic.Int32
	release := make(chan struct{})
	aborted := make(chan struct{}, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		select {
		case <-release:
			_, _ = w.Write([]byte("1,a.example\r\n"))
		case <-r.Context().Done():
			aborted <- struct{}{}
		}
	}))
	defer srv.Close()
	defer close(release)
	env := testEnv(t)
	req := Request{URL: srv.URL + "/x"}

	first, cancelFirst := context.WithCancel(context.Background())
	firstDone := make(chan error, 1)
	go func() {
		_, err := Download(first, env, req)
		firstDone <- err
	}()
	for hits.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	second := make(chan error, 1)
	go func() {
		_, err := Download(context.Background(), env, req)
		second <- err
	}()
	time.Sleep(20 * time.Millisecond)
	cancelFirst()
	if err := <-firstDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("the cancelled caller got %v", err)
	}
	release <- struct{}{}
	if err := <-second; err != nil {
		t.Fatalf("the other caller failed with the first caller's cancellation: %v", err)
	}
	if hits.Load() != 1 {
		t.Fatalf("%d requests, want 1", hits.Load())
	}

	// Every caller gives up: the request is cancelled, and the next caller starts a new download.
	other := Request{URL: srv.URL + "/y"}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := Download(ctx, env, other)
		done <- err
	}()
	for hits.Load() == 1 {
		time.Sleep(time.Millisecond)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
	select {
	case <-aborted:
	case <-time.After(5 * time.Second):
		t.Fatal("the download went on without a caller")
	}
	go func() { release <- struct{}{} }()
	if _, err := Download(context.Background(), env, other); err != nil {
		t.Fatalf("a new caller after the cancellation: %v", err)
	}
}

func TestRetries(t *testing.T) {
	t.Run("5xx then success", func(t *testing.T) {
		var hits atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			if hits.Add(1) < 3 {
				http.Error(w, "busy", http.StatusBadGateway)
				return
			}
			_, _ = w.Write([]byte("ok"))
		}))
		defer srv.Close()
		resp, err := Text(context.Background(), testEnv(t), Request{URL: srv.URL})
		if err != nil || string(resp.Body) != "ok" || hits.Load() != 3 {
			t.Fatalf("resp %+v err %v hits %d", resp, err, hits.Load())
		}
	})
	t.Run("exhausted", func(t *testing.T) {
		var hits atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			hits.Add(1)
			http.Error(w, "down", http.StatusServiceUnavailable)
		}))
		defer srv.Close()
		_, err := Download(context.Background(), testEnv(t), Request{URL: srv.URL + "/download/X/1"})
		e, ok := core.AsError(err)
		if !ok || e.Type != api.ErrorPlatform || !e.Retryable || e.Message != "GET "+srv.URL+"/download/X/1: 503 Service Unavailable" {
			t.Fatalf("err %v", err)
		}
		if hits.Load() != Attempts {
			t.Fatalf("%d tries, want %d", hits.Load(), Attempts)
		}
	})
	t.Run("429 honours Retry-After", func(t *testing.T) {
		var hits atomic.Int32
		var first time.Time
		var gap time.Duration
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			if hits.Add(1) == 1 {
				first = time.Now()
				w.Header().Set("Retry-After", "1")
				w.WriteHeader(http.StatusTooManyRequests)
				return
			}
			gap = time.Since(first)
			_, _ = w.Write([]byte("ok"))
		}))
		defer srv.Close()
		if _, err := Text(context.Background(), testEnv(t), Request{URL: srv.URL}); err != nil {
			t.Fatal(err)
		}
		if gap < 900*time.Millisecond {
			t.Fatalf("retried after %v despite Retry-After: 1", gap)
		}
	})
	t.Run("network error", func(t *testing.T) {
		srv := httptest.NewServer(http.NotFoundHandler())
		url := srv.URL
		srv.Close()
		_, err := Text(context.Background(), testEnv(t), Request{URL: url})
		e, ok := core.AsError(err)
		if !ok || e.Type != api.ErrorPlatform || !e.Retryable {
			t.Fatalf("err %v", err)
		}
	})
	t.Run("4xx is an answer", func(t *testing.T) {
		var hits atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			hits.Add(1)
			http.NotFound(w, nil)
		}))
		defer srv.Close()
		resp, err := Text(context.Background(), testEnv(t), Request{URL: srv.URL})
		if err != nil || resp.StatusCode != 404 || hits.Load() != 1 {
			t.Fatalf("resp %+v err %v hits %d", resp, err, hits.Load())
		}
		_, err = Download(context.Background(), testEnv(t), Request{URL: srv.URL + "/f"})
		var serr *StatusError
		if !errors.As(err, &serr) || serr.StatusCode != 404 {
			t.Fatalf("err %v", err)
		}
	})
	t.Run("Final accepts a 503 answer", func(t *testing.T) {
		var hits atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			hits.Add(1)
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("null"))
		}))
		defer srv.Close()
		resp, err := Text(context.Background(), testEnv(t), Request{URL: srv.URL, Final: func(status int, body []byte) bool {
			return status == 503 && string(body) == "null"
		}})
		if err != nil || resp.StatusCode != 503 || string(resp.Body) != "null" || hits.Load() != 1 {
			t.Fatalf("resp %+v err %v hits %d", resp, err, hits.Load())
		}
	})
	t.Run("cancelled context", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "down", http.StatusInternalServerError)
		}))
		defer srv.Close()
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := Text(ctx, testEnv(t), Request{URL: srv.URL}); !errors.Is(err, context.Canceled) {
			t.Fatalf("err %v", err)
		}
	})
}

func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 10, 21, 10, 0, 0, 0, time.UTC)
	cases := map[string]time.Duration{
		"":                              0,
		"3":                             3 * time.Second,
		"3600":                          MaxRetryAfter,
		"-1":                            0,
		"soon":                          0,
		"Wed, 21 Oct 2026 10:00:10 GMT": 10 * time.Second,
		"Wed, 21 Oct 2026 11:00:00 GMT": MaxRetryAfter,
		"Wed, 21 Oct 2026 09:00:00 GMT": 0,
	}
	for in, want := range cases {
		if got := parseRetryAfter(in, now); got != want {
			t.Errorf("parseRetryAfter(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestSizeCaps(t *testing.T) {
	big := strings.Repeat("a", 4096)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/plain":
			_, _ = w.Write([]byte(big))
		case "/bomb":
			_, _ = w.Write(gz(t, big))
		}
	}))
	defer srv.Close()
	check := func(err error) {
		t.Helper()
		e, ok := core.AsError(err)
		if !ok || e.Type != api.ErrorPlatform || e.Retryable || !strings.Contains(e.Message, "size limit") {
			t.Fatalf("want a non-retryable size error, got %v", err)
		}
	}
	_, err := Download(context.Background(), testEnv(t), Request{URL: srv.URL + "/plain", MaxBytes: 1000})
	check(err)
	// The compressed file is small, its content is not.
	_, err = Download(context.Background(), testEnv(t), Request{URL: srv.URL + "/bomb", Gunzip: true, MaxDecoded: 1000})
	check(err)
	if _, err := Download(context.Background(), testEnv(t), Request{URL: srv.URL + "/bomb", Gunzip: true, MaxDecoded: 4096}); err != nil {
		t.Fatalf("exactly at the cap: %v", err)
	}
}

func TestRedirects(t *testing.T) {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, err := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/"))
		if err != nil || n == 0 {
			_, _ = w.Write([]byte("done"))
			return
		}
		http.Redirect(w, r, srv.URL+"/"+strconv.Itoa(n-1), http.StatusFound)
	}))
	defer srv.Close()
	client, err := NewHTTPClient("")
	if err != nil {
		t.Fatal(err)
	}
	env := testEnv(t)
	env.HTTP = client
	if resp, err := Text(context.Background(), env, Request{URL: srv.URL + "/5"}); err != nil || string(resp.Body) != "done" {
		t.Fatalf("5 redirects: %v", err)
	}
	if _, err := Text(context.Background(), env, Request{URL: srv.URL + "/6"}); err == nil {
		t.Fatal("6 redirects were followed")
	}
}

func TestPresignedURLNotInMessages(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusInternalServerError)
	}))
	defer srv.Close()
	url := srv.URL + "/uploads/x?X-Amz-Signature=secret"
	_, err := Download(context.Background(), testEnv(t), Request{URL: url, Label: "upload x"})
	if err == nil || strings.Contains(err.Error(), "secret") || !strings.Contains(err.Error(), "upload x") {
		t.Fatalf("err %v", err)
	}
	srv.Close()
	_, err = Download(context.Background(), testEnv(t), Request{URL: url, Label: "upload x"})
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("err %v", err)
	}
}

func TestDownloadNeedsTmpDir(t *testing.T) {
	_, err := Download(context.Background(), core.Env{}, Request{URL: "http://127.0.0.1:1/x"})
	if e, ok := core.AsError(err); !ok || e.Type != api.ErrorPlatform || e.Retryable {
		t.Fatalf("err %v", err)
	}
}

func TestSpacer(t *testing.T) {
	s := NewSpacer(50 * time.Millisecond)
	start := time.Now()
	var wg sync.WaitGroup
	var inFlight, maxInFlight atomic.Int32
	for range 3 {
		wg.Go(func() {
			release, err := s.Acquire(context.Background())
			if err != nil {
				t.Error(err)
				return
			}
			if n := inFlight.Add(1); n > maxInFlight.Load() {
				maxInFlight.Store(n)
			}
			time.Sleep(10 * time.Millisecond)
			inFlight.Add(-1)
			release()
		})
	}
	wg.Wait()
	if d := time.Since(start); d < 130*time.Millisecond || maxInFlight.Load() != 1 {
		t.Fatalf("three requests within %v, %d at once", d, maxInFlight.Load())
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	busy := NewSpacer(time.Hour)
	release, err := busy.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	release()
	if _, err := busy.Acquire(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled wait: %v", err)
	}
}
