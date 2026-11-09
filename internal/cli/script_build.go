package cli

import (
	"errors"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/taskpipe"
)

// The script pipeline command (docs/scripts.md): hidden, because the orchestrator runs it as a
// subprocess of the scriptRun job; users reach it through script runs. It shares the task pipeline's
// pack, static and build steps, its event format and its exit codes.
func init() {
	registerGroup("", "script", "Run the script pipeline: build a script image", true)
	registerCommand("script", newScriptBuildCommand)
}

func newScriptBuildCommand(app *App) *cobra.Command {
	var opts taskpipe.ScriptBuildOptions
	var events taskEventFlags
	cmd := &cobra.Command{
		Use:   "build <dir|tgz|->",
		Short: "Build a script image on the local Docker daemon",
		Long: "Build a script folder (docs/scripts.md): pack → static checks (scantor-script.yaml rules S1–S6, the " +
			"Dockerfile and the Dockerfile policy D1–D11) → BuildKit build on the base image of the script's " +
			"language. The image stays local: there is no describe, type check or push. The result event reports " +
			"{pack, manifest, entry, defaults, baseImage, image, errors, warnings, durationsMs}. Exit codes: 0 " +
			"success, 2 invalid script content, 3 platform failure. The input is a script folder, a tar.gz pack, " +
			"or - for a pack on stdin.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if opts.Tag == "" {
				return UsageError(errors.New("--tag is required"))
			}
			if opts.ExpectName == "" {
				return UsageError(errors.New("--expect-name is required"))
			}
			format, err := events.resolve(app.Stdout)
			if err != nil {
				return err
			}
			cfg, err := app.Config()
			if err != nil {
				return err
			}
			in, closeInput, err := openTaskInput(app, args[0])
			if err != nil {
				return err
			}
			defer closeInput()
			emitter := taskpipe.NewEmitter(app.Stdout, format)
			docker, err := app.Docker()
			if err != nil {
				return err
			}
			res := taskpipe.New(taskPipelineConfig(cfg), emitter, docker, nil).BuildScript(cmd.Context(), in, opts)
			return scriptBuildOutcome(emitter, res)
		},
	}
	cmd.Flags().StringVar(&opts.Tag, "tag", "", "reference of the built local image (required)")
	cmd.Flags().StringVar(&opts.ExpectName, "expect-name", "", "fail unless the manifest name equals this script name (rule S6; required)")
	cmd.Flags().BoolVar(&opts.ReuseExisting, "reuse-existing", false, "skip the image build when an image tagged --tag exists locally and was built on the current base image")
	events.add(cmd)
	return cmd
}

// scriptBuildOutcome turns a script build result into the command's exit, like taskOutcome: the events
// already reported every error, so a failure exits silently with its code.
func scriptBuildOutcome(emitter *taskpipe.Emitter, res *taskpipe.ScriptResult) error {
	if err := emitter.Err(); err != nil {
		return PlatformError(err)
	}
	if code := res.ExitCode(); code != ExitOK {
		return SilentExit(code)
	}
	return nil
}
