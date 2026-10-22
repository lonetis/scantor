package upload

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/runtime/bootstrap"
	"github.com/lonetis/scantor/internal/runtime/internal/fakeapi"
	"github.com/lonetis/scantor/internal/runtime/scerr"
)

func setup(t *testing.T) (*fakeapi.Server, *Uploader, []File) {
	t.Helper()
	srv := fakeapi.New()
	t.Cleanup(srv.Close)
	policy := api.Policy{EnforcePlaintext: true}
	c, err := api.New(api.Options{BaseURL: srv.URL, Credential: api.Credential{Kind: api.PrincipalWorker, Token: fakeapi.Token("7c6d5e4f-3a2b-4c1d-9e0f-8a7b6c5d4e3f")}, Policy: policy})
	if err != nil {
		t.Fatal(err)
	}
	httpClient, err := policy.HTTPClient()
	if err != nil {
		t.Fatal(err)
	}
	u := &Uploader{Presigner: bootstrap.NewClient(c, bootstrap.NewClock(), nil), HTTP: httpClient, Policy: policy, Timeout: 5 * time.Second}
	dir := t.TempDir()
	var files []File
	for i, content := range []string{"abc", "", strings.Repeat("z", 100000)} {
		p := filepath.Join(dir, strconv.Itoa(i))
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		files = append(files, File{ID: fakeapi.NewID(), Name: "f" + strconv.Itoa(i) + ".bin", Path: p, Size: int64(len(content)), SHA256: strings.Repeat("0", 64), ContentType: "application/octet-stream"})
	}
	return srv, u, files
}

func TestUpload(t *testing.T) {
	srv, u, files := setup(t)
	target := Target{Seq: 4, Round: 1, Attempt: 2, ExecutionID: "e1"}
	if err := u.Upload(context.Background(), target, files); err != nil {
		t.Fatal(err)
	}
	srv.Snapshot(func(s *fakeapi.Server) {
		if len(s.PresignReqs) != 1 || len(s.PresignReqs[0].Files) != 3 || s.PresignReqs[0].Seq != 4 || s.PresignReqs[0].ExecutionID != "e1" {
			t.Fatalf("presign %+v", s.PresignReqs)
		}
		for _, f := range files {
			put, ok := s.Puts["e1/"+f.ID]
			if !ok {
				t.Fatalf("no PUT for %s", f.Name)
			}
			if int64(len(put.Body)) != f.Size || put.Headers.Get("Content-Type") != "application/octet-stream" || put.Headers.Get("Authorization") != "" {
				t.Fatalf("PUT %s: %d bytes, headers %v", f.Name, len(put.Body), put.Headers)
			}
		}
	})
}

func TestUploadDeterministicFailures(t *testing.T) {
	cases := map[string]struct {
		presign func(api.PresignRequest) (any, int)
		put     int
		check   func(*testing.T, scerr.ScantorError)
	}{
		"validationFailed": {
			presign: func(api.PresignRequest) (any, int) {
				return map[string]any{"error": map[string]any{"code": "validationFailed", "message": "duplicate fileId"}}, http.StatusBadRequest
			},
			check: func(t *testing.T, e scerr.ScantorError) {
				if e.Type != api.ErrorValidation || e.Retryable || e.Phase != api.PhaseUpload || e.Message != "duplicate fileId" {
					t.Fatalf("%+v", e)
				}
			},
		},
		"quotaExceeded": {
			presign: func(api.PresignRequest) (any, int) {
				return map[string]any{"error": map[string]any{"code": "quotaExceeded", "message": "quota"}}, http.StatusForbidden
			},
			check: func(t *testing.T, e scerr.ScantorError) {
				if e.Type != api.ErrorPlatform || e.Retryable || e.Message != "storage quota exceeded" {
					t.Fatalf("%+v", e)
				}
			},
		},
		"put4xx": {
			put: http.StatusBadRequest,
			check: func(t *testing.T, e scerr.ScantorError) {
				if e.Type != api.ErrorPlatform || e.Retryable || !strings.Contains(e.Message, "HTTP 400") {
					t.Fatalf("%+v", e)
				}
			},
		},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			srv, u, files := setup(t)
			srv.Snapshot(func(s *fakeapi.Server) { s.Presign, s.PutStatus = c.presign, c.put })
			err := u.Upload(context.Background(), Target{Seq: 1, Round: 1, Attempt: 1, ExecutionID: "e"}, files)
			var se scerr.ScantorError
			if !errors.As(err, &se) {
				t.Fatalf("err = %v", err)
			}
			c.check(t, se)
		})
	}
}

func TestUploadRefusedURLAndTransientBudget(t *testing.T) {
	srv, u, files := setup(t)
	srv.Snapshot(func(s *fakeapi.Server) {
		s.Presign = func(req api.PresignRequest) (any, int) {
			resp := s.DefaultPresign(req)
			for i := range resp.Files {
				resp.Files[i].URL = "http://203.0.113.9/bucket/key"
			}
			return resp, http.StatusOK
		}
	})
	err := u.Upload(context.Background(), Target{Seq: 1, Round: 1, Attempt: 1, ExecutionID: "e"}, files)
	var se scerr.ScantorError
	if !errors.As(err, &se) || !strings.Contains(se.Message, "transport policy") {
		t.Fatalf("refused URL: %v", err)
	}

	srv.Snapshot(func(s *fakeapi.Server) { s.Presign, s.PutStatus = nil, http.StatusServiceUnavailable })
	var transient atomic.Int32
	u.OnTransient = func(error) { transient.Add(1) }
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err = u.Upload(ctx, Target{Seq: 1, Round: 1, Attempt: 1, ExecutionID: "e"}, files)
	var te *TransientError
	if !errors.As(err, &te) || transient.Load() == 0 {
		t.Fatalf("budget exhausted: %v (%d transient failures)", err, transient.Load())
	}
}

func TestUploadRepresignsExpiredURLs(t *testing.T) {
	srv, u, files := setup(t)
	calls := 0
	srv.Snapshot(func(s *fakeapi.Server) {
		s.Presign = func(req api.PresignRequest) (any, int) {
			calls++
			resp := s.DefaultPresign(req)
			if calls == 1 {
				for i := range resp.Files {
					resp.Files[i].ExpiresAt = api.NewTime(time.Now().Add(-time.Minute))
				}
			}
			return resp, http.StatusOK
		}
	})
	if err := u.Upload(context.Background(), Target{Seq: 1, Round: 1, Attempt: 1, ExecutionID: "e"}, files); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("%d presign calls", calls)
	}
}
