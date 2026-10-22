package cli

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/redact"
)

// apiDownloadHeaderTimeout bounds the wait for the response headers of a presigned download.
const apiDownloadHeaderTimeout = time.Minute

// apiOutputTarget is where a command writes downloaded or streamed bytes: a local file or stdout.
type apiOutputTarget struct {
	path  string
	force bool
}

// apiOutputFlags adds --file and --force.
func apiOutputFlags(cmd *cobra.Command, t *apiOutputTarget, what string) {
	cmd.Flags().StringVarP(&t.path, "file", "f", "", "write "+what+" to this file (- = stdout)")
	cmd.Flags().BoolVar(&t.force, "force", false, "overwrite an existing file")
}

func (t apiOutputTarget) stdout() bool { return t.path == "-" }

// apiSavedFile is the result of a download, printed by the commands that save files.
type apiSavedFile struct {
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

// apiExpect holds the size and digest a download must have; zero values skip the check.
type apiExpect struct {
	size   int64
	sha256 string
}

// write streams r to the target. Files are written to a temporary file next to the destination and
// renamed only after verification, so a failed or interrupted transfer never leaves a partial file.
func (t apiOutputTarget) write(app *App, r io.Reader, expect apiExpect) (*apiSavedFile, error) {
	hash := sha256.New()
	if t.stdout() {
		n, err := io.Copy(io.MultiWriter(app.Stdout, hash), r)
		if err != nil {
			return nil, PlatformError(fmt.Errorf("download: %w", err))
		}
		saved := &apiSavedFile{Path: "-", Bytes: n, SHA256: hex.EncodeToString(hash.Sum(nil))}
		return saved, expect.verify(saved)
	}
	if _, err := os.Lstat(t.path); err == nil && !t.force {
		return nil, ValidationError(fmt.Errorf("%s already exists; use --force to overwrite it", t.path))
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, ValidationError(err)
	}
	dir := filepath.Dir(t.path)
	tmp, err := os.CreateTemp(dir, ".scantor-download-*")
	if err != nil {
		return nil, ValidationError(fmt.Errorf("create %s: %w", t.path, err))
	}
	committed := false
	defer func() {
		if !committed {
			_ = tmp.Close()
			_ = os.Remove(tmp.Name())
		}
	}()
	n, err := io.Copy(io.MultiWriter(tmp, hash), r)
	if err != nil {
		return nil, PlatformError(fmt.Errorf("download %s: %w", t.path, err))
	}
	saved := &apiSavedFile{Path: t.path, Bytes: n, SHA256: hex.EncodeToString(hash.Sum(nil))}
	if err := expect.verify(saved); err != nil {
		return nil, err
	}
	if err := tmp.Close(); err != nil {
		return nil, PlatformError(fmt.Errorf("write %s: %w", t.path, err))
	}
	// Downloads are ordinary user files; CreateTemp creates them 0600.
	if err := os.Chmod(tmp.Name(), 0o644); err != nil { //nolint:gosec // results are the user's own files
		return nil, PlatformError(err)
	}
	if err := os.Rename(tmp.Name(), t.path); err != nil {
		return nil, PlatformError(fmt.Errorf("write %s: %w", t.path, err))
	}
	committed = true
	return saved, nil
}

func (e apiExpect) verify(saved *apiSavedFile) error {
	if e.size > 0 && saved.Bytes != e.size {
		return PlatformError(fmt.Errorf("download incomplete: got %d bytes, expected %d", saved.Bytes, e.size))
	}
	if e.sha256 != "" && !strings.EqualFold(strings.TrimPrefix(e.sha256, "sha256:"), saved.SHA256) {
		return PlatformError(errors.New("download corrupted: the SHA-256 does not match the recorded digest"))
	}
	return nil
}

// apiDownload fetches a presigned URL without credentials and writes it to the target. Inside the
// docker shim, a loopback host is dialled through host.docker.internal while the signed Host header is
// kept, so presigned URLs of a local deployment work from the CLI container too.
func apiDownload(ctx context.Context, app *App, client *api.Client, rawURL string, target apiOutputTarget, expect apiExpect) (*apiSavedFile, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	req, err := apiPresignedRequest(ctx, app, rawURL)
	if err != nil {
		return nil, err
	}
	var timedOut atomic.Bool
	timer := time.AfterFunc(apiDownloadHeaderTimeout, func() { timedOut.Store(true); cancel() })
	resp, err := client.HTTPClient().Do(req)
	timer.Stop()
	switch {
	case err == nil:
	case timedOut.Load():
		return nil, PlatformError(fmt.Errorf("download: no response within %s", apiDownloadHeaderTimeout))
	case ctx.Err() != nil:
		return nil, Interrupted()
	default:
		return nil, PlatformError(fmt.Errorf("download: %s", redact.String(err.Error())))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, PlatformError(fmt.Errorf("download failed: HTTP %d %s", resp.StatusCode, apiTruncate(redact.String(string(body)), 300)))
	}
	return target.write(app, resp.Body, expect)
}

// apiPresignedRequest builds the credential-less GET of a presigned URL, with the docker-shim rewrite of
// loopback hosts (the signed Host header stays unchanged).
func apiPresignedRequest(ctx context.Context, app *App, rawURL string) (*http.Request, error) {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, PlatformError(errors.New("the orchestrator returned an invalid download URL"))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, PlatformError(err)
	}
	if app.Containerized != nil && apiIsLoopbackHost(u.Hostname()) && app.Containerized() {
		req.Host = u.Host
		dial := *u
		if port := u.Port(); port != "" {
			dial.Host = net.JoinHostPort(ContainerHost, port)
		} else {
			dial.Host = ContainerHost
		}
		req.URL = &dial
	}
	return req, nil
}

// apiIsLoopbackHost reports whether host is localhost or a loopback address.
func apiIsLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// apiSafeFileName returns a local file name for a server-provided name: its base name, or fallback when
// the name has no usable base.
func apiSafeFileName(name, fallback string) string {
	base := filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	if base == "." || base == ".." || base == "/" || base == "" || strings.ContainsRune(base, 0) {
		return fallback
	}
	return base
}
