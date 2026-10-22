// Package local is local mode (`scantor runtime local --spec <file>`, docs/runtime.md §15): one container
// runs a task without queue or platform, for `scantor dev run`, `scantor dev debug` and test runs. It
// describes the task, takes at most `limit` items from the schedule (natively or through the connector),
// runs them with the run path of worker mode (timeouts, crashes, recycling, result checks, files, the
// retry policy with delays capped at 2 s) and writes NDJSON events to stdout and files to the output
// directory.
package local

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"unicode/utf16"

	"golang.org/x/text/unicode/norm"

	"github.com/lonetis/scantor/internal/api"
)

// SpecVersion is the `v` of the local spec.
const SpecVersion = 1

// DefaultOutDir is the output directory when the spec names none.
const DefaultOutDir = "/scantor/out"

// Upload is one uploaded list available as a local file.
type Upload struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

// SpecLimits are the limits of a local run (bootstrap limits).
type SpecLimits struct {
	MaxAnalysisConfigBytes int64 `json:"maxAnalysisConfigBytes"`
	MaxResultBytes         int64 `json:"maxResultBytes"`
	MaxFileBytes           int64 `json:"maxFileBytes"`
	MaxFilesPerAnalysis    int   `json:"maxFilesPerAnalysis"`
	LogTailBytes           int   `json:"logTailBytes"`
	LogTailEarlierBytes    int   `json:"logTailEarlierBytes"`
}

// Spec is the local-mode input /scantor/in/spec.json (docs/runtime.md §15.1).
type Spec struct {
	V                     int                       `json:"v"`
	RunID                 string                    `json:"runId"`
	Entry                 string                    `json:"entry"`
	TaskConfig            json.RawMessage           `json:"taskConfig"`
	ScanConfig            json.RawMessage           `json:"scanConfig"`
	AnalysisConfig        json.RawMessage           `json:"analysisConfig"`
	Limit                 int                       `json:"limit"`
	Processes             int                       `json:"processes"`
	TimeoutMs             int64                     `json:"timeoutMs"`
	MaxAttempts           int                       `json:"maxAttempts"`
	Backoff               api.Backoff               `json:"backoff"`
	MaxAnalysesPerProcess int                       `json:"maxAnalysesPerProcess"`
	TotalTimeoutMs        int64                     `json:"totalTimeoutMs"`
	Debug                 bool                      `json:"debug"`
	DataSources           api.DataSources           `json:"dataSources"`
	Uploads               map[string]Upload         `json:"uploads"`
	Resolved              map[string]api.Resolution `json:"resolved"`
	Limits                SpecLimits                `json:"limits"`
	OutDir                string                    `json:"outDir"`
}

// HasAnalysisConfig reports whether run is called once with the analysis config (schedule skipped).
func (s *Spec) HasAnalysisConfig() bool { return present(s.AnalysisConfig) }

func present(raw json.RawMessage) bool {
	t := bytes.TrimSpace(raw)
	return len(t) > 0 && !bytes.Equal(t, []byte("null"))
}

func isObject(raw json.RawMessage) bool {
	t := bytes.TrimSpace(raw)
	return len(t) > 0 && t[0] == '{'
}

// ReadSpec reads and validates a spec file.
func ReadSpec(path string) (*Spec, error) {
	data, err := os.ReadFile(path) //nolint:gosec // the spec path is an input of local mode
	if err != nil {
		return nil, fmt.Errorf("read the spec: %w", err)
	}
	return ParseSpec(data)
}

// ParseSpec decodes and validates a spec, applying the optional defaults.
func ParseSpec(data []byte) (*Spec, error) {
	var s Spec
	dec := json.NewDecoder(bytes.NewReader(data))
	if err := dec.Decode(&s); err != nil {
		return nil, fmt.Errorf("invalid spec: %w", err)
	}
	var errs []error
	check := func(ok bool, format string, args ...any) {
		if !ok {
			errs = append(errs, fmt.Errorf(format, args...))
		}
	}
	check(s.V == SpecVersion, "v must be %d", SpecVersion)
	check(s.RunID != "", "runId is required")
	check(s.Entry != "", "entry is required")
	check(isObject(s.TaskConfig), "taskConfig must be an object")
	if s.HasAnalysisConfig() {
		check(isObject(s.AnalysisConfig), "analysisConfig must be an object")
	} else {
		check(isObject(s.ScanConfig), "scanConfig or analysisConfig must be an object")
	}
	check(s.Limit >= 1, "limit must be at least 1")
	if s.Processes == 0 {
		s.Processes = 1
	}
	check(s.Processes >= 1, "processes must be at least 1")
	check(s.TimeoutMs > 0, "timeoutMs must be positive")
	check(s.MaxAttempts >= 1, "maxAttempts must be at least 1")
	check(s.Backoff.InitialMs >= 0 && s.Backoff.MaxMs >= 0, "backoff must not be negative")
	check(s.MaxAnalysesPerProcess >= 1, "maxAnalysesPerProcess must be at least 1")
	check(s.TotalTimeoutMs >= 0, "totalTimeoutMs must not be negative")
	check(s.Limits.LogTailBytes > 0 && s.Limits.LogTailEarlierBytes > 0, "limits.logTailBytes and limits.logTailEarlierBytes are required")
	if s.OutDir == "" {
		s.OutDir = DefaultOutDir
	}
	if s.Debug {
		s.Processes = 1
	}
	if len(errs) > 0 {
		return nil, fmt.Errorf("invalid spec: %w", errors.Join(errs...))
	}
	return &s, nil
}

// SafeName is the sanitised last path segment of a user-supplied file name (docs/data-model.md §9),
// identical to the orchestrator's: NFC, every UTF-16 code unit outside [A-Za-z0-9._-] replaced by `_`,
// at most 128 code units, never empty, `.` or `..`.
func SafeName(name string) string {
	units := utf16.Encode([]rune(norm.NFC.String(name)))
	out := make([]byte, 0, min(len(units), 128))
	for _, u := range units {
		if len(out) == 128 {
			break
		}
		if u < 0x80 && safeByte(byte(u)) {
			out = append(out, byte(u))
		} else {
			out = append(out, '_')
		}
	}
	switch s := string(out); s {
	case "":
		return "_"
	case ".", "..":
		return string(bytes.Repeat([]byte("_"), len(s)))
	default:
		return s
	}
}

func safeByte(c byte) bool {
	return c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-'
}
