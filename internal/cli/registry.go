// Package cli is the cobra command tree of the scantor binary: the user CLI, plus the hidden roles that
// share the binary (runtime, node daemon, task pipeline, workspace helpers, conformance, docs).
//
// # Adding a command
//
// Every command lives in its own file of this package and registers itself from init(); nothing edits
// root.go:
//
//	func init() { registerCommand("scans", newScansPauseCommand) }
//
//	func newScansPauseCommand(app *App) *cobra.Command {
//		return &cobra.Command{
//			Use:   "pause <scan>",
//			Short: "Pause a running scan",
//			Args:  cobra.ExactArgs(1),
//			RunE: func(cmd *cobra.Command, args []string) error {
//				client, err := app.APIClient()
//				if err != nil {
//					return err
//				}
//				scan, err := client.PauseScan(cmd.Context(), args[0])
//				if err != nil {
//					return err
//				}
//				return app.Output().Print(scan, func(w io.Writer) error { … })
//			},
//		}
//	}
//
// registerCommand(parent, build) attaches the command below the command path parent ("" is the root,
// "scans" or "dev" a group). Groups are declared once with registerGroup(parent, name, short, hidden),
// which is idempotent, so several files may declare the same group. Registration order does not matter:
// the tree is assembled when NewRootCommand runs. Hidden commands (runtime, conformance and docs,
// docs/development.md §6) set Hidden: true on their command. The root defines no PersistentPreRunE (the
// global -o flag validates itself while flags are parsed), so groups and commands may define their own.
//
// # What *App provides
//
//   - app.Output(): the -o human|json writer (Print, PrintJSON, Table, NDJSON, Infof, Warnf).
//   - app.Config(): the CLI configuration (LoadConfig, loaded once on first use).
//   - app.APIClient(): an api.Client for SCANTOR_URL/SCANTOR_TOKEN with the transport policy.
//   - app.Docker(): a Docker Engine client (DOCKER_HOST).
//   - app.Getenv: the environment reader to pass to other components' LoadConfig (runtime, node daemon);
//     no other code reads the environment.
//   - app.Logger(): a redacting slog logger on stderr.
//
// # Errors and exit codes
//
// Return errors; never call os.Exit. Wrap them with an exit class (UsageError, ValidationError,
// PlatformError, WithExit, SilentExit) or return errors that implement ExitClass() (api.Error,
// api.NetworkError). The root command prints the error once (human or JSON) and main exits with
// ExitCode(err): 0 ok, 1 analysis failures, 2 validation, 3 platform.
package cli

import (
	"fmt"
	"slices"
	"strings"
	"sync"

	"github.com/spf13/cobra"
)

// CommandBuilder builds one command for an App.
type CommandBuilder func(app *App) *cobra.Command

type registration struct {
	parent string
	build  CommandBuilder
}

type group struct {
	parent, name, short string
	hidden              bool
}

var (
	registryMu    sync.Mutex
	registrations []registration
	groups        []group
)

// registerCommand registers a command below the command path parent ("" = root, for example "scans" or
// "dev"). It is called from init() of the command's file.
func registerCommand(parent string, build CommandBuilder) {
	registryMu.Lock()
	defer registryMu.Unlock()
	registrations = append(registrations, registration{parent: normalisePath(parent), build: build})
}

// registerGroup declares a command group (a command whose only job is to hold subcommands). Declaring
// the same group again with the same parent is a no-op.
func registerGroup(parent, name, short string, hidden bool) {
	registryMu.Lock()
	defer registryMu.Unlock()
	parent = normalisePath(parent)
	for _, g := range groups {
		if g.parent == parent && g.name == name {
			return
		}
	}
	groups = append(groups, group{parent: parent, name: name, short: short, hidden: hidden})
}

func normalisePath(p string) string { return strings.Join(strings.Fields(p), " ") }

// attachCommands builds every registered group and command and attaches them below root.
func attachCommands(root *cobra.Command, app *App) error {
	registryMu.Lock()
	regs := slices.Clone(registrations)
	grps := slices.Clone(groups)
	registryMu.Unlock()

	byPath := map[string]*cobra.Command{"": root}
	// Groups may be nested; attach them parents first.
	slices.SortStableFunc(grps, func(a, b group) int { return len(strings.Fields(a.parent)) - len(strings.Fields(b.parent)) })
	for _, g := range grps {
		parent, ok := byPath[g.parent]
		if !ok {
			return fmt.Errorf("command group %q: unknown parent %q", g.name, g.parent)
		}
		cmd := newGroupCommand(g.name, g.short, g.hidden)
		parent.AddCommand(cmd)
		byPath[joinPath(g.parent, g.name)] = cmd
	}
	for _, r := range regs {
		parent, ok := byPath[r.parent]
		if !ok {
			return fmt.Errorf("command registered below unknown parent %q", r.parent)
		}
		cmd := r.build(app)
		if cmd == nil {
			return fmt.Errorf("command builder below %q returned nil", r.parent)
		}
		name := cmd.Name()
		for _, existing := range parent.Commands() {
			if existing.Name() == name {
				return fmt.Errorf("command %q registered twice below %q", name, r.parent)
			}
		}
		parent.AddCommand(cmd)
		byPath[joinPath(r.parent, name)] = cmd
	}
	return nil
}

func joinPath(parent, name string) string {
	if parent == "" {
		return name
	}
	return parent + " " + name
}

// newGroupCommand returns a command that only holds subcommands: without arguments it prints its help,
// an unknown subcommand is a usage error.
func newGroupCommand(name, short string, hidden bool) *cobra.Command {
	return &cobra.Command{
		Use:    name,
		Short:  short,
		Hidden: hidden,
		Args:   cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) > 0 {
				return UsageError(fmt.Errorf("unknown command %q for %q; run '%s --help'", args[0], cmd.CommandPath(), cmd.CommandPath()))
			}
			return cmd.Help()
		},
	}
}
