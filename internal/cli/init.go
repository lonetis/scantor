package cli

import (
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/languages"
	"github.com/lonetis/scantor/internal/workspace"
)

func init() { registerCommand("", newInitCommand) }

// initResult is the JSON output of `scantor init`.
type initResult struct {
	Dir      string   `json:"dir"`
	Name     string   `json:"name"`
	Language string   `json:"language"`
	Template string   `json:"template"`
	Files    []string `json:"files"`
}

// newInitCommand is `scantor init [dir] --language <l> [--template <t>] [--name <n>] [--description
// <d>]` (docs/tasks.md §12.2): it renders the embedded scaffold locally with the same renderer as the
// workspace helper.
func newInitCommand(app *App) *cobra.Command {
	var language, template, name, description string
	cmd := &cobra.Command{
		Use:   "init [dir]",
		Short: "Create a task folder from a scaffold",
		Long: "Create a task folder from the scaffold of a language and a template. The folder publishes unchanged.\n\n" +
			"dir defaults to ./<name>; --name defaults to the slugified base name of dir; --template defaults to " +
			"single (use a template name or \"custom\" for a custom schedule). An existing non-empty directory is refused.",
		Example: "  scantor init echo --language python\n  scantor init --name origins --language typescript --template crux",
		Args:    cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if language == "" {
				return UsageError(fmt.Errorf("--language is required; use one of %s", initLanguageNames()))
			}
			dir, taskName, err := initTarget(args, name)
			if err != nil {
				return err
			}
			cfg, err := app.Config()
			if err != nil {
				return err
			}
			files, err := workspace.RenderInto(dir, workspace.ScaffoldRequest{
				Name: taskName, Language: language, Template: template, Description: description, Images: cfg.Images,
			})
			if err != nil {
				return initError(err)
			}
			res := initResult{Dir: dir, Name: taskName, Language: language, Template: template, Files: files}
			if abs, err := filepath.Abs(dir); err == nil {
				res.Dir = abs
			}
			return app.Output().Print(res, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "Created task %q (%s, template %s) in %s\n\nNext steps:\n"+
					"  scantor dev run %s       build and run it locally\n"+
					"  scantor validate %s      run every publish check\n"+
					"  scantor push %s          upload and publish a revision\n",
					taskName, language, template, dir, dir, dir, dir)
				return err
			})
		},
	}
	cmd.Flags().StringVar(&language, "language", "", "task language ("+initLanguageNames()+")")
	cmd.Flags().StringVar(&template, "template", workspace.DefaultTemplate, `template name or "custom"`)
	cmd.Flags().StringVar(&name, "name", "", "task name (default: the slugified base name of dir)")
	cmd.Flags().StringVar(&description, "description", "", "task description")
	return cmd
}

// initTarget resolves the directory and the task name: dir defaults to ./<name>, the name to the
// slugified base name of dir.
func initTarget(args []string, name string) (dir, taskName string, err error) {
	switch {
	case len(args) == 0 && name == "":
		return "", "", UsageError(errors.New("give a directory or --name"))
	case len(args) == 0:
		dir, taskName = "./"+name, name
	default:
		dir, taskName = args[0], name
		if taskName == "" {
			abs, err := filepath.Abs(dir)
			if err != nil {
				return "", "", UsageError(fmt.Errorf("resolve %s: %w", dir, err))
			}
			taskName = slugifyTaskName(filepath.Base(abs))
		}
	}
	if err := workspace.ValidateTaskName(taskName); err != nil {
		return "", "", UsageError(fmt.Errorf("%w; choose a name with --name", err))
	}
	return dir, taskName, nil
}

var initSlugRuns = regexp.MustCompile(`[^a-z0-9]+`)

// slugifyTaskName turns a directory name into a task name: lowercase, runs of other characters become
// one '-', at most 64 characters, no leading or trailing '-'.
func slugifyTaskName(s string) string {
	s = strings.Trim(initSlugRuns.ReplaceAllString(strings.ToLower(s), "-"), "-")
	if len(s) > 64 {
		s = strings.TrimRight(s[:64], "-")
	}
	return s
}

// initError maps a renderer error to a CLI exit class: invalid input and an existing directory are
// validation errors (2), everything else a platform error (3).
func initError(err error) error {
	var werr *workspace.Error
	if errors.As(err, &werr) && werr.Code != workspace.CodeInternal {
		return ValidationError(err)
	}
	return PlatformError(err)
}

func initLanguageNames() string {
	table, err := languages.Load()
	if err != nil {
		return "see schemas/languages.json"
	}
	return strings.Join(table.Names(), ", ")
}
