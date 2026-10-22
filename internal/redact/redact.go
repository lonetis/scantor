// Package redact is the only log redactor of the Go roles (CLI, node daemon, runtime; docs/security.md
// MC-10). It removes credentials from header values, URLs and free text before they are logged.
//
// Redacted: the authorization, proxy-authorization, x-api-key, x-scantor-internal-auth,
// x-scantor-setup-token, x-registry-auth, cookie and set-cookie headers; token-shaped substrings
// (sk_scantor_…, snt_…, swt_…, sst_…, spk_…, sic_…, sec_…); passwords in scheme://user:pass@ URLs (amqp,
// amqps and every other scheme); X-Amz-Signature query values; the /setup?token= query; git
// extraheader values; and "Authorization: <value>" text.
package redact

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
)

// Mask replaces every redacted value.
const Mask = "[REDACTED]"

var sensitiveHeaders = map[string]bool{
	"authorization":           true,
	"proxy-authorization":     true,
	"x-api-key":               true,
	"x-scantor-internal-auth": true,
	"x-scantor-setup-token":   true,
	"x-registry-auth":         true,
	"cookie":                  true,
	"set-cookie":              true,
}

// IsSensitiveHeader reports whether the value of the header name must never be logged.
func IsSensitiveHeader(name string) bool { return sensitiveHeaders[strings.ToLower(name)] }

// HeaderValue returns Mask for sensitive headers and the redacted text otherwise.
func HeaderValue(name, value string) string {
	if IsSensitiveHeader(name) {
		return Mask
	}
	return String(value)
}

// Headers returns a copy of h with sensitive values masked and every other value redacted as text.
func Headers(h http.Header) http.Header {
	out := make(http.Header, len(h))
	for name, values := range h {
		masked := make([]string, len(values))
		for i, v := range values {
			masked[i] = HeaderValue(name, v)
		}
		out[name] = masked
	}
	return out
}

type rule struct {
	re   *regexp.Regexp
	repl string
}

// Order matters: the git extraheader and Authorization rules consume their whole value before the token
// rules run.
var rules = []rule{
	// git -c http.extraheader=… and GIT_CONFIG_VALUE_n values carrying an extraheader
	{regexp.MustCompile(`(?i)(extraheader\s*[=:]\s*["']?)[^\r\n"']+`), "${1}" + Mask},
	// Authorization / Proxy-Authorization header lines in free text (curl -v, error bodies)
	{regexp.MustCompile(`(?i)\b((?:proxy-)?authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s"',;]+`), "${1}" + Mask},
	// x-api-key / internal capability / setup token / registry auth headers in free text
	{regexp.MustCompile(`(?i)\b((?:x-api-key|x-scantor-internal-auth|x-scantor-setup-token|x-registry-auth)\s*[:=]\s*)[^\s"',;]+`), "${1}" + Mask},
	// userinfo passwords in URLs: amqp://user:pass@host, https://user:pass@host
	{regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.-]*://[^\s:/@"'<>]*:)[^\s@/"'<>]+@`), "${1}" + Mask + "@"},
	// presigned S3 URLs
	{regexp.MustCompile(`(?i)(X-Amz-Signature=)[^&\s"'<>]+`), "${1}" + Mask},
	{regexp.MustCompile(`(?i)(X-Amz-Security-Token=)[^&\s"'<>]+`), "${1}" + Mask},
	// first-admin setup link
	{regexp.MustCompile(`(/setup\?(?:[^\s"'<>]*&)?token=)[^&\s"'<>]+`), "${1}" + Mask},
	// worker tokens keep their (non-secret) worker id for debugging
	{regexp.MustCompile(`swt_([0-9a-fA-F-]{36}\.)?[A-Za-z0-9_-]{8,}`), "swt_${1}" + Mask},
	// API keys (default and editor configurations)
	{regexp.MustCompile(`(sk_scantor_(?:editor_)?)[A-Za-z0-9_-]{8,}`), "${1}" + Mask},
	// node tokens, setup tokens, passkey setup tokens, internal capabilities, editor one-time codes
	{regexp.MustCompile(`((?:snt|sst|spk|sic|sec)_)[A-Za-z0-9_-]{16,}`), "${1}" + Mask},
}

// String redacts credentials in free text.
func String(s string) string {
	for _, r := range rules {
		s = r.re.ReplaceAllString(s, r.repl)
	}
	return s
}

// ReplaceAttr is a slog.HandlerOptions.ReplaceAttr function that redacts every string attribute and
// masks attributes named like sensitive headers or credentials.
func ReplaceAttr(_ []string, a slog.Attr) slog.Attr {
	key := strings.ToLower(a.Key)
	if IsSensitiveHeader(key) || sensitiveKey(key) {
		return slog.String(a.Key, Mask)
	}
	switch a.Value.Kind() {
	case slog.KindString:
		return slog.String(a.Key, String(a.Value.String()))
	case slog.KindAny:
		if err, ok := a.Value.Any().(error); ok {
			return slog.String(a.Key, String(err.Error()))
		}
	}
	return a
}

func sensitiveKey(key string) bool {
	switch key {
	case "token", "password", "secret", "apikey", "api_key", "workertoken", "nodetoken":
		return true
	}
	return false
}

// HandlerOptions returns a copy of opts whose ReplaceAttr redacts every attribute, chained after any
// existing ReplaceAttr function.
func HandlerOptions(opts *slog.HandlerOptions) *slog.HandlerOptions {
	out := slog.HandlerOptions{}
	if opts != nil {
		out = *opts
	}
	prev := out.ReplaceAttr
	out.ReplaceAttr = func(groups []string, a slog.Attr) slog.Attr {
		if prev != nil {
			a = prev(groups, a)
		}
		return ReplaceAttr(groups, a)
	}
	return &out
}

// Log formats of NewLogger (the values of SCANTOR_LOG_FORMAT).
const (
	FormatJSON = "json"
	FormatText = "text"
)

// NewLogger returns a redacting slog logger on w: JSON records for FormatJSON, text records otherwise.
// Every Go role builds its logger here, so no record bypasses redaction.
func NewLogger(w io.Writer, format string, level slog.Leveler) *slog.Logger {
	opts := HandlerOptions(&slog.HandlerOptions{Level: level})
	if format == FormatJSON {
		return slog.New(slog.NewJSONHandler(w, opts))
	}
	return slog.New(slog.NewTextHandler(w, opts))
}

// ParseLevel parses a log level name (debug, info, warn, error; the values of SCANTOR_LOG_LEVEL).
func ParseLevel(s string) (slog.Level, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return slog.LevelInfo, fmt.Errorf("invalid log level %q: use debug, info, warn or error", s)
	}
}
