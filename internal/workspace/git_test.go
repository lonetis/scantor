package workspace

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// gitServer is a smart-HTTP git server over TLS: git http-backend behind httptest. Its certificate is
// valid for example.com, which tests pin to 127.0.0.1 through the Git lookup function, so a clone only
// succeeds when git connects to the pinned address (http.curloptResolve).
type gitServer struct {
	srv   *httptest.Server
	root  string
	caPEM string
	// auth is the Authorization header the server requires ("" = none).
	auth string

	mu       sync.Mutex
	requests []string
}

const gitHost = "example.com"

func newGitServer(t *testing.T) *gitServer {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	execPath := strings.TrimSpace(runGit(t, "", "--exec-path"))
	backend := filepath.Join(execPath, "git-http-backend")
	if _, err := os.Stat(backend); err != nil {
		t.Skipf("git-http-backend is not available: %v", err)
	}
	s := &gitServer{root: t.TempDir()}
	cgiHandler := &cgi.Handler{
		Path:       backend,
		Env:        []string{"GIT_PROJECT_ROOT=" + s.root, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null"},
		InheritEnv: []string{"PATH"},
	}
	s.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.requests = append(s.requests, r.URL.Path)
		s.mu.Unlock()
		if rest, ok := strings.CutPrefix(r.URL.Path, "/redirect.git/"); ok {
			http.Redirect(w, r, "/repo.git/"+rest+"?"+r.URL.RawQuery, http.StatusFound)
			return
		}
		if s.auth != "" && r.Header.Get("Authorization") != s.auth {
			w.Header().Set("WWW-Authenticate", `Basic realm="git"`)
			http.Error(w, "authentication required", http.StatusUnauthorized)
			return
		}
		cgiHandler.ServeHTTP(w, r)
	}))
	t.Cleanup(s.srv.Close)
	s.caPEM = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: s.srv.Certificate().Raw}))
	return s
}

// url returns the repository URL with the pinned host name.
func (s *gitServer) url(repo string) string {
	u, err := url.Parse(s.srv.URL)
	if err != nil {
		panic(err)
	}
	return fmt.Sprintf("https://%s:%s/%s", gitHost, u.Port(), repo)
}

func (s *gitServer) hostPort() string {
	u, _ := url.Parse(s.url("x"))
	return u.Host
}

func (s *gitServer) resetRequests() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = nil
}

func (s *gitServer) served(prefix string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.ContainsFunc(s.requests, func(p string) bool { return strings.HasPrefix(p, prefix) })
}

// runGit runs git with a neutral configuration and fixed identity.
func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

// testRepo is a work tree pushed to a bare repository of a gitServer.
type testRepo struct {
	t    *testing.T
	work string
	bare string
}

func (s *gitServer) newRepo(t *testing.T, name string) *testRepo {
	t.Helper()
	r := &testRepo{t: t, work: t.TempDir(), bare: filepath.Join(s.root, name)}
	runGit(t, "", "init", "--quiet", "--bare", "--initial-branch=main", r.bare)
	runGit(t, r.bare, "config", "uploadpack.allowFilter", "true")
	runGit(t, r.bare, "config", "uploadpack.allowAnySHA1InWant", "true")
	runGit(t, r.bare, "config", "http.receivepack", "false")
	runGit(t, "", "init", "--quiet", "--initial-branch=main", r.work)
	return r
}

// commit writes tree into the work tree, commits everything and pushes main; it returns the commit.
func (r *testRepo) commit(msg string, tree map[string]node) string {
	writeTree(r.t, r.work, tree)
	runGit(r.t, r.work, "add", "--all")
	runGit(r.t, r.work, "commit", "--quiet", "--allow-empty", "-m", msg)
	runGit(r.t, r.work, "push", "--quiet", "--force", r.bare, "main")
	return strings.TrimSpace(runGit(r.t, r.work, "rev-parse", "HEAD"))
}

func (r *testRepo) remove(p string) {
	if err := os.RemoveAll(filepath.Join(r.work, filepath.FromSlash(p))); err != nil {
		r.t.Fatal(err)
	}
}

// newTestGit returns the git operations on a fresh workspace, pinned to the test server.
func newTestGit(t *testing.T, s *gitServer, limits Limits, cred *GitCredential) (*Git, *testWorkspace) {
	t.Helper()
	ws := newTestWorkspace(t, limits)
	g := NewGit(ws.Workspace, Config{CACert: s.caPEM, GitCredential: cred, Path: os.Getenv("PATH"), TempDir: t.TempDir()})
	g.lookupIP = func(_ context.Context, host string) ([]netip.Addr, error) {
		if host != gitHost {
			return nil, fmt.Errorf("unexpected lookup of %s", host)
		}
		return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
	}
	return g, ws
}

func manifestFor(name string) string {
	return strings.Replace(testManifest, "echo", name, 1)
}

func TestGitClone(t *testing.T) {
	s := newGitServer(t)
	repo := s.newRepo(t, "repo.git")
	first := repo.commit("first", map[string]node{
		"README.md":                         file("readme"),
		"tasks/echo/scantor.yaml":           file(testManifest),
		"tasks/echo/main.py":                file("print(1)\n"),
		"tasks/echo/run.sh":                 execFile("#!/bin/sh\n"),
		"tasks/bad/scantor.yaml":            file("scantor: 1\nname: bad\nlanguage: rust\n"),
		"tasks/linked/scantor.yaml":         file(manifestFor("linked")),
		"tasks/linked/main.py":              file("x"),
		"tasks/linked/alias.py":             symlink("main.py"),
		"node_modules/dep/scantor.yaml":     file(manifestFor("dep")),
		"deep/1/2/3/4/5/scantor.yaml":       file(manifestFor("deep")),
		"deep/1/2/3/4/5/6/scantor.yaml":     file(manifestFor("deeper")),
		"tasks/echo/.scantor/out/debug.txt": file("ignored"),
	})
	runGit(t, repo.work, "tag", "v1")
	runGit(t, repo.work, "push", "--quiet", repo.bare, "v1")
	second := repo.commit("second", map[string]node{"tasks/echo/main.py": file("print(2)\n")})

	g, ws := newTestGit(t, s, DefaultLimits(), nil)
	res, err := g.Clone(bg, GitOptions{URL: s.url("repo.git"), Path: "tasks", Staging: "c1", AllowPrivate: true})
	if err != nil {
		t.Fatalf("Clone: %v\n%s", err, ws.stderr)
	}
	if res.Commit != second {
		t.Fatalf("commit %s, want %s", res.Commit, second)
	}
	var summary []string
	for _, c := range res.Candidates {
		name := "<nil>"
		if c.Name != nil {
			name = *c.Name
		}
		summary = append(summary, fmt.Sprintf("%s:%s:%t", c.Path, name, c.Valid))
	}
	if want := []string{"tasks/bad:bad:false", "tasks/echo:echo:true", "tasks/linked:linked:false"}; !slices.Equal(summary, want) {
		t.Fatalf("candidates %v, want %v (%+v)", summary, want, res.Candidates)
	}
	linked := res.Candidates[2]
	if len(linked.Errors) == 0 || !strings.Contains(linked.Errors[0].Message, "symlinks are not supported") {
		t.Fatalf("linked errors %+v", linked.Errors)
	}
	echo := res.Candidates[1]
	tree := filepath.Join(ws.dir, StagingDir, "c1", "tree")
	if echo.Summary == nil || echo.Summary.PackSHA256 != packHash(t, filepath.Join(tree, "tasks", "echo")) || len(echo.Errors) != 0 {
		t.Fatalf("echo candidate %+v", echo)
	}

	// The whole repository: depth ≤ 6, node_modules skipped.
	res, err = g.Clone(bg, GitOptions{URL: s.url("repo.git"), Ref: "v1", Staging: "c2", AllowPrivate: true})
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, c := range res.Candidates {
		paths = append(paths, c.Path)
	}
	if res.Commit != first || !slices.Equal(paths, []string{"deep/1/2/3/4/5", "tasks/bad", "tasks/echo", "tasks/linked"}) {
		t.Fatalf("tag clone: commit %s, candidates %v", res.Commit, paths)
	}

	// Commit a candidate: no .git, no .scantor, normalised modes, the candidate's hash.
	cres, err := ws.Commit(bg, CommitOptions{Staging: "c1", From: "tasks/echo", Task: "echo", Expect: ExpectAbsent})
	if err != nil {
		t.Fatal(err)
	}
	if cres.Workspace.PackSHA256 != echo.Summary.PackSHA256 {
		t.Fatalf("committed %s, candidate %s", cres.Workspace.PackSHA256, echo.Summary.PackSHA256)
	}
	got := listTestTree(t, filepath.Join(ws.dir, "echo"))
	want := []treeEntry{{"main.py", TypeFile, 0o644}, {"run.sh", TypeFile, 0o755}, {"scantor.yaml", TypeFile, 0o644}}
	if !slices.Equal(got, want) {
		t.Fatalf("task folder %+v, want %+v", got, want)
	}
	if err := ws.Discard("c1"); err != nil {
		t.Fatal(err)
	}

	// A full commit hash works as the ref.
	if res, err := g.Clone(bg, GitOptions{URL: s.url("repo.git"), Ref: first, Path: "tasks/echo", Staging: "c3", AllowPrivate: true}); err != nil || res.Commit != first || len(res.Candidates) != 1 {
		t.Fatalf("clone by commit: %+v, %v", res, err)
	}
}

func TestGitCloneFailures(t *testing.T) {
	s := newGitServer(t)
	repo := s.newRepo(t, "repo.git")
	repo.commit("first", map[string]node{"scantor.yaml": file(testManifest), "big.bin": file(randomText(t, 3<<20))})

	t.Run("unknown ref", func(t *testing.T) {
		g, ws := newTestGit(t, s, DefaultLimits(), nil)
		_, err := g.Clone(bg, GitOptions{URL: s.url("repo.git"), Ref: "nope", Staging: "c1", AllowPrivate: true})
		wantCode(t, err, CodeGitFailed)
		mustNotExist(t, filepath.Join(ws.dir, StagingDir, "c1"))
	})
	t.Run("missing path", func(t *testing.T) {
		g, ws := newTestGit(t, s, DefaultLimits(), nil)
		_, err := g.Clone(bg, GitOptions{URL: s.url("repo.git"), Path: "nope", Staging: "c1", AllowPrivate: true})
		wantCode(t, err, CodeNotFound)
		mustNotExist(t, filepath.Join(ws.dir, StagingDir, "c1"))
	})
	t.Run("redirect not followed", func(t *testing.T) {
		g, _ := newTestGit(t, s, DefaultLimits(), nil)
		s.resetRequests()
		_, err := g.Clone(bg, GitOptions{URL: s.url("redirect.git"), Staging: "c1", AllowPrivate: true})
		wantCode(t, err, CodeGitFailed)
		if !s.served("/redirect.git/") || s.served("/repo.git/") {
			t.Fatal("git followed the redirect")
		}
	})
	t.Run("private host", func(t *testing.T) {
		g, _ := newTestGit(t, s, DefaultLimits(), nil)
		_, err := g.Clone(bg, GitOptions{URL: s.url("repo.git"), Staging: "c1"})
		wantCode(t, err, CodeInvalidArgument)
	})
	t.Run("untrusted certificate", func(t *testing.T) {
		g, _ := newTestGit(t, s, DefaultLimits(), nil)
		g.cfg.CACert = ""
		_, err := g.Clone(bg, GitOptions{URL: s.url("repo.git"), Staging: "c1", AllowPrivate: true})
		wantCode(t, err, CodeGitFailed)
	})
	t.Run("repository larger than the workspace", func(t *testing.T) {
		g, ws := newTestGit(t, s, Limits{MaxWorkspaceBytes: 1 << 20}, nil)
		_, err := g.Clone(bg, GitOptions{URL: s.url("repo.git"), Staging: "c1", AllowPrivate: true})
		wantCode(t, err, CodeWorkspaceFull)
		mustNotExist(t, filepath.Join(ws.dir, StagingDir, "c1"))
	})
	t.Run("staging id taken", func(t *testing.T) {
		g, ws := newTestGit(t, s, DefaultLimits(), nil)
		stage(t, ws, "c1", map[string]node{"keep": file("x")})
		_, err := g.Clone(bg, GitOptions{URL: s.url("repo.git"), Staging: "c1", AllowPrivate: true})
		wantCode(t, err, CodeExists)
		if got := readTestFile(t, filepath.Join(ws.dir, StagingDir, "c1", "tree", "keep")); got != "x" {
			t.Fatal("another run's staging was touched")
		}
	})
}

func randomText(t *testing.T, n int) string {
	t.Helper()
	b := make([]byte, n*3/4)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(b)
}

func TestGitCredential(t *testing.T) {
	s := newGitServer(t)
	repo := s.newRepo(t, "repo.git")
	repo.commit("first", map[string]node{"scantor.yaml": file(testManifest)})
	const token = "ghp_s3cr3tT0ken"
	s.auth = "Basic " + base64.StdEncoding.EncodeToString([]byte("user:"+token))
	cred := &GitCredential{Host: s.hostPort(), Key: "http.https://" + s.hostPort() + "/.extraheader", Value: "Authorization: " + s.auth}

	g, _ := newTestGit(t, s, DefaultLimits(), nil)
	_, err := g.Clone(bg, GitOptions{URL: s.url("repo.git"), Staging: "c1", AllowPrivate: true})
	wantCode(t, err, CodeGitFailed)

	g, ws := newTestGit(t, s, DefaultLimits(), cred)
	res, err := g.Clone(bg, GitOptions{URL: s.url("repo.git"), Staging: "c1", AllowPrivate: true})
	if err != nil || len(res.Candidates) != 1 || !res.Candidates[0].Valid {
		t.Fatalf("authenticated clone: %+v, %v", res, err)
	}
	// The credential never reaches the checkout or the messages.
	config := readTestFile(t, filepath.Join(ws.dir, StagingDir, "c1", "tree", ".git", "config"))
	if strings.Contains(config, token) || strings.Contains(config, s.auth) {
		t.Fatalf(".git/config contains the credential:\n%s", config)
	}
	run, err := g.runner(&gitTarget{host: gitHost, port: "443", addr: netip.MustParseAddr("127.0.0.1")}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_, err = run.git(bg, "-C", "/nonexistent/"+token, "status")
	werr := codeOf(t, err, CodeGitFailed)
	if strings.Contains(werr.Message, token) {
		t.Fatalf("the error message leaks the token: %s", werr.Message)
	}

	// A credential for another host is refused.
	other := *cred
	other.Host = "github.com"
	g, _ = newTestGit(t, s, DefaultLimits(), &other)
	_, err = g.Clone(bg, GitOptions{URL: s.url("repo.git"), Staging: "c2", AllowPrivate: true})
	wantCode(t, err, CodeInvalidArgument)
}

func TestGitPull(t *testing.T) {
	s := newGitServer(t)
	repo := s.newRepo(t, "repo.git")
	a := repo.commit("a", map[string]node{"task/scantor.yaml": file(testManifest), "task/main.py": file("a")})

	g, ws := newTestGit(t, s, DefaultLimits(), nil)
	if _, err := g.Clone(bg, GitOptions{URL: s.url("repo.git"), Path: "task", Staging: "c1", AllowPrivate: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.Commit(bg, CommitOptions{Staging: "c1", From: "task", Task: "echo", Expect: ExpectAbsent}); err != nil {
		t.Fatal(err)
	}
	pull := func(id, base string) *PullResult {
		t.Helper()
		res, err := g.Pull(bg, PullOptions{GitOptions: GitOptions{URL: s.url("repo.git"), Path: "task", Staging: id, AllowPrivate: true}, Task: "echo", BaseCommit: base})
		if err != nil {
			t.Fatalf("Pull: %v\n%s", err, ws.stderr)
		}
		return res
	}

	// Nothing new: unchanged and a fast-forward of itself.
	res := pull("p1", a)
	if !res.FastForward || res.Changed || res.Commit != a || res.PreviousCommit != a || res.Current == nil || !res.Candidate.Valid {
		t.Fatalf("pull without changes %+v", res)
	}

	// A fast-forward with new content.
	b := repo.commit("b", map[string]node{"task/main.py": file("b")})
	res = pull("p2", a)
	if !res.FastForward || !res.Changed || res.Commit != b {
		t.Fatalf("fast-forward pull %+v", res)
	}
	candidate := filepath.Join(ws.dir, StagingDir, "p2", "tree", "task")
	if got := readTestFile(t, filepath.Join(candidate, "main.py")); got != "b" || res.Candidate.Summary.PackSHA256 != packHash(t, candidate) {
		t.Fatalf("candidate content %q, summary %+v", got, res.Candidate.Summary)
	}
	if _, err := ws.Commit(bg, CommitOptions{Staging: "p2", From: "task", Task: "echo", Expect: res.Current.PackSHA256}); err != nil {
		t.Fatal(err)
	}

	// Rewritten history: not a fast-forward of b.
	runGit(t, repo.work, "reset", "--quiet", "--hard", a)
	c := repo.commit("c", map[string]node{"task/main.py": file("c")})
	res = pull("p3", b)
	if res.FastForward || !res.Changed || res.Commit != c {
		t.Fatalf("diverged pull %+v", res)
	}
	// Unknown or missing base: not a fast-forward.
	if res := pull("p4", ""); res.FastForward {
		t.Fatalf("pull without base %+v", res)
	}
	if res := pull("p5", strings.Repeat("ab", 20)); res.FastForward {
		t.Fatalf("pull with an unknown base %+v", res)
	}

	// The task folder is gone: current is null.
	if _, err := ws.DeleteFiles(bg, "echo", "", true); err != nil {
		t.Fatal(err)
	}
	if res := pull("p6", c); res.Current != nil || !res.Changed {
		t.Fatalf("pull without a task folder %+v", res)
	}

	// The candidate folder was removed upstream: an invalid candidate.
	repo.remove("task")
	repo.commit("d", nil)
	if res := pull("p7", c); res.Candidate.Valid || res.Candidate.Summary != nil {
		t.Fatalf("pull of a removed folder %+v", res)
	}

	_, err := g.Pull(bg, PullOptions{GitOptions: GitOptions{URL: s.url("repo.git"), Staging: "p8", AllowPrivate: true}, Task: "echo", BaseCommit: "HEAD"})
	wantCode(t, err, CodeInvalidArgument)
}

func TestResolveURL(t *testing.T) {
	public := netip.MustParseAddr("140.82.121.3")
	lookups := map[string][]netip.Addr{
		"github.com":       {public},
		"internal.example": {netip.MustParseAddr("10.0.0.5")},
		"mixed.example":    {public, netip.MustParseAddr("127.0.0.1")},
		"ula.example":      {netip.MustParseAddr("fd00::1")},
		"cgnat.example":    {netip.MustParseAddr("100.64.1.1")},
	}
	g := &Git{ws: &Workspace{}, lookupIP: func(_ context.Context, host string) ([]netip.Addr, error) {
		if a, ok := lookups[host]; ok {
			return a, nil
		}
		return nil, fmt.Errorf("no such host %s", host)
	}}
	tests := []struct {
		url          string
		allowPrivate bool
		code         Code
		pin          string
	}{
		{url: "https://github.com/lonetis/scantor.git", pin: "github.com:443:140.82.121.3"},
		{url: "https://GitHub.com:8443/x.git", pin: "github.com:8443:140.82.121.3"},
		{url: "http://github.com/x.git", code: CodeInvalidArgument},
		{url: "ssh://git@github.com/x.git", code: CodeInvalidArgument},
		{url: "git@github.com:x/y.git", code: CodeInvalidArgument},
		{url: "ext::sh -c touch% /tmp/pwned", code: CodeInvalidArgument},
		{url: "file:///etc", code: CodeInvalidArgument},
		{url: "https://user:token@github.com/x.git", code: CodeInvalidArgument},
		{url: "https://user@github.com/x.git", code: CodeInvalidArgument},
		{url: "-uhttps://github.com/x.git", code: CodeInvalidArgument},
		{url: "--upload-pack=touch /tmp/pwned", code: CodeInvalidArgument},
		{url: "https://github.com/x.git#frag", code: CodeInvalidArgument},
		{url: "https://github.com/x .git", code: CodeInvalidArgument},
		{url: "https://github.com:99999/x.git", code: CodeInvalidArgument},
		{url: "https:///x.git", code: CodeInvalidArgument},
		{url: "https://internal.example/x.git", code: CodeInvalidArgument},
		{url: "https://internal.example/x.git", allowPrivate: true, pin: "internal.example:443:10.0.0.5"},
		{url: "https://mixed.example/x.git", code: CodeInvalidArgument},
		{url: "https://ula.example/x.git", code: CodeInvalidArgument},
		{url: "https://cgnat.example/x.git", code: CodeInvalidArgument},
		{url: "https://127.0.0.1/x.git", code: CodeInvalidArgument},
		{url: "https://[::1]/x.git", code: CodeInvalidArgument},
		{url: "https://169.254.169.254/latest", code: CodeInvalidArgument},
		{url: "https://[::1]:8443/x.git", allowPrivate: true, pin: "::1:8443:[::1]"},
		{url: "https://unknown.example/x.git", code: CodeGitFailed},
	}
	for _, tt := range tests {
		t.Run(tt.url, func(t *testing.T) {
			target, err := g.resolveURL(bg, tt.url, tt.allowPrivate)
			if tt.code != "" {
				wantCode(t, err, tt.code)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			addr := target.addr.String()
			if target.addr.Is6() {
				addr = "[" + addr + "]"
			}
			if pin := target.host + ":" + target.port + ":" + addr; pin != tt.pin {
				t.Fatalf("pin %s, want %s", pin, tt.pin)
			}
		})
	}
}

func TestValidateRef(t *testing.T) {
	for _, ref := range []string{"HEAD", "main", "release/1.4", "v1.4.0", strings.Repeat("a", 40), "feature_x-y"} {
		if err := validateRef(ref); err != nil {
			t.Errorf("%q: %v", ref, err)
		}
	}
	for _, ref := range []string{"-main", "--upload-pack=x", "a:b", "+main:refs/x", "a..b", "a b", "a\nb", "a~1", "a^", "a*", "a?", "a[", `a\b`, strings.Repeat("a", 256), "\xff"} {
		if err := validateRef(ref); err == nil {
			t.Errorf("%q is valid", ref)
		}
	}
}

func TestIsPublic(t *testing.T) {
	for addr, want := range map[string]bool{
		"8.8.8.8": true, "140.82.121.3": true, "2606:4700::1111": true,
		"127.0.0.1": false, "10.1.2.3": false, "172.16.0.1": false, "192.168.1.1": false, "169.254.169.254": false,
		"100.64.0.1": false, "0.0.0.0": false, "::1": false, "fd12::1": false, "fe80::1": false, "::": false,
		"224.0.0.1": false, "::ffff:127.0.0.1": false, "::ffff:10.0.0.1": false, "198.18.0.1": false, "240.0.0.1": false,
	} {
		if got := isPublic(netip.MustParseAddr(addr)); got != want {
			t.Errorf("isPublic(%s) = %t, want %t", addr, got, want)
		}
	}
}

func TestLoadConfig(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	cfg, err := LoadConfig(env(map[string]string{}))
	if err != nil || cfg.GitCredential != nil || cfg.Path != DefaultPath || cfg.TempDir != "/tmp" || cfg.CACert != "" {
		t.Fatalf("defaults %+v, %v", cfg, err)
	}
	value := "Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte("u:t"))
	cfg, err = LoadConfig(env(map[string]string{
		"GIT_CONFIG_COUNT":     "1",
		"GIT_CONFIG_KEY_0":     "http.https://GitHub.com/.extraheader",
		"GIT_CONFIG_VALUE_0":   value,
		"SCANTOR_IMAGE_PREFIX": "registry.example/",
		"SCANTOR_IMAGE_TAG":    "1.2.3",
	}))
	if err != nil || cfg.GitCredential == nil || cfg.GitCredential.Host != "github.com" || cfg.GitCredential.Value != value || cfg.Images.Tag != "1.2.3" {
		t.Fatalf("credential %+v, %v", cfg, err)
	}
	for name, m := range map[string]map[string]string{
		"count":         {"GIT_CONFIG_COUNT": "2"},
		"key":           {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.sshCommand", "GIT_CONFIG_VALUE_0": "Authorization: x"},
		"value":         {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.https://h/.extraheader", "GIT_CONFIG_VALUE_0": "X-Other: x"},
		"value newline": {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.https://h/.extraheader", "GIT_CONFIG_VALUE_0": "Authorization: x\nEvil: y"},
		"ca":            {"SCANTOR_CA_CERT": "not a certificate"},
		"prefix":        {"SCANTOR_IMAGE_PREFIX": "registry.example", "SCANTOR_IMAGE_TAG": "1"},
	} {
		if _, err := LoadConfig(env(m)); err == nil {
			t.Errorf("%s: no error", name)
		} else if strings.Contains(err.Error(), "Authorization: x") {
			t.Errorf("%s: the error names the value: %v", name, err)
		}
	}
}

func TestSizeGuard(t *testing.T) {
	dir := t.TempDir()
	guard := &sizeGuard{dir: dir, budget: 100, limit: 1000, interval: 5 * time.Millisecond}
	ctx, stop := context.WithCancel(bg)
	defer stop()
	done := make(chan bool, 1)
	go func() { done <- guard.watch(ctx, stop) }()
	writeTree(t, dir, map[string]node{"objects/pack/p": file(strings.Repeat("x", 101))})
	select {
	case exceeded := <-done:
		if !exceeded || ctx.Err() == nil {
			t.Fatalf("exceeded %t, ctx %v", exceeded, ctx.Err())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the guard did not stop the command")
	}
	wantCode(t, guard.err(), CodeWorkspaceFull)

	// Within the budget the guard only ends with the command.
	small := &sizeGuard{dir: t.TempDir(), budget: 100, interval: 5 * time.Millisecond}
	ctx2, stop2 := context.WithTimeout(bg, 50*time.Millisecond)
	defer stop2()
	if small.watch(ctx2, stop2) {
		t.Fatal("an empty directory exceeded the budget")
	}
}
