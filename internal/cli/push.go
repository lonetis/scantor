package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/manifest"
	"github.com/lonetis/scantor/internal/taskpipe"
	"github.com/lonetis/scantor/internal/workspace"
)

func init() { registerCommand("", newPushCommand) }

// pushResult is the JSON output of `scantor push`: the upload response, or inside the editor only the
// published revision.
type pushResult struct {
	Task     *api.Task         `json:"task,omitempty"`
	Revision *api.Revision     `json:"revision"`
	Created  bool              `json:"created"`
	Pack     *taskpipe.Summary `json:"pack,omitempty"`
}

func newPushCommand(app *App) *cobra.Command {
	var noPublish, force bool
	var message string
	var wait apiWaitOptions
	cmd := &cobra.Command{
		Use:   "push [dir]",
		Short: "Upload a task or script folder (and publish a task revision)",
		Long: "Pack the task folder locally and upload it (docs/tasks.md §13); the instance applies its own file " +
			"count and size limits to the upload. The manifest name selects or creates " +
			"the task, the upload replaces its platform workspace, and a revision is published and built on the " +
			"server unless --no-publish is given. The upload fails with workspaceDirty when the platform " +
			"workspace has changes that were never published or synced (for example editor edits); --force " +
			"replaces them.\n\n" +
			"Inside the editor (SCANTOR_WORKSPACE set and the folder inside it) the folder already is the " +
			"workspace, so push only publishes a revision. With --wait the command waits for the build " +
			"and exits 2 when the revision failed on its content, 3 on a platform failure.\n\n" +
			"A folder with a scantor-script.yaml is a script folder: push uploads it like 'scantor scripts push' " +
			"(only --force applies). A folder with both scantor.yaml and scantor-script.yaml is refused.",
		Example: "  scantor push\n  scantor push ./echo -m \"add greeting option\" --wait\n  scantor push --no-publish",
		Args:    cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := wait.validate(); err != nil {
				return err
			}
			if noPublish && wait.wait {
				return UsageError(errors.New("--wait needs a published revision; drop --no-publish"))
			}
			dir := "."
			if len(args) == 1 {
				dir = args[0]
			}
			cfg, err := app.Config()
			if err != nil {
				return err
			}
			folder, inEditor, err := pushFolderKind(cfg.Workspace, dir)
			if err != nil {
				return err
			}
			if folder.kind == editorKindScript {
				if noPublish || message != "" || wait.wait {
					return UsageError(fmt.Errorf("%s is a script folder: scripts have no revisions, so --no-publish, --message and --wait do not apply", dir))
				}
				return scriptsPush(cmd.Context(), app, dir, folder.name, inEditor, force)
			}
			task := folder.name
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			out := app.Output()

			var res pushResult
			if inEditor {
				if noPublish {
					return UsageError(errors.New("inside the editor the folder already is the workspace, so there is nothing to upload; drop --no-publish to publish a revision"))
				}
				rev, err := client.PublishRevision(ctx, task, api.PublishRevision{Message: message}, 0)
				if err != nil {
					return interruptedOr(ctx, err)
				}
				res.Revision = rev
			} else {
				up, summary, err := uploadFolder(ctx, app, client, dir, api.UploadTaskOptions{NoPublish: noPublish, Force: force, Message: message})
				if err != nil {
					return err
				}
				res = pushResult{Task: &up.Task, Revision: up.Revision, Created: up.Created, Pack: summary}
			}
			if wait.wait && res.Revision != nil && !apiRevisionSettled(res.Revision.State) {
				if !out.JSON() {
					out.Infof("revision %s is %s; waiting for the build…", res.Revision.Ref, res.Revision.State)
				}
				rev, err := apiWaitRevision(ctx, client, res.Revision.TaskName, res.Revision.ID, wait.timeout)
				if err != nil {
					return err
				}
				res.Revision = rev
			}
			if err := out.Print(res, func(w io.Writer) error { return pushWrite(w, res, wait.wait) }); err != nil {
				return err
			}
			if wait.wait && res.Revision != nil {
				return apiRevisionOutcome(res.Revision)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&noPublish, "no-publish", false, "only update the platform workspace; publish no revision")
	cmd.Flags().BoolVar(&force, "force", false, "replace a platform workspace with unpublished changes")
	cmd.Flags().StringVarP(&message, "message", "m", "", "revision message")
	apiWaitFlags(cmd, &wait, "the revision is built (ready or failed)")
	return cmd
}

// pushWrite renders the outcome for humans: the task, then the revision (in full after waiting).
func pushWrite(w io.Writer, res pushResult, waited bool) error {
	if res.Task != nil {
		verb := "Updated the workspace of task"
		if res.Created {
			verb = "Created task"
		}
		if _, err := fmt.Fprintf(w, "%s %s\n", verb, res.Task.Name); err != nil {
			return err
		}
	}
	switch {
	case res.Revision != nil && waited:
		return apiWriteRevision(w, res.Revision)
	case res.Revision != nil && res.Revision.State == api.RevisionReady:
		// A publish of unchanged content returns the existing revision (docs/tasks.md §10).
		_, err := fmt.Fprintf(w, "Revision %s is ready\n", res.Revision.Ref)
		return err
	case res.Revision != nil && res.Revision.State == api.RevisionFailed:
		_, err := fmt.Fprintf(w, "Revision %s failed; see the build log with 'scantor revisions logs %s'\n",
			res.Revision.Ref, res.Revision.Ref)
		return err
	case res.Revision != nil:
		_, err := fmt.Fprintf(w, "Revision %s is %s; follow the build with 'scantor revisions logs %s --follow'\n",
			res.Revision.Ref, res.Revision.State, res.Revision.Ref)
		return err
	case res.Task != nil:
		_, err := fmt.Fprintf(w, "Not published (--no-publish); publish with 'scantor revisions publish %s'\n", res.Task.Name)
		return err
	}
	return nil
}

// Kinds of workspace folders: a task folder (`<name>/`, scantor.yaml) or a script folder
// (`.scripts/<name>/`, scantor-script.yaml).
const (
	editorKindTask   = "task"
	editorKindScript = "script"
)

// editorScriptsDir is the folder below the workspace root that holds the script folders (docs/scripts.md).
const editorScriptsDir = workspace.ScriptsDir

// editorFolderRef is a task or script folder of the editor workspace.
type editorFolderRef struct {
	kind string
	name string
}

// editorFolder reports whether dir lies inside the editor workspace (SCANTOR_WORKSPACE) and returns the
// folder it belongs to: the first path segment below the workspace root names a task, and
// `.scripts/<name>` a script (docs/editor.md §5).
func editorFolder(workspace, dir string) (folder editorFolderRef, inEditor bool, err error) {
	if workspace == "" {
		return editorFolderRef{}, false, nil
	}
	root, err := canonicalPath(workspace)
	if err != nil {
		return editorFolderRef{}, false, ValidationError(fmt.Errorf("SCANTOR_WORKSPACE: %w", err))
	}
	target, err := canonicalPath(dir)
	if err != nil {
		return editorFolderRef{}, false, ValidationError(err)
	}
	rel, err := filepath.Rel(root, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return editorFolderRef{}, false, nil
	}
	if rel == "." {
		return editorFolderRef{}, false, UsageError(fmt.Errorf("%s is the workspace root; run the command inside a task or script folder", dir))
	}
	segments := strings.SplitN(filepath.ToSlash(rel), "/", 3)
	if segments[0] != editorScriptsDir {
		return editorFolderRef{kind: editorKindTask, name: segments[0]}, true, nil
	}
	if len(segments) == 1 {
		return editorFolderRef{}, false, UsageError(fmt.Errorf("%s is the folder of all scripts; run the command inside a script folder", dir))
	}
	return editorFolderRef{kind: editorKindScript, name: segments[1]}, true, nil
}

// editorTask is editorFolder for the commands that work on task folders only: a script folder is a usage
// error.
func editorTask(workspace, dir string) (task string, inEditor bool, err error) {
	folder, inEditor, err := editorFolder(workspace, dir)
	if err != nil || !inEditor {
		return "", inEditor, err
	}
	if folder.kind != editorKindTask {
		return "", false, UsageError(fmt.Errorf("%s belongs to script %s, not to a task; scripts run with 'scantor scripts run'", dir, folder.name))
	}
	return folder.name, true, nil
}

// pushFolderKind decides what `scantor push` uploads: inside the editor the workspace path names the folder;
// outside, the manifest in dir does (a script folder holds scantor-script.yaml, and a folder with both
// manifests is refused). The name is empty for a folder outside the editor (the manifest names it).
func pushFolderKind(workspace, dir string) (editorFolderRef, bool, error) {
	folder, inEditor, err := editorFolder(workspace, dir)
	if err != nil || inEditor {
		return folder, inEditor, err
	}
	hasTask, err := hasRegularFile(dir, manifest.FileName)
	if err != nil {
		return editorFolderRef{}, false, err
	}
	hasScript, err := hasRegularFile(dir, manifest.ScriptFileName)
	if err != nil {
		return editorFolderRef{}, false, err
	}
	switch {
	case hasTask && hasScript:
		return editorFolderRef{}, false, UsageError(fmt.Errorf("%s holds both %s and %s; a folder is either a task or a script", dir, manifest.FileName, manifest.ScriptFileName))
	case hasScript:
		return editorFolderRef{kind: editorKindScript}, false, nil
	default:
		return editorFolderRef{kind: editorKindTask}, false, nil
	}
}

// hasRegularFile reports whether dir/name is a regular file (symlinks are not followed).
func hasRegularFile(dir, name string) (bool, error) {
	info, err := os.Lstat(filepath.Join(dir, name))
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return false, nil
	case err != nil:
		return false, ValidationError(err)
	default:
		return info.Mode().IsRegular(), nil
	}
}

// canonicalPath returns the absolute path of p with symlinks resolved.
func canonicalPath(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	return resolved, nil
}

// uploadFolder packs dir locally (docs/tasks.md §9.2) and streams the tar.gz to uploadTask. A 409
// workspaceDirty gets a hint about --force.
//
// The pack applies the content rules but none of the SCANTOR_TASK_MAX_* caps: an upload is bound by the
// instance's caps, which the API and helper extract enforce (413 payloadTooLarge), and a native CLI does
// not know them (the CLI reads its own only for local commands, CLI section of .env.example), so its
// defaults would refuse folders the instance accepts.
func uploadFolder(ctx context.Context, app *App, client *api.Client, dir string, opts api.UploadTaskOptions) (*api.UploadTaskResult, *taskpipe.Summary, error) {
	var res *api.UploadTaskResult
	summary, err := uploadPack(ctx, app, dir, editorKindTask, func(body io.Reader) (err error) {
		res, err = client.UploadTask(ctx, body, opts)
		return err
	})
	if err != nil {
		return nil, nil, interruptedOr(ctx, apiWithHint(err, api.CodeWorkspaceDirty,
			"the platform workspace has changes that were never published or synced; use --force to replace them"))
	}
	return res, summary, nil
}

// uploadPack packs dir (a task or script folder, named by kind in messages) and streams the tar.gz to
// send. Pack problems, interrupts and stream failures come back as CLI errors; the error of send is
// returned as it is.
func uploadPack(ctx context.Context, app *App, dir, kind string, send func(body io.Reader) error) (*taskpipe.Summary, error) {
	pack, err := taskpipe.PackDir(ctx, dir, taskpipe.PackLimits{})
	if err != nil {
		return nil, packFailure(ctx, app.Output(), kind, err)
	}
	defer func() {
		if err := pack.Close(); err != nil {
			app.Output().Warnf("remove the temporary pack: %v", err)
		}
	}()
	s := pack.Summary
	if !app.Output().JSON() {
		app.Output().Infof("packed %d files (%s), sha256 %s", s.FileCount, HumanBytes(s.PackBytes), s.PackSHA256)
	}

	pr, pw := io.Pipe()
	written := make(chan error, 1)
	go func() {
		err := pack.WriteGzip(pw)
		pw.CloseWithError(err)
		written <- err
	}()
	err = send(pr)
	// The request may end before the whole pack was read (an early error response); closing the reader
	// ends the writer, which must finish before the pack is closed.
	_ = pr.CloseWithError(errUploadEnded) // never fails for a pipe reader
	writeErr := <-written
	switch {
	case err != nil:
		return nil, err
	case writeErr != nil && !errors.Is(writeErr, errUploadEnded):
		return nil, PlatformError(fmt.Errorf("stream the pack: %w", writeErr))
	}
	return &s, nil
}

var errUploadEnded = errors.New("upload ended")

// packFailure reports the content problems of a pack on stderr and returns a validation error; other
// failures are interrupts or platform errors. kind names the folder (task or script).
func packFailure(ctx context.Context, out *Output, kind string, err error) error {
	var problems taskpipe.PackErrors
	switch {
	case errors.As(err, &problems):
		for _, p := range problems {
			out.Infof("  %s", FormatBuildError(api.BuildError{Phase: api.BuildPhasePack, File: p.Path, Message: p.Message}))
		}
		return ValidationError(fmt.Errorf("the %s folder cannot be packed (%d problem(s))", kind, len(problems)))
	case ctx.Err() != nil:
		return Interrupted()
	default:
		return PlatformError(fmt.Errorf("pack the %s folder: %w", kind, err))
	}
}

// interruptedOr returns Interrupted() when ctx was cancelled (SIGINT/SIGTERM), else err.
func interruptedOr(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return Interrupted()
	}
	return err
}
