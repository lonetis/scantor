package cli

import (
	"fmt"
	"io"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/version"
)

func init() { registerCommand("", newVersionCommand) }

func newVersionCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print the scantor version",
		Long:  "Print the version, commit and image prefix this binary was built with.",
		Args:  cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			info := version.Current()
			return app.Output().Print(info, func(w io.Writer) error {
				commit := info.Commit
				if commit == "" {
					commit = "unknown"
				}
				prefix := info.ImagePrefix
				if prefix == "" {
					prefix = "(local images)"
				}
				_, err := fmt.Fprintf(w, "scantor %s\ncommit:       %s\nimage prefix: %s\ngo:           %s\nplatform:     %s/%s\n",
					info.Version, commit, prefix, info.Go, info.OS, info.Arch)
				return err
			})
		},
	}
}
