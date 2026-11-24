package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"time"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/redact"
	"github.com/lonetis/scantor/internal/resolver"
)

// The hidden `scantor node resolver` commands run inside the node resolver's containers, which the
// node daemon creates from its own image (docs/nodes.md §6.11): `serve` in the resolver container,
// `healthcheck` as its container healthcheck and `probe` in the one-shot probe container on the worker
// network. None of them reads the environment: serve gets everything from its flags.

// probeTimeout bounds the probe's lookup: Docker's embedded DNS waits 4 s per server.
const probeTimeout = 10 * time.Second

func newNodeResolverCommand(app *App) *cobra.Command {
	cmd := &cobra.Command{
		Use:    "resolver",
		Short:  "Run the node resolver (runs inside the resolver containers of the node daemon)",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE:   func(cmd *cobra.Command, _ []string) error { return cmd.Help() },
	}
	cmd.AddCommand(newNodeResolverServeCommand(app), newNodeResolverHealthcheckCommand(app), newNodeResolverProbeCommand(app))
	return cmd
}

func newNodeResolverServeCommand(app *App) *cobra.Command {
	var config, specHash string
	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Serve DNS to the node's workers until SIGTERM",
		Long: "Serve DNS on the worker network's gateway with a cache, resolving through the upstream servers or " +
			"from the root servers with zdns. Bound next to a serving resolver, it takes no query before its upstream " +
			"check passes. On SIGTERM new queries go to the other resolver on the same address and the open ones are " +
			"answered before the sockets close.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := resolver.ParseConfig([]byte(config))
			if err != nil {
				return ValidationError(fmt.Errorf("--config: %w", err))
			}
			level, _ := redact.ParseLevel(cfg.LogLevel) // validated by ParseConfig; empty means info
			format := cfg.LogFormat
			if format == "" {
				format = redact.FormatJSON
			}
			logger := redact.NewLogger(app.Stdout, format, level)
			err = resolver.Run(cmd.Context(), resolver.Options{Config: cfg, SpecHash: specHash, Logger: logger})
			switch {
			case err == nil:
				return nil
			case errors.Is(err, resolver.ErrPanic):
				return WithExit(1, err)
			default:
				return PlatformError(err)
			}
		},
	}
	cmd.Flags().StringVar(&config, "config", "", "resolver configuration (compact JSON)")
	cmd.Flags().StringVar(&specHash, "spec-hash", "", "spec hash of the resolver container (sha256:<hex>)")
	_ = cmd.MarkFlagRequired("config")
	_ = cmd.MarkFlagRequired("spec-hash")
	return cmd
}

func newNodeResolverHealthcheckCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "healthcheck",
		Short: "Print the resolver's stats and exit 0 when it listens and its servers answer",
		Long: "Read " + resolver.StatePath + ", print its stats as one line of JSON and exit 0 when the file is " +
			"fresh, the resolver listens and its upstream check passes; exit 1 otherwise.",
		Args: cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			line, err := resolver.Healthcheck(resolver.StatePath, time.Now())
			if line != nil {
				if _, werr := fmt.Fprintln(app.Stdout, string(line)); werr != nil && err == nil {
					err = werr
				}
			}
			if err != nil {
				return WithExit(1, err)
			}
			return nil
		},
	}
}

func newNodeResolverProbeCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "probe",
		Short: "Look up the resolver's probe name through the system resolver and print the result as JSON",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx, cancel := context.WithTimeout(cmd.Context(), probeTimeout)
			defer cancel()
			res := resolver.Probe(ctx, &net.Resolver{PreferGo: true})
			line, err := json.Marshal(res)
			if err != nil {
				return PlatformError(err)
			}
			_, err = fmt.Fprintln(app.Stdout, string(line))
			return err
		},
	}
}
