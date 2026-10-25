package fetch

import (
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/lonetis/scantor/internal/templates/core"
)

// File is a downloaded and decoded data file in Env.TmpDir.
type File struct {
	Path      string
	SHA256    string // hex SHA-256 of the decoded data (docs/templates.md §4)
	Size      int64  // decoded bytes
	FetchedAt time.Time
}

// Open opens the decoded data for reading.
func (f *File) Open() (*os.File, error) {
	file, err := os.Open(filepath.Clean(f.Path))
	if err != nil {
		return nil, core.Platformf(true, err, "open downloaded data: %v", err)
	}
	return file, nil
}

var (
	cacheMu sync.Mutex
	cache   = map[string]*File{}

	flightsMu sync.Mutex
	flights   = map[string]*flight{}
)

// flight is one download that concurrent callers for the same URL and TmpDir share. It runs with its
// own context, detached from the caller that started it: a caller whose context ends stops waiting and
// returns its own error, and the download is cancelled only when no caller waits any more, so one
// caller's cancellation never fails the others.
type flight struct {
	done    chan struct{}
	file    *File
	err     error
	waiters int
	cancel  context.CancelFunc
}

// Download fetches req.URL with GET into Env.TmpDir, decoding HTTP content encoding and, with
// req.Gunzip, a gzip file body. A URL already downloaded into the same TmpDir by this process is
// served from the cache. A final non-2xx status is returned as *StatusError; network errors and
// 5xx/429 responses that remain after the retries are retryable platform errors; exceeding the size
// caps is a non-retryable platform error.
func Download(ctx context.Context, env core.Env, req Request) (*File, error) {
	if env.TmpDir == "" {
		return nil, core.Platformf(false, nil, "no scratch directory for template data (Env.TmpDir is empty)")
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("%t\x00%s", req.Gunzip, req.URL)))
	path := filepath.Join(env.TmpDir, "template-data-"+hex.EncodeToString(sum[:]))
	if f := cached(path); f != nil {
		return f, nil
	}
	return join(ctx, path, func(ctx context.Context) (*File, error) {
		if f := cached(path); f != nil {
			return f, nil
		}
		f, err := download(ctx, env, req, path)
		if err != nil {
			return nil, err
		}
		cacheMu.Lock()
		cache[path] = f
		cacheMu.Unlock()
		return f, nil
	})
}

// join waits for the flight of key, starting it with run when none is in progress, until it ends or ctx
// ends.
func join(ctx context.Context, key string, run func(context.Context) (*File, error)) (*File, error) {
	flightsMu.Lock()
	f := flights[key]
	if f == nil {
		fctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
		f = &flight{done: make(chan struct{}), cancel: cancel}
		flights[key] = f
		go func() {
			f.file, f.err = run(fctx)
			flightsMu.Lock()
			if flights[key] == f {
				delete(flights, key)
			}
			flightsMu.Unlock()
			cancel()
			close(f.done)
		}()
	}
	f.waiters++
	flightsMu.Unlock()

	select {
	case <-f.done:
		return f.file, f.err
	case <-ctx.Done():
		flightsMu.Lock()
		f.waiters--
		if f.waiters == 0 {
			// Nobody waits any more: stop the download, and let a later caller start a new one rather
			// than join this cancelled flight.
			f.cancel()
			if flights[key] == f {
				delete(flights, key)
			}
		}
		flightsMu.Unlock()
		return nil, ctx.Err()
	}
}

// cached returns the cache entry of path when its file still exists unchanged.
func cached(path string) *File {
	cacheMu.Lock()
	f := cache[path]
	cacheMu.Unlock()
	if f == nil {
		return nil
	}
	if st, err := os.Stat(path); err != nil || st.Size() != f.Size {
		cacheMu.Lock()
		delete(cache, path)
		cacheMu.Unlock()
		return nil
	}
	return f
}

func download(ctx context.Context, env core.Env, req Request, path string) (*File, error) {
	var out *File
	err := do(ctx, env, req, http.MethodGet, func(resp *http.Response) *attemptError {
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			return &attemptError{err: &StatusError{
				Method: http.MethodGet, Target: req.target(), StatusCode: resp.StatusCode, Status: resp.Status, Body: peekBody(resp),
			}}
		}
		f, aerr := save(env, req, resp, path)
		if aerr != nil {
			return aerr
		}
		out = f
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// save streams a 2xx body through the caps and decoders into a temporary file, hashes the decoded
// bytes and renames the file into place.
func save(env core.Env, req Request, resp *http.Response, path string) (*File, *attemptError) {
	maxBytes, maxDecoded := req.MaxBytes, req.MaxDecoded
	if maxBytes <= 0 {
		maxBytes = MaxDownloadBytes
	}
	if maxDecoded <= 0 {
		maxDecoded = MaxDecodedBytes
	}
	var r io.Reader = &cappedReader{r: resp.Body, limit: maxBytes, what: "download", target: req.target()}
	r, err := decodeBody(r, resp.Header.Get("Content-Encoding"))
	if err != nil {
		return nil, readFailure(req, err)
	}
	if req.Gunzip {
		if r, err = gunzipFile(r); err != nil {
			return nil, readFailure(req, err)
		}
	}
	r = &cappedReader{r: r, limit: maxDecoded, what: "decoded data", target: req.target()}

	tmp, err := os.CreateTemp(env.TmpDir, "template-data-*.part")
	if err != nil {
		return nil, &attemptError{err: core.Platformf(true, err, "create scratch file for %s: %v", req.target(), err)}
	}
	committed := false
	defer func() {
		if !committed {
			_ = tmp.Close()
			_ = os.Remove(tmp.Name())
		}
	}()
	h := sha256.New()
	n, err := io.Copy(&errWriter{w: io.MultiWriter(tmp, h)}, r)
	if err != nil {
		var werr *writeError
		if errors.As(err, &werr) {
			return nil, &attemptError{err: core.Platformf(true, werr.err, "write scratch file for %s: %v", req.target(), werr.err)}
		}
		return nil, readFailure(req, err)
	}
	if err := tmp.Close(); err != nil {
		return nil, &attemptError{err: core.Platformf(true, err, "write scratch file for %s: %v", req.target(), err)}
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return nil, &attemptError{err: core.Platformf(true, err, "store scratch file for %s: %v", req.target(), err)}
	}
	committed = true
	return &File{Path: path, SHA256: hex.EncodeToString(h.Sum(nil)), Size: n, FetchedAt: env.Clock().UTC()}, nil
}

// readFailure classifies an error while reading a body: exceeded caps are final, everything else
// (connection resets, truncated gzip streams) is retried.
func readFailure(req Request, err error) *attemptError {
	var lerr *limitError
	if errors.As(err, &lerr) {
		return &attemptError{err: core.Platformf(false, nil, "%s", lerr.Error())}
	}
	return &attemptError{err: fmt.Errorf("GET %s: %w", req.target(), unwrapURLError(err)), retry: true}
}

// decodeBody undoes HTTP content encoding. Only gzip is advertised in Accept-Encoding.
func decodeBody(r io.Reader, contentEncoding string) (io.Reader, error) {
	switch strings.ToLower(strings.TrimSpace(contentEncoding)) {
	case "", "identity":
		return r, nil
	case "gzip", "x-gzip":
		gz, err := gzip.NewReader(r)
		if err != nil {
			return nil, fmt.Errorf("gzip content encoding: %w", err)
		}
		return gz, nil
	default:
		return nil, fmt.Errorf("unsupported Content-Encoding %q", contentEncoding)
	}
}

// gunzipFile decompresses a gzip file body; a body without the gzip magic bytes is returned as is
// (a server that already decoded it through Content-Encoding).
func gunzipFile(r io.Reader) (io.Reader, error) {
	br := bufio.NewReader(r)
	magic, err := br.Peek(2)
	if err != nil || magic[0] != 0x1f || magic[1] != 0x8b {
		// A body shorter than the magic is not gzip either; the parser reports bad content.
		return br, nil
	}
	gz, err := gzip.NewReader(br)
	if err != nil {
		return nil, fmt.Errorf("gzip file: %w", err)
	}
	return gz, nil
}

// cappedReader fails once more than limit bytes were read.
type cappedReader struct {
	r      io.Reader
	limit  int64
	read   int64
	what   string
	target string
}

func (c *cappedReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.read += int64(n)
	if c.read > c.limit {
		return 0, &limitError{what: c.what, target: c.target, limit: c.limit}
	}
	return n, err
}

type limitError struct {
	what, target string
	limit        int64
}

func (e *limitError) Error() string {
	return fmt.Sprintf("%s: the %s exceeds the size limit of %s", e.target, e.what, humanBytes(e.limit))
}

func humanBytes(n int64) string {
	if n >= 1<<20 && n%(1<<20) == 0 {
		return fmt.Sprintf("%d MiB", n>>20)
	}
	return fmt.Sprintf("%d bytes", n)
}

// errWriter marks failures of the destination, so io.Copy errors can be told apart from read errors.
type errWriter struct{ w io.Writer }

func (e *errWriter) Write(p []byte) (int, error) {
	n, err := e.w.Write(p)
	if err != nil {
		return n, &writeError{err: err}
	}
	return n, nil
}

type writeError struct{ err error }

func (e *writeError) Error() string { return e.err.Error() }
