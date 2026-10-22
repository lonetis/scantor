package workspace

import (
	"context"
	"errors"
	"io"
	"strings"

	"github.com/lonetis/scantor/internal/taskpipe"
)

// Summary describes a task folder as its pack (docs/editor.md §9.4): the pack hash, the number of
// regular files and the uncompressed size. The orchestrator copies it into tasks.workspace.
type Summary struct {
	PackSHA256 string `json:"packSha256"`
	FileCount  int    `json:"fileCount"`
	Bytes      int64  `json:"bytes"`
}

// PackSummary is a Summary plus the compressed size of the pack.
type PackSummary struct {
	PackSHA256 string `json:"packSha256"`
	PackBytes  int64  `json:"packBytes"`
	FileCount  int    `json:"fileCount"`
	Bytes      int64  `json:"bytes"`
}

// Summary drops the compressed size.
func (s PackSummary) Summary() Summary {
	return Summary{PackSHA256: s.PackSHA256, FileCount: s.FileCount, Bytes: s.Bytes}
}

// packDir packs the folder dir with the task pipeline's pack code (taskpipe.PackDir, docs/tasks.md
// §9.2): the workspace hash must be exactly the hash `scantor task pack` and the revision builds
// compute. With out != nil the deterministic tar.gz is written to out. The caps are limits.MaxFiles,
// MaxBytes and MaxPackBytes (0 = no cap). Content problems (symlinks leaving the folder, special files,
// path rules, caps) become helper errors.
//
// The pack spools the whole uncompressed tar (up to SCANTOR_TASK_MAX_BYTES), and a helper's /tmp is a
// 64 MiB tmpfs, so the spool goes to a scratch directory on the workspace volume that exists only while
// the pack does.
func (w *Workspace) packDir(ctx context.Context, dir string, out io.Writer, limits Limits) (PackSummary, error) {
	scratch, removeScratch, err := w.ScratchDir()
	if err != nil {
		return PackSummary{}, err
	}
	defer func() {
		// A leftover scratch directory does not change the result; the staging collection removes it.
		if rerr := removeScratch(); rerr != nil {
			w.events.Warnf("%v", rerr)
		}
	}()
	packLimits := limits.packLimits()
	packLimits.TempDir = scratch
	pack, err := taskpipe.PackDir(ctx, dir, packLimits)
	if err != nil {
		return PackSummary{}, packError(err, limits)
	}
	defer func() {
		// The spool is a temporary file in the scratch directory, which is removed right after.
		_ = pack.Close()
	}()
	if out != nil {
		if err := pack.WriteGzip(out); err != nil {
			return PackSummary{}, internalError(err, "write the pack")
		}
	}
	s := pack.Summary
	return PackSummary{PackSHA256: s.PackSHA256, PackBytes: s.PackBytes, FileCount: s.FileCount, Bytes: s.Bytes}, nil
}

// summarizeDir returns the pack summary of the folder dir without caps.
func (w *Workspace) summarizeDir(ctx context.Context, dir string) (Summary, error) {
	s, err := w.packDir(ctx, dir, nil, Limits{})
	if err != nil {
		return Summary{}, err
	}
	return s.Summary(), nil
}

// maxPackErrorMessages bounds the pack problems quoted in one error message.
const maxPackErrorMessages = 5

// packError maps the task pipeline's pack errors: an entry problem is invalidPath naming the first
// offending path, a cap (taskpipe.PackError.Cap) is tooManyFiles or tooLarge, anything else is internal.
func packError(err error, limits Limits) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	var problems taskpipe.PackErrors
	if !errors.As(err, &problems) || len(problems) == 0 {
		return internalError(err, "pack the task folder")
	}
	msgs := make([]string, 0, maxPackErrorMessages)
	for _, p := range problems[:min(len(problems), maxPackErrorMessages)] {
		msgs = append(msgs, p.Error())
	}
	msg := strings.Join(msgs, "; ")
	if len(problems) > maxPackErrorMessages {
		msg += "; …"
	}
	first := problems[0]
	switch {
	case first.Path != "":
		return pathError(first.Path, "the task folder cannot be packed: %s", msg)
	case first.Cap == taskpipe.CapFiles:
		return limitError(CodeTooManyFiles, int64(limits.MaxFiles), -1, "%s", msg)
	case first.Cap == taskpipe.CapPackBytes:
		return limitError(CodeTooLarge, limits.MaxPackBytes, -1, "%s", msg)
	case first.Cap == taskpipe.CapBytes:
		return limitError(CodeTooLarge, limits.MaxBytes, -1, "%s", msg)
	default:
		return internalError(err, "pack the task folder")
	}
}
