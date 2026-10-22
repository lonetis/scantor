package api

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTaskFileData(t *testing.T) {
	for _, tc := range []struct {
		data   []byte
		binary bool
		want   string
	}{
		{[]byte("héllo\n"), false, `"héllo\n"`},
		{[]byte("<b>&</b>"), false, `"<b>&</b>"`},
		{[]byte("a\x00b"), true, `{"base64":"YQBi"}`},
		{[]byte{0xff, 0xfe}, true, `{"base64":"//4="}`},
		{nil, false, `""`},
	} {
		d := NewTaskFileData(tc.data)
		got, err := marshalNoEscape(d)
		if err != nil || d.Binary() != tc.binary || string(got) != tc.want {
			t.Errorf("%q: binary %v, json %s, err %v; want %v %s", tc.data, d.Binary(), got, err, tc.binary, tc.want)
		}
	}
}

func TestTaskFileAndGitRequests(t *testing.T) {
	type seen struct {
		method, path, query, body string
	}
	var got []seen
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got = append(got, seen{r.Method, r.URL.Path, r.URL.RawQuery, string(body)})
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/tasks/import-git":
			_, _ = io.WriteString(w, `{"imported":[{"id":"t1","name":"echo"}],"candidates":[{"path":"tasks/echo","name":"echo","language":"python","exists":false}]}`)
		case "/api/tasks/echo/git/pull":
			_, _ = io.WriteString(w, `{"task":{"id":"t1","name":"echo"},"previousCommit":"a","commit":"b","changed":true}`)
		default:
			_, _ = io.WriteString(w, `{"written":["a.txt"],"deleted":["b.txt"],"workspace":{"packSha256":"ff","dirty":true}}`)
		}
	}))
	defer srv.Close()
	c := newTestClient(t, srv, Credential{Kind: PrincipalUser, Token: "sk_scantor_test"})
	ctx := context.Background()

	written, err := c.WriteTaskFiles(ctx, "echo", map[string]TaskFileData{"a.txt": NewTaskFileData([]byte("x"))})
	if err != nil || len(written.Written) != 1 || !written.Workspace.Dirty {
		t.Fatalf("write: %+v %v", written, err)
	}
	deleted, err := c.DeleteTaskFile(ctx, "echo", "dir/b.txt", true)
	if err != nil || deleted.Deleted[0] != "b.txt" || deleted.Workspace.PackSHA256 != "ff" {
		t.Fatalf("delete: %+v %v", deleted, err)
	}
	imported, err := c.ImportGitTask(ctx, ImportGitTask{URL: "https://example.com/r.git", Select: []string{"tasks/echo"}})
	if err != nil || imported.Imported[0].Name != "echo" || imported.Candidates[0].Path != "tasks/echo" {
		t.Fatalf("import: %+v %v", imported, err)
	}
	pulled, err := c.PullGitTask(ctx, "echo", PullGitTask{Force: true})
	if err != nil || !pulled.Changed || pulled.Commit != "b" {
		t.Fatalf("pull: %+v %v", pulled, err)
	}

	want := []seen{
		{"PUT", "/api/tasks/echo/files", "", `{"files":{"a.txt":"x"}}`},
		{"DELETE", "/api/tasks/echo/files", "path=dir%2Fb.txt&recursive=true", ""},
		{"POST", "/api/tasks/import-git", "", `{"url":"https://example.com/r.git","select":["tasks/echo"]}`},
		{"POST", "/api/tasks/echo/git/pull", "", `{"force":true}`},
	}
	if len(got) != len(want) {
		t.Fatalf("requests = %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("request %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}
