package cli

import "github.com/spf13/cobra"

func init() {
	registerGroup("", "files", "Download the files attached to analyses", false)
	registerCommand("files", newFilesGetCommand)
}

func newFilesGetCommand(app *App) *cobra.Command {
	var target apiOutputTarget
	cmd := &cobra.Command{
		Use:   "get <analysis> <file>",
		Short: "Download a file of an analysis",
		Long: "Download a file attached to an analysis (addressed as <scanId>-<seq>) by its file id, as listed by " +
			"'scantor analyses get'. The file is saved under its recorded name in the current directory unless " +
			"--file names another path (- writes to stdout). Size and SHA-256 are verified; an existing file is " +
			"only replaced with --force.",
		Example: `  scantor files get 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f-42 0c2d8a7b-4c3d-4e1f-9a3b-4c5d6e7f5e1f
  scantor files get 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f-42 0c2d8a7b-4c3d-4e1f-9a3b-4c5d6e7f5e1f --file - | less`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx, stop := InterruptContext(cmd.Context())
			defer stop()
			dl, err := client.GetFileDownload(ctx, args[0], args[1])
			if err != nil {
				return err
			}
			if target.path == "" {
				target.path = apiSafeFileName(dl.Name, args[1])
			}
			saved, err := apiDownload(ctx, app, client, dl.URL, target, apiExpect{size: dl.Size, sha256: dl.SHA256})
			if err != nil {
				return err
			}
			return apiPrintSaved(app, saved)
		},
	}
	apiOutputFlags(cmd, &target, "the file")
	return cmd
}
