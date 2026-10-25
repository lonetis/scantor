package cli

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/cobra/doc"
)

func init() {
	registerGroup("", "docs", "Generate documentation", true)
	registerCommand("docs", newDocsCLICommand)
}

// Paths of the generated documentation, relative to the repository root.
const (
	apiDocsGuideDir = "docs/guide"
	apiDocsCLIFile  = "docs/guide/cli.md"
)

// apiDocsReport is the output of `scantor docs cli`.
type apiDocsReport struct {
	// Updated lists the files written (or, with --check, the stale files).
	Updated []string `json:"updated"`
	Check   bool     `json:"check"`
}

func newDocsCLICommand(app *App) *cobra.Command {
	var check bool
	var root string
	cmd := &cobra.Command{
		Use:    "cli",
		Short:  "Regenerate docs/guide/cli.md and the guide snippets",
		Hidden: true,
		Long: "Write the CLI reference docs/guide/cli.md from the cobra command tree and refresh every " +
			"<!-- scantor:include <path> --> block of docs/guide/*.md with the current content of <path>. With " +
			"--check nothing is written and the command fails when a file is stale. Run from the repository " +
			"root (just docs).",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			files, err := apiGenerateDocs(cmd.Root(), root)
			if err != nil {
				return err
			}
			report := apiDocsReport{Updated: []string{}, Check: check}
			for _, name := range slices.Sorted(maps.Keys(files)) {
				target := filepath.Join(root, filepath.FromSlash(name))
				current, err := os.ReadFile(target) //nolint:gosec // a path inside the repository root
				if err != nil && !errors.Is(err, fs.ErrNotExist) {
					return ValidationError(err)
				}
				if bytes.Equal(current, files[name]) {
					continue
				}
				report.Updated = append(report.Updated, name)
				if check {
					continue
				}
				if err := os.WriteFile(target, files[name], 0o644); err != nil { //nolint:gosec // documentation is world-readable
					return PlatformError(err)
				}
			}
			if err := app.Output().Print(report, func(w io.Writer) error {
				verb := "updated"
				if check {
					verb = "stale"
				}
				if len(report.Updated) == 0 {
					_, err := fmt.Fprintln(w, "documentation is up to date")
					return err
				}
				for _, name := range report.Updated {
					if _, err := fmt.Fprintf(w, "%s %s\n", verb, name); err != nil {
						return err
					}
				}
				return nil
			}); err != nil {
				return err
			}
			if check && len(report.Updated) > 0 {
				return ValidationError(fmt.Errorf("%d documentation file(s) are stale; run 'just docs'", len(report.Updated)))
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&check, "check", false, "fail when a file is stale instead of writing it")
	cmd.Flags().StringVar(&root, "root", ".", "repository root")
	return cmd
}

// apiGenerateDocs returns the generated content of every documentation file, keyed by its path relative
// to the repository root: the CLI reference and every guide with include blocks.
func apiGenerateDocs(rootCmd *cobra.Command, repoRoot string) (map[string][]byte, error) {
	reference, err := apiCLIReference(rootCmd)
	if err != nil {
		return nil, PlatformError(fmt.Errorf("generate the CLI reference: %w", err))
	}
	files := map[string][]byte{apiDocsCLIFile: reference}
	repo, err := os.OpenRoot(repoRoot)
	if err != nil {
		return nil, ValidationError(fmt.Errorf("open the repository root: %w", err))
	}
	defer repo.Close()
	guides, err := fs.Glob(repo.FS(), apiDocsGuideDir+"/*.md")
	if err != nil {
		return nil, PlatformError(err)
	}
	for _, guide := range guides {
		if guide == apiDocsCLIFile {
			continue
		}
		content, err := repo.ReadFile(guide)
		if err != nil {
			return nil, ValidationError(err)
		}
		refreshed, err := apiRefreshIncludes(content, guide, repo.ReadFile)
		if err != nil {
			return nil, err
		}
		files[guide] = refreshed
	}
	return files, nil
}

const apiCLIReferenceIntro = `# CLI reference

<!-- Generated from the cobra command tree by ` + "`just docs`" + ` (hidden command ` + "`scantor docs cli`" + `); do not edit. -->

The ` + "`scantor`" + ` CLI authors, validates, publishes and runs tasks and inspects scans and results. It is a
single binary (release downloads for Linux and macOS) and also runs through the Docker shim ` + "`scantor.sh`" + `.

- **Credentials** come only from ` + "`SCANTOR_URL`" + ` and ` + "`SCANTOR_TOKEN`" + ` (an API key from "CLI & MCP access" in the web
  UI). The other variables the CLI reads are listed in the CLI section of ` + "`.env.example`" + `.
- **Output**: human-readable by default; ` + "`-o json`" + ` prints JSON on stdout (one document, or one object per line
  for streams such as ` + "`scans watch`" + ` and ` + "`revisions logs`" + `). Progress and errors go to stderr; in JSON mode
  errors are printed as ` + "`{\"error\": {code, message, exitCode, …}}`" + `. Human output shows control characters
  escaped (` + "`\\x1b`" + `), so task-controlled text cannot drive the terminal; raw content (` + "`tasks files cat`" + `,
  ` + "`scans worker logs`" + `) keeps its exact bytes in a pipe or file, and ` + "`-o json`" + ` always carries the exact text.
- **Exit codes**:

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | analyses failed: ` + "`dev run`" + `, and the waiting scan commands (` + "`scans start --wait`" + `, ` + "`scans get --wait`" + `, ` + "`scans watch`" + `) when the scan failed, was cancelled, paused by the circuit breaker, or completed with failed or lost analyses |
| 2 | invalid input: usage, configuration, task content, configs, requests the platform rejected (4xx) |
| 3 | platform failure: Docker, network, orchestrator errors (5xx), timeouts, interrupts |

`

// apiCLIReference renders the Markdown CLI reference of every public command below root.
func apiCLIReference(root *cobra.Command) ([]byte, error) {
	root.InitDefaultHelpCmd()
	root.InitDefaultCompletionCmd()
	root.InitDefaultVersionFlag()
	defer apiEscapeDescriptions(root)()
	var buf bytes.Buffer
	buf.WriteString(apiCLIReferenceIntro)
	var walk func(cmd *cobra.Command) error
	walk = func(cmd *cobra.Command) error {
		cmd.DisableAutoGenTag = true
		buf.WriteString("\n")
		if err := doc.GenMarkdownCustom(cmd, &buf, apiDocsAnchor); err != nil {
			return err
		}
		children := slices.Clone(cmd.Commands())
		slices.SortFunc(children, func(a, b *cobra.Command) int { return strings.Compare(a.Name(), b.Name()) })
		for _, child := range children {
			if !child.IsAvailableCommand() || child.IsAdditionalHelpTopicCommand() {
				continue
			}
			if err := walk(child); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(root); err != nil {
		return nil, err
	}
	return append(bytes.TrimRight(buf.Bytes(), "\n"), '\n'), nil
}

// apiEscapeDescriptions escapes < and > in the descriptions of every command of the tree, so
// placeholders such as <task>@<number> are not taken for HTML when the Markdown is rendered. It returns
// the function that restores the originals.
func apiEscapeDescriptions(root *cobra.Command) (restore func()) {
	escape := strings.NewReplacer("<", "&lt;", ">", "&gt;")
	type saved struct {
		cmd         *cobra.Command
		short, long string
	}
	var originals []saved
	var walk func(cmd *cobra.Command)
	walk = func(cmd *cobra.Command) {
		originals = append(originals, saved{cmd, cmd.Short, cmd.Long})
		cmd.Short, cmd.Long = escape.Replace(cmd.Short), escape.Replace(cmd.Long)
		for _, child := range cmd.Commands() {
			walk(child)
		}
	}
	walk(root)
	return func() {
		for _, o := range originals {
			o.cmd.Short, o.cmd.Long = o.short, o.long
		}
	}
}

// apiDocsAnchor turns cobra's per-command file links ("scantor_scans_start.md") into anchors of the
// single reference page ("#scantor-scans-start").
func apiDocsAnchor(file string) string {
	return "#" + strings.ReplaceAll(strings.TrimSuffix(file, ".md"), "_", "-")
}

var (
	apiIncludeStart = regexp.MustCompile(`^<!-- scantor:include (\S+) -->$`)
	apiIncludeEnd   = "<!-- scantor:include:end -->"
	apiFenceLang    = map[string]string{
		".py": "python", ".ts": "typescript", ".js": "javascript", ".go": "go", ".yaml": "yaml", ".yml": "yaml",
		".json": "json", ".toml": "toml", ".sh": "sh", ".md": "markdown", ".txt": "text",
	}
)

// apiRefreshIncludes replaces the body of every include block of a guide with the current content of the
// included file as a fenced code block. The fence keeps the language of the existing block. Included
// paths are relative to the repository root.
func apiRefreshIncludes(guide []byte, name string, readFile func(string) ([]byte, error)) ([]byte, error) {
	lines := strings.SplitAfter(string(guide), "\n")
	var out strings.Builder
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		m := apiIncludeStart.FindStringSubmatch(strings.TrimRight(line, "\r\n"))
		if m == nil {
			if strings.TrimRight(line, "\r\n") == apiIncludeEnd {
				return nil, ValidationError(fmt.Errorf("%s:%d: include end without a start", name, i+1))
			}
			out.WriteString(line)
			continue
		}
		include := m[1]
		if !filepath.IsLocal(filepath.FromSlash(include)) {
			return nil, ValidationError(fmt.Errorf("%s:%d: include path %q must be relative to the repository root", name, i+1, include))
		}
		end := -1
		for j := i + 1; j < len(lines); j++ {
			trimmed := strings.TrimRight(lines[j], "\r\n")
			if trimmed == apiIncludeEnd {
				end = j
				break
			}
			if apiIncludeStart.MatchString(trimmed) {
				return nil, ValidationError(fmt.Errorf("%s:%d: nested include", name, j+1))
			}
		}
		if end < 0 {
			return nil, ValidationError(fmt.Errorf("%s:%d: include of %s has no %s", name, i+1, include, apiIncludeEnd))
		}
		content, err := readFile(path.Clean(include))
		if err != nil {
			return nil, ValidationError(fmt.Errorf("%s:%d: %w", name, i+1, err))
		}
		lang := apiFenceLang[strings.ToLower(path.Ext(include))]
		if i+1 < end {
			if opening := strings.TrimRight(lines[i+1], "\r\n"); strings.HasPrefix(opening, "```") {
				lang = strings.TrimLeft(opening, "`")
			}
		}
		fence := strings.Repeat("`", max(3, apiLongestBacktickRun(content)+1))
		out.WriteString(line)
		out.WriteString(fence + lang + "\n")
		out.Write(content)
		if len(content) > 0 && content[len(content)-1] != '\n' {
			out.WriteString("\n")
		}
		out.WriteString(fence + "\n")
		out.WriteString(lines[end])
		i = end
	}
	return []byte(out.String()), nil
}

func apiLongestBacktickRun(b []byte) int {
	longest, run := 0, 0
	for _, c := range b {
		if c == '`' {
			run++
			longest = max(longest, run)
		} else {
			run = 0
		}
	}
	return longest
}
