package bundlerun

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/bundle"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/local"
	"github.com/lonetis/scantor/internal/runtime/scheduler"
	"github.com/lonetis/scantor/internal/version"
)

// Files of a run directory (docs/runtime.md §15.8).
const (
	ResultsFile = "results.jsonl"
	RunFile     = "run.json"
	// RunFileVersion is the `v` of run.json.
	RunFileVersion = 1
)

// runFileInterval is the period of the run.json rewrites while a run is running (a variable for tests).
var runFileInterval = 30 * time.Second

// RunInfo is run.json: what ran with which effective configs (secrets masked) and settings, the template
// resolutions (kept for a future --resume) and, once the run ended, its summary, reason and exit code.
type RunInfo struct {
	V              int                      `json:"v"`
	Bundle         RunBundle                `json:"bundle"`
	ScantorVersion string                   `json:"scantorVersion"`
	StartedAt      api.Time                 `json:"startedAt"`
	FinishedAt     *api.Time                `json:"finishedAt"`
	TaskConfig     json.RawMessage          `json:"taskConfig"`
	ScanConfig     json.RawMessage          `json:"scanConfig"`
	AnalysisConfig json.RawMessage          `json:"analysisConfig"`
	Settings       bundle.Settings          `json:"settings"`
	Limit          int                      `json:"limit"`
	TotalTimeoutMs int64                    `json:"totalTimeoutMs"`
	Uploads        []Upload                 `json:"uploads"`
	Resolved       map[string]RunResolution `json:"resolved"`
	Summary        local.Summary            `json:"summary"`
	// Reason and ExitCode are null while the run is running.
	Reason   *string `json:"reason"`
	ExitCode *int    `json:"exitCode"`
}

// RunBundle identifies the bundle of a run.
type RunBundle struct {
	Image    string       `json:"image"`
	Ref      string       `json:"ref"`
	Language string       `json:"language"`
	Platform api.Platform `json:"platform"`
}

// RunResolution is a template resolution of a run (the resolved event without type and time).
type RunResolution struct {
	Template      string          `json:"template"`
	ScanConfig    json.RawMessage `json:"scanConfig"`
	Provenance    json.RawMessage `json:"provenance"`
	ExpectedTotal *int64          `json:"expectedTotal"`
}

// ResultLine is one line of results.jsonl: the local-mode result event without type, secrets masked, with
// the logTail that --log-tails keeps.
type ResultLine struct {
	At       api.Time          `json:"at"`
	Seq      int64             `json:"seq"`
	Status   string            `json:"status"`
	Attempt  int               `json:"attempt"`
	Config   json.RawMessage   `json:"config"`
	Result   json.RawMessage   `json:"result"`
	Error    *api.ScantorError `json:"error"`
	Files    []local.File      `json:"files"`
	LogTail  string            `json:"logTail"`
	Attempts []local.Attempt   `json:"attempts"`
	Timings  local.Timings     `json:"timings"`
}

// sink is the local.Sink of a bundle run: it masks secrets, appends results.jsonl, keeps run.json and
// hands every event to the console. A failed write of the run directory closes failed, which stops the run
// (reason outputFailed, exit 3).
type sink struct {
	dir      string
	owner    *local.FileOwner
	logTails string
	masker   masker
	console  *console

	mu       sync.Mutex
	results  *os.File
	info     RunInfo
	err      error
	failed   chan struct{}
	failOnce sync.Once

	stop chan struct{}
	done chan struct{}
}

// newSink creates results.jsonl and the first run.json in the run directory and starts the periodic
// run.json rewrites and progress lines.
func newSink(o *Options, p *prepared, console *console) (*sink, error) {
	results, err := os.OpenFile(filepath.Join(p.outDir, ResultsFile), os.O_WRONLY|os.O_CREATE|os.O_EXCL|os.O_APPEND, 0o644) //nolint:gosec // the recipient reads the results
	if err != nil {
		return nil, fmt.Errorf("create %s: %w", ResultsFile, unwrapPathError(err))
	}
	if p.owner != nil {
		_ = results.Chown(p.owner.UID, p.owner.GID)
	}
	m := masker{paths: o.Info.Description.SecretPaths}
	uploads := p.uploads
	if uploads == nil {
		uploads = []Upload{}
	}
	logTails := o.Flags.LogTails
	if logTails == "" {
		logTails = LogTailsFailed
	}
	s := &sink{
		dir: p.outDir, owner: p.owner, logTails: logTails, masker: m, console: console, results: results,
		info: RunInfo{
			V: RunFileVersion,
			Bundle: RunBundle{
				Image: o.Info.Image, Ref: o.Info.Ref, Language: o.Info.Language, Platform: o.Info.Platform,
			},
			ScantorVersion: version.Version,
			StartedAt:      api.NewTime(o.Now()),
			TaskConfig:     m.taskConfig(p.taskConfig),
			ScanConfig:     m.scanConfig(p.scanConfig),
			AnalysisConfig: m.analysisConfig(p.analysisConfig),
			Settings:       p.settings,
			Limit:          o.Flags.Limit,
			TotalTimeoutMs: o.Flags.TotalTimeout.Milliseconds(),
			Uploads:        uploads,
			Resolved:       map[string]RunResolution{},
		},
		failed: make(chan struct{}), stop: make(chan struct{}), done: make(chan struct{}),
	}
	if err := s.writeInfo(); err != nil {
		_ = results.Close()
		return nil, err
	}
	go s.tick()
	return s, nil
}

// tick rewrites run.json every runFileInterval and prints the progress lines until close.
func (s *sink) tick() {
	defer close(s.done)
	info := time.NewTicker(runFileInterval)
	defer info.Stop()
	progress := time.NewTicker(progressInterval)
	defer progress.Stop()
	for {
		select {
		case <-info.C:
			s.mu.Lock()
			s.writeInfoLocked()
			s.mu.Unlock()
		case <-progress.C:
			s.console.progress()
		case <-s.stop:
			return
		}
	}
}

// Failed is closed when the run directory cannot be written (local.Options.Stop).
func (s *sink) Failed() <-chan struct{} { return s.failed }

// Emit implements local.Sink.
func (s *sink) Emit(ev any) {
	switch e := ev.(type) {
	case local.ResolvedEvent:
		if e.Key == scheduler.KeySchedule {
			e.ScanConfig = s.masker.scanConfig(e.ScanConfig)
		}
		s.mu.Lock()
		s.info.Resolved[e.Key] = RunResolution{Template: e.Template, ScanConfig: e.ScanConfig, Provenance: e.Provenance, ExpectedTotal: e.ExpectedTotal}
		s.writeInfoLocked()
		s.mu.Unlock()
		ev = e
	case local.ScheduledEvent:
		e.Config = s.masker.analysisConfig(e.Config)
		ev = e
	case local.ResultEvent:
		e.Config = s.masker.analysisConfig(e.Config)
		e.Result = s.masker.result(e.Result)
		s.appendResult(e)
		ev = e
	case local.EndEvent:
		s.mu.Lock()
		finished := e.At
		s.info.FinishedAt, s.info.Summary = &finished, e.Summary
		reason, code := e.Reason, e.ExitCode
		s.info.Reason, s.info.ExitCode = &reason, &code
		s.mu.Unlock()
	}
	s.console.event(ev)
}

// appendResult writes the line of a final analysis with one write call, so lines never interleave.
func (s *sink) appendResult(e local.ResultEvent) {
	line := ResultLine{
		At: e.At, Seq: e.Seq, Status: e.Status, Attempt: e.Attempt, Config: e.Config, Result: e.Result, Error: e.Error,
		Files: e.Files, LogTail: e.LogTail, Attempts: e.Attempts, Timings: e.Timings,
	}
	if s.logTails == LogTailsNone || s.logTails == LogTailsFailed && e.Status == runtime.StatusSucceeded {
		line.LogTail = ""
	}
	data, err := encodeLine(line)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.info.Summary.Analyses++
	if e.Status == runtime.StatusSucceeded {
		s.info.Summary.Succeeded++
	} else {
		s.info.Summary.Failed++
	}
	if s.err != nil {
		return
	}
	if err == nil {
		_, err = s.results.Write(data)
	}
	if err != nil {
		s.failLocked(fmt.Errorf("write %s: %w", ResultsFile, unwrapPathError(err)))
	}
}

// Err implements local.Sink: the first write error of the run directory or of the console.
func (s *sink) Err() error {
	s.mu.Lock()
	err := s.err
	s.mu.Unlock()
	if err != nil {
		return err
	}
	return s.console.Err()
}

func (s *sink) failLocked(err error) {
	if s.err == nil {
		s.err = err
		s.console.failure(err)
	}
	s.failOnce.Do(func() { close(s.failed) })
}

// writeInfoLocked replaces run.json; a failure stops the run.
func (s *sink) writeInfoLocked() {
	if s.err != nil {
		return
	}
	if err := s.writeInfo(); err != nil {
		s.failLocked(err)
	}
}

// writeInfo replaces run.json atomically: a temporary file, fsync, rename.
func (s *sink) writeInfo() error {
	data, err := json.MarshalIndent(s.info, "", "  ")
	if err == nil {
		err = s.replace(RunFile, append(data, '\n'))
	}
	if err != nil {
		return fmt.Errorf("write %s: %w", RunFile, unwrapPathError(err))
	}
	return nil
}

func (s *sink) replace(name string, data []byte) error {
	tmp, err := os.CreateTemp(s.dir, "."+name+".*")
	if err != nil {
		return err
	}
	_, err = tmp.Write(data)
	if err == nil {
		err = tmp.Chmod(0o644)
	}
	if err == nil && s.owner != nil {
		_ = tmp.Chown(s.owner.UID, s.owner.GID)
	}
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), filepath.Join(s.dir, name))
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
	}
	return err
}

// close ends the run directory after local.Run returned code: it fsyncs and closes results.jsonl, writes the
// final run.json and prints the summary. It returns the exit code of the run, 3 when the run directory
// could not be written.
func (s *sink) close(code int) int {
	close(s.stop)
	<-s.done
	s.mu.Lock()
	err := s.results.Sync()
	if cerr := s.results.Close(); err == nil {
		err = cerr
	}
	if err != nil && s.err == nil {
		s.failLocked(fmt.Errorf("write %s: %w", ResultsFile, unwrapPathError(err)))
	}
	if s.err != nil {
		code = max(code, local.ExitPlatform)
	}
	if s.info.FinishedAt == nil {
		now := api.Now()
		s.info.FinishedAt = &now
	}
	if s.info.Reason == nil {
		reason := local.ReasonOutputFailed
		s.info.Reason = &reason
	}
	s.info.ExitCode = &code
	s.writeInfoLocked()
	if s.err != nil {
		code = max(code, local.ExitPlatform)
	}
	info := s.info
	s.mu.Unlock()
	s.console.final(info, code)
	return code
}

func encodeLine(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	if buf.Len() == 0 {
		return nil, errors.New("empty line")
	}
	return buf.Bytes(), nil
}
