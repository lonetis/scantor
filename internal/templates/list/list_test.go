package list

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/templates/core"
	"github.com/lonetis/scantor/internal/templates/templatestest"
)

func items(t *testing.T, content string) ([]string, error) {
	t.Helper()
	var out []string
	err := forEachItem(strings.NewReader(content), func(_ int64, item []byte) bool {
		out = append(out, string(item))
		return true
	})
	return out, err
}

func TestTrimmingIsASCIIWhitespace(t *testing.T) {
	// Only ASCII whitespace is trimmed; Unicode spaces (NBSP, BOM, U+3000, U+2028) are content.
	got, err := items(t, "a\r\n \t\v\f\n\u00A0b\u3000\n\uFEFF\n  d e  \r\n\r\n")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"a", "\u00A0b\u3000", "\uFEFF", "d e"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %q, want %q", got, want)
	}
	if Trim(" \t x y \r\n") != "x y" || Trim("\u00A0x") != "\u00A0x" {
		t.Fatal("Trim")
	}
}

// orchestratorLines is the line count of the orchestrator's upload LineCounter
// (orchestrator/server/services/uploads): lines that contain a byte other than ASCII whitespace.
func orchestratorLines(content []byte) int64 {
	var n int64
	current := false
	for _, b := range content {
		switch b {
		case '\n':
			if current {
				n++
			}
			current = false
		case ' ', '\t', '\r', '\v', '\f':
		default:
			current = true
		}
	}
	if current {
		n++
	}
	return n
}

func TestItemCountMatchesTheOrchestratorLineCount(t *testing.T) {
	alphabet := []byte{'a', ' ', '\t', '\r', '\n', '\v', '\f', 0xC2, 0xA0, 0xEF, 0xBB, 0xBF}
	rng := rand.New(rand.NewPCG(1, 2))
	for range 2000 {
		content := make([]byte, rng.IntN(64))
		for i := range content {
			content[i] = alphabet[rng.IntN(len(alphabet))]
		}
		got, err := items(t, string(content))
		if err != nil {
			t.Fatal(err)
		}
		if int64(len(got)) != orchestratorLines(content) {
			t.Fatalf("%q: %d items, the orchestrator counts %d lines", content, len(got), orchestratorLines(content))
		}
	}
}

func TestLongLines(t *testing.T) {
	item := strings.Repeat("x", MaxItemBytes)
	space := strings.Repeat(" ", 200<<10) // longer than the reader buffer
	cases := []struct {
		name    string
		content string
		want    []string
		tooLong int64
	}{
		{"exactly the maximum", item + "\n", []string{item}, 0},
		{"one byte over", item + "x\n", nil, 1},
		{"padded far beyond the buffer", space + item + space + "\r\nnext", []string{item, "next"}, 0},
		{"only whitespace beyond the buffer", "a\n" + space + "\n", []string{"a"}, 0},
		{"long content beyond the buffer", "a\n" + strings.Repeat("y", 100<<10) + "\n", nil, 2},
		{"inner whitespace makes it too long", "a\n" + "x" + space + "y\n", nil, 2},
		{"multibyte runes across chunks are content", strings.Repeat(" ", 64<<10-1) + "\u00A0\u00E9" + strings.Repeat(" ", 64<<10) + "\n", []string{"\u00A0\u00E9"}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := items(t, tc.content)
			var tooLong *errItemTooLong
			if tc.tooLong > 0 {
				if !errors.As(err, &tooLong) || tooLong.line != tc.tooLong {
					t.Fatalf("err %v, want line %d too long", err, tc.tooLong)
				}
				return
			}
			if err != nil || fmt.Sprint(got) != fmt.Sprint(tc.want) {
				t.Fatalf("got %d items %v", len(got), err)
			}
		})
	}
}

type uploadServer struct {
	*httptest.Server
	content map[string]string
	status  int
}

func newUploadServer(t *testing.T, content map[string]string) *uploadServer {
	t.Helper()
	us := &uploadServer{content: content}
	us.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if us.status != 0 {
			w.WriteHeader(us.status)
			return
		}
		body, ok := us.content[strings.TrimPrefix(r.URL.Path, "/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(us.Close)
	return us
}

func (us *uploadServer) env(t *testing.T, lines map[string]int64) core.Env {
	t.Helper()
	uploads := map[string]core.Upload{}
	for id, body := range us.content {
		sum := sha256.Sum256([]byte(body))
		uploads[id] = core.Upload{URL: us.URL + "/" + id + "?X-Amz-Signature=s3cr3t", SHA256: hex.EncodeToString(sum[:]), Bytes: int64(len(body)), Lines: lines[id]}
	}
	return core.Env{Uploads: uploads, TmpDir: t.TempDir()}
}

func TestEstimateMatchesStream(t *testing.T) {
	const id = "7b0c6e2a-1f3d-4c5e-9a8b-0d1e2f3a4b5c"
	content := "a\n\n b \r\nc\n\n\nd\ne"
	us := newUploadServer(t, map[string]string{id: content})
	env := us.env(t, map[string]int64{id: 5})
	for _, cfg := range []string{
		`{"items":["x","  ","y"],"upload":"%s","offset":0,"limit":null}`,
		`{"items":["x"],"upload":"%s","offset":3,"limit":2}`,
		`{"items":[],"upload":"%s","offset":10,"limit":null}`,
		`{"items":["x","y"],"upload":"%s","offset":0,"limit":1}`,
	} {
		raw := json.RawMessage(fmt.Sprintf(cfg, id))
		est, err := New().Estimate(raw, env)
		if err != nil {
			t.Fatal(err)
		}
		res, err := New().Resolve(context.Background(), env, raw)
		if err != nil {
			t.Fatal(err)
		}
		got, err := templatestest.Collect(context.Background(), New(), env, res)
		if err != nil {
			t.Fatal(err)
		}
		if *est.ExpectedTotal != int64(len(got)) || *res.ExpectedTotal != int64(len(got)) {
			t.Fatalf("%s: estimate %d, resolution %d, stream %d", raw, *est.ExpectedTotal, *res.ExpectedTotal, len(got))
		}
	}
}

func TestUploadFailures(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000001"
	raw := json.RawMessage(fmt.Sprintf(`{"items":[],"upload":"%s","offset":0,"limit":null}`, id))
	check := func(t *testing.T, err error, typ api.ErrorType, retryable bool, contains string) {
		t.Helper()
		e, ok := core.AsError(err)
		if !ok || e.Type != typ || e.Retryable != retryable || !strings.Contains(e.Message, contains) || strings.Contains(e.Message, "s3cr3t") {
			t.Fatalf("err %v, want %s retryable=%t containing %q", err, typ, retryable, contains)
		}
	}
	t.Run("sha256 differs from the record", func(t *testing.T) {
		us := newUploadServer(t, map[string]string{id: "a\nb\n"})
		env := us.env(t, nil)
		u := env.Uploads[id]
		u.SHA256 = strings.Repeat("0", 64)
		env.Uploads[id] = u
		_, err := New().Resolve(context.Background(), env, raw)
		check(t, err, api.ErrorValidation, false, "does not match its recorded sha256")
	})
	t.Run("object gone", func(t *testing.T) {
		us := newUploadServer(t, map[string]string{id: "a\n"})
		env := us.env(t, nil)
		us.content = map[string]string{}
		_, err := New().Resolve(context.Background(), env, raw)
		check(t, err, api.ErrorValidation, false, "is not available")
	})
	t.Run("expired presigned URL", func(t *testing.T) {
		us := newUploadServer(t, map[string]string{id: "a\n"})
		env := us.env(t, nil)
		us.status = http.StatusForbidden
		_, err := New().Resolve(context.Background(), env, raw)
		check(t, err, api.ErrorPlatform, true, "403")
	})
	t.Run("item too long", func(t *testing.T) {
		us := newUploadServer(t, map[string]string{id: "ok\n\n" + strings.Repeat("z", MaxItemBytes+1) + "\n"})
		_, err := New().Resolve(context.Background(), us.env(t, nil), raw)
		check(t, err, api.ErrorValidation, false, "line 3 of upload exceeds 4096 bytes")
	})
	t.Run("larger than recorded", func(t *testing.T) {
		us := newUploadServer(t, map[string]string{id: "a\n"})
		env := us.env(t, nil)
		us.content[id] = "a\nb\nc\n"
		_, err := New().Resolve(context.Background(), env, raw)
		check(t, err, api.ErrorPlatform, false, "size limit")
	})
	t.Run("not available in local mode", func(t *testing.T) {
		env := core.Env{Uploads: map[string]core.Upload{id: {}}, TmpDir: t.TempDir()}
		_, err := New().Resolve(context.Background(), env, raw)
		check(t, err, api.ErrorValidation, false, "not available here")
	})
}

func TestLimitStopsBeforeTheUpload(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000002"
	us := newUploadServer(t, map[string]string{id: "u\n"})
	env := us.env(t, map[string]int64{id: 1})
	raw := json.RawMessage(fmt.Sprintf(`{"items":["a","b"],"upload":"%s","offset":0,"limit":2}`, id))
	res, err := New().Resolve(context.Background(), env, raw)
	if err != nil {
		t.Fatal(err)
	}
	us.status = http.StatusInternalServerError // the stream must not need the upload
	got, err := templatestest.Collect(context.Background(), New(), core.Env{Uploads: env.Uploads, TmpDir: t.TempDir()}, res)
	if err != nil || len(got) != 2 {
		t.Fatalf("%s %v", got, err)
	}
}
