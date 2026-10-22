package cli

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/api"
)

const apiUploadID = "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d"

func apiUploadFixture(name string) map[string]any {
	return map[string]any{"id": apiUploadID, "kind": "list", "name": name, "contentType": "text/plain", "bytes": 24,
		"sha256": "77aa", "lines": 2, "lastUsedAt": nil, "createdAt": "2026-10-21T10:00:00.000Z"}
}

func TestAPIUploads(t *testing.T) {
	f := newAPIFake(t)
	f.reply("POST", "/api/uploads", 201, apiUploadFixture("domains.txt"))
	list := filepath.Join(t.TempDir(), "domains.txt")
	if err := os.WriteFile(list, []byte("example.org\nexample.net\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	code, out, errOut := f.exec("uploads", "create", list)
	req := f.last("POST", "/api/uploads")
	if code != 0 || !strings.Contains(out, `{"upload": "`+apiUploadID+`"}`) || string(req.Body) != "example.org\nexample.net\n" ||
		req.Query.Get("name") != "domains.txt" || req.Query.Get("kind") != "list" || req.Header.Get("Content-Type") != "text/plain" {
		t.Fatalf("create: exit %d, out %q, err %q, request %+v", code, out, errOut, req)
	}

	code, out, _ = f.execIn("a\nb\n", "uploads", "create", "-", "--name", "piped", "-o", "json")
	req = f.last("POST", "/api/uploads")
	if code != 0 || apiDecode[api.Upload](t, []byte(out)).ID != apiUploadID || string(req.Body) != "a\nb\n" || req.Query.Get("name") != "piped" {
		t.Fatalf("stdin: exit %d, out %q, request %+v", code, out, req)
	}
	before := f.count()
	for _, bad := range []string{filepath.Join(t.TempDir(), "missing.txt"), t.TempDir()} {
		if code, _, _ := f.exec("uploads", "create", bad); code != ExitValidation || f.count() != before {
			t.Fatalf("%s: exit %d", bad, code)
		}
	}

	f.reply("GET", "/api/uploads", 200, map[string]any{"items": []any{apiUploadFixture("domains.txt")}, "nextCursor": nil})
	if code, out, _ := f.exec("uploads", "list", "--limit", "5"); code != 0 || !strings.Contains(out, "domains.txt") || f.last("GET", "/api/uploads").Query.Get("limit") != "5" {
		t.Fatalf("list: exit %d, out %q", code, out)
	}
	f.reply("GET", "/api/uploads/"+apiUploadID, 200, apiUploadFixture(""))
	if code, out, _ := f.exec("uploads", "get", apiUploadID); code != 0 || !strings.Contains(out, "2 lines") {
		t.Fatalf("get: exit %d, out %q", code, out)
	}

	f.fail("DELETE", "/api/uploads/"+apiUploadID, 409, "uploadInUse", "a scan references the upload", nil)
	if code, _, errOut := f.exec("uploads", "delete", apiUploadID); code != ExitValidation || !strings.Contains(errOut, "delete the scans") {
		t.Fatalf("in use: exit %d, %q", code, errOut)
	}
	f.on("DELETE", "/api/uploads/"+apiUploadID, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	if code, out, _ := f.exec("uploads", "delete", apiUploadID, "-o", "json"); code != 0 || !strings.Contains(out, `"deleted": true`) {
		t.Fatalf("delete: exit %d, out %q", code, out)
	}
}
