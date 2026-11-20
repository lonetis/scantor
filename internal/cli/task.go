package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/moby/moby/client"
	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/bundle"
	"github.com/lonetis/scantor/internal/container"
	"github.com/lonetis/scantor/internal/taskpipe"
)

// The task pipeline commands (docs/tasks.md §9.1): hidden, because the orchestrator runs them as
// subprocesses and users reach them through validate, dev run, push and revisions bundle.
func init() {
	registerGroup("", "task", "Run the task pipeline: pack, static checks, build, bundle", true)
	registerCommand("task", newTaskPackCommand)
	registerCommand("task", newTaskCheckStaticCommand)
	registerCommand("task", newTaskBuildCommand)
	registerCommand("task", newTaskBundleCommand)
}

const taskInputHelp = "The input is a task folder, a tar.gz pack, or - for a pack on stdin."

// taskEventFlags holds --events; the default renders text on a terminal and NDJSON otherwise.
type taskEventFlags struct{ format string }

func (f *taskEventFlags) add(cmd *cobra.Command) {
	cmd.Flags().StringVar(&f.format, "events", "", "event format: ndjson or text (default: text on a terminal, else ndjson)")
}

func (f *taskEventFlags) resolve(w io.Writer) (taskpipe.EventFormat, error) {
	if f.format == "" {
		if apiIsTerminal(w) {
			return taskpipe.EventsText, nil
		}
		return taskpipe.EventsNDJSON, nil
	}
	format, err := taskpipe.ParseEventFormat(f.format)
	if err != nil {
		return "", UsageError(err)
	}
	return format, nil
}

func newTaskPackCommand(app *App) *cobra.Command {
	var output string
	var events taskEventFlags
	cmd := &cobra.Command{
		Use:   "pack <dir|tgz|->",
		Short: "Pack a task folder into its deterministic tar.gz",
		Long: "Pack a task folder (docs/tasks.md §9.2): apply .dockerignore and the hard excludes, check entry " +
			"types, paths and caps, and report the pack summary {packSha256, packBytes, fileCount, bytes} in the " +
			"result event. With --output the tar.gz is written to a file, or with --output - to stdout (the " +
			"events then go to stderr). " + taskInputHelp,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			eventsTo := app.Stdout
			if output == "-" {
				eventsTo = app.Stderr
			}
			format, err := events.resolve(eventsTo)
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
			emitter := taskpipe.NewEmitter(eventsTo, format)
			pipeline := taskpipe.New(taskPipelineConfig(cfg), emitter, nil, nil)
			ctx := cmd.Context()

			var res *taskpipe.Result
			switch output {
			case "":
				res = pipeline.Pack(ctx, in, nil)
			case "-":
				res = pipeline.Pack(ctx, in, app.Stdout)
			default:
				if res, err = taskPackToFile(ctx, pipeline, in, output); err != nil {
					return err
				}
			}
			return taskOutcome(emitter, res)
		},
	}
	// --output shadows the global -o/--output (human|json): the pipeline commands report events, chosen
	// with --events, so the output format flag has no meaning here.
	cmd.Flags().StringVarP(&output, "output", "o", "", "write the tar.gz to this file (- = stdout)")
	events.add(cmd)
	return cmd
}

// taskPackToFile packs into a temporary file next to path and renames it only when packing succeeded,
// so a failed pack never leaves a partial archive.
func taskPackToFile(ctx context.Context, pipeline *taskpipe.Pipeline, in taskpipe.Input, path string) (*taskpipe.Result, error) {
	var res *taskpipe.Result
	err := writeFileOnSuccess(path, ".scantor-pack-*", func(w io.Writer) bool {
		res = pipeline.Pack(ctx, in, w)
		return res.OK
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}

// writeFileOnSuccess runs write on a temporary file (named after pattern) next to path and renames it to
// path only when write reports success, so a failed command never leaves a partial file.
func writeFileOnSuccess(path, pattern string, write func(w io.Writer) bool) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), pattern)
	if err != nil {
		return ValidationError(fmt.Errorf("create %s: %w", path, err))
	}
	committed := false
	defer func() {
		if !committed {
			_ = tmp.Close()
			_ = os.Remove(tmp.Name())
		}
	}()
	if !write(tmp) {
		return nil
	}
	if err := tmp.Close(); err != nil {
		return PlatformError(fmt.Errorf("write %s: %w", path, err))
	}
	// The file is an ordinary user file; CreateTemp creates it 0600.
	if err := os.Chmod(tmp.Name(), 0o644); err != nil { //nolint:gosec // the file is the user's own file
		return PlatformError(err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return PlatformError(fmt.Errorf("write %s: %w", path, err))
	}
	committed = true
	return nil
}

func newTaskCheckStaticCommand(app *App) *cobra.Command {
	var opts taskpipe.StaticOptions
	var events taskEventFlags
	cmd := &cobra.Command{
		Use:   "check-static <dir|tgz|->",
		Short: "Check a task's manifest, required files and Dockerfile policy",
		Long: "Pack the input (a folder) or read and verify it (a pack), then apply the manifest rules M1–M10, the " +
			"required files and the Dockerfile policy D1–D11 with warnings W1–W3 (docs/tasks.md §9.3). " + taskInputHelp,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
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
			ctx := cmd.Context()
			res := taskpipe.New(taskPipelineConfig(cfg), emitter, nil, nil).CheckStatic(ctx, in, opts)
			return taskOutcome(emitter, res)
		},
	}
	taskStaticFlags(cmd, &opts)
	events.add(cmd)
	return cmd
}

func taskStaticFlags(cmd *cobra.Command, opts *taskpipe.StaticOptions) {
	cmd.Flags().StringVar(&opts.ExpectName, "expect-name", "", "fail unless the manifest name equals this task name (rule M9)")
	cmd.Flags().BoolVar(&opts.AllowPrivileged, "allow-privileged", false, "permit defaults.privileged: true (rule M10)")
}

func newTaskBuildCommand(app *App) *cobra.Command {
	var opts taskpipe.BuildOptions
	var events taskEventFlags
	var pushGate int
	cmd := &cobra.Command{
		Use:   "build <dir|tgz|->",
		Short: "Build, describe, check and optionally push a task image",
		Long: "Run the whole task pipeline (docs/tasks.md §9.4): pack → static checks → BuildKit build on the " +
			"local Docker daemon → describe → type check → push. --push needs the registry push credential in " +
			"SCANTOR_REGISTRY_PUSH_PASSWORD; --push-gate <fd> makes the push wait for the line \"push\" on that " +
			"file descriptor. Exit codes: 0 success, 2 invalid task content, 3 platform failure. " + taskInputHelp,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if opts.Tag == "" {
				return UsageError(errors.New("--tag is required"))
			}
			format, err := events.resolve(app.Stdout)
			if err != nil {
				return err
			}
			if cmd.Flags().Changed("push-gate") {
				if !opts.Push {
					return UsageError(errors.New("--push-gate needs --push"))
				}
				gate, err := openPushGate(pushGate)
				if err != nil {
					return err
				}
				defer gate.Close()
				opts.PushGate = gate
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
			ctx := cmd.Context()
			pipeline := taskpipe.New(taskPipelineConfig(cfg), emitter, docker, taskRuntime(docker, cfg, emitter))
			return taskOutcome(emitter, pipeline.Build(ctx, in, opts))
		},
	}
	cmd.Flags().StringVar(&opts.Tag, "tag", "", "reference of the built image (required)")
	cmd.Flags().BoolVar(&opts.Push, "push", false, "push the image by digest after every other phase succeeded")
	cmd.Flags().IntVar(&pushGate, "push-gate", 0, "file descriptor to read the push go-ahead line from (with --push)")
	cmd.Flags().BoolVar(&opts.SkipCheck, "skip-check", false, "skip the type check phase")
	cmd.Flags().BoolVar(&opts.ReuseExisting, "reuse-existing", false, "skip the image build when an image tagged --tag exists locally and was built on the current base image")
	cmd.Flags().BoolVar(&opts.DebugBuild, "debug-build", false, "build with SCANTOR_GCFLAGS=\""+taskpipe.DebugGCFlags+"\" (debuggable Go binaries)")
	taskStaticFlags(cmd, &opts.StaticOptions)
	events.add(cmd)
	return cmd
}

func newTaskBundleCommand(app *App) *cobra.Command {
	var opts taskpipe.BundleOptions
	var events taskEventFlags
	var output string
	var outputFD int
	cmd := &cobra.Command{
		Use:   "bundle <info|->",
		Short: "Build the bundle archive of a revision image",
		Long: "Build the bundle of a ready revision (docs/tasks.md §9.11): parse the bundle info (/scantor/bundle.json, " +
			"from a file or - for stdin), use the local revision image --image (or pull --pull <registry host>/<repository>@sha256:<digest> " +
			"with the registry push credential in SCANTOR_REGISTRY_PUSH_PASSWORD when the local image is absent or another one), " +
			"build the bundle image with the runtime binary and the info on the local Docker daemon, and write its gzip docker " +
			"save archive, named localhost/scantor/<task>:<revision>, to the inherited file descriptor --output-fd or to the " +
			"file --output (exactly one). The result event reports {ok, bundle: {image, platform, imageBytes, bytes, sha256, " +
			"scantorVersion}, errors, warnings, durationsMs}. Exit codes: 0 success, 2 build error, 3 platform failure.",
		Args:   cobra.ExactArgs(1),
		Hidden: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if opts.Image == "" {
				return UsageError(errors.New("--image is required"))
			}
			toFD := cmd.Flags().Changed("output-fd")
			switch {
			case toFD == (output != ""):
				return UsageError(errors.New("exactly one of --output-fd and --output is required"))
			case output == "-":
				return UsageError(errors.New("--output - is not supported: stdout carries the events; use --output-fd"))
			}
			format, err := events.resolve(app.Stdout)
			if err != nil {
				return err
			}
			var out *os.File
			if toFD {
				if out, err = openInheritedFD("output-fd", "output", outputFD); err != nil {
					return err
				}
				defer out.Close()
			}
			cfg, err := app.Config()
			if err != nil {
				return err
			}
			info, err := readBundleInfo(app, args[0])
			if err != nil {
				return err
			}
			emitter := taskpipe.NewEmitter(app.Stdout, format)
			docker, err := app.Docker()
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			pipeline := taskpipe.New(taskPipelineConfig(cfg), emitter, docker, bundleRuntime(docker, cfg, emitter))
			var res *taskpipe.BundleResult
			if toFD {
				res = pipeline.Bundle(ctx, info, opts, out)
			} else if err := writeFileOnSuccess(output, ".scantor-bundle-*", func(w io.Writer) bool {
				res = pipeline.Bundle(ctx, info, opts, w)
				return res.OK
			}); err != nil {
				return err
			}
			return bundleOutcome(emitter, res)
		},
	}
	cmd.Flags().StringVar(&opts.Image, "image", "", "local reference of the revision image (required)")
	cmd.Flags().StringVar(&opts.Pull, "pull", "", "the revision image by digest, pulled when the local image is absent or another one")
	cmd.Flags().IntVar(&outputFD, "output-fd", 0, "inherited file descriptor (≥ 3) to write the archive to")
	// --output shadows the global -o/--output (human|json), as in task pack: the result is reported as
	// events, chosen with --events.
	cmd.Flags().StringVarP(&output, "output", "o", "", "file to write the archive to (written only when the bundle succeeded)")
	events.add(cmd)
	return cmd
}

// readBundleInfo reads the <info|-> argument of task bundle: at most one byte more than a bundle info
// may have, so the bundle step reports an oversized info.
func readBundleInfo(app *App, arg string) ([]byte, error) {
	r := app.Stdin
	if arg != "-" {
		f, err := os.Open(arg) //nolint:gosec // the caller names the info file to read
		if err != nil {
			return nil, ValidationError(err)
		}
		defer f.Close()
		r = f
	}
	data, err := io.ReadAll(io.LimitReader(r, bundle.MaxInfoBytes+1))
	if err != nil {
		return nil, PlatformError(fmt.Errorf("read the bundle info: %w", err))
	}
	return data, nil
}

// bundleOutcome turns a bundle result into the command's exit, like taskOutcome: the events already
// reported every error, so a failure exits silently with its code.
func bundleOutcome(emitter *taskpipe.Emitter, res *taskpipe.BundleResult) error {
	if err := emitter.Err(); err != nil {
		return PlatformError(err)
	}
	if code := res.ExitCode(); code != ExitOK {
		return SilentExit(code)
	}
	return nil
}

// openPushGate opens the inherited file descriptor of --push-gate.
func openPushGate(fd int) (*os.File, error) { return openInheritedFD("push-gate", "gate", fd) }

// openInheritedFD opens the inherited file descriptor fd of the flag --<flag>; noun names its role in
// messages. 0, 1 and 2 are the standard streams and never accepted.
func openInheritedFD(flag, noun string, fd int) (*os.File, error) {
	if fd < 3 {
		return nil, UsageError(fmt.Errorf("--%s %d: the %s must be an inherited file descriptor ≥ 3", flag, fd, noun))
	}
	f := os.NewFile(uintptr(fd), flag)
	if f == nil {
		return nil, UsageError(fmt.Errorf("--%s %d: invalid file descriptor", flag, fd))
	}
	if _, err := f.Stat(); err != nil {
		return nil, UsageError(fmt.Errorf("--%s %d: %w", flag, fd, err))
	}
	return f, nil
}

// openTaskInput resolves the <dir|tgz|-> argument: - reads a pack from stdin, a regular file is a pack,
// anything else is packed as a folder (a missing folder is reported by the pack phase).
func openTaskInput(app *App, arg string) (taskpipe.Input, func(), error) {
	if arg == "-" {
		return taskpipe.Input{Archive: app.Stdin}, func() {}, nil
	}
	info, err := os.Stat(arg)
	if err != nil || info.IsDir() {
		return taskpipe.Input{Dir: arg}, func() {}, nil
	}
	if !info.Mode().IsRegular() {
		return taskpipe.Input{}, nil, ValidationError(fmt.Errorf("%s is neither a task folder nor a pack file", arg))
	}
	f, err := os.Open(arg) //nolint:gosec // the user names the pack to read
	if err != nil {
		return taskpipe.Input{}, nil, ValidationError(err)
	}
	return taskpipe.Input{Archive: f}, func() { _ = f.Close() }, nil
}

// taskOutcome turns a pipeline result into the command's exit: the events already reported every
// error, so a failure exits silently with the code of docs/tasks.md §9.9.
func taskOutcome(emitter *taskpipe.Emitter, res *taskpipe.Result) error {
	if err := emitter.Err(); err != nil {
		return PlatformError(err)
	}
	if code := res.ExitCode(); code != ExitOK {
		return SilentExit(code)
	}
	return nil
}

// taskPipelineConfig maps the CLI configuration to the task-pipeline settings.
func taskPipelineConfig(cfg Config) taskpipe.Config {
	p := cfg.Pipeline
	return taskpipe.Config{
		Pack:                 taskpipe.PackLimits{MaxFiles: p.TaskMaxFiles, MaxBytes: p.TaskMaxBytes, MaxPackBytes: p.TaskMaxPackBytes},
		ManifestLimits:       cfg.Limits,
		Images:               cfg.Images,
		BuildTimeout:         p.BuildTimeout,
		DescribeTimeout:      p.DescribeTimeout,
		MaxImageBytes:        p.MaxImageBytes,
		BuildCacheMaxBytes:   p.BuildCacheMaxBytes,
		PublicURL:            p.PublicURL,
		RegistryPublicHost:   p.RegistryPublicHost,
		RegistryPushPassword: p.RegistryPushPassword,
	}
}

// taskRuntime returns the resolver of the runtime binary injected into describe, check and local-mode
// containers (docs/tasks.md §9.6). Extraction progress is reported as a describe log event.
func taskRuntime(docker client.APIClient, cfg Config, emitter *taskpipe.Emitter) container.RuntimeBinary {
	r := taskRuntimeBinary(docker, cfg)
	r.Progress = func(text string) {
		emitter.Log(api.BuildPhaseDescribe, taskpipe.StreamPipeline, taskpipe.LevelInfo, text)
	}
	return r
}

// bundleRuntime returns the resolver of the runtime binary baked into a bundle image. Extraction progress
// is reported as a build log event.
func bundleRuntime(docker client.APIClient, cfg Config, emitter *taskpipe.Emitter) container.RuntimeBinary {
	r := taskRuntimeBinary(docker, cfg)
	r.Progress = func(text string) {
		emitter.Log(api.BuildPhaseBuild, taskpipe.StreamPipeline, taskpipe.LevelInfo, text)
	}
	return r
}

// taskRuntimeBinary returns the runtime resolver without progress reporting. When the executable path
// or the cache directory cannot be determined, the field stays empty and Resolve reports the problem
// if it needs that value.
func taskRuntimeBinary(docker client.APIClient, cfg Config) container.RuntimeBinary {
	exe, err := os.Executable()
	if err != nil {
		exe = ""
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		cache = ""
	}
	return container.RuntimeBinary{Docker: docker, CacheDir: cache, Images: cfg.Images, Executable: exe}
}
