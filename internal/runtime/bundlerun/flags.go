package bundlerun

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/schema"
)

// Flags are the flags of bundle mode, the recipient's interface (docs/runtime.md §15.7). They mirror
// `scans start` and `dev run`.
type Flags struct {
	// TaskConfig, ScanConfig, AnalysisConfig and Settings are raw flag values: JSON, @file (relative to
	// the work directory) or - (stdin, for at most one flag); empty means not given.
	TaskConfig, ScanConfig, AnalysisConfig, Settings string
	// Processes overrides settings.processes; 0 means not given.
	Processes int
	// Limit bounds the analyses taken from the schedule; 0 means the whole schedule.
	Limit int
	// TotalTimeout bounds the whole run; 0 means none.
	TotalTimeout time.Duration
	// Out is the run directory; empty means results/<UTC 20060102T150405Z> (-2, -3, … when it exists).
	Out string
	// LogTails selects the logTail of results.jsonl lines: failed (the default), all or none.
	LogTails string
	// Describe prints the bundle, the effective configs and settings and the recommended limits, and exits.
	Describe bool
}

// Flag names of bundle mode.
const (
	FlagTaskConfig     = "task-config"
	FlagScanConfig     = "scan-config"
	FlagAnalysisConfig = "analysis-config"
	FlagSettings       = "settings"
	FlagProcesses      = "processes"
	FlagLimit          = "limit"
	FlagTotalTimeout   = "total-timeout"
	FlagOut            = "out"
	FlagLogTails       = "log-tails"
	FlagDescribe       = "describe"
)

// Values of --log-tails.
const (
	LogTailsFailed = "failed"
	LogTailsAll    = "all"
	LogTailsNone   = "none"
)

// FlagDoc documents one flag: its name, the name of its value ("" for a boolean flag) and its help text.
type FlagDoc struct {
	Name, Value, Help string
}

// FlagDocs are the flags of bundle mode in the order Usage lists them; the CLI registers the flags with
// these help texts.
var FlagDocs = []FlagDoc{
	{FlagTaskConfig, "json", "task config: JSON, @file (relative to /work) or - (stdin, needs docker run -i); schema defaults fill the rest"},
	{FlagScanConfig, "json", "scan config: JSON, @file or -; a string at an upload field is the path of a file below /work"},
	{FlagAnalysisConfig, "json", "run once (seq 0) with this analysis config and skip the schedule: JSON, @file or -"},
	{FlagSettings, "json", "settings: processes, timeoutMs, maxAttempts, backoff (merged field by field), maxAnalysesPerProcess; JSON, @file or -"},
	{FlagProcesses, "n", "concurrent analyses (overrides settings.processes)"},
	{FlagLimit, "n", "at most n analyses from the schedule (0: the whole schedule)"},
	{FlagTotalTimeout, "duration", "stop the run after this time, for example 2h30m (0: no limit)"},
	{FlagOut, "dir", "run directory, relative to /work (default results/<UTC time>); must not exist or be empty"},
	{FlagLogTails, "which", "log tails in results.jsonl: failed, all or none"},
	{FlagDescribe, "", "print the effective configs, settings, schemas and recommended limits, and exit"},
}

// FlagHelp returns the help text of the flag name.
func FlagHelp(name string) string {
	for _, f := range FlagDocs {
		if f.Name == name {
			return f.Help
		}
	}
	return ""
}

// maxValueBytes bounds a config or settings value read from a file or stdin.
const maxValueBytes = 16 << 20

// readObject reads the value of a config or settings flag (JSON, @file or -) and checks that it is a JSON
// object. An empty value is not given (nil, no issue).
func (o *Options) readObject(flag, value string) (json.RawMessage, *api.Issue) {
	if value == "" {
		return nil, nil
	}
	var data []byte
	switch {
	case value == "-":
		b, err := io.ReadAll(io.LimitReader(o.Stdin, maxValueBytes+1))
		if err != nil {
			return nil, issue("--"+flag, "cannot read stdin: %v", err)
		}
		data = b
	case value[0] == '@':
		name := o.workPath(value[1:])
		f, err := os.Open(name) //nolint:gosec // a file the recipient names
		if err != nil {
			return nil, issue("--"+flag, "cannot read %s: %v", value[1:], unwrapPathError(err))
		}
		b, err := io.ReadAll(io.LimitReader(f, maxValueBytes+1))
		_ = f.Close()
		if err != nil {
			return nil, issue("--"+flag, "cannot read %s: %v", value[1:], unwrapPathError(err))
		}
		data = b
	default:
		data = []byte(value)
	}
	if len(data) > maxValueBytes {
		return nil, issue("--"+flag, "is larger than %d bytes", maxValueBytes)
	}
	doc, err := schema.ParseJSON(data)
	if err != nil {
		return nil, issue("--"+flag, "is not valid JSON: %v", err)
	}
	if _, ok := doc.(map[string]any); !ok {
		return nil, issue("--"+flag, "must be a JSON object")
	}
	return json.RawMessage(bytes.TrimSpace(data)), nil
}

// workPath resolves a path the recipient gives: relative paths are relative to the work directory.
func (o *Options) workPath(name string) string {
	if filepath.IsAbs(name) {
		return filepath.Clean(name)
	}
	return filepath.Join(o.WorkDir, name)
}

// unwrapPathError drops the path of an *os.PathError, which names the container path.
func unwrapPathError(err error) error {
	var pe *os.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}

func issue(path, format string, args ...any) *api.Issue {
	return &api.Issue{Path: path, Message: fmt.Sprintf(format, args...)}
}
