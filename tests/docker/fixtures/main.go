// Command scantor-test-fixtures is the fixtures server of the dockerized test suite (docs/testing.md
// §7.9). It replaces every external service the test stack would otherwise reach, on one plain-HTTP
// port:
//
//   - /tranco and /crux: the data-source fakes of internal/templates/templatestest with small,
//     deterministic lists generated relative to the server's start (SCANTOR_TRANCO_URL and
//     SCANTOR_CRUX_URL of the test stack point here), plus GET /healthz;
//   - /<name>.git/...: read-only git smart-HTTP (git http-backend) over the bare repositories in
//     /srv/git; Traefik serves them as https://git.<domain>/<name>.git with the test CA's certificate.
//     Repositories whose name starts with "private" require Basic auth with the fixed test credential;
//   - /control/repos: per-test copies of a repository and moves of a copy's main branch, so pull tests
//     (fast-forward, divergence) never share state.
package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/cgi"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/lonetis/scantor/internal/templates/templatestest"
)

const (
	listenAddress = ":8089"
	gitRoot       = "/srv/git"
	gitBackend    = "/usr/libexec/git-core/git-http-backend"
	// The Basic-auth credential of the private repositories; tests/helpers/fixtures.ts has the same values.
	privateUser     = "scantor-test"
	privatePassword = "fixtures-token"
)

var (
	repoName  = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	gitPath   = regexp.MustCompile(`^/([a-z0-9][a-z0-9-]{0,62})\.git/(info/refs|git-upload-pack)$`)
	gitBranch = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	data := templatestest.NewHandler(templatestest.DefaultDataSet(time.Now()))

	mux := http.NewServeMux()
	mux.Handle("/tranco/", data)
	mux.Handle("/crux/", data)
	mux.Handle("GET /healthz", data)
	mux.HandleFunc("POST /control/repos", copyRepo)
	mux.HandleFunc("POST /control/repos/{name}/main", moveMain)
	mux.Handle("/", gitHandler())

	server := &http.Server{
		Addr:              listenAddress,
		Handler:           logRequests(log, mux),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Info("fixtures server listening", "address", listenAddress, "gitRoot", gitRoot)
	if err := server.ListenAndServe(); err != nil {
		log.Error("server stopped", "err", err)
		os.Exit(1)
	}
}

func logRequests(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.Info("request", "method", r.Method, "host", r.Host, "path", r.URL.Path, "status", rec.status, "ms", time.Since(start).Milliseconds())
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

// gitHandler serves the upload-pack side of the smart protocol only: clones and fetches work, pushes and
// the dumb protocol do not.
func gitHandler() http.Handler {
	backend := &cgi.Handler{
		Path: gitBackend,
		Root: "/",
		Env:  []string{"GIT_PROJECT_ROOT=" + gitRoot, "GIT_HTTP_EXPORT_ALL=1"},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m := gitPath.FindStringSubmatch(r.URL.Path)
		upload := m != nil && ((m[2] == "info/refs" && r.Method == http.MethodGet && r.URL.Query().Get("service") == "git-upload-pack") ||
			(m[2] == "git-upload-pack" && r.Method == http.MethodPost))
		if !upload {
			http.NotFound(w, r)
			return
		}
		if strings.HasPrefix(m[1], "private") && !authorized(r) {
			w.Header().Set("WWW-Authenticate", `Basic realm="scantor test fixtures"`)
			http.Error(w, "authentication required", http.StatusUnauthorized)
			return
		}
		if _, err := os.Stat(filepath.Join(gitRoot, m[1]+".git")); err != nil {
			http.NotFound(w, r)
			return
		}
		backend.ServeHTTP(w, r)
	})
}

func authorized(r *http.Request) bool {
	user, password, ok := r.BasicAuth()
	return ok && subtle.ConstantTimeCompare([]byte(user), []byte(privateUser)) == 1 &&
		subtle.ConstantTimeCompare([]byte(password), []byte(privatePassword)) == 1
}

// copyRepo answers POST /control/repos {"from": "<name>"} with 201 {"name": "<from>-<random>"}: a mirror
// copy of the repository with every branch, private when the source is.
func copyRepo(w http.ResponseWriter, r *http.Request) {
	var body struct {
		From string `json:"from"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || !repoName.MatchString(body.From) {
		http.Error(w, `body must be {"from": "<repository name>"}`, http.StatusBadRequest)
		return
	}
	source := filepath.Join(gitRoot, body.From+".git")
	if _, err := os.Stat(source); err != nil {
		http.Error(w, "unknown repository "+body.From, http.StatusNotFound)
		return
	}
	suffix := make([]byte, 4)
	if _, err := rand.Read(suffix); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	name := body.From + "-" + hex.EncodeToString(suffix)
	if err := git(r.Context(), "", "clone", "--quiet", "--mirror", source, filepath.Join(gitRoot, name+".git")); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]string{"name": name})
}

// moveMain answers POST /control/repos/{name}/main {"branch": "<branch>"} with 204 after pointing main at
// that branch's commit (for example "advanced" for a fast-forward, "rewritten" for a divergence).
func moveMain(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var body struct {
		Branch string `json:"branch"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || !gitBranch.MatchString(body.Branch) || !repoName.MatchString(name) {
		http.Error(w, `body must be {"branch": "<branch name>"}`, http.StatusBadRequest)
		return
	}
	repo := filepath.Join(gitRoot, name+".git")
	if _, err := os.Stat(repo); err != nil {
		http.Error(w, "unknown repository "+name, http.StatusNotFound)
		return
	}
	if err := git(r.Context(), repo, "update-ref", "refs/heads/main", "refs/heads/"+body.Branch); err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func git(ctx context.Context, dir string, args ...string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return fmt.Errorf("git %s: %s", strings.Join(args, " "), strings.TrimSpace(string(out)))
		}
		return fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return nil
}
