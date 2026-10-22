package cli

import (
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
)

func init() {
	registerCommand("", newWhoamiCommand)
	registerCommand("", newInstanceCommand)
}

// apiWhoami is the output of `scantor whoami`: the orchestrator URL and the account of SCANTOR_TOKEN.
type apiWhoami struct {
	URL string `json:"url"`
	api.Account
}

func newWhoamiCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "whoami",
		Short: "Show the account of SCANTOR_TOKEN",
		Long: "Show which orchestrator the CLI talks to (SCANTOR_URL) and the account the API key in " +
			"SCANTOR_TOKEN belongs to. Useful to check the CLI configuration.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			account, err := client.GetAccount(cmd.Context())
			if err != nil {
				return err
			}
			res := apiWhoami{URL: client.BaseURL(), Account: *account}
			return app.Output().Print(res, func(w io.Writer) error {
				var kv apiKV
				kv.add("url", res.URL)
				kv.add("user", fmt.Sprintf("%s <%s>", account.Name, account.Email))
				kv.add("id", account.ID)
				kv.add("role", account.Role)
				kv.add("privileged", apiYesNo(account.CanRunPrivileged))
				kv.add("max workers", fmt.Sprintf("%d", account.MaxWorkers))
				return kv.write(w)
			})
		},
	}
}

func newInstanceCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "instance",
		Short: "Show the orchestrator's version, URLs, features and limits",
		Long: "Show the version of the orchestrator at SCANTOR_URL, its public, editor and MCP URLs, the CLI " +
			"image, the enabled features and the instance limits (maximum workers per scan, processes per " +
			"worker, result and file sizes, the scan confirmation threshold).",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			info, err := client.GetInstanceInfo(cmd.Context())
			if err != nil {
				return err
			}
			return app.Output().Print(info, func(w io.Writer) error {
				var kv apiKV
				kv.add("version", info.Version)
				kv.add("public url", info.PublicURL)
				kv.add("editor url", info.EditorURL)
				kv.add("mcp url", apiDeref(info.MCPURL))
				kv.add("registry", info.RegistryPublicHost)
				kv.add("cli image", info.CLIImage)
				var features []string
				for _, f := range []struct {
					name string
					on   bool
				}{{"editor", info.Features.Editor}, {"mcp", info.Features.MCP}, {"mcpOAuth", info.Features.MCPOAuth}, {"passkeys", info.Features.Passkeys}} {
					if f.on {
						features = append(features, f.name)
					}
				}
				kv.add("features", strings.Join(features, ", "))
				l := info.Limits
				kv.add("limits", fmt.Sprintf("%d workers per scan, %d processes per worker, results ≤ %s, files ≤ %s, confirm above %d analyses",
					l.MaxWorkersPerScan, l.MaxProcessesPerWorker, HumanBytes(l.MaxResultBytes), HumanBytes(l.MaxFileBytes), l.ScanConfirmThreshold))
				kv.add("you", fmt.Sprintf("%s (%s)", info.User.ID, info.User.Role))
				return kv.write(w)
			})
		},
	}
}
