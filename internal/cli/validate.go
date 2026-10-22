package cli

import (
	"context"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/taskpipe"
)

func init() { registerCommand("", newValidateCommand) }

// devImageRepository is the repository of local builds (`validate`, `dev run`, `dev debug`).
const devImageRepository = "scantor-dev/"

// devImageTag names a local build after the task and its content: scantor-dev/<name>:<packSha256[0:12]>
// (docs/tasks.md §9.1).
func devImageTag(name, packSHA256 string) string {
	return devImageRepository + name + ":" + packSHA256[:min(12, len(packSHA256))]
}

// devDebugImageTag names a debug build (`dev debug`, built with SCANTOR_GCFLAGS), so it never replaces
// the regular image of the same content.
func devDebugImageTag(name, packSHA256 string) string {
	return devImageTag(name, packSHA256) + "-debug"
}

func newValidateCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "validate [dir]",
		Short: "Run every publish check on a task folder with local Docker",
		Long: "Run the checks a publish runs, on the local Docker daemon: pack, static checks (manifest, required " +
			"files, Dockerfile policy), image build, describe and type check. The image is tagged " +
			"scantor-dev/<name>:<hash> and never pushed. Privileged tasks are accepted locally; publishing " +
			"checks the permission on the server.\n\n" +
			"The pipeline events are printed as they happen; with -o json one JSON object per line. Exit codes: " +
			"0 valid, 2 invalid task content, 3 platform failure (for example Docker unreachable).",
		Example: "  scantor validate\n  scantor validate ./echo -o json",
		Args:    cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir := "."
			if len(args) == 1 {
				dir = args[0]
			}
			ctx, stop := InterruptContext(cmd.Context())
			defer stop()
			emitter := taskpipe.NewEmitter(app.Stdout, devEventFormat(app))
			res, err := localBuild(ctx, app, emitter, dir, taskpipe.BuildOptions{})
			if err != nil {
				return err
			}
			return taskOutcome(emitter, res)
		},
	}
}

// devEventFormat renders pipeline events as text in human mode and as NDJSON with -o json.
func devEventFormat(app *App) taskpipe.EventFormat {
	if app.Output().JSON() {
		return taskpipe.EventsNDJSON
	}
	return taskpipe.EventsText
}

// localBuild runs `task build` on a folder against the local Docker daemon as validate, dev run and
// dev debug do: privileged tasks allowed, tagged scantor-dev/<name>:<hash> (debug builds with a -debug
// suffix), never pushed. opts adds SkipCheck and DebugBuild.
func localBuild(ctx context.Context, app *App, emitter *taskpipe.Emitter, dir string, opts taskpipe.BuildOptions) (*taskpipe.Result, error) {
	cfg, err := app.Config()
	if err != nil {
		return nil, err
	}
	docker, err := app.Docker()
	if err != nil {
		return nil, err
	}
	opts.AllowPrivileged = true
	opts.TagFunc = devImageTag
	if opts.DebugBuild {
		opts.TagFunc = devDebugImageTag
	}
	opts.Push, opts.PushGate, opts.Tag = false, nil, ""
	pipeline := taskpipe.New(taskPipelineConfig(cfg), emitter, docker, taskRuntime(docker, cfg, emitter))
	return pipeline.Build(ctx, taskpipe.Input{Dir: dir}, opts), nil
}
