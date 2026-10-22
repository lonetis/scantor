package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/envconf"
	"github.com/lonetis/scantor/internal/workspace"
)

// `scantor workspace <op>`: the hidden workspace helper operations the orchestrator runs in throwaway
// helper containers (docs/editor.md §9). Every operation writes exactly one JSON document to stdout
// (snapshot: the tar.gz pack), NDJSON events to stderr, and exits 0 (success), 1 (user error, explained
// by the final error event) or 2 (internal error). Limits arrive as flags, never through the environment.

// DefaultWorkspaceRoot is where helpers mount the user's workspace subpath.
const DefaultWorkspaceRoot = "/workspace"

func init() {
	registerGroup("", "workspace", "Workspace helper operations (run by the orchestrator in helper containers)", true)
	registerCommand("workspace", newWorkspaceInitCommand)
	registerCommand("workspace", newWorkspacePurgeCommand)
	registerCommand("workspace", newWorkspaceListCommand)
	registerCommand("workspace", newWorkspaceReadCommand)
	registerCommand("workspace", newWorkspaceWriteFilesCommand)
	registerCommand("workspace", newWorkspaceDeleteFilesCommand)
	registerCommand("workspace", newWorkspaceScaffoldCommand)
	registerCommand("workspace", newWorkspaceExtractCommand)
	registerCommand("workspace", newWorkspaceGitCloneCommand)
	registerCommand("workspace", newWorkspaceGitPullCommand)
	registerCommand("workspace", newWorkspaceCommitCommand)
	registerCommand("workspace", newWorkspaceDiscardCommand)
	registerCommand("workspace", newWorkspaceSnapshotCommand)
}

// wsRun runs one helper operation with the helper I/O protocol: the result as one JSON document on
// stdout (nil: the operation wrote stdout itself), a failure as the final error event and exit 1 or 2.
// Helpers take no positional arguments; everything is a flag.
func wsRun(app *App, cmd *cobra.Command, args []string, op func(ctx context.Context, events *workspace.Events) (any, error)) error {
	ctx, cancel := InterruptContext(cmd.Context())
	defer cancel()
	events := workspace.NewEvents(app.Stderr)
	var result any
	err := wsNoArgs(args)
	if err == nil {
		result, err = op(ctx, events)
	}
	if err == nil && result != nil {
		enc := json.NewEncoder(app.Stdout)
		enc.SetEscapeHTML(false)
		if encErr := enc.Encode(result); encErr != nil {
			err = fmt.Errorf("write the result: %w", encErr)
		}
	}
	if err != nil {
		werr := workspace.AsError(err)
		events.Error(werr)
		return SilentExit(werr.ExitCode())
	}
	return nil
}

func wsNoArgs(args []string) error {
	if len(args) > 0 {
		return &workspace.Error{Code: workspace.CodeInvalidArgument, Message: fmt.Sprintf("unexpected argument %q; helpers take flags only", args[0])}
	}
	return nil
}

// wsCommand finishes a helper command: positional arguments reach wsRun, and flag errors are reported
// as an invalidArgument error event with exit 1 like every other helper failure, instead of cobra's
// text error.
func wsCommand(app *App, cmd *cobra.Command) *cobra.Command {
	cmd.Args = cobra.ArbitraryArgs
	cmd.SetFlagErrorFunc(func(c *cobra.Command, err error) error {
		workspace.NewEvents(app.Stderr).Error(&workspace.Error{Code: workspace.CodeInvalidArgument, Message: err.Error()})
		// cobra prints flag errors itself unless told not to; the error event already reported this one.
		c.SilenceErrors = true
		c.Root().SilenceErrors = true
		return SilentExit(workspace.ExitUser)
	})
	return cmd
}

// wsWith opens the workspace, runs fn and closes it (which also removes the run's pack spool directory
// on the workspace volume).
func wsWith(root string, limits workspace.Limits, events *workspace.Events, fn func(ws *workspace.Workspace) (any, error)) (any, error) {
	ws, err := workspace.Open(root, limits, events)
	if err != nil {
		return nil, err
	}
	defer func() {
		if cerr := ws.Close(); cerr != nil {
			events.Warnf("close the workspace: %v", cerr)
		}
	}()
	return fn(ws)
}

// wsFlag is a required flag and its value.
type wsFlag struct{ name, value string }

// wsRequire fails with invalidArgument at the first empty required flag (helpers report every failure as
// an error event, so cobra's required-flag check is not used).
func wsRequire(flags ...wsFlag) error {
	for _, f := range flags {
		if f.value == "" {
			return &workspace.Error{Code: workspace.CodeInvalidArgument, Message: fmt.Sprintf("--%s is required", f.name)}
		}
	}
	return nil
}

// wsRootFlag adds the hidden --root flag (the mounted workspace; tests point it elsewhere).
func wsRootFlag(cmd *cobra.Command, root *string) {
	cmd.Flags().StringVar(root, "root", DefaultWorkspaceRoot, "workspace directory")
	_ = cmd.Flags().MarkHidden("root")
}

// wsLimitFlags adds the cap flags an operation uses.
type wsLimitFlags struct {
	files     int
	bytes     wsByteSize
	workspace wsByteSize
	pack      wsByteSize
}

func newWSLimitFlags() *wsLimitFlags {
	d := workspace.DefaultLimits()
	return &wsLimitFlags{files: d.MaxFiles, bytes: wsByteSize(d.MaxBytes), workspace: wsByteSize(d.MaxWorkspaceBytes), pack: wsByteSize(d.MaxPackBytes)}
}

func (l *wsLimitFlags) addFiles(cmd *cobra.Command) {
	cmd.Flags().IntVar(&l.files, "max-files", l.files, "max regular files of a task folder (SCANTOR_TASK_MAX_FILES)")
}

func (l *wsLimitFlags) addBytes(cmd *cobra.Command) {
	cmd.Flags().Var(&l.bytes, "max-bytes", "max uncompressed bytes of a task folder (SCANTOR_TASK_MAX_BYTES)")
}

func (l *wsLimitFlags) addWorkspace(cmd *cobra.Command) {
	cmd.Flags().Var(&l.workspace, "max-workspace-bytes", "max bytes of the whole workspace (SCANTOR_WORKSPACE_MAX_BYTES)")
}

func (l *wsLimitFlags) addPack(cmd *cobra.Command) {
	cmd.Flags().Var(&l.pack, "max-pack-bytes", "max compressed bytes of an archive (SCANTOR_TASK_MAX_PACK_BYTES)")
}

func (l *wsLimitFlags) limits() workspace.Limits {
	return workspace.Limits{MaxFiles: l.files, MaxBytes: int64(l.bytes), MaxWorkspaceBytes: int64(l.workspace), MaxPackBytes: int64(l.pack)}
}

// wsByteSize is a byte-size flag in the env value syntax ("512MiB", or a plain number of bytes).
type wsByteSize int64

func (b *wsByteSize) String() string { return envconf.FormatByteSize(int64(*b)) }

func (b *wsByteSize) Set(s string) error {
	n, err := envconf.ParseByteSize(s)
	if err != nil {
		return err
	}
	*b = wsByteSize(n)
	return nil
}

func (b *wsByteSize) Type() string { return "bytes" }

func newWorkspaceInitCommand(app *App) *cobra.Command {
	var user, volumes string
	uid, gid := workspace.DefaultUID, workspace.DefaultGID
	cmd := &cobra.Command{
		Use:   "init",
		Short: "Create a user's workspace and editor home directories (root helper)",
		RunE: func(cmd *cobra.Command, args []string) error {
			return wsRun(app, cmd, args, func(ctx context.Context, _ *workspace.Events) (any, error) {
				if err := wsRequire(wsFlag{"user", user}); err != nil {
					return nil, err
				}
				return workspace.InitUser(ctx, workspace.VolumeOptions{Root: volumes, UID: uid, GID: gid}, user)
			})
		},
	}
	cmd.Flags().StringVar(&user, "user", "", "user id")
	wsVolumeFlags(cmd, &volumes)
	cmd.Flags().IntVar(&uid, "uid", uid, "owner uid of the created directories")
	cmd.Flags().IntVar(&gid, "gid", gid, "owner gid of the created directories")
	_ = cmd.Flags().MarkHidden("uid")
	_ = cmd.Flags().MarkHidden("gid")
	return wsCommand(app, cmd)
}

func wsVolumeFlags(cmd *cobra.Command, volumes *string) {
	cmd.Flags().StringVar(volumes, "volumes", workspace.DefaultVolumesRoot, "directory holding the workspaces and editor-home volumes")
	_ = cmd.Flags().MarkHidden("volumes")
}

func newWorkspacePurgeCommand(app *App) *cobra.Command {
	var user, volumes string
	cmd := &cobra.Command{
		Use:   "purge",
		Short: "Remove a user's workspace and editor home directories (root helper)",
		RunE: func(cmd *cobra.Command, args []string) error {
			return wsRun(app, cmd, args, func(ctx context.Context, _ *workspace.Events) (any, error) {
				if err := wsRequire(wsFlag{"user", user}); err != nil {
					return nil, err
				}
				return workspace.PurgeUser(ctx, workspace.VolumeOptions{Root: volumes}, user)
			})
		},
	}
	cmd.Flags().StringVar(&user, "user", "", "user id")
	wsVolumeFlags(cmd, &volumes)
	return wsCommand(app, cmd)
}

func newWorkspaceListCommand(app *App) *cobra.Command {
	var root, task string
	var archive bool
	opts := workspace.ListOptions{Recursive: true, MaxEntries: workspace.DefaultMaxEntries}
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List a task folder, or a snapshot on stdin with --archive",
		RunE: func(cmd *cobra.Command, args []string) error {
			return wsRun(app, cmd, args, func(ctx context.Context, events *workspace.Events) (any, error) {
				if archive {
					return workspace.ListArchive(ctx, app.Stdin, opts)
				}
				if err := wsRequire(wsFlag{"task", task}); err != nil {
					return nil, err
				}
				return wsWith(root, workspace.Limits{}, events, func(ws *workspace.Workspace) (any, error) {
					return ws.List(ctx, task, opts)
				})
			})
		},
	}
	cmd.Flags().StringVar(&task, "task", "", "task name (the folder below the workspace)")
	cmd.Flags().StringVar(&opts.Path, "path", "", `folder or file to list ("" = the task root)`)
	cmd.Flags().BoolVar(&opts.Recursive, "recursive", true, "list the whole subtree")
	cmd.Flags().IntVar(&opts.MaxEntries, "max-entries", opts.MaxEntries, "maximum entries returned")
	cmd.Flags().BoolVar(&archive, "archive", false, "list the tar.gz snapshot on stdin instead of the workspace")
	wsRootFlag(cmd, &root)
	return wsCommand(app, cmd)
}

func newWorkspaceReadCommand(app *App) *cobra.Command {
	var root, task, path string
	var archive bool
	maxBytes := wsByteSize(workspace.DefaultMaxReadBytes)
	cmd := &cobra.Command{
		Use:   "read",
		Short: "Read a file of a task folder, or of a snapshot on stdin with --archive",
		RunE: func(cmd *cobra.Command, args []string) error {
			return wsRun(app, cmd, args, func(ctx context.Context, events *workspace.Events) (any, error) {
				if err := wsRequire(wsFlag{"path", path}); err != nil {
					return nil, err
				}
				if archive {
					return workspace.ReadArchive(ctx, app.Stdin, path, int64(maxBytes))
				}
				if err := wsRequire(wsFlag{"task", task}); err != nil {
					return nil, err
				}
				return wsWith(root, workspace.Limits{}, events, func(ws *workspace.Workspace) (any, error) {
					return ws.Read(ctx, task, path, int64(maxBytes))
				})
			})
		},
	}
	cmd.Flags().StringVar(&task, "task", "", "task name")
	cmd.Flags().StringVar(&path, "path", "", "file to read")
	cmd.Flags().Var(&maxBytes, "max-bytes", "content returned at most (the hash covers the whole file)")
	cmd.Flags().BoolVar(&archive, "archive", false, "read from the tar.gz snapshot on stdin instead of the workspace")
	wsRootFlag(cmd, &root)
	return wsCommand(app, cmd)
}

func newWorkspaceWriteFilesCommand(app *App) *cobra.Command {
	var root, task string
	var create bool
	limits := newWSLimitFlags()
	cmd := &cobra.Command{
		Use:   "write-files",
		Short: `Write the files of {"files": {...}} on stdin into a task folder`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return wsRun(app, cmd, args, func(ctx context.Context, events *workspace.Events) (any, error) {
				if err := wsRequire(wsFlag{"task", task}); err != nil {
					return nil, err
				}
				return wsWith(root, limits.limits(), events, func(ws *workspace.Workspace) (any, error) {
					return ws.WriteFiles(ctx, task, create, app.Stdin)
				})
			})
		},
	}
	cmd.Flags().StringVar(&task, "task", "", "task name")
	cmd.Flags().BoolVar(&create, "create", false, "create the task folder when it does not exist")
	limits.addFiles(cmd)
	limits.addBytes(cmd)
	limits.addWorkspace(cmd)
	wsRootFlag(cmd, &root)
	return wsCommand(app, cmd)
}

func newWorkspaceDeleteFilesCommand(app *App) *cobra.Command {
	var root, task, path string
	var recursive bool
	cmd := &cobra.Command{
		Use:   "delete-files",
		Short: "Delete a file or folder of a task folder (--path \"\" --recursive: the whole folder)",
		RunE: func(cmd *cobra.Command, args []string) error {
			return wsRun(app, cmd, args, func(ctx context.Context, events *workspace.Events) (any, error) {
				if err := wsRequire(wsFlag{"task", task}); err != nil {
					return nil, err
				}
				return wsWith(root, workspace.Limits{}, events, func(ws *workspace.Workspace) (any, error) {
					return ws.DeleteFiles(ctx, task, path, recursive)
				})
			})
		},
	}
	cmd.Flags().StringVar(&task, "task", "", "task name")
	cmd.Flags().StringVar(&path, "path", "", `path to delete ("" = the task folder itself)`)
	cmd.Flags().BoolVar(&recursive, "recursive", false, "delete a non-empty folder")
	wsRootFlag(cmd, &root)
	return wsCommand(app, cmd)
}

func newWorkspaceScaffoldCommand(app *App) *cobra.Command {
	var root string
	var req workspace.ScaffoldRequest
	limits := newWSLimitFlags()
	cmd := &cobra.Command{
		Use:   "scaffold",
		Short: "Render the embedded scaffold into a new task folder",
		RunE: func(cmd *cobra.Command, args []string) error {
			return wsRun(app, cmd, args, func(ctx context.Context, events *workspace.Events) (any, error) {
				if err := wsRequire(wsFlag{"task", req.Name}, wsFlag{"language", req.Language}); err != nil {
					return nil, err
				}
				cfg, err := workspace.LoadConfig(app.Getenv)
				if err != nil {
					return nil, err
				}
				req.Images = cfg.Images
				return wsWith(root, limits.limits(), events, func(ws *workspace.Workspace) (any, error) {
					return ws.Scaffold(ctx, req)
				})
			})
		},
	}
	cmd.Flags().StringVar(&req.Name, "task", "", "task name")
	cmd.Flags().StringVar(&req.Language, "language", "", "language of schemas/languages.json")
	cmd.Flags().StringVar(&req.Template, "template", workspace.DefaultTemplate, `template name or "custom"`)
	cmd.Flags().StringVar(&req.Description, "description", "", "task description")
	limits.addFiles(cmd)
	limits.addBytes(cmd)
	limits.addWorkspace(cmd)
	wsRootFlag(cmd, &root)
	return wsCommand(app, cmd)
}

func newWorkspaceExtractCommand(app *App) *cobra.Command {
	var root, staging string
	limits := newWSLimitFlags()
	cmd := &cobra.Command{
		Use:   "extract",
		Short: "Extract the uploaded archive on stdin into a staging directory and validate its manifest",
		RunE: func(cmd *cobra.Command, args []string) error {
			return wsRun(app, cmd, args, func(ctx context.Context, events *workspace.Events) (any, error) {
				if err := wsRequire(wsFlag{"staging", staging}); err != nil {
					return nil, err
				}
				return wsWith(root, limits.limits(), events, func(ws *workspace.Workspace) (any, error) {
					return ws.Extract(ctx, staging, bufio.NewReaderSize(app.Stdin, 64<<10))
				})
			})
		},
	}
	cmd.Flags().StringVar(&staging, "staging", "", "staging id")
	limits.addPack(cmd)
	limits.addFiles(cmd)
	limits.addBytes(cmd)
	limits.addWorkspace(cmd)
	wsRootFlag(cmd, &root)
	return wsCommand(app, cmd)
}

// wsGitFlags adds the flags shared by git-clone and git-pull.
func wsGitFlags(cmd *cobra.Command, opts *workspace.GitOptions) {
	cmd.Flags().StringVar(&opts.URL, "url", "", "https URL of the repository")
	cmd.Flags().StringVar(&opts.Ref, "ref", workspace.DefaultRef, "branch, tag, full commit hash or HEAD")
	cmd.Flags().StringVar(&opts.Path, "path", ".", "folder of the repository to search or import")
	cmd.Flags().StringVar(&opts.Staging, "staging", "", "staging id")
	cmd.Flags().BoolVar(&opts.AllowPrivate, "allow-private", false, "allow hosts with loopback, private, link-local, CGNAT and ULA addresses (SCANTOR_GIT_ALLOW_PRIVATE)")
}

// wsGit opens the workspace and the git operations with the helper configuration.
func wsGit(app *App, root string, limits workspace.Limits, events *workspace.Events, fn func(git *workspace.Git) (any, error)) (any, error) {
	cfg, err := workspace.LoadConfig(app.Getenv)
	if err != nil {
		return nil, err
	}
	return wsWith(root, limits, events, func(ws *workspace.Workspace) (any, error) {
		return fn(workspace.NewGit(ws, cfg))
	})
}

func newWorkspaceGitCloneCommand(app *App) *cobra.Command {
	var root string
	var opts workspace.GitOptions
	limits := newWSLimitFlags()
	cmd := &cobra.Command{
		Use:   "git-clone",
		Short: "Fetch a git ref into a staging directory and list its task candidates",
		RunE: func(cmd *cobra.Command, args []string) error {
			return wsRun(app, cmd, args, func(ctx context.Context, events *workspace.Events) (any, error) {
				if err := wsRequire(wsFlag{"url", opts.URL}, wsFlag{"staging", opts.Staging}); err != nil {
					return nil, err
				}
				return wsGit(app, root, limits.limits(), events, func(git *workspace.Git) (any, error) {
					return git.Clone(ctx, opts)
				})
			})
		},
	}
	wsGitFlags(cmd, &opts)
	limits.addFiles(cmd)
	limits.addBytes(cmd)
	limits.addWorkspace(cmd)
	wsRootFlag(cmd, &root)
	return wsCommand(app, cmd)
}

func newWorkspaceGitPullCommand(app *App) *cobra.Command {
	var root string
	var opts workspace.PullOptions
	limits := newWSLimitFlags()
	cmd := &cobra.Command{
		Use:   "git-pull",
		Short: "Fetch a git ref into a staging directory and compare it with the task folder",
		RunE: func(cmd *cobra.Command, args []string) error {
			return wsRun(app, cmd, args, func(ctx context.Context, events *workspace.Events) (any, error) {
				if err := wsRequire(wsFlag{"task", opts.Task}, wsFlag{"url", opts.URL}, wsFlag{"staging", opts.Staging}); err != nil {
					return nil, err
				}
				return wsGit(app, root, limits.limits(), events, func(git *workspace.Git) (any, error) {
					return git.Pull(ctx, opts)
				})
			})
		},
	}
	wsGitFlags(cmd, &opts.GitOptions)
	cmd.Flags().StringVar(&opts.Task, "task", "", "task name")
	cmd.Flags().StringVar(&opts.BaseCommit, "base-commit", "", "commit of the last import or pull")
	limits.addFiles(cmd)
	limits.addBytes(cmd)
	limits.addWorkspace(cmd)
	wsRootFlag(cmd, &root)
	return wsCommand(app, cmd)
}

func newWorkspaceCommitCommand(app *App) *cobra.Command {
	var root string
	var opts workspace.CommitOptions
	limits := newWSLimitFlags()
	cmd := &cobra.Command{
		Use:   "commit",
		Short: "Replace a task folder atomically with a staged tree",
		RunE: func(cmd *cobra.Command, args []string) error {
			return wsRun(app, cmd, args, func(ctx context.Context, events *workspace.Events) (any, error) {
				if err := wsRequire(wsFlag{"staging", opts.Staging}, wsFlag{"task", opts.Task}, wsFlag{"expect", opts.Expect}); err != nil {
					return nil, err
				}
				return wsWith(root, limits.limits(), events, func(ws *workspace.Workspace) (any, error) {
					return ws.Commit(ctx, opts)
				})
			})
		},
	}
	cmd.Flags().StringVar(&opts.Staging, "staging", "", "staging id")
	cmd.Flags().StringVar(&opts.From, "from", "", "folder below the staging tree to commit (default: the whole tree)")
	cmd.Flags().StringVar(&opts.Task, "task", "", "task name")
	cmd.Flags().StringVar(&opts.Expect, "expect", "", `current workspace hash the decision was based on, "absent" or "any"`)
	limits.addFiles(cmd)
	limits.addBytes(cmd)
	limits.addWorkspace(cmd)
	wsRootFlag(cmd, &root)
	return wsCommand(app, cmd)
}

func newWorkspaceDiscardCommand(app *App) *cobra.Command {
	var root, staging string
	cmd := &cobra.Command{
		Use:   "discard",
		Short: "Remove a staging directory",
		RunE: func(cmd *cobra.Command, args []string) error {
			return wsRun(app, cmd, args, func(_ context.Context, events *workspace.Events) (any, error) {
				if err := wsRequire(wsFlag{"staging", staging}); err != nil {
					return nil, err
				}
				return wsWith(root, workspace.Limits{}, events, func(ws *workspace.Workspace) (any, error) {
					return struct{}{}, ws.Discard(staging)
				})
			})
		},
	}
	cmd.Flags().StringVar(&staging, "staging", "", "staging id")
	wsRootFlag(cmd, &root)
	return wsCommand(app, cmd)
}

func newWorkspaceSnapshotCommand(app *App) *cobra.Command {
	var root, task string
	var hashOnly bool
	limits := newWSLimitFlags()
	cmd := &cobra.Command{
		Use:   "snapshot",
		Short: "Write the deterministic pack of a task folder to stdout (or its summary with --hash-only)",
		RunE: func(cmd *cobra.Command, args []string) error {
			return wsRun(app, cmd, args, func(ctx context.Context, events *workspace.Events) (any, error) {
				if err := wsRequire(wsFlag{"task", task}); err != nil {
					return nil, err
				}
				return wsWith(root, limits.limits(), events, func(ws *workspace.Workspace) (any, error) {
					if hashOnly {
						sum, err := ws.Snapshot(ctx, task, nil)
						return sum.Summary(), err
					}
					out := bufio.NewWriterSize(app.Stdout, 64<<10)
					sum, err := ws.Snapshot(ctx, task, out)
					if err != nil {
						return nil, err
					}
					if err := out.Flush(); err != nil {
						return nil, fmt.Errorf("write the pack: %w", err)
					}
					events.Summary(sum)
					return nil, nil
				})
			})
		},
	}
	cmd.Flags().StringVar(&task, "task", "", "task name")
	cmd.Flags().BoolVar(&hashOnly, "hash-only", false, "print the summary JSON instead of the pack")
	limits.addFiles(cmd)
	limits.addBytes(cmd)
	limits.addPack(cmd)
	wsRootFlag(cmd, &root)
	return wsCommand(app, cmd)
}
