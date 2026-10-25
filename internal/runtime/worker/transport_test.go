package worker

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/runtime"
)

// recorder is a base transport that answers every request with 200 and records its URL.
type recorder struct{ urls []string }

func (r *recorder) RoundTrip(req *http.Request) (*http.Response, error) {
	r.urls = append(r.urls, req.URL.String())
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("")), Request: req}, nil
}

// The presigned GETs of uploaded lists follow the transport rule (docs/runtime.md §4.2): plaintext to a public
// peer is refused, also after a redirect, with a non-retryable platform error that does not carry the signature.
func TestUploadDownloadsFollowTheTransportRule(t *testing.T) {
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "a.example\n") }))
	defer local.Close()
	const public = "http://203.0.113.10:9000/scantor/list?X-Amz-Signature=secret"
	policy := api.Policy{EnforcePlaintext: true}
	base := &recorder{}
	rt := withUploadRule(base, policy, []string{public, local.URL + "/list?X-Amz-Signature=secret", "https://s3.example/list"})

	get := func(raw string, via *http.Request) (*http.Response, error) {
		req, err := http.NewRequest(http.MethodGet, raw, nil)
		if err != nil {
			t.Fatal(err)
		}
		if via != nil {
			req.Response = &http.Response{Request: via}
		}
		return rt.RoundTrip(req)
	}
	refused := func(what string, err error) {
		t.Helper()
		e, ok := runtime.AsError(err)
		if !errors.Is(err, api.ErrPlaintextRefused) || !ok || e.Type != api.ErrorPlatform || e.Retryable || strings.Contains(err.Error(), "secret") {
			t.Fatalf("%s: %v", what, err)
		}
	}

	_, err := get(public, nil)
	refused("public plaintext upload", err)
	upload, _ := http.NewRequest(http.MethodGet, "https://s3.example/list", nil)
	_, err = get("http://203.0.113.10:9000/elsewhere", upload)
	refused("a redirect from an upload URL to public plaintext", err)

	resp, err := get(local.URL+"/list?X-Amz-Signature=secret", nil)
	if err != nil {
		t.Fatalf("private plaintext upload: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if string(body) != "a.example\n" {
		t.Fatalf("private plaintext upload: %q", body)
	}
	for _, raw := range []string{"https://s3.example/list", "http://203.0.113.20/tranco/top-1m.csv"} {
		if _, err := get(raw, nil); err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
	}
	if len(base.urls) != 2 {
		t.Fatalf("the base transport saw %v: want the https upload and the data source only", base.urls)
	}

	if got := withUploadRule(base, api.Policy{EnforcePlaintext: true, AllowInsecure: true}, []string{public}); got != http.RoundTripper(base) {
		t.Fatal("SCANTOR_ALLOW_INSECURE_TRANSPORT=true still applies the rule")
	}
	if got := withUploadRule(base, policy, nil); got != http.RoundTripper(base) {
		t.Fatal("a scheduler without uploads changed its transport")
	}
}
