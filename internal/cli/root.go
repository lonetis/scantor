package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/moby/moby/client"
	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
	"github.com/lonetis/scantor/internal/redact"
	"github.com/lonetis/scantor/internal/version"
)

// App is the shared context of every command: streams, output format, configuration and client
// factories. Commands receive it in their CommandBuilder.
type App struct {
	// Getenv reads the environment; LoadConfig functions of other components receive it.
	Getenv func(string) string
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
	// Containerized reports whether the CLI runs inside a container (the docker shim), which enables the
	// localhost → host.docker.internal rewrite of SCANTOR_URL.
	Containerized func() bool

	format string

	configOnce sync.Once
	config     Config
	configErr  error

	apiOnce   sync.Once
	apiClient *api.Client
	apiErr    error

	dockerOnce   sync.Once
	dockerClient *client.Client
	dockerErr    error
}

// NewApp returns an App on the process streams and environment.
func NewApp() *App {
	return &App{
		Getenv:        os.Getenv,
		Stdin:         os.Stdin,
		Stdout:        os.Stdout,
		Stderr:        os.Stderr,
		Containerized: inContainer,
		format:        string(FormatHuman),
	}
}

// inContainer reports whether the process runs in a Docker container that can reach the Docker host as
// host.docker.internal (the docker shim adds it with --add-host). Without that name a rewritten URL could
// not resolve, so a loopback SCANTOR_URL is then kept as it is.
func inContainer() bool {
	if _, err := os.Stat("/.dockerenv"); err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupHost(ctx, ContainerHost)
	return err == nil && len(addrs) > 0
}

// Output returns the writer of the selected format.
func (a *App) Output() *Output {
	f, err := ParseFormat(a.format)
	if err != nil {
		f = FormatHuman
	}
	return &Output{Format: f, Out: a.Stdout, Err: a.Stderr}
}

// Config returns the CLI configuration, loaded once on first use.
func (a *App) Config() (Config, error) {
	a.configOnce.Do(func() {
		a.config, a.configErr = LoadConfig(a.Getenv)
		if a.configErr == nil {
			for _, w := range a.config.Warnings {
				a.Output().Warnf("%s", w)
			}
		}
	})
	return a.config, a.configErr
}

// APIClient returns a client of the orchestrator at SCANTOR_URL authenticated with SCANTOR_TOKEN. It
// fails with a validation error when no token is configured.
func (a *App) APIClient() (*api.Client, error) {
	a.apiOnce.Do(func() {
		cfg, err := a.Config()
		if err != nil {
			a.apiErr = err
			return
		}
		if cfg.Token == "" {
			a.apiErr = ValidationError(api.ErrNoToken)
			return
		}
		c, err := api.New(api.Options{
			BaseURL:    cfg.EffectiveURL(a.Containerized != nil && a.Containerized()),
			Credential: api.Credential{Kind: api.PrincipalUser, Token: cfg.Token},
			Policy:     api.Policy{CACertPEM: cfg.CACert},
		})
		if err != nil {
			a.apiErr = ValidationError(err)
			return
		}
		a.apiClient = c
	})
	return a.apiClient, a.apiErr
}

// Docker returns a Docker Engine client for DOCKER_HOST (or the default socket).
func (a *App) Docker() (*client.Client, error) {
	a.dockerOnce.Do(func() {
		c, err := container.NewClient(version.UserAgent("scantor-cli"))
		if err != nil {
			a.dockerErr = PlatformError(err)
			return
		}
		a.dockerClient = c
	})
	return a.dockerClient, a.dockerErr
}

// Logger returns a redacting text logger on stderr at info level.
func (a *App) Logger() *slog.Logger {
	return redact.NewLogger(a.Stderr, redact.FormatText, slog.LevelInfo)
}

// InterruptContext returns a context that is cancelled on SIGINT or SIGTERM, for commands that run until
// interrupted (long-polls, streams, local runs).
func InterruptContext(parent context.Context) (context.Context, context.CancelFunc) {
	return signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
}

// NewRootCommand builds the scantor command tree with every registered command.
func NewRootCommand() *cobra.Command {
	return newRootCommand(NewApp())
}

func newRootCommand(app *App) *cobra.Command {
	root := &cobra.Command{
		Use:           "scantor",
		Short:         "Run scanning tasks at scale",
		Long:          "scantor runs user-defined scanning tasks at large scale. The CLI authors, validates, publishes and runs tasks and inspects scans and results.\n\nCredentials come only from SCANTOR_URL and SCANTOR_TOKEN.",
		SilenceUsage:  true,
		SilenceErrors: false,
		Version:       version.Version,
		Args:          cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) > 0 {
				return UsageError(fmt.Errorf("unknown command %q for %q; run 'scantor --help'", args[0], cmd.CommandPath()))
			}
			return cmd.Help()
		},
	}
	root.SetIn(app.Stdin)
	root.SetOut(app.Stdout)
	root.SetErr(app.Stderr)
	root.SetVersionTemplate("scantor {{.Version}}\n")
	// The flag value validates itself, so an invalid -o is a usage error during flag parsing and the root
	// needs no PersistentPreRunE (command groups may define their own).
	root.PersistentFlags().VarP((*formatFlag)(&app.format), "output", "o", "output format: human or json")
	root.SetFlagErrorFunc(func(cmd *cobra.Command, err error) error {
		return UsageError(fmt.Errorf("%w; run '%s --help'", err, cmd.CommandPath()))
	})
	if err := attachCommands(root, app); err != nil {
		// A broken registration is a programming error caught by the registry test.
		panic(err)
	}
	reportErrors(root, app)
	return root
}

// reportErrors wraps every RunE so a failing command prints its error once in the selected format and
// cobra does not print it again. Errors raised before RunE (flag parsing, argument validation) are
// printed by cobra as "Error: …".
func reportErrors(cmd *cobra.Command, app *App) {
	if run := cmd.RunE; run != nil {
		cmd.RunE = func(c *cobra.Command, args []string) error {
			err := run(c, args)
			if err != nil {
				app.Output().PrintError(err)
				c.SilenceErrors = true
				c.Root().SilenceErrors = true
			}
			return err
		}
	}
	if args := cmd.Args; args != nil {
		cmd.Args = func(c *cobra.Command, a []string) error {
			if err := args(c, a); err != nil {
				return UsageError(err)
			}
			return nil
		}
	}
	for _, sub := range cmd.Commands() {
		reportErrors(sub, app)
	}
}

// formatFlag is the pflag.Value of -o/--output; Set rejects anything but human and json.
type formatFlag string

func (f *formatFlag) String() string { return string(*f) }

func (f *formatFlag) Set(s string) error {
	format, err := ParseFormat(s)
	if err != nil {
		return err
	}
	*f = formatFlag(format)
	return nil
}

func (f *formatFlag) Type() string { return "format" }

// errInterrupted is returned by commands that stop on SIGINT/SIGTERM.
var errInterrupted = errors.New("interrupted")

// Interrupted returns the platform-class error of an interrupted command.
func Interrupted() error { return PlatformError(errInterrupted) }
