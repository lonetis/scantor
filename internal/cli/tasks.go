package cli

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
)

func init() {
	registerGroup("", "tasks", "Manage tasks and their workspace files", false)
	registerGroup("tasks", "files", "Read and change the files of a task's workspace", false)
	registerCommand("tasks", newTasksListCommand)
	registerCommand("tasks", newTasksGetCommand)
	registerCommand("tasks", newTasksCreateCommand)
	registerCommand("tasks", newTasksDeleteCommand)
	registerCommand("tasks", newTasksImportGitCommand)
	registerCommand("tasks", newTasksPullCommand)
	registerCommand("tasks files", newTasksFilesListCommand)
	registerCommand("tasks files", newTasksFilesCatCommand)
	registerCommand("tasks files", newTasksFilesPutCommand)
	registerCommand("tasks files", newTasksFilesRemoveCommand)
}

const apiTaskArgHelp = "A task is addressed by its name or its id."

func newTasksListCommand(app *App) *cobra.Command {
	var query api.ListTasksQuery
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List tasks",
		Long:  "List your tasks, newest first. Admins see every user's tasks and may filter with --user.",
		Example: `  scantor tasks list
  scantor tasks list --language python -o json`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := apiCheckLimit(query.Limit, 200); err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			page, err := client.ListTasks(cmd.Context(), query)
			if err != nil {
				return err
			}
			err = app.Output().Print(page, func(w io.Writer) error {
				t := Table{Headers: []string{"NAME", "LANGUAGE", "LATEST", "STATE", "WORKSPACE", "UPDATED"}}
				for _, task := range page.Items {
					latest, state := "-", "-"
					if task.LatestRevision != nil {
						latest = fmt.Sprintf("%s@%d", task.Name, task.LatestRevision.Number)
						state = task.LatestRevision.State
					}
					t.Add(task.Name, task.Language, latest, state, apiWorkspaceState(task.Workspace), apiTimeValue(task.UpdatedAt))
				}
				return t.Write(w)
			})
			if err == nil {
				apiPrintMore(app, page.NextCursor, "--cursor")
			}
			return err
		},
	}
	cmd.Flags().StringVar(&query.Q, "search", "", "only tasks whose name or description contains this text")
	cmd.Flags().StringVar(&query.Language, "language", "", "only tasks of this language")
	cmd.Flags().StringVar(&query.UserID, "user", "", "only tasks of this user id (admins)")
	apiPageFlags(cmd, &query.PageQuery, 200)
	return cmd
}

func apiWorkspaceState(ws api.TaskWorkspace) string {
	if ws.Dirty {
		return "unpublished changes"
	}
	return "published"
}

func newTasksGetCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:     "get <task>",
		Short:   "Show a task",
		Long:    "Show a task with its source, cached workspace status and latest revisions. " + apiTaskArgHelp,
		Example: "  scantor tasks get echo",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			task, err := client.GetTask(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			return app.Output().Print(task, func(w io.Writer) error { return apiWriteTask(w, task) })
		},
	}
}

func apiWriteTask(w io.Writer, task *api.Task) error {
	var kv apiKV
	kv.add("name", task.Name)
	kv.add("id", task.ID)
	kv.add("language", task.Language)
	kv.add("description", task.Description)
	source := task.Source.Kind
	if task.Source.Template != "" {
		source += " (template " + task.Source.Template + ")"
	}
	if g := task.Source.Git; g != nil {
		source = fmt.Sprintf("git %s ref %s path %s at %s", g.URL, g.Ref, g.Path, apiShortCommit(g.Commit))
	}
	kv.add("source", source)
	ws := task.Workspace
	kv.add("workspace", fmt.Sprintf("%s, %d files, %s (checked %s)", apiWorkspaceState(ws), ws.FileCount, HumanBytes(ws.Bytes), apiTime(ws.CheckedAt)))
	kv.add("revisions", strconv.Itoa(task.RevisionCount))
	if r := task.LatestRevision; r != nil {
		kv.add("latest", fmt.Sprintf("%s@%d (%s, %s)", task.Name, r.Number, r.State, apiTimeValue(r.CreatedAt)))
	}
	if r := task.LatestReadyRevision; r != nil {
		kv.add("latest ready", fmt.Sprintf("%s@%d", task.Name, r.Number))
	}
	if task.Privileged {
		kv.add("privileged", "yes")
	}
	kv.add("created", apiTimeValue(task.CreatedAt))
	kv.add("updated", apiTimeValue(task.UpdatedAt))
	return kv.write(w)
}

func apiShortCommit(commit string) string {
	if len(commit) > 12 {
		return commit[:12]
	}
	if commit == "" {
		return "-"
	}
	return commit
}

func newTasksCreateCommand(app *App) *cobra.Command {
	var body api.CreateTask
	cmd := &cobra.Command{
		Use:   "create <name>",
		Short: "Create a task from a scaffold",
		Long: "Create a task on the platform and scaffold its workspace for a language and a template " +
			"(\"custom\" for a hand-written schedule). Edit it in the browser editor, with 'scantor tasks files' " +
			"or locally (see 'scantor init' and 'scantor push').",
		Example: `  scantor tasks create echo --language python
  scantor tasks create origins --language typescript --template tranco --description "HTTP origins of the Tranco list"`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if body.Language == "" {
				return UsageError(errors.New("--language is required"))
			}
			body.Name = args[0]
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			task, err := client.CreateTask(cmd.Context(), body)
			if err != nil {
				return err
			}
			return app.Output().Print(task, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "created task %s (%s, id %s)\n", task.Name, task.Language, task.ID)
				return err
			})
		},
	}
	cmd.Flags().StringVar(&body.Language, "language", "", "task language (python, typescript, javascript, go)")
	cmd.Flags().StringVar(&body.Template, "template", "", `schedule template, or "custom" (server default "single")`)
	cmd.Flags().StringVar(&body.Description, "description", "", "short description")
	return cmd
}

func newTasksDeleteCommand(app *App) *cobra.Command {
	var wait apiWaitOptions
	cmd := &cobra.Command{
		Use:   "delete <task>",
		Short: "Delete a task with its revisions, images and test runs",
		Long: "Delete a task: its workspace folder, revisions, snapshots, task images and test runs are removed by " +
			"a background job. Fails while a scan of the task is not finished. " + apiTaskArgHelp,
		Example: "  scantor tasks delete echo --wait",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := wait.validate(); err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx, stop := InterruptContext(cmd.Context())
			defer stop()
			ref, err := client.DeleteTask(ctx, args[0])
			if err != nil {
				return err
			}
			return apiPrintJobRef(ctx, app, client, *ref, wait, "deleting task "+args[0])
		},
	}
	apiWaitFlags(cmd, &wait, "the deletion has finished")
	return cmd
}

func newTasksImportGitCommand(app *App) *cobra.Command {
	var body api.ImportGitTask
	cmd := &cobra.Command{
		Use:   "import-git <url>",
		Short: "Import tasks from a git repository",
		Long: "Clone an https git repository on the platform and import the task folder below --path. When " +
			"several task folders exist, the candidates are listed and nothing is imported until you choose " +
			"them with --select. Private repositories need a git credential (created in the web UI), passed " +
			"with --credential.",
		Example: `  scantor tasks import-git https://github.com/example/scans --path tasks/echo
  scantor tasks import-git https://github.com/example/scans --select tasks/echo --select tasks/power`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body.URL = args[0]
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			res, err := client.ImportGitTask(cmd.Context(), body)
			if err != nil {
				return err
			}
			out := app.Output()
			err = out.Print(res, func(w io.Writer) error {
				if len(res.Imported) > 0 {
					for _, task := range res.Imported {
						if _, err := fmt.Fprintf(w, "imported task %s (%s, id %s)\n", task.Name, task.Language, task.ID); err != nil {
							return err
						}
					}
					return nil
				}
				t := Table{Headers: []string{"PATH", "NAME", "LANGUAGE", "EXISTS"}}
				for _, c := range res.Candidates {
					t.Add(c.Path, c.Name, c.Language, apiYesNo(c.Exists))
				}
				return t.Write(w)
			})
			if err == nil && len(res.Imported) == 0 && len(res.Candidates) > 0 && !out.JSON() {
				out.Infof("nothing imported: several task folders were found; choose them with --select <path>")
			}
			return err
		},
	}
	cmd.Flags().StringVar(&body.Ref, "ref", "", `branch, tag or commit (server default "HEAD")`)
	cmd.Flags().StringVar(&body.Path, "path", "", `folder inside the repository to search (server default ".")`)
	cmd.Flags().StringVar(&body.CredentialID, "credential", "", "id of a git credential for private repositories")
	cmd.Flags().StringSliceVar(&body.Select, "select", nil, "import these candidate folders (repeatable)")
	return cmd
}

func newTasksPullCommand(app *App) *cobra.Command {
	var body api.PullGitTask
	cmd := &cobra.Command{
		Use:   "pull <task>",
		Short: "Fast-forward a git-imported task to its remote",
		Long: "Fetch the git source of an imported task and replace its workspace folder when the remote is a " +
			"fast-forward. Fails with gitDiverged when the workspace has local changes since the last import or " +
			"pull, or when the remote history diverged; --force replaces the folder anyway. Pull never publishes " +
			"a revision. " + apiTaskArgHelp,
		Example: "  scantor tasks pull echo",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			res, err := client.PullGitTask(cmd.Context(), args[0], body)
			if err != nil {
				return apiWithHint(err, api.CodeGitDiverged, "re-run with --force to discard local changes")
			}
			return app.Output().Print(res, func(w io.Writer) error {
				if !res.Changed {
					_, err := fmt.Fprintf(w, "%s is up to date at %s\n", res.Task.Name, apiShortCommit(res.Commit))
					return err
				}
				_, err := fmt.Fprintf(w, "%s: %s → %s\n", res.Task.Name, apiShortCommit(res.PreviousCommit), apiShortCommit(res.Commit))
				return err
			})
		},
	}
	cmd.Flags().BoolVar(&body.Force, "force", false, "replace the workspace folder even with local changes or a diverged remote")
	return cmd
}

// ── files ────────────────────────────────────────────────────────────────────

func newTasksFilesListCommand(app *App) *cobra.Command {
	var revision string
	var recursive bool
	cmd := &cobra.Command{
		Use:     "ls <task> [path]",
		Aliases: []string{"list"},
		Short:   "List the files of a task's workspace or of a revision",
		Long: "List the files below a folder of the task's workspace (default: the task root), or of a " +
			"published revision with --revision (a number, \"latest\" or an id). At most 5000 entries are returned.",
		Example: `  scantor tasks files ls echo
  scantor tasks files ls echo src --recursive=false
  scantor tasks files ls echo --revision 3`,
		Args: cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			path := ""
			if len(args) == 2 {
				path = args[1]
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			list, err := client.ListTaskFiles(cmd.Context(), args[0], path, recursive, revision)
			if err != nil {
				return err
			}
			out := app.Output()
			err = out.Print(list, func(w io.Writer) error {
				t := Table{Headers: []string{"TYPE", "MODE", "SIZE", "PATH"}}
				for _, e := range list.Entries {
					size := "-"
					if e.Type == "file" {
						size = HumanBytes(e.Size)
					}
					t.Add(e.Type, fmt.Sprintf("%04o", e.Mode&0o7777), size, e.Path)
				}
				return t.Write(w)
			})
			if err == nil && list.Truncated && !out.JSON() {
				out.Warnf("the listing is truncated; list a subfolder")
			}
			return err
		},
	}
	cmd.Flags().StringVar(&revision, "revision", "", "list a revision's snapshot instead of the workspace")
	cmd.Flags().BoolVar(&recursive, "recursive", true, "include subfolders")
	return cmd
}

func newTasksFilesCatCommand(app *App) *cobra.Command {
	var revision string
	cmd := &cobra.Command{
		Use:   "cat <task> <path>",
		Short: "Print a file of a task's workspace or of a revision",
		Long: "Print one file of the task's workspace, or of a published revision with --revision. The content " +
			"is written as raw bytes into a pipe or file; on a terminal, control characters are shown escaped " +
			"(\\x1b). The API returns at most 1 MiB of a file. With -o json the response object (with base64 " +
			"content for binary files) is printed instead.",
		Example: `  scantor tasks files cat echo main.py
  scantor tasks files cat echo scantor.yaml --revision latest`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			file, err := client.ReadTaskFile(cmd.Context(), args[0], args[1], revision)
			if err != nil {
				return err
			}
			out := app.Output()
			if out.JSON() {
				return out.PrintJSON(file)
			}
			data := []byte(file.Content)
			if file.Encoding == "base64" {
				if data, err = base64.StdEncoding.DecodeString(file.Content); err != nil {
					return PlatformError(fmt.Errorf("decode %s: %w", file.Path, err))
				}
			}
			if _, err := io.WriteString(out.Out, out.TerminalText(string(data))); err != nil {
				return PlatformError(fmt.Errorf("write output: %w", err))
			}
			if file.Truncated {
				out.Warnf("%s is %s; only the first %s were returned", file.Path, HumanBytes(file.Size), HumanBytes(int64(len(data))))
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&revision, "revision", "", "read from a revision's snapshot instead of the workspace")
	return cmd
}

func newTasksFilesPutCommand(app *App) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "put <task> <path>[=<source>]...",
		Short: "Write files into a task's workspace",
		Long: "Write one or more files into the task's workspace (at most 200 per call). Each argument is a " +
			"task-relative path, optionally followed by =<source>: a local file, or - for stdin. Without a " +
			"source, the local file with the same relative path is uploaded. Text files are sent as UTF-8, other " +
			"files as base64. Writes never publish a revision.",
		Example: `  scantor tasks files put echo main.py scantor.yaml
  scantor tasks files put echo main.py=./build/main.py
  cat main.py | scantor tasks files put echo main.py=-`,
		Args: cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args)-1 > 200 {
				return UsageError(errors.New("at most 200 files can be written per call"))
			}
			in := newAPIInputs(app)
			files := make(map[string]api.TaskFileData, len(args)-1)
			for _, arg := range args[1:] {
				path, source, found := strings.Cut(arg, "=")
				if !found {
					source = path
				}
				if path == "" || source == "" {
					return UsageError(fmt.Errorf("invalid argument %q: use <path>[=<source>]", arg))
				}
				if _, dup := files[path]; dup {
					return UsageError(fmt.Errorf("%s is given twice", path))
				}
				var data []byte
				var err error
				if source == "-" {
					data, err = in.stdin(path)
				} else {
					data, err = in.file(path, source)
				}
				if err != nil {
					return err
				}
				files[path] = api.NewTaskFileData(data)
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			res, err := client.WriteTaskFiles(cmd.Context(), args[0], files)
			if err != nil {
				return err
			}
			return app.Output().Print(res, func(w io.Writer) error {
				for _, p := range res.Written {
					if _, err := fmt.Fprintf(w, "wrote %s\n", p); err != nil {
						return err
					}
				}
				return apiWriteWorkspaceRef(w, res.Workspace)
			})
		},
	}
	return cmd
}

func apiWriteWorkspaceRef(w io.Writer, ws api.WorkspaceRef) error {
	state := "matches the latest revision"
	if ws.Dirty {
		state = "has unpublished changes"
	}
	_, err := fmt.Fprintf(w, "workspace %s (pack %s)\n", state, apiShortCommit(ws.PackSHA256))
	return err
}

func newTasksFilesRemoveCommand(app *App) *cobra.Command {
	var recursive bool
	cmd := &cobra.Command{
		Use:     "rm <task> <path>",
		Aliases: []string{"delete"},
		Short:   "Delete a file or folder of a task's workspace",
		Long:    "Delete one file of the task's workspace, or a folder with --recursive. Deletions never publish a revision.",
		Example: `  scantor tasks files rm echo old.py
  scantor tasks files rm echo testdata --recursive`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			res, err := client.DeleteTaskFile(cmd.Context(), args[0], args[1], recursive)
			if err != nil {
				return err
			}
			return app.Output().Print(res, func(w io.Writer) error {
				for _, p := range res.Deleted {
					if _, err := fmt.Fprintf(w, "deleted %s\n", p); err != nil {
						return err
					}
				}
				return apiWriteWorkspaceRef(w, res.Workspace)
			})
		},
	}
	cmd.Flags().BoolVarP(&recursive, "recursive", "r", false, "delete a folder with its content")
	return cmd
}
