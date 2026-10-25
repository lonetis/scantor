package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/taskpipe"
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
		Short: "Upload a task folder and publish a revision",
		Long: "Pack the task folder locally and upload it (docs/tasks.md §13): the manifest name selects or creates " +
			"the task, the upload replaces its platform workspace, and a revision is published and built on the " +
			"server unless --no-publish is given. The upload fails with workspaceDirty when the platform " +
			"workspace has changes that were never published or synced (for example editor edits); --force " +
			"replaces them.\n\n" +
			"Inside the editor (SCANTOR_WORKSPACE set and the folder inside it) the folder already is the " +
			"workspace, so push only publishes a revision. With --wait the command waits for the build " +
			"and exits 2 when the revision failed on its content, 3 on a platform failure.",
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
			task, inEditor, err := editorTask(cfg.Workspace, dir)
			if err != nil {
				return err
			}
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

// editorTask reports whether dir lies inside the editor workspace (SCANTOR_WORKSPACE) and returns the
// task it belongs to: the first path segment below the workspace root (docs/editor.md §5).
func editorTask(workspace, dir string) (task string, inEditor bool, err error) {
	if workspace == "" {
		return "", false, nil
	}
	root, err := canonicalPath(workspace)
	if err != nil {
		return "", false, ValidationError(fmt.Errorf("SCANTOR_WORKSPACE: %w", err))
	}
	target, err := canonicalPath(dir)
	if err != nil {
		return "", false, ValidationError(err)
	}
	rel, err := filepath.Rel(root, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false, nil
	}
	if rel == "." {
		return "", false, UsageError(fmt.Errorf("%s is the workspace root; run the command inside a task folder", dir))
	}
	return strings.SplitN(filepath.ToSlash(rel), "/", 2)[0], true, nil
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
func uploadFolder(ctx context.Context, app *App, client *api.Client, dir string, opts api.UploadTaskOptions) (*api.UploadTaskResult, *taskpipe.Summary, error) {
	cfg, err := app.Config()
	if err != nil {
		return nil, nil, err
	}
	pack, err := taskpipe.PackDir(ctx, dir, taskPipelineConfig(cfg).Pack)
	if err != nil {
		return nil, nil, packFailure(ctx, app.Output(), err)
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
	res, err := client.UploadTask(ctx, pr, opts)
	// The request may end before the whole pack was read (an early error response); closing the reader
	// ends the writer, which must finish before the pack is closed.
	_ = pr.CloseWithError(errUploadEnded) // never fails for a pipe reader
	writeErr := <-written
	switch {
	case err != nil:
		return nil, nil, interruptedOr(ctx, apiWithHint(err, api.CodeWorkspaceDirty,
			"the platform workspace has changes that were never published or synced; use --force to replace them"))
	case writeErr != nil && !errors.Is(writeErr, errUploadEnded):
		return nil, nil, PlatformError(fmt.Errorf("stream the pack: %w", writeErr))
	}
	return res, &s, nil
}

var errUploadEnded = errors.New("upload ended")

// packFailure reports the content problems of a pack on stderr and returns a validation error; other
// failures are interrupts or platform errors.
func packFailure(ctx context.Context, out *Output, err error) error {
	var problems taskpipe.PackErrors
	switch {
	case errors.As(err, &problems):
		for _, p := range problems {
			out.Infof("  %s", FormatBuildError(api.BuildError{Phase: api.BuildPhasePack, File: p.Path, Message: p.Message}))
		}
		return ValidationError(fmt.Errorf("the task folder cannot be packed (%d problem(s))", len(problems)))
	case ctx.Err() != nil:
		return Interrupted()
	default:
		return PlatformError(fmt.Errorf("pack the task folder: %w", err))
	}
}

// interruptedOr returns Interrupted() when ctx was cancelled (SIGINT/SIGTERM), else err.
func interruptedOr(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return Interrupted()
	}
	return err
}
