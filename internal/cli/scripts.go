package cli

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path/filepath"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/languages"
	"github.com/lonetis/scantor/internal/manifest"
	"github.com/lonetis/scantor/internal/taskpipe"
	"github.com/lonetis/scantor/internal/workspace"
)

// `scantor scripts`: scripts, their folders and files (docs/scripts.md). The run commands live in
// scripts_runs.go. Identifiers carry a scripts prefix; the hidden `scantor script build` pipeline command
// (script_build.go) is unrelated.

func init() {
	registerGroup("", "scripts", "Manage scripts, their files and their runs", false)
	registerGroup("scripts", "files", "Read and change the files of a script folder", false)
	registerCommand("scripts", newScriptsListCommand)
	registerCommand("scripts", newScriptsGetCommand)
	registerCommand("scripts", newScriptsCreateCommand)
	registerCommand("scripts", newScriptsDeleteCommand)
	registerCommand("scripts", newScriptsInitCommand)
	registerCommand("scripts", newScriptsPushCommand)
	registerCommand("scripts files", newScriptsFilesListCommand)
	registerCommand("scripts files", newScriptsFilesReadCommand)
	registerCommand("scripts files", newScriptsFilesWriteCommand)
	registerCommand("scripts files", newScriptsFilesDeleteCommand)
}

const scriptsArgHelp = "A script is addressed by its name or its id."

func newScriptsListCommand(app *App) *cobra.Command {
	var query api.ListScriptsQuery
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List scripts",
		Long:  "List your scripts, newest first. Admins see every user's scripts and may filter with --user.",
		Example: `  scantor scripts list
  scantor scripts list --search csp -o json`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := apiCheckLimit(query.Limit, 200); err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			page, err := client.ListScripts(cmd.Context(), query)
			if err != nil {
				return err
			}
			err = app.Output().Print(page, func(w io.Writer) error {
				t := Table{Headers: []string{"NAME", "LANGUAGE", "LATEST RUN", "STATE", "UPDATED"}}
				for _, s := range page.Items {
					run, state := "-", "-"
					if r := s.LatestRun; r != nil {
						run, state = r.ID, r.State
					}
					t.Add(s.Name, s.Language, run, state, apiTimeValue(s.UpdatedAt))
				}
				return t.Write(w)
			})
			if err == nil {
				apiPrintMore(app, page.NextCursor, "--cursor")
			}
			return err
		},
	}
	cmd.Flags().StringVar(&query.Q, "search", "", "only scripts whose name or description contains this text")
	cmd.Flags().StringVar(&query.UserID, "user", "", "only scripts of this user id (admins)")
	apiPageFlags(cmd, &query.PageQuery, 200)
	return cmd
}

func newScriptsGetCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:     "get <script>",
		Short:   "Show a script",
		Long:    "Show a script with its cached folder status, the schemas its code reported and its recent runs. " + scriptsArgHelp,
		Example: "  scantor scripts get csp-report",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			script, err := client.GetScript(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			return app.Output().Print(script, func(w io.Writer) error { return scriptsWriteScript(w, script) })
		},
	}
}

func scriptsWriteScript(w io.Writer, s *api.Script) error {
	var kv apiKV
	kv.add("name", s.Name)
	kv.add("id", s.ID)
	kv.add("language", s.Language)
	kv.add("description", apiDeref(s.Description))
	kv.add("source", s.Source.Kind)
	ws := s.Workspace
	kv.add("folder", fmt.Sprintf("%d files, %s, pack %s (checked %s)", ws.FileCount, HumanBytes(ws.Bytes), apiShortCommit(apiDeref(ws.PackSHA256)), apiTime(ws.CheckedAt)))
	if d := s.Describe; d != nil {
		state := "reported by a run of an earlier state of the folder"
		if ws.PackSHA256 != nil && *ws.PackSHA256 == d.PackSHA256 {
			state = "reported by a run of the current folder"
		}
		kv.add("schemas", fmt.Sprintf("config %s, result %s (%s, %s)", scriptsSchemaState(d.ConfigSchema), scriptsSchemaState(d.ResultSchema), state, apiTimeValue(d.At)))
	}
	if r := s.LatestRun; r != nil {
		kv.add("latest run", fmt.Sprintf("%s (%s, %s)", r.ID, r.State, apiTimeValue(r.CreatedAt)))
	}
	kv.add("created", apiTimeValue(s.CreatedAt))
	kv.add("updated", apiTimeValue(s.UpdatedAt))
	if err := kv.write(w); err != nil {
		return err
	}
	if s.RecentRuns == nil || len(*s.RecentRuns) == 0 {
		return nil
	}
	if _, err := fmt.Fprintln(w, "recent runs:"); err != nil {
		return err
	}
	t := Table{Headers: []string{"  RUN", "STATE", "PROGRESS", "CREATED", "FINISHED"}}
	for _, r := range *s.RecentRuns {
		t.Add("  "+r.ID, r.State, scriptsProgressText(r.Progress), apiTimeValue(r.CreatedAt), apiTime(r.FinishedAt))
	}
	return t.Write(w)
}

func scriptsSchemaState(schema []byte) string {
	if len(schema) == 0 || string(schema) == "null" {
		return "none"
	}
	return "declared"
}

func newScriptsCreateCommand(app *App) *cobra.Command {
	var body api.CreateScript
	cmd := &cobra.Command{
		Use:   "create <name>",
		Short: "Create a script from the scaffold",
		Long: "Create a script on the platform and scaffold its folder (a working example that reads the results " +
			"of a scan). Edit it in the browser editor, with 'scantor scripts files' or locally (see 'scantor " +
			"scripts init' and 'scantor scripts push').",
		Example: `  scantor scripts create csp-report --description "Count the sites that send a CSP header"`,
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body.Name = args[0]
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			script, err := client.CreateScript(cmd.Context(), body)
			if err != nil {
				return err
			}
			return app.Output().Print(script, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "created script %s (%s, id %s)\n", script.Name, script.Language, script.ID)
				return err
			})
		},
	}
	cmd.Flags().StringVar(&body.Description, "description", "", "short description")
	return cmd
}

func newScriptsDeleteCommand(app *App) *cobra.Command {
	var wait apiWaitOptions
	cmd := &cobra.Command{
		Use:   "delete <script>",
		Short: "Delete a script with its runs",
		Long: "Delete a script: a background job cancels its active runs and removes their outputs, logs and " +
			"snapshots, the script's images and its folder. " + scriptsArgHelp,
		Example: "  scantor scripts delete csp-report --wait",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := wait.validate(); err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			ref, err := client.DeleteScript(ctx, args[0])
			if err != nil {
				return err
			}
			return apiPrintJobRef(ctx, app, client, *ref, wait, "deleting script "+args[0])
		},
	}
	apiWaitFlags(cmd, &wait, "the deletion has finished")
	return cmd
}

// ── init ─────────────────────────────────────────────────────────────────────

// scriptsInitResult is the JSON output of `scantor scripts init`.
type scriptsInitResult struct {
	Dir      string   `json:"dir"`
	Name     string   `json:"name"`
	Language string   `json:"language"`
	Files    []string `json:"files"`
}

func newScriptsInitCommand(app *App) *cobra.Command {
	var name, description, language string
	cmd := &cobra.Command{
		Use:   "init [dir]",
		Short: "Create a script folder from the scaffold",
		Long: "Create a script folder locally from the script scaffold: scantor-script.yaml, a Dockerfile, a working " +
			"main.py and models.py for the Result model of the task whose scans the script reads.\n\n" +
			"dir defaults to ./<name>; --name defaults to the slugified base name of dir; --language defaults to " +
			"the only language that supports scripts. An existing non-empty directory is refused.",
		Example: "  scantor scripts init csp-report\n  scantor scripts init --name csp-report --description \"Count CSP headers\"",
		Args:    cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			lang, err := scriptsLanguage(language)
			if err != nil {
				return err
			}
			dir, scriptName, err := initTarget(args, name)
			if err != nil {
				return err
			}
			cfg, err := app.Config()
			if err != nil {
				return err
			}
			err = workspace.RenderScriptInto(dir, workspace.ScriptScaffoldRequest{
				Name: scriptName, Description: description, Language: lang, Images: cfg.Images,
			})
			if err != nil {
				return initError(err)
			}
			files, err := scriptsListFiles(dir)
			if err != nil {
				return err
			}
			res := scriptsInitResult{Dir: dir, Name: scriptName, Language: lang, Files: files}
			if abs, err := filepath.Abs(dir); err == nil {
				res.Dir = abs
			}
			return app.Output().Print(res, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "Created script %q (%s) in %s\n\nNext steps:\n"+
					"  paste the task's Result model into models.py\n"+
					"  scantor scripts push %s                 upload the folder\n"+
					"  scantor scripts run %s --scan <scanId> --limit 100 --follow   try it on 100 analyses\n",
					scriptName, lang, dir, dir, dir)
				return err
			})
		},
	}
	cmd.Flags().StringVar(&name, "name", "", "script name (default: the slugified base name of dir)")
	cmd.Flags().StringVar(&description, "description", "", "script description")
	cmd.Flags().StringVar(&language, "language", "", "script language (default: the only language that supports scripts)")
	return cmd
}

// scriptsLanguage validates --language against the languages with a script scaffold; empty selects the
// only one.
func scriptsLanguage(language string) (string, error) {
	table, err := languages.Load()
	if err != nil {
		return "", PlatformError(err)
	}
	var names []string
	for _, l := range table.WithScripts() {
		names = append(names, l.Name)
	}
	switch {
	case len(names) == 0:
		return "", PlatformError(errors.New("no language supports scripts"))
	case language == "" && len(names) == 1:
		return names[0], nil
	case language == "":
		return "", UsageError(fmt.Errorf("--language is required; use one of %s", strings.Join(names, ", ")))
	case !slices.Contains(names, language):
		return "", UsageError(fmt.Errorf("%s does not support scripts; use one of %s", language, strings.Join(names, ", ")))
	}
	return language, nil
}

// scriptsListFiles returns the slash-separated paths of the regular files below dir, sorted.
func scriptsListFiles(dir string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type().IsRegular() {
			rel, err := filepath.Rel(dir, path)
			if err != nil {
				return err
			}
			files = append(files, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		return nil, PlatformError(fmt.Errorf("list %s: %w", dir, err))
	}
	slices.Sort(files)
	return files, nil
}

// ── push ─────────────────────────────────────────────────────────────────────

// scriptsPushResult is the JSON output of `scantor scripts push` (and of `scantor push` for a script
// folder): the upload response with the local pack summary; inside the editor nothing is uploaded.
type scriptsPushResult struct {
	Script   *api.Script       `json:"script"`
	Created  bool              `json:"created"`
	Uploaded bool              `json:"uploaded"`
	Pack     *taskpipe.Summary `json:"pack,omitempty"`
}

func newScriptsPushCommand(app *App) *cobra.Command {
	var force bool
	cmd := &cobra.Command{
		Use:   "push [dir]",
		Short: "Upload a script folder",
		Long: "Pack the script folder locally and upload it. The name in scantor-script.yaml selects or creates " +
			"the script, and the upload replaces its folder on the platform. The upload fails with workspaceDirty " +
			"when the platform folder has changes that were never uploaded (for example editor edits); --force " +
			"replaces them. Scripts have no revisions: the next run uses the uploaded folder.\n\n" +
			"Inside the editor (SCANTOR_WORKSPACE set and the folder below .scripts/) the folder already is the " +
			"script's folder, so nothing is uploaded.",
		Example: "  scantor scripts push\n  scantor scripts push ./csp-report --force",
		Args:    cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
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
			if folder.kind != editorKindScript {
				if inEditor {
					return UsageError(fmt.Errorf("%s belongs to task %s; push it with 'scantor push'", dir, folder.name))
				}
				return ValidationError(fmt.Errorf("%s has no %s; give a script folder", dir, manifest.ScriptFileName))
			}
			return scriptsPush(cmd.Context(), app, dir, folder.name, inEditor, force)
		},
	}
	cmd.Flags().BoolVar(&force, "force", false, "replace a platform folder with changes that were never uploaded")
	return cmd
}

// scriptsPush uploads a script folder (or, inside the editor, only shows the script) and prints the
// outcome.
func scriptsPush(ctx context.Context, app *App, dir, name string, inEditor, force bool) error {
	client, err := app.APIClient()
	if err != nil {
		return err
	}
	var res scriptsPushResult
	if inEditor {
		script, err := client.GetScript(ctx, name)
		if err != nil {
			return interruptedOr(ctx, err)
		}
		res.Script = script
	} else {
		up, summary, err := scriptsUploadFolder(ctx, app, client, dir, force)
		if err != nil {
			return err
		}
		res = scriptsPushResult{Script: &up.Script, Created: up.Created, Uploaded: true, Pack: summary}
	}
	return app.Output().Print(res, func(w io.Writer) error {
		verb := "Uploaded the folder of script"
		switch {
		case !res.Uploaded:
			verb = "Nothing to upload: inside the editor the folder already is the folder of script"
		case res.Created:
			verb = "Created script"
		}
		_, err := fmt.Fprintf(w, "%s %s\nStart a run with 'scantor scripts run %s --scan <scanId>'\n", verb, res.Script.Name, res.Script.Name)
		return err
	})
}

// scriptsUploadFolder packs a script folder and streams it to uploadScript. Like uploadFolder it applies
// the content rules but none of the instance's caps.
func scriptsUploadFolder(ctx context.Context, app *App, client *api.Client, dir string, force bool) (*api.UploadScriptResult, *taskpipe.Summary, error) {
	var res *api.UploadScriptResult
	summary, err := uploadPack(ctx, app, dir, editorKindScript, func(body io.Reader) (err error) {
		res, err = client.UploadScript(ctx, body, api.UploadScriptOptions{Force: force})
		return err
	})
	if err != nil {
		return nil, nil, interruptedOr(ctx, apiWithHint(err, api.CodeWorkspaceDirty,
			"the script folder on the platform has changes that were never uploaded; use 'scantor scripts push --force' to replace them"))
	}
	return res, summary, nil
}

// ── files ────────────────────────────────────────────────────────────────────

func newScriptsFilesListCommand(app *App) *cobra.Command {
	var recursive bool
	cmd := &cobra.Command{
		Use:     "list <script> [path]",
		Aliases: []string{"ls"},
		Short:   "List the files of a script folder",
		Long:    "List the files below a folder of the script (default: the script root). At most 5000 entries are returned. " + scriptsArgHelp,
		Example: `  scantor scripts files list csp-report
  scantor scripts files list csp-report lib --recursive=false`,
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
			list, err := client.ListScriptFiles(cmd.Context(), args[0], path, recursive)
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
	cmd.Flags().BoolVar(&recursive, "recursive", true, "include subfolders")
	return cmd
}

func newScriptsFilesReadCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:     "read <script> <path>",
		Aliases: []string{"cat"},
		Short:   "Print a file of a script folder",
		Long: "Print one file of the script folder. The content is written as raw bytes into a pipe or file; on a " +
			"terminal, control characters are shown escaped (\\x1b). The API returns at most 1 MiB of a file. With " +
			"-o json the response object (with base64 content for binary files) is printed instead.",
		Example: "  scantor scripts files read csp-report main.py",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			file, err := client.ReadScriptFile(cmd.Context(), args[0], args[1])
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
}

func newScriptsFilesWriteCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:     "write <script> <path>[=<source>]...",
		Aliases: []string{"put"},
		Short:   "Write files into a script folder",
		Long: "Write one or more files into the script folder (at most 200 per call). Each argument is a " +
			"script-relative path, optionally followed by =<source>: a local file, or - for stdin. Without a " +
			"source, the local file with the same relative path is uploaded. Text files are sent as UTF-8, other " +
			"files as base64. The next run uses the changed folder.",
		Example: `  scantor scripts files write csp-report main.py models.py
  cat main.py | scantor scripts files write csp-report main.py=-`,
		Args: cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			files, err := scriptsFileArgs(app, args[1:])
			if err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			res, err := client.WriteScriptFiles(cmd.Context(), args[0], files)
			if err != nil {
				return err
			}
			return app.Output().Print(res, func(w io.Writer) error {
				for _, p := range res.Written {
					if _, err := fmt.Fprintf(w, "wrote %s\n", p); err != nil {
						return err
					}
				}
				return scriptsWriteWorkspaceChange(w, res.Workspace)
			})
		},
	}
}

// scriptsFileArgs reads the <path>[=<source>] arguments of `scripts files write`.
func scriptsFileArgs(app *App, args []string) (map[string]api.TaskFileData, error) {
	if len(args) > 200 {
		return nil, UsageError(errors.New("at most 200 files can be written per call"))
	}
	in := newAPIInputs(app)
	files := make(map[string]api.TaskFileData, len(args))
	for _, arg := range args {
		path, source, found := strings.Cut(arg, "=")
		if !found {
			source = path
		}
		if path == "" || source == "" {
			return nil, UsageError(fmt.Errorf("invalid argument %q: use <path>[=<source>]", arg))
		}
		if _, dup := files[path]; dup {
			return nil, UsageError(fmt.Errorf("%s is given twice", path))
		}
		var data []byte
		var err error
		if source == "-" {
			data, err = in.stdin(path)
		} else {
			data, err = in.file(path, source)
		}
		if err != nil {
			return nil, err
		}
		files[path] = api.NewTaskFileData(data)
	}
	return files, nil
}

func scriptsWriteWorkspaceChange(w io.Writer, ws api.ScriptWorkspaceChange) error {
	_, err := fmt.Fprintf(w, "script folder pack %s\n", apiShortCommit(ws.PackSHA256))
	return err
}

func newScriptsFilesDeleteCommand(app *App) *cobra.Command {
	var recursive bool
	cmd := &cobra.Command{
		Use:     "delete <script> <path>",
		Aliases: []string{"rm"},
		Short:   "Delete a file or folder of a script folder",
		Long:    "Delete one file of the script folder, or a folder with --recursive. " + scriptsArgHelp,
		Example: `  scantor scripts files delete csp-report old.py
  scantor scripts files delete csp-report testdata --recursive`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			res, err := client.DeleteScriptFile(cmd.Context(), args[0], args[1], recursive)
			if err != nil {
				return err
			}
			return app.Output().Print(res, func(w io.Writer) error {
				for _, p := range res.Deleted {
					if _, err := fmt.Fprintf(w, "deleted %s\n", p); err != nil {
						return err
					}
				}
				return scriptsWriteWorkspaceChange(w, res.Workspace)
			})
		},
	}
	cmd.Flags().BoolVarP(&recursive, "recursive", "r", false, "delete a folder with its content")
	return cmd
}
