package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
)

func init() {
	registerGroup("", "nodes", "Manage the nodes that run workers (admins)", false)
	registerGroup("nodes", "token", "Rotate or revoke a node's token", false)
	for _, build := range []CommandBuilder{
		newNodesListCommand, newNodesCreateCommand, newNodesGetCommand, newNodesUpdateCommand,
		newNodesDeleteCommand, newNodesJoinCommand, newNodesWorkersCommand, newNodesEventsCommand,
	} {
		registerCommand("nodes", build)
	}
	registerCommand("nodes token", newNodesTokenRotateCommand)
	registerCommand("nodes token", newNodesTokenRevokeCommand)
}

const apiNodeArgHelp = "A node is addressed by its id or its name."

// apiResolveNode turns a node name into its id; ids pass through unchanged.
func apiResolveNode(ctx context.Context, client *api.Client, ref string) (string, error) {
	if apiIsUUID(ref) {
		return ref, nil
	}
	nodes, err := client.ListNodes(ctx, "", "")
	if err != nil {
		return "", err
	}
	for _, n := range nodes {
		if n.Name == ref {
			return n.ID, nil
		}
	}
	return "", ValidationError(fmt.Errorf("node %q not found", ref))
}

func newNodesListCommand(app *App) *cobra.Command {
	var state, pool string
	cmd := &cobra.Command{
		Use:     "list",
		Short:   "List nodes",
		Long:    "List every node with its state, pool, architecture, worker usage and last heartbeat. Admins only.",
		Example: "  scantor nodes list --state online",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			nodes, err := client.ListNodes(cmd.Context(), state, pool)
			if err != nil {
				return err
			}
			now := time.Now()
			return app.Output().Print(api.List[api.Node]{Items: nodes}, func(w io.Writer) error {
				t := Table{Headers: []string{"NAME", "STATE", "POOL", "ARCH", "WORKERS", "CORDONED", "LAST SEEN", "ID"}}
				for _, n := range nodes {
					arch := "-"
					if n.Info != nil {
						arch = n.Info.Arch
					}
					t.Add(n.Name, n.State, n.Pool, arch, apiNodeWorkers(n), apiYesNo(n.Cordoned), HumanAge(n.LastSeenAt, now), n.ID)
				}
				return t.Write(w)
			})
		},
	}
	cmd.Flags().StringVar(&state, "state", "", "only nodes in this state (pending, online, offline, revoked)")
	cmd.Flags().StringVar(&pool, "pool", "", "only nodes of this pool")
	return cmd
}

// apiNodeWorkers renders "active/max" with the effective worker cap.
func apiNodeWorkers(n api.Node) string {
	limit := "-"
	switch {
	case n.MaxWorkers != nil:
		limit = fmt.Sprintf("%d", *n.MaxWorkers)
	case n.Info != nil && n.Info.MaxWorkers > 0:
		limit = fmt.Sprintf("%d", n.Info.MaxWorkers)
	}
	return fmt.Sprintf("%d/%s", n.ActiveWorkers, limit)
}

func newNodesCreateCommand(app *App) *cobra.Command {
	var body api.CreateNode
	var labels []string
	var maxWorkers int
	cmd := &cobra.Command{
		Use:   "create <name>",
		Short: "Create a remote node and print its token and join command",
		Long: "Create a remote node record and print its node token (shown only once) with a docker run command " +
			"and a Docker Compose file that start the node daemon on the node host. The node stays pending until " +
			"its daemon says hello. Admins only.",
		Example: `  scantor nodes create scan-eu-1 --pool remote --label region=eu --max-workers 8`,
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body.Name = args[0]
			var err error
			if body.Labels, err = apiParseLabels(labels); err != nil {
				return err
			}
			if cmd.Flags().Changed("max-workers") {
				if maxWorkers < 0 {
					return UsageError(errors.New("--max-workers must not be negative"))
				}
				body.MaxWorkers = &maxWorkers
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			res, err := client.CreateNode(cmd.Context(), body)
			if err != nil {
				return err
			}
			return app.Output().Print(res, func(w io.Writer) error {
				return apiWriteNodeToken(w, fmt.Sprintf("created node %s (id %s, pool %s, %s)", res.Node.Name, res.Node.ID, res.Node.Pool, res.Node.State), res)
			})
		},
	}
	cmd.Flags().StringVar(&body.Pool, "pool", "", `node pool scans select with nodeSelector.pool (server default "shared")`)
	cmd.Flags().StringArrayVar(&labels, "label", nil, "label key=value (repeatable)")
	cmd.Flags().IntVar(&maxWorkers, "max-workers", 0, "maximum number of workers on the node (default: what the daemon reports)")
	return cmd
}

// apiParseLabels parses repeated key=value flags.
func apiParseLabels(values []string) (map[string]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	labels := make(map[string]string, len(values))
	for _, v := range values {
		key, value, ok := strings.Cut(v, "=")
		if !ok || key == "" {
			return nil, UsageError(fmt.Errorf("invalid label %q: use key=value", v))
		}
		labels[key] = value
	}
	return labels, nil
}

// apiWriteNodeToken prints a node token (shown once) and the join snippets.
func apiWriteNodeToken(w io.Writer, headline string, res *api.NodeWithToken) error {
	_, err := fmt.Fprintf(w, "%s\n\nNode token (shown only once; store it now):\n\n  %s\n\n", headline, res.Token)
	if err != nil {
		return err
	}
	return apiWriteJoin(w, res.Join)
}

func apiWriteJoin(w io.Writer, join api.NodeJoin) error {
	_, err := fmt.Fprintf(w, "Start the node daemon on the node host:\n\n  %s\n\nOr with Docker Compose (save as compose.yml in an empty directory, then run docker compose up -d):\n\n%s",
		join.DockerRun, join.Compose)
	if err == nil && !strings.HasSuffix(join.Compose, "\n") {
		_, err = fmt.Fprintln(w)
	}
	return err
}

func newNodesGetCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:     "get <node>",
		Short:   "Show a node",
		Long:    "Show a node: state, endpoint profile, pool, labels, reported host info and instance lease. " + apiNodeArgHelp,
		Example: "  scantor nodes get scan-eu-1",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			id, err := apiResolveNode(cmd.Context(), client, args[0])
			if err != nil {
				return err
			}
			node, err := client.GetNode(cmd.Context(), id)
			if err != nil {
				return err
			}
			return app.Output().Print(node, func(w io.Writer) error { return apiWriteNode(w, node) })
		},
	}
}

func apiWriteNode(w io.Writer, n *api.Node) error {
	var kv apiKV
	kv.add("node", n.Name)
	kv.add("id", n.ID)
	state := n.State
	if n.Cordoned {
		state += ", cordoned"
	}
	if n.BuiltIn {
		state += ", built-in"
	}
	kv.add("state", state)
	kv.add("profile", n.EndpointProfile)
	kv.add("pool", n.Pool)
	if len(n.Labels) > 0 {
		pairs := make([]string, 0, len(n.Labels))
		for k, v := range n.Labels {
			pairs = append(pairs, k+"="+v)
		}
		sort.Strings(pairs)
		kv.add("labels", strings.Join(pairs, ", "))
	}
	kv.add("workers", apiNodeWorkers(*n))
	if i := n.Info; i != nil {
		kv.add("host", fmt.Sprintf("%s (%s/%s, kernel %s, Docker %s)", i.Hostname, i.OS, i.Arch, i.Kernel, i.DockerVersion))
		kv.add("resources", fmt.Sprintf("%d CPUs, %s memory, %s free disk", i.CPUs, HumanBytes(i.MemoryBytes), HumanBytes(i.DiskFreeBytes)))
		egress := "applied"
		if !i.EgressDenyApplied {
			egress = "not applied"
		}
		kv.add("daemon", fmt.Sprintf("%s, DinD %s, egress deny list %s", i.Version, i.DinDMode, egress))
	}
	kv.add("token", n.TokenPrefix)
	kv.add("last seen", apiTime(n.LastSeenAt))
	kv.add("created", apiTimeValue(n.CreatedAt))
	return kv.write(w)
}

func newNodesUpdateCommand(app *App) *cobra.Command {
	var name, pool string
	var labels []string
	var noMaxWorkers, clearLabels, cordoned bool
	var maxWorkers int
	cmd := &cobra.Command{
		Use:   "update <node>",
		Short: "Change a node's name, pool, labels, worker cap or cordon",
		Long: "Change a node. --label replaces all labels (repeat it for several); --clear-labels removes them all. " +
			"--cordoned stops new workers from being placed on the node (--cordoned=false lifts it); running " +
			"workers stay. " + apiNodeArgHelp,
		Example: `  scantor nodes update scan-eu-1 --cordoned
  scantor nodes update scan-eu-1 --pool remote --label region=eu --label gpu=false --no-max-workers`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			f := cmd.Flags()
			var body api.UpdateNode
			if f.Changed("name") {
				body.Name = &name
			}
			if f.Changed("pool") {
				body.Pool = &pool
			}
			var err error
			if body.Labels, err = apiParseLabels(labels); err != nil {
				return err
			}
			if clearLabels {
				if len(labels) > 0 {
					return UsageError(errors.New("--label and --clear-labels exclude each other"))
				}
				body.ClearLabels = true
			}
			switch {
			case noMaxWorkers && f.Changed("max-workers"):
				return UsageError(errors.New("--max-workers and --no-max-workers exclude each other"))
			case noMaxWorkers:
				body.ClearMaxWorkers = true
			case f.Changed("max-workers"):
				if maxWorkers < 0 {
					return UsageError(errors.New("--max-workers must not be negative"))
				}
				body.MaxWorkers = &maxWorkers
			}
			if f.Changed("cordoned") {
				body.Cordoned = &cordoned
			}
			if body.Name == nil && body.Pool == nil && body.Labels == nil && !body.ClearLabels && body.MaxWorkers == nil && !body.ClearMaxWorkers && body.Cordoned == nil {
				return UsageError(errors.New("nothing to change: give at least one flag"))
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			id, err := apiResolveNode(cmd.Context(), client, args[0])
			if err != nil {
				return err
			}
			node, err := client.UpdateNode(cmd.Context(), id, body)
			if err != nil {
				return err
			}
			return app.Output().Print(node, func(w io.Writer) error { return apiWriteNode(w, node) })
		},
	}
	cmd.Flags().StringVar(&name, "name", "", "new name")
	cmd.Flags().StringVar(&pool, "pool", "", "new pool")
	cmd.Flags().StringArrayVar(&labels, "label", nil, "label key=value; replaces all labels (repeatable)")
	cmd.Flags().BoolVar(&clearLabels, "clear-labels", false, "remove every label")
	cmd.Flags().IntVar(&maxWorkers, "max-workers", 0, "maximum number of workers on the node")
	cmd.Flags().BoolVar(&noMaxWorkers, "no-max-workers", false, "use the worker cap the daemon reports")
	cmd.Flags().BoolVar(&cordoned, "cordoned", false, "stop placing new workers on the node")
	return cmd
}

func newNodesDeleteCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "delete <node>",
		Short: "Delete a node",
		Long: "Delete a node: its token is revoked, its workers become lost and are replaced elsewhere, and the " +
			"record is removed. The built-in node cannot be deleted. " + apiNodeArgHelp,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			id, err := apiResolveNode(cmd.Context(), client, args[0])
			if err != nil {
				return err
			}
			if err := client.DeleteNode(cmd.Context(), id); err != nil {
				return err
			}
			return app.Output().Print(apiDeleted{ID: id, Deleted: true}, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "deleted node %s\n", args[0])
				return err
			})
		},
	}
}

func newNodesTokenRotateCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "rotate <node>",
		Short: "Replace a node's token",
		Long: "Replace a node's token and print the new one (shown only once) with the join command. The running " +
			"daemon is rejected from then on until it is restarted with the new token; a revoked node becomes " +
			"pending again. Not allowed for the built-in node. " + apiNodeArgHelp,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			id, err := apiResolveNode(cmd.Context(), client, args[0])
			if err != nil {
				return err
			}
			res, err := client.RotateNodeToken(cmd.Context(), id)
			if err != nil {
				return err
			}
			return app.Output().Print(res, func(w io.Writer) error {
				return apiWriteNodeToken(w, fmt.Sprintf("rotated the token of node %s", res.Node.Name), res)
			})
		},
	}
}

func newNodesTokenRevokeCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "revoke <node>",
		Short: "Revoke a node's token",
		Long: "Revoke a node's token: the node becomes revoked, its workers become lost immediately and registry " +
			"pulls are denied. Rotate the token to bring it back. Not allowed for the built-in node. " + apiNodeArgHelp,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			id, err := apiResolveNode(cmd.Context(), client, args[0])
			if err != nil {
				return err
			}
			node, err := client.RevokeNodeToken(cmd.Context(), id)
			if err != nil {
				return err
			}
			return app.Output().Print(node, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "revoked the token of node %s (%s)\n", node.Name, node.State)
				return err
			})
		},
	}
}

func newNodesJoinCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "join <node>",
		Short: "Print the commands that start a node's daemon",
		Long: "Print the docker run command and the Docker Compose file that start the node daemon of a node, with " +
			"the token replaced by ${SCANTOR_NODE_TOKEN} (the token itself is only shown when the node is created " +
			"or its token rotated). " + apiNodeArgHelp,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			id, err := apiResolveNode(cmd.Context(), client, args[0])
			if err != nil {
				return err
			}
			join, err := client.GetNodeJoin(cmd.Context(), id)
			if err != nil {
				return err
			}
			return app.Output().Print(join, func(w io.Writer) error { return apiWriteJoin(w, *join) })
		},
	}
}

func newNodesWorkersCommand(app *App) *cobra.Command {
	var states []string
	var page api.PageQuery
	cmd := &cobra.Command{
		Use:     "workers <node>",
		Short:   "List the workers placed on a node",
		Long:    "List the workers whose node is this node, with their scan, role and state. " + apiNodeArgHelp,
		Example: "  scantor nodes workers scan-eu-1 --state running",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := apiCheckLimit(page.Limit, 200); err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			id, err := apiResolveNode(cmd.Context(), client, args[0])
			if err != nil {
				return err
			}
			list, err := client.ListNodeWorkers(cmd.Context(), id, states, page)
			if err != nil {
				return err
			}
			err = app.Output().Print(list, func(w io.Writer) error { return apiWorkersTable(list.Items).Write(w) })
			if err == nil {
				apiPrintMore(app, list.NextCursor, "--cursor")
			}
			return err
		},
	}
	cmd.Flags().StringSliceVar(&states, "state", nil, "only workers in these states (comma-separated)")
	apiPageFlags(cmd, &page, 200)
	return cmd
}

func newNodesEventsCommand(app *App) *cobra.Command {
	var eventType string
	var page api.PageQuery
	cmd := &cobra.Command{
		Use:   "events <node>",
		Short: "List the timeline of a node",
		Long:  "List the events of a node, newest first: hellos, state changes, lost workers and more. " + apiNodeArgHelp,
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := apiCheckLimit(page.Limit, 200); err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			id, err := apiResolveNode(cmd.Context(), client, args[0])
			if err != nil {
				return err
			}
			list, err := client.ListNodeEvents(cmd.Context(), id, eventType, page)
			if err != nil {
				return err
			}
			err = app.Output().Print(list, func(w io.Writer) error {
				t := Table{Headers: []string{"AT", "LEVEL", "TYPE", "MESSAGE"}}
				for _, e := range list.Items {
					t.Add(apiTimeValue(e.At), e.Level, e.Type, e.Message)
				}
				return t.Write(w)
			})
			if err == nil {
				apiPrintMore(app, list.NextCursor, "--cursor")
			}
			return err
		},
	}
	cmd.Flags().StringVar(&eventType, "type", "", "only events of this type")
	apiPageFlags(cmd, &page, 200)
	return cmd
}
