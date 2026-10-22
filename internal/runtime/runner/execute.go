package runner

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/protocol"
	"github.com/lonetis/scantor/internal/runtime/logtail"
	"github.com/lonetis/scantor/internal/runtime/pool"
	"github.com/lonetis/scantor/internal/runtime/scerr"
	"github.com/lonetis/scantor/internal/runtime/upload"
)

// Limits are the per-execution limits (bootstrap limits and uploads, or the local spec).
type Limits struct {
	MaxResultBytes      int64
	MaxFileBytes        int64
	MaxFilesPerAnalysis int
	StackBytes          int
}

// Control is a shutdown instruction for a running execution (docs/runtime.md §14): send `cancel` with
// Cancel as reason, or Kill the process group.
type Control struct {
	Cancel string
	Kill   bool
}

// ExecSpec describes one execution of an analysis (docs/runtime.md §8.3–§8.7).
type ExecSpec struct {
	Process    *pool.Process
	ScanID     string
	Seq        int64
	Round      int
	Attempt    int
	Config     json.RawMessage
	TaskConfig json.RawMessage
	// Timeout is settings.timeoutMs; 0 disables the deadline (`scantor dev debug`).
	Timeout  time.Duration
	WorkRoot string
	Limits   Limits
	// Now is the server-corrected clock.
	Now func() time.Time
	// Capture receives the execution's output (reset at dispatch); Output mirrors every line.
	Capture *logtail.Buffer
	Output  pool.Sink
	// Control delivers shutdown instructions; nil means none.
	Control <-chan Control
	// OnStart is called with the execution id and start time once the run was sent.
	OnStart func(executionID string, startedAt time.Time)
	// OnProgress receives the latest progress value.
	OnProgress func(json.RawMessage)
}

// Execution is the outcome of one execution.
type Execution struct {
	ID         string
	StartedAt  time.Time // server time
	FinishedAt time.Time
	Duration   time.Duration
	// Result is set on success.
	Result json.RawMessage
	// Files are the files registered during the run (uploaded only after success).
	Files []upload.File
	// Error is set on failure.
	Error *scerr.ScantorError
	// Recycle: the process must be replaced (timeout, crash, protocol violation, cancel).
	Recycle bool
	// Cancelled: the connector ended the run with `cancelled` after a cancel; not retried, not an attempt.
	Cancelled bool
	// Aborted: the runtime killed the process for a shutdown; nothing is published.
	Aborted bool
	// Dir is /tmp/scantor/x-<executionId>; Cleanup removes it.
	Dir string
}

// Cleanup removes the execution directory.
func (e *Execution) Cleanup() error {
	if e.Dir == "" {
		return nil
	}
	return os.RemoveAll(e.Dir)
}

// Succeeded reports whether the execution produced a result.
func (e *Execution) Succeeded() bool { return e.Error == nil && e.Result != nil }

// killDrain bounds how long an execution waits for a killed process's output.
const killDrain = 2 * time.Second

// Execute runs one analysis on spec.Process and classifies the outcome (docs/runtime.md §8.3–§8.7).
func Execute(ctx context.Context, spec ExecSpec) *Execution {
	x := &Execution{ID: uuid.NewString()}
	x.Dir = filepath.Join(spec.WorkRoot, "x-"+x.ID)
	tmpDir, filesDir := filepath.Join(x.Dir, "tmp"), filepath.Join(x.Dir, "files")
	monoStart := time.Now()
	x.StartedAt = spec.Now()
	finish := func() *Execution {
		x.FinishedAt = spec.Now()
		x.Duration = time.Since(monoStart)
		return x
	}
	fail := func(e scerr.ScantorError) *Execution {
		e.Attempt = spec.Attempt
		e.At = spec.Now()
		e = e.Truncate(spec.Limits.StackBytes)
		x.Error = &e
		return finish()
	}
	for _, d := range []string{tmpDir, filesDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			x.Recycle = true
			return fail(scerr.Newf(api.ErrorPlatform, api.PhasePlatform, "cannot create the execution directory: %v", err))
		}
	}

	var deadline time.Time
	var deadlineMs *int64
	var timerC <-chan time.Time
	if spec.Timeout > 0 {
		deadline = time.Now().Add(spec.Timeout)
		ms := deadline.UnixMilli() // container wall clock: connectors arm their timers against it
		deadlineMs = &ms
		timer := time.NewTimer(spec.Timeout)
		defer timer.Stop()
		timerC = timer.C
	}
	if spec.Capture != nil {
		spec.Capture.Reset()
	}
	proc := spec.Process
	proc.SetSink(func(stream, line string) {
		if spec.Capture != nil {
			spec.Capture.WriteString(line + "\n")
		}
		if spec.Output != nil {
			spec.Output(stream, line)
		}
	})
	defer proc.ClearSink()

	analysisID := spec.ScanID + "-" + fmt.Sprint(spec.Seq)
	seq, round := spec.Seq, spec.Round
	ctxMsg := protocol.Ctx{
		ScanID: spec.ScanID, AnalysisID: &analysisID, Seq: &seq, Round: &round, Attempt: spec.Attempt,
		ExecutionID: &x.ID, DeadlineMs: deadlineMs, TmpDir: tmpDir, FilesDir: &filesDir,
	}
	oomBefore := oomKills()
	call, err := proc.Run(ctxMsg, spec.Config, spec.TaskConfig)
	if err != nil {
		x.Recycle = true
		proc.Kill()
		return fail(scerr.New(api.ErrorCrash, api.PhaseRun, "cannot send the run request: "+err.Error()).
			WithDetails(map[string]any{"protocolError": err.Error()}))
	}
	defer call.End()
	if spec.OnStart != nil {
		spec.OnStart(x.ID, x.StartedAt)
	}

	files := &fileRegistry{dir: filesDir, limits: spec.Limits, names: map[string]bool{}}
	cancelSent := false
	killedByUs := false
	killAndDrain := func() {
		killedByUs = true
		proc.Kill()
		select {
		case <-proc.Done():
		case <-time.After(killDrain):
		}
	}
	for {
		select {
		case ev := <-call.Events():
			switch {
			case ev.Violation != nil:
				x.Recycle = true
				return fail(scerr.New(api.ErrorCrash, api.PhaseRun, "connector protocol violation: "+ev.Violation.Error()).
					WithDetails(map[string]any{"protocolError": ev.Violation.Error()}))
			case ev.Exit != nil:
				x.Recycle = true
				if killedByUs {
					x.Aborted = true
					return finish()
				}
				return fail(crash(*ev.Exit, oomBefore))
			}
			switch m := ev.Msg.(type) {
			case protocol.Result:
				proc.Flush(100 * time.Millisecond)
				x.Files = files.list
				if err := checkResult(m.Result, spec.Limits.MaxResultBytes); err != nil {
					return fail(*err)
				}
				x.Result = m.Result
				return finish()
			case protocol.Error:
				proc.Flush(100 * time.Millisecond)
				e := scerr.FromConnector(m.Error, scerr.InRun)
				e = scerr.ClassifyCancelled(e, cancelSent, time.Now(), deadline, spec.Timeout > 0)
				switch e.Type {
				case api.ErrorCancelled:
					x.Cancelled, x.Recycle = true, true
				case api.ErrorTimeout:
					x.Recycle = true
					killAndDrain()
				}
				return fail(e)
			case protocol.File:
				ref, ferr := files.register(m)
				var reply protocol.Message = protocol.FileRef{ID: m.ID, FileRef: ref}
				if ferr != nil {
					f := false
					reply = protocol.Error{ID: m.ID, Error: protocol.ErrorObject{Type: protocol.ErrorValidation, Message: ferr.Error(), Retryable: &f}}
				}
				if err := call.Send(reply); err != nil {
					x.Recycle = true
					killAndDrain()
					return fail(scerr.New(api.ErrorCrash, api.PhaseRun, "cannot answer the connector: "+err.Error()))
				}
			case protocol.Progress:
				if spec.OnProgress != nil {
					b, _ := json.Marshal(api.BusyProgress{Fraction: m.Fraction, Message: m.Message})
					spec.OnProgress(b)
				}
			case protocol.Template:
				f := false
				_ = call.Send(protocol.Error{ID: m.ID, Error: protocol.ErrorObject{Type: protocol.ErrorValidation, Message: "templates are only available in schedule", Retryable: &f}})
				call.CloseTemplate(m.ID)
			}
		case <-timerC:
			x.Recycle = true
			killAndDrain()
			return fail(scerr.Newf(api.ErrorTimeout, api.PhaseRun, "run exceeded %d ms", spec.Timeout.Milliseconds()))
		case c := <-spec.Control:
			if c.Kill {
				x.Recycle = true
				killAndDrain()
				x.Aborted = true
				return finish()
			}
			if c.Cancel != "" && !cancelSent {
				cancelSent = true
				x.Recycle = true // a cancelled process is never reused
				if err := call.Cancel(c.Cancel); err != nil {
					killAndDrain()
					x.Aborted = true
					return finish()
				}
			}
		case <-ctx.Done():
			x.Recycle = true
			killAndDrain()
			x.Aborted = true
			return finish()
		}
	}
}

// crash classifies an unexpected process end (docs/runtime.md §8.6).
func crash(st pool.ExitStatus, oomBefore int64) scerr.ScantorError {
	var exitCode any
	if st.Signal == "" {
		exitCode = st.Code
	}
	oomKilled := st.Signal == "SIGKILL" && !st.KilledByRuntime && oomBefore >= 0 && oomKills() > oomBefore
	msg := "connector process ended during the run (" + st.String() + ")"
	if oomKilled {
		msg = "connector process was killed by the out-of-memory killer"
	}
	var signal any
	if st.Signal != "" {
		signal = st.Signal
	}
	return scerr.New(api.ErrorCrash, api.PhaseRun, msg).WithDetails(map[string]any{"exitCode": exitCode, "signal": signal, "oomKilled": oomKilled})
}

// checkResult applies the result checks (docs/runtime.md §8.7): a JSON object whose compact
// serialization is at most maxBytes.
func checkResult(raw json.RawMessage, maxBytes int64) *scerr.ScantorError {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		e := scerr.New(api.ErrorValidation, api.PhaseValidate, "result is not a JSON object")
		return &e
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, trimmed); err != nil {
		e := scerr.New(api.ErrorValidation, api.PhaseValidate, "result is not valid JSON: "+err.Error())
		return &e
	}
	if maxBytes > 0 && int64(compact.Len()) > maxBytes {
		e := scerr.Newf(api.ErrorValidation, api.PhaseValidate, "result is %d bytes; the maximum is %d; store large data with ctx.files.put", compact.Len(), maxBytes)
		return &e
	}
	return nil
}

// fileRegistry registers files of one execution (docs/runtime.md §8.4).
type fileRegistry struct {
	dir    string
	limits Limits
	names  map[string]bool
	list   []upload.File
}

const defaultContentType = "application/octet-stream"

func (r *fileRegistry) register(m protocol.File) (protocol.FileRefObject, error) {
	if err := validName(m.Name); err != nil {
		return protocol.FileRefObject{}, err
	}
	if r.names[m.Name] {
		return protocol.FileRefObject{}, fmt.Errorf("file name %s is already used in this execution", m.Name)
	}
	if r.limits.MaxFilesPerAnalysis > 0 && len(r.list) >= r.limits.MaxFilesPerAnalysis {
		return protocol.FileRefObject{}, fmt.Errorf("too many files: the limit is %d per analysis", r.limits.MaxFilesPerAnalysis)
	}
	path, err := r.resolve(m.Path)
	if err != nil {
		return protocol.FileRefObject{}, err
	}
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0) //nolint:gosec // resolved inside filesDir above
	if err != nil {
		return protocol.FileRefObject{}, fmt.Errorf("file %s cannot be opened: %w", m.Name, unwrapPath(err))
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return protocol.FileRefObject{}, fmt.Errorf("file %s is not a regular file", m.Name)
	}
	if r.limits.MaxFileBytes > 0 && st.Size() > r.limits.MaxFileBytes {
		return protocol.FileRefObject{}, fmt.Errorf("file %s is %d bytes; the limit is %d", m.Name, st.Size(), r.limits.MaxFileBytes)
	}
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return protocol.FileRefObject{}, fmt.Errorf("file %s cannot be read: %w", m.Name, unwrapPath(err))
	}
	if r.limits.MaxFileBytes > 0 && n > r.limits.MaxFileBytes {
		return protocol.FileRefObject{}, fmt.Errorf("file %s is %d bytes; the limit is %d", m.Name, n, r.limits.MaxFileBytes)
	}
	contentType := defaultContentType
	if m.ContentType != nil && *m.ContentType != "" {
		contentType = *m.ContentType
	}
	ref := protocol.FileRefObject{ID: uuid.NewString(), Name: m.Name, Size: n, SHA256: hex.EncodeToString(h.Sum(nil)), ContentType: contentType}
	r.names[m.Name] = true
	r.list = append(r.list, upload.File{ID: ref.ID, Name: ref.Name, Path: path, Size: ref.Size, SHA256: ref.SHA256, ContentType: ref.ContentType})
	return ref, nil
}

// resolve requires path to lie inside the execution's filesDir, also after resolving symlinks of its
// directories (the file itself is opened with O_NOFOLLOW).
func (r *fileRegistry) resolve(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("file path %s is not absolute", path)
	}
	root, err := filepath.EvalSymlinks(r.dir)
	if err != nil {
		return "", fmt.Errorf("files directory: %w", err)
	}
	clean := filepath.Clean(path)
	parent, err := filepath.EvalSymlinks(filepath.Dir(clean))
	if err != nil {
		return "", fmt.Errorf("file path %s does not exist inside ctx.filesDir", path)
	}
	if parent != root && !strings.HasPrefix(parent, root+string(filepath.Separator)) {
		return "", fmt.Errorf("file path %s is outside ctx.filesDir", path)
	}
	return filepath.Join(parent, filepath.Base(clean)), nil
}

func validName(name string) error {
	switch {
	case len(name) == 0 || len([]rune(name)) > 255:
		return fmt.Errorf("file name must have 1 to 255 characters")
	case strings.ContainsAny(name, "/\\\x00"):
		return fmt.Errorf("file name %q must not contain '/', '\\' or NUL", name)
	}
	return nil
}

// unwrapPath drops the path from an *os.PathError (the message already names the file).
func unwrapPath(err error) error {
	var pe *os.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}
