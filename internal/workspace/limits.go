package workspace

import (
	"github.com/lonetis/scantor/internal/envconf"
	"github.com/lonetis/scantor/internal/taskpipe"
)

// Limits are the caps of helper operations. The orchestrator passes them as flags, never through the
// environment (docs/editor.md §9.2).
type Limits struct {
	// MaxFiles caps the entries of a task folder (--max-files, SCANTOR_TASK_MAX_FILES). Entries are
	// files, directories and symlinks, the unit the pack counts, so a folder within the cap can always
	// be packed.
	MaxFiles int
	// MaxBytes caps the uncompressed bytes of a task folder (--max-bytes, SCANTOR_TASK_MAX_BYTES).
	MaxBytes int64
	// MaxWorkspaceBytes caps the user's whole workspace after an operation (--max-workspace-bytes,
	// SCANTOR_WORKSPACE_MAX_BYTES).
	MaxWorkspaceBytes int64
	// MaxPackBytes caps compressed archives: uploads read by extract and packs written by snapshot
	// (--max-pack-bytes, SCANTOR_TASK_MAX_PACK_BYTES).
	MaxPackBytes int64
}

// packLimits are the caps the pack applies to a task folder of this run.
func (l Limits) packLimits() taskpipe.PackLimits {
	return taskpipe.PackLimits{MaxFiles: l.MaxFiles, MaxBytes: l.MaxBytes, MaxPackBytes: l.MaxPackBytes}
}

// DefaultLimits are the .env.example defaults of the four variables. The orchestrator always passes its
// own values; the defaults only serve manual runs.
func DefaultLimits() Limits {
	return Limits{
		MaxFiles:          5000,
		MaxBytes:          200 * envconf.MiB,
		MaxWorkspaceBytes: 2 * envconf.GiB,
		MaxPackBytes:      50 * envconf.MiB,
	}
}
