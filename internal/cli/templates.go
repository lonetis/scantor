package cli

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/templates"
)

func init() {
	registerGroup("", "templates", "List the templates and estimate scan sizes", false)
	registerCommand("templates", newTemplatesListCommand)
	registerCommand("templates", newTemplatesEstimateCommand)
}

// templatesMaxConfigBytes bounds a scan config read by `templates estimate`.
const templatesMaxConfigBytes = 16 << 20

func newTemplatesListCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List the templates",
		Long: "List the built-in templates with their scan and analysis config schemas.\n\n" +
			"With -o json the output is {\"items\": [...]} with the fields of GET /api/templates " +
			"(name, title, description, scanConfigSchema, analysisConfigSchema, example, resolves) plus " +
			"version, estimate, dataSources and uploads.",
		Args: cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			defs := templates.List()
			items := make([]templates.Info, len(defs))
			table := Table{Headers: []string{"NAME", "TITLE", "ESTIMATE", "RESOLVES", "DATA SOURCES", "UPLOADS"}}
			for i, def := range defs {
				info := def.Info()
				items[i] = info
				sources := strings.Join(info.DataSources, ",")
				if sources == "" {
					sources = "-"
				}
				table.Add(info.Name, info.Title, info.Estimate, yesNo(info.Resolves), sources, yesNo(info.Uploads))
			}
			return app.Output().Print(map[string]any{"items": items}, table.Write)
		},
	}
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// templatesIssues is the stdout document of a rejected scan config (exit 2).
type templatesIssues struct {
	Issues []templates.Issue `json:"issues"`
}

func newTemplatesEstimateCommand(app *App) *cobra.Command {
	var config, scanConfig string
	var uploads []string
	cmd := &cobra.Command{
		Use:   "estimate <template>",
		Short: "Validate a scan config and estimate the number of analyses",
		Long: "Apply the template's defaults to a scan config, validate it (JSON Schema and the template's " +
			"semantic rules) and estimate the number of analyses without network access.\n\n" +
			"The scan config is given with --config (alias --scan-config) as inline JSON, @file or - for " +
			"stdin; without it the defaults apply. Referenced uploads need --upload <id>=<lines>.\n\n" +
			"The output is always JSON on stdout, because the orchestrator runs this command at scan start:\n" +
			"  exit 0: {\"expectedTotal\": n | null, \"exact\": bool}\n" +
			"  exit 2: {\"issues\": [{\"path\": <JSON pointer>, \"message\": ...}]}\n" +
			"  exit 3: internal failure",
		Example: "  scantor templates estimate cidr --config '{\"cidrs\": [\"10.0.0.0/16\"]}'\n" +
			"  echo '{\"upload\": \"7b0c6e2a-1f3d-4c5e-9a8b-0d1e2f3a4b5c\"}' | scantor templates estimate list --config - --upload 7b0c6e2a-1f3d-4c5e-9a8b-0d1e2f3a4b5c=10000",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			def, ok := templates.Lookup(args[0])
			if !ok {
				return UsageError(fmt.Errorf("unknown template %q (known: %s)", args[0], strings.Join(templates.Names(), ", ")))
			}
			if config != "" && scanConfig != "" {
				return UsageError(errors.New("--config and --scan-config are the same flag; give one"))
			}
			if config == "" {
				config = scanConfig
			}
			raw, err := templatesReadConfig(app, config)
			if err != nil {
				return err
			}
			env := templates.Env{Uploads: map[string]templates.Upload{}}
			for _, u := range uploads {
				id, lines, err := templatesParseUpload(u)
				if err != nil {
					return err
				}
				env.Uploads[id] = templates.Upload{Lines: lines}
			}

			effective, issues, err := def.Effective(raw)
			if err != nil {
				if inner := errors.Unwrap(err); inner != nil {
					err = inner
				}
				issues = []templates.Issue{{Path: "", Message: "the scan config is not valid JSON: " + err.Error()}}
			}
			if len(issues) > 0 {
				return templatesReject(app, issues)
			}
			est, err := def.Estimate(effective, env)
			if err != nil {
				if e, ok := templates.AsError(err); ok && e.Type == api.ErrorValidation {
					return templatesReject(app, templates.ErrorIssues(e))
				}
				return PlatformError(fmt.Errorf("estimate %s: %w", def.Name(), err))
			}
			return app.Output().PrintJSON(est)
		},
	}
	cmd.Flags().StringVar(&config, "config", "", "scan config: inline JSON, @file or - (stdin)")
	cmd.Flags().StringVar(&scanConfig, "scan-config", "", "alias of --config")
	cmd.Flags().StringArrayVar(&uploads, "upload", nil, "line count of a referenced upload, as <id>=<lines> (repeatable)")
	return cmd
}

// templatesReject prints the issues document on stdout (and a summary on stderr in human mode) and
// ends with exit 2.
func templatesReject(app *App, issues []templates.Issue) error {
	out := app.Output()
	if err := out.PrintJSON(templatesIssues{Issues: issues}); err != nil {
		return err
	}
	if !out.JSON() {
		_, _ = fmt.Fprintln(out.Err, "Error: the scan config is invalid")
		for _, is := range issues {
			_, _ = fmt.Fprintf(out.Err, "  %s\n", TerminalSafe(is.String()))
		}
	}
	return SilentExit(ExitValidation)
}

// templatesReadConfig reads a scan config given inline, as @file or as - (stdin); empty means {}.
func templatesReadConfig(app *App, value string) ([]byte, error) {
	var r io.Reader
	switch {
	case value == "":
		return []byte(`{}`), nil
	case value == "-":
		r = app.Stdin
	case strings.HasPrefix(value, "@"):
		name := strings.TrimPrefix(value, "@")
		f, err := os.Open(name) // #nosec G304 -- the user names the file to read
		if err != nil {
			return nil, ValidationError(fmt.Errorf("--config: %w", err))
		}
		defer func() { _ = f.Close() }()
		r = f
	default:
		return []byte(value), nil
	}
	data, err := io.ReadAll(io.LimitReader(r, templatesMaxConfigBytes+1))
	if err != nil {
		return nil, ValidationError(fmt.Errorf("read --config: %w", err))
	}
	if len(data) > templatesMaxConfigBytes {
		return nil, ValidationError(fmt.Errorf("--config exceeds %s", HumanBytes(templatesMaxConfigBytes)))
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return []byte(`{}`), nil
	}
	return data, nil
}

func templatesParseUpload(v string) (string, int64, error) {
	id, linesText, ok := strings.Cut(v, "=")
	lines, err := strconv.ParseInt(linesText, 10, 64)
	if !ok || id == "" || err != nil || lines < 0 {
		return "", 0, UsageError(fmt.Errorf("--upload %q: want <id>=<lines> with lines ≥ 0", v))
	}
	return id, lines, nil
}
