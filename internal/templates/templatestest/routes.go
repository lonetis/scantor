// Package templatestest provides fakes of the template data sources and a runner for the template
// fixtures (docs/templates.md §10):
//
//   - Routes serves the canned `http[]` responses of a fixture case exactly.
//   - Tranco and Crux serve the exact upstream endpoints of docs/templates.md §9.5–§9.6 (paths, query
//     strings, content types, CRLF/LF line endings and gzip) from in-memory lists; NewHandler mounts
//     them below /tranco and /crux the way the fixtures server of docs/testing.md §7.9 does, and
//     DefaultDataSet generates small, deterministic lists relative to a clock.
//   - Uploads serves uploaded lists at presigned-style URLs.
//   - RunFixtures drives a template through schemas/templates/<name>.fixtures.json.
//
// The fakes (Routes, Tranco, Crux, Uploads, NewHandler) use only the standard library, so a fixtures
// server binary can serve them; RunFixtures and the helpers in fixtures.go are for Go tests.
package templatestest

import (
	"bytes"
	"compress/gzip"
	"net/http"
	"strings"
	"sync"
)

// Route is one canned response: the `http[]` entry of a fixture case.
type Route struct {
	Method      string `json:"method"`
	Path        string `json:"path"` // path and exact query string below the data-source base URL
	Status      int    `json:"status"`
	ContentType string `json:"contentType"`
	Body        string `json:"body"`
	// Encoding is "text" (the body as is) or "gzip" (the body gzip-compressed, served as the file
	// content without Content-Encoding, like a .gz file on GitHub).
	Encoding string `json:"encoding"`
}

// Routes serves canned routes below a path prefix. A request matches a route by method and by path
// plus raw query, exactly. A HEAD request for a path with a GET route answers 200 without a body;
// every other request answers 404.
type Routes struct {
	prefix string
	routes []Route
	vars   map[string]string

	mu       sync.Mutex
	requests []string
}

// NewRoutes returns a handler for routes below prefix ("" or for example "/tranco"). Every "${name}"
// in a body is replaced by vars[name] (the fixture placeholders ${tranco} and ${crux}).
func NewRoutes(prefix string, routes []Route, vars map[string]string) *Routes {
	return &Routes{prefix: strings.TrimSuffix(prefix, "/"), routes: routes, vars: vars}
}

// Requests returns "METHOD path?query" of every request served so far, in order.
func (h *Routes) Requests() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.requests...)
}

func (h *Routes) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	target := r.URL.EscapedPath()
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	h.mu.Lock()
	h.requests = append(h.requests, r.Method+" "+target)
	h.mu.Unlock()
	rel, ok := strings.CutPrefix(target, h.prefix)
	if !ok {
		http.NotFound(w, r)
		return
	}
	for _, route := range h.routes {
		if route.Path != rel {
			continue
		}
		switch {
		case r.Method == route.Method:
			body := []byte(h.expand(route.Body))
			if route.Encoding == "gzip" {
				body = Gzip(body)
			}
			if route.ContentType != "" {
				w.Header().Set("Content-Type", route.ContentType)
			}
			w.WriteHeader(route.Status)
			if r.Method != http.MethodHead {
				_, _ = w.Write(body)
			}
			return
		case r.Method == http.MethodHead && route.Method == http.MethodGet:
			w.WriteHeader(http.StatusOK)
			return
		}
	}
	http.NotFound(w, r)
}

func (h *Routes) expand(s string) string {
	for k, v := range h.vars {
		s = strings.ReplaceAll(s, "${"+k+"}", v)
	}
	return s
}

// Gzip compresses data deterministically (no name, zero modification time).
func Gzip(data []byte) []byte {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	_, _ = zw.Write(data) // writes to a bytes.Buffer cannot fail
	_ = zw.Close()
	return buf.Bytes()
}
