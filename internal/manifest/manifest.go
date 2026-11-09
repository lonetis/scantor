// Package manifest parses and validates the task manifest scantor.yaml (docs/tasks.md §3): YAML 1.2
// parsing without duplicate keys, the strict JSON Schema schemas/task-manifest.schema.json (M2) and the
// semantic rules M1–M10, and normalises the result into the stored manifest and the revision's
// settingsDefaults. CheckScript does the same for the script manifest scantor-script.yaml (rules S1–S6,
// docs/scripts.md), sharing the YAML bounds, the schema step and the entry rules.
package manifest

import (
	"encoding/json"
	"fmt"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	scantor "github.com/lonetis/scantor"
	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/envconf"
	"github.com/lonetis/scantor/internal/languages"
	"github.com/lonetis/scantor/internal/schema"
)

// FileName is the exact name of the manifest at the task root.
const FileName = "scantor.yaml"

// SchemaPath is the path of the manifest schema inside scantor.Schemas.
const SchemaPath = "schemas/task-manifest.schema.json"

// MaxBytes is the maximum manifest size (M1).
const MaxBytes = 64 << 10

// Manifest is the normalised manifest stored on revisions: the document as written with `entry`
// defaulted; `defaults` keeps the manifest's own names and units.
type Manifest struct {
	Scantor     int      `json:"scantor"`
	Name        string   `json:"name"`
	Language    string   `json:"language"`
	Description string   `json:"description,omitempty"`
	Entry       string   `json:"entry"`
	Defaults    Defaults `json:"defaults"`
}

// Defaults are the manifest's default scan settings as written; nil means "not set".
type Defaults struct {
	Workers               *int               `json:"workers,omitempty"`
	Processes             *int               `json:"processes,omitempty"`
	Timeout               *string            `json:"timeout,omitempty"`
	MaxAttempts           *int               `json:"maxAttempts,omitempty"`
	Backoff               *BackoffDefaults   `json:"backoff,omitempty"`
	Resources             *ResourcesDefaults `json:"resources,omitempty"`
	MaxAnalysesPerProcess *int               `json:"maxAnalysesPerProcess,omitempty"`
	Privileged            *bool              `json:"privileged,omitempty"`
}

// BackoffDefaults are the manifest's backoff defaults.
type BackoffDefaults struct {
	Initial *string  `json:"initial,omitempty"`
	Factor  *float64 `json:"factor,omitempty"`
	Max     *string  `json:"max,omitempty"`
	Jitter  *bool    `json:"jitter,omitempty"`
}

// ResourcesDefaults are the manifest's per-process resource defaults.
type ResourcesDefaults struct {
	CPUs   *float64 `json:"cpus,omitempty"`
	Memory *string  `json:"memory,omitempty"`
}

// Limits are the instance limits of rule M8.
type Limits struct {
	MaxWorkersPerScan     int
	MaxProcessesPerWorker int
}

// DefaultLimits are the compiled-in limits, equal to the .env.example defaults of
// SCANTOR_MAX_WORKERS_PER_SCAN and SCANTOR_MAX_PROCESSES_PER_WORKER.
func DefaultLimits() Limits { return Limits{MaxWorkersPerScan: 100, MaxProcessesPerWorker: 64} }

// Options configure Check.
type Options struct {
	// Limits are the instance limits (M8); the zero value means DefaultLimits.
	Limits Limits
	// ExpectName, when set, must equal the manifest name (M9).
	ExpectName string
	// AllowPrivileged permits `defaults.privileged: true` (M10).
	AllowPrivileged bool
	// IsRegularFile reports whether a '/'-separated path relative to the task root is a regular file of
	// the pack. When nil, the existence part of M4 is skipped.
	IsRegularFile func(path string) bool
	// Languages is the language table; nil means the embedded table.
	Languages *languages.Table
}

// Result is a valid manifest with its derived values.
type Result struct {
	Manifest Manifest
	Language languages.Language
	// SettingsDefaults are the normalised default settings (ScanSettings without nodeSelector).
	SettingsDefaults api.ScanSettings
	Privileged       bool
}

// Issue is one manifest error; Line and Column are 1-based (0 when unknown), Path is the JSON pointer of
// the offending value.
type Issue struct {
	Rule string
	// File is the manifest the issue belongs to: ScriptFileName for the issues of CheckScript, "" for
	// the task manifest FileName.
	File    string
	Path    string
	Line    int
	Column  int
	Message string
}

func (i Issue) file() string {
	if i.File == "" {
		return FileName
	}
	return i.File
}

// String renders "<manifest>:<line>: <message>", for example "scantor.yaml:3: …".
func (i Issue) String() string {
	if i.Line > 0 {
		return fmt.Sprintf("%s:%d: %s", i.file(), i.Line, i.Message)
	}
	return i.file() + ": " + i.Message
}

// BuildError converts the issue into a static-phase BuildError of its manifest file.
func (i Issue) BuildError() api.BuildError {
	return api.BuildError{Phase: api.BuildPhaseStatic, File: i.file(), Line: i.Line, Column: i.Column, Message: i.Message}
}

// embeddedSchema compiles one embedded JSON Schema once.
type embeddedSchema struct {
	path     string
	once     sync.Once
	compiled *schema.Schema
	err      error
}

func (e *embeddedSchema) get() (*schema.Schema, error) {
	e.once.Do(func() {
		data, err := scantor.Schemas.ReadFile(e.path)
		if err != nil {
			e.err = fmt.Errorf("read embedded %s: %w", e.path, err)
			return
		}
		e.compiled, e.err = schema.Compile(data)
	})
	return e.compiled, e.err
}

var taskSchema = &embeddedSchema{path: SchemaPath}

// decode applies the steps every manifest shares: the size bound and the YAML parsing of M1 and the
// strict schema of M2, then decodes the document into out. It returns the parsed document for the
// positions of later issues, or every issue of the first failing step.
func decode(data []byte, s *embeddedSchema, out any) (*document, []Issue) {
	if len(data) > MaxBytes {
		return nil, []Issue{{Rule: "M1", Message: fmt.Sprintf("the manifest is %d bytes; the limit is %d", len(data), MaxBytes)}}
	}
	doc, issues := parseYAML(data)
	if issues != nil {
		return nil, issues
	}
	compiled, err := s.get()
	if err != nil {
		return nil, []Issue{{Rule: "M2", Message: err.Error()}}
	}
	if schemaIssues := compiled.Validate(doc.value); len(schemaIssues) > 0 {
		return nil, doc.schemaIssues(schemaIssues)
	}
	raw, err := json.Marshal(doc.value)
	if err != nil {
		return nil, []Issue{{Rule: "M2", Message: fmt.Sprintf("encode manifest: %v", err)}}
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return nil, []Issue{{Rule: "M2", Message: fmt.Sprintf("decode manifest: %v", err)}}
	}
	return doc, nil
}

// languageTable returns opts.Languages, or the embedded table when it is nil.
func languageTable(opts Options) (*languages.Table, error) {
	if opts.Languages != nil {
		return opts.Languages, nil
	}
	return languages.Load()
}

// taskEntryRules are the entry rules M4/M5 of scantor.yaml.
func taskEntryRules(lang languages.Language) entryRules {
	return entryRules{defaultEntry: lang.Entry, sourceRule: "M4", binaryRule: "M5", kind: "task", file: FileName}
}

// Check parses data and applies rules M1–M10. It returns the result, or nil and every issue of the
// first failing step (M1, then M2, then the semantic rules M3–M10 together).
func Check(data []byte, opts Options) (*Result, []Issue) {
	var m Manifest
	doc, issues := decode(data, taskSchema, &m)
	if issues != nil {
		return nil, issues
	}
	table, err := languageTable(opts)
	if err != nil {
		return nil, []Issue{{Rule: "M3", Message: err.Error()}}
	}
	limits := opts.Limits
	if limits == (Limits{}) {
		limits = DefaultLimits()
	}
	c := checker{doc: doc, m: &m}
	lang, ok := table.Get(m.Language)
	if !ok {
		c.add("M3", "/language", fmt.Sprintf("unknown language %q", m.Language))
	} else {
		c.checkEntry(&m.Entry, lang, taskEntryRules(lang), opts.IsRegularFile)
	}
	settings := c.settings(limits)
	if opts.ExpectName != "" && m.Name != opts.ExpectName {
		c.add("M9", "/name", fmt.Sprintf("name %q does not match task %q; task names are immutable", m.Name, opts.ExpectName))
	}
	if settings.Privileged && !opts.AllowPrivileged {
		c.add("M10", "/defaults/privileged", "privileged tasks require the canRunPrivileged permission")
	}
	if len(c.issues) > 0 {
		return nil, c.issues
	}
	return &Result{Manifest: m, Language: lang, SettingsDefaults: settings, Privileged: settings.Privileged}, nil
}

func (d *document) schemaIssues(in []schema.Issue) []Issue {
	out := make([]Issue, 0, len(in))
	for _, is := range in {
		ptr := is.Path
		msg := is.Message
		switch {
		case is.Keyword == "additionalProperties" && len(is.Properties) > 0:
			ptr = is.Path + "/" + escapePointer(is.Properties[0])
			msg = fmt.Sprintf("unknown key %s", quoteAll(is.Properties))
		case is.Keyword == "required" && len(is.Properties) > 0:
			msg = fmt.Sprintf("missing required key %s", quoteAll(is.Properties))
		case is.Keyword == "not" && is.Path == "/name":
			msg = "must not be a uuid or a reserved name (upload, import-git, new, latest)"
		}
		if ptr != "" && is.Keyword != "additionalProperties" && is.Keyword != "required" {
			msg = ptr + ": " + msg
		} else if is.Path != "" {
			msg = is.Path + ": " + msg
		}
		pos := d.position(ptr)
		out = append(out, Issue{Rule: "M2", Path: ptr, Line: pos.line, Column: pos.column, Message: msg})
	}
	return out
}

func quoteAll(names []string) string {
	q := make([]string, len(names))
	for i, n := range names {
		q[i] = strconv.Quote(n)
	}
	return strings.Join(q, ", ")
}

type checker struct {
	doc    *document
	m      *Manifest
	issues []Issue
}

func (c *checker) add(rule, ptr, msg string) {
	pos := c.doc.position(ptr)
	c.issues = append(c.issues, Issue{Rule: rule, Path: ptr, Line: pos.line, Column: pos.column, Message: msg})
}

// entryRules are what the entry rules of the task manifest (M4/M5) and the script manifest (S4/S5)
// differ in: the default entry, the rule ids, the folder kind and the manifest file named in messages.
type entryRules struct {
	defaultEntry string
	sourceRule   string
	binaryRule   string
	kind         string
	file         string
}

// checkEntry applies the source rule (source languages) and the binary rule (binary languages) to
// *entry and defaults it. A defaulted source entry (main.py, main.ts, …) must exist too: only its path
// rules are known to hold.
func (c *checker) checkEntry(entry *string, lang languages.Language, rules entryRules, isRegularFile func(string) bool) {
	if *entry == "" {
		*entry = rules.defaultEntry
		if lang.IsSource() && isRegularFile != nil && !isRegularFile(*entry) {
			c.add(rules.sourceRule, "/entry", fmt.Sprintf("entry %q is not a regular file of the %s folder (the default entry of %s %ss; set entry in %s to use another file)", *entry, rules.kind, lang.Name, rules.kind, rules.file))
		}
		return
	}
	if lang.IsSource() {
		switch {
		case path.IsAbs(*entry):
			c.add(rules.sourceRule, "/entry", fmt.Sprintf("entry %q must be a relative path", *entry))
		case !normalised(*entry):
			c.add(rules.sourceRule, "/entry", fmt.Sprintf("entry %q must be a normalised path without ./ or .. segments", *entry))
		case !lang.HasExtension(*entry):
			c.add(rules.sourceRule, "/entry", fmt.Sprintf("entry %q must end in %s", *entry, joinOr(lang.Extensions)))
		case isRegularFile != nil && !isRegularFile(*entry):
			c.add(rules.sourceRule, "/entry", fmt.Sprintf("entry %q is not a regular file of the %s folder", *entry, rules.kind))
		}
		return
	}
	trimmed := strings.TrimPrefix(*entry, "/")
	if trimmed == "" || !normalised(trimmed) {
		c.add(rules.binaryRule, "/entry", fmt.Sprintf("entry %q must be a normalised path without ./ or .. segments", *entry))
	}
}

func normalised(p string) bool {
	if p == "" || strings.HasSuffix(p, "/") || strings.Contains(p, "//") {
		return false
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "." || seg == ".." {
			return false
		}
	}
	return path.Clean(p) == p
}

func joinOr(items []string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	default:
		return strings.Join(items[:len(items)-1], ", ") + " or " + items[len(items)-1]
	}
}

const (
	minTimeout     = time.Second
	maxDuration    = 24 * time.Hour
	minBackoff     = time.Second
	minMemoryBytes = 64 * envconf.MiB
	maxMemoryBytes = 64 * envconf.GiB
)

// settings applies M6–M8 and returns the normalised settingsDefaults.
func (c *checker) settings(limits Limits) api.ScanSettings {
	s := api.DefaultScanSettings()
	d := c.m.Defaults
	if d.Workers != nil {
		s.Workers = *d.Workers
		if s.Workers > limits.MaxWorkersPerScan {
			c.add("M8", "/defaults/workers", fmt.Sprintf("/defaults/workers: %d exceeds this instance's maximum %d", s.Workers, limits.MaxWorkersPerScan))
		}
	}
	if d.Processes != nil {
		s.Processes = *d.Processes
		if s.Processes > limits.MaxProcessesPerWorker {
			c.add("M8", "/defaults/processes", fmt.Sprintf("/defaults/processes: %d exceeds this instance's maximum %d", s.Processes, limits.MaxProcessesPerWorker))
		}
	}
	if d.Timeout != nil {
		if v, ok := c.duration("/defaults/timeout", *d.Timeout, minTimeout, maxDuration); ok {
			s.TimeoutMs = v.Milliseconds()
		}
	}
	if d.MaxAttempts != nil {
		s.MaxAttempts = *d.MaxAttempts
	}
	if b := d.Backoff; b != nil {
		initialOK, maxOK := true, true
		if b.Initial != nil {
			var v time.Duration
			if v, initialOK = c.duration("/defaults/backoff/initial", *b.Initial, minBackoff, maxDuration); initialOK {
				s.Backoff.InitialMs = v.Milliseconds()
			}
		}
		if b.Max != nil {
			var v time.Duration
			if v, maxOK = c.duration("/defaults/backoff/max", *b.Max, minBackoff, maxDuration); maxOK {
				s.Backoff.MaxMs = v.Milliseconds()
			}
		}
		if b.Factor != nil {
			s.Backoff.Factor = *b.Factor
		}
		if b.Jitter != nil {
			s.Backoff.Jitter = *b.Jitter
		}
		if initialOK && maxOK && s.Backoff.MaxMs < s.Backoff.InitialMs {
			initial := time.Duration(s.Backoff.InitialMs) * time.Millisecond
			maxDelay := time.Duration(s.Backoff.MaxMs) * time.Millisecond
			if b.Max != nil {
				c.add("M6", "/defaults/backoff/max", fmt.Sprintf("/defaults/backoff/max: %s is shorter than initial %s", fmtDuration(maxDelay), fmtDuration(initial)))
			} else {
				c.add("M6", "/defaults/backoff/initial", fmt.Sprintf("/defaults/backoff/initial: %s is longer than the default max %s; set backoff.max", fmtDuration(initial), fmtDuration(maxDelay)))
			}
		}
	}
	if r := d.Resources; r != nil {
		if r.CPUs != nil {
			s.Resources.CPUs = *r.CPUs
		}
		if r.Memory != nil {
			if mib, ok := c.memory(*r.Memory); ok {
				s.Resources.MemoryMiB = mib
			}
		}
	}
	if d.MaxAnalysesPerProcess != nil {
		s.MaxAnalysesPerProcess = *d.MaxAnalysesPerProcess
	}
	if d.Privileged != nil {
		s.Privileged = *d.Privileged
	}
	return s
}

func (c *checker) duration(ptr, value string, minimum, maximum time.Duration) (time.Duration, bool) {
	v, err := time.ParseDuration(value)
	if err != nil {
		c.add("M6", ptr, fmt.Sprintf("%s: invalid duration %q", ptr, value))
		return 0, false
	}
	if v < minimum || v > maximum {
		c.add("M6", ptr, fmt.Sprintf("%s: %s is outside %s … %s", ptr, value, fmtDuration(minimum), fmtDuration(maximum)))
		return 0, false
	}
	return v, true
}

func (c *checker) memory(value string) (int64, bool) {
	const ptr = "/defaults/resources/memory"
	n, err := envconf.ParseByteSize(value)
	switch {
	case err != nil:
		c.add("M7", ptr, fmt.Sprintf("%s: invalid byte size %q", ptr, value))
	case n%envconf.MiB != 0:
		c.add("M7", ptr, fmt.Sprintf("%s: %s is not a whole number of MiB", ptr, value))
	case n < minMemoryBytes || n > maxMemoryBytes:
		c.add("M7", ptr, fmt.Sprintf("%s: %s is outside 64MiB … 64GiB", ptr, value))
	default:
		return n / envconf.MiB, true
	}
	return 0, false
}

// fmtDuration renders a duration in the manifest's syntax (whole h, m, s, ms units).
func fmtDuration(d time.Duration) string {
	if d == 0 {
		return "0s"
	}
	var b strings.Builder
	for _, u := range []struct {
		unit time.Duration
		name string
	}{{time.Hour, "h"}, {time.Minute, "m"}, {time.Second, "s"}, {time.Millisecond, "ms"}} {
		if n := d / u.unit; n > 0 {
			b.WriteString(strconv.FormatInt(int64(n), 10) + u.name)
			d -= n * u.unit
		}
	}
	return b.String()
}
