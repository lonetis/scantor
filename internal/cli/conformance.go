package cli

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/conformance"
	"github.com/lonetis/scantor/internal/languages"
	"github.com/lonetis/scantor/internal/runtime"
)

// The connector conformance harness (docs/protocol.md §12, docs/testing.md §5) is hidden like the
// runtime commands: `just test-conformance` and CI run it.
func init() { registerCommand("", newConformanceCommand) }

func newConformanceCommand(app *App) *cobra.Command {
	var (
		language, fixtures, imagePrefix, namePrefix string
		cases                                       []string
		keepImages                                  bool
	)
	cmd := &cobra.Command{
		Use:    "conformance",
		Short:  "Run the connector conformance harness for one language",
		Hidden: true,
		Long: "Build every fixture task of internal/conformance/testdata/<language>/ with `scantor task build` against " +
			"the language's base image and run each conformance case in its own container (network none, the " +
			"injected scantor binary). Run from the repository root with access to Docker.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			table, err := languages.Load()
			if err != nil {
				return PlatformError(err)
			}
			if _, ok := table.Get(language); !ok {
				return UsageError(fmt.Errorf("unknown language %q; use one of %v", language, table.Names()))
			}
			cfg, err := app.Config()
			if err != nil {
				return err
			}
			docker, err := app.Docker()
			if err != nil {
				return err
			}
			ctx, cancel := InterruptContext(cmd.Context())
			defer cancel()
			bin, err := taskRuntimeBinary(docker, cfg).Resolve(ctx)
			if err != nil {
				return PlatformError(fmt.Errorf("resolve the scantor binary to inject: %w", err))
			}
			exe, err := os.Executable()
			if err != nil {
				return PlatformError(err)
			}
			suite := &conformance.Suite{
				Language: language, FixturesDir: fixtures, Docker: docker, Binary: bin,
				Builder: conformance.Builder{Executable: exe, Env: os.Environ()},
				Cases:   cases, ImagePrefix: imagePrefix, NamePrefix: namePrefix, KeepImages: keepImages, Out: app.Stderr,
			}
			summary, err := suite.Run(ctx)
			if err != nil {
				return PlatformError(err)
			}
			if out := app.Output(); out.JSON() {
				if err := out.PrintJSON(summary); err != nil {
					return err
				}
			}
			if summary.Failed > 0 {
				return SilentExit(ExitAnalysisFailures)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&language, "language", "", "language of schemas/languages.json to test (required)")
	cmd.Flags().StringVar(&fixtures, "fixtures", conformance.DefaultFixturesDir, "directory with <language>/<fixture>/ task folders")
	cmd.Flags().StringSliceVar(&cases, "case", nil, "run only these case ids (repeatable)")
	cmd.Flags().StringVar(&imagePrefix, "image-prefix", "scantor-conformance/", "prefix of the fixture image tags")
	cmd.Flags().StringVar(&namePrefix, "name-prefix", "scantor-test-", "prefix of the case container names")
	cmd.Flags().BoolVar(&keepImages, "keep-images", false, "keep the fixture images after the run")
	_ = cmd.MarkFlagRequired("language")
	cmd.AddCommand(newConformanceExecCommand(app))
	return cmd
}

func newConformanceExecCommand(app *App) *cobra.Command {
	var caseID, fixture, entry, language string
	cmd := &cobra.Command{
		Use:    "exec",
		Short:  "Run one conformance case inside a fixture container",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if caseID == "" || entry == "" {
				return UsageError(errors.New("--case and --entry are required"))
			}
			cfg, err := runtime.LoadConfig(app.Getenv, os.Environ())
			if err != nil {
				return ValidationError(err)
			}
			if language == "" {
				language = cfg.Language
			}
			code := conformance.Exec(cmd.Context(), conformance.ExecConfig{
				Language: language, Fixture: fixture, Entry: entry, ConnectorCmd: cfg.ConnectorCmd, Environ: cfg.Environ,
				TaskDir: runtime.TaskDir, WorkRoot: filepath.Join(filepath.Dir(cfg.WorkRoot), "scantor-conformance"),
			}, caseID, app.Stdout)
			if code != conformance.ExitPassed {
				return SilentExit(code)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&caseID, "case", "", "case id (H1 … P4)")
	cmd.Flags().StringVar(&fixture, "fixture", "", "fixture name")
	cmd.Flags().StringVar(&entry, "entry", "", "the fixture's entry (substituted for {entry})")
	cmd.Flags().StringVar(&language, "language", "", "suite language (default SCANTOR_LANGUAGE)")
	return cmd
}
