package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/container"
	"github.com/lonetis/scantor/internal/node"
	"github.com/lonetis/scantor/internal/redact"
	"github.com/lonetis/scantor/internal/version"
)

// `scantor node` runs the node daemon (docs/nodes.md). `scantor node healthcheck` is the container
// healthcheck of compose and the join snippet; the hidden `scantor node egress-apply` runs inside the
// egress helper container.

func init() { registerCommand("", newNodeCommand) }

func newNodeCommand(app *App) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "node",
		Short: "Run the node daemon that runs workers on this Docker host",
		Long: "Run the node daemon. It registers with the orchestrator at SCANTOR_URL, long-polls the workers " +
			"assigned to this node and runs them as containers on the local Docker engine (Docker socket " +
			"required). Remote nodes authenticate with SCANTOR_NODE_TOKEN; the master's built-in node sets " +
			"SCANTOR_NODE_BUILTIN=true. Configuration comes only from the environment (see .env.example).\n\n" +
			"On SIGTERM the daemon stops and leaves its workers running; the next daemon adopts them.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := node.LoadConfig(os.LookupEnv)
			if err != nil {
				return ValidationError(err)
			}
			docker, err := container.NewClient(version.UserAgent("scantor-node"))
			if err != nil {
				return PlatformError(err)
			}
			defer docker.Close()
			// The daemon logs to stdout (docs/deployment.md §13.2).
			logger := redact.NewLogger(app.Stdout, cfg.LogFormat, cfg.LogLevel)
			d, err := node.New(node.Options{Config: cfg, Docker: docker, Logger: logger})
			if err != nil {
				return PlatformError(err)
			}
			ctx := cmd.Context()
			if err := d.Run(ctx); err != nil {
				var cfgErr *node.ConfigError
				if errors.As(err, &cfgErr) {
					return ValidationError(err)
				}
				return PlatformError(err)
			}
			return nil
		},
	}
	cmd.AddCommand(newNodeHealthcheckCommand(app), newNodeEgressApplyCommand(app))
	return cmd
}

func newNodeHealthcheckCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "healthcheck",
		Short: "Check that the node daemon reported its status recently",
		Long: "Exit 0 when the node daemon's last successful status report is younger than three status " +
			"intervals, and 1 otherwise. It reads " + node.StatusFile + " inside the daemon container and is " +
			"the container healthcheck of the node service.",
		Args: cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			if err := node.Healthcheck(node.StatusFile, time.Now()); err != nil {
				return WithExit(1, err)
			}
			_, err := fmt.Fprintln(app.Stdout, "healthy")
			return err
		},
	}
}

func newNodeEgressApplyCommand(app *App) *cobra.Command {
	var deny string
	cmd := &cobra.Command{
		Use:    "egress-apply",
		Short:  "Apply the egress deny list to DOCKER-USER (runs inside the egress helper container)",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cidrs, err := node.ParseCIDRs(deny)
			if err != nil {
				return UsageError(fmt.Errorf("--deny: %w", err))
			}
			res := node.EgressApply(cmd.Context(), cidrs, node.ExecRunner)
			line, err := json.Marshal(res)
			if err != nil {
				return PlatformError(err)
			}
			_, err = fmt.Fprintln(app.Stdout, string(line))
			return err
		},
	}
	cmd.Flags().StringVar(&deny, "deny", "", "comma-separated CIDRs workers must not reach")
	return cmd
}
