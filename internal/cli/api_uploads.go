package cli

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
)

// Uploaded list files: the input of the list template's scanConfig.upload (docs/api.md §4.9,
// docs/templates.md §9.2).

func init() {
	registerGroup("", "uploads", "Upload list files for scans of the list template", false)
	registerCommand("uploads", newUploadsCreateCommand)
	registerCommand("uploads", newUploadsListCommand)
	registerCommand("uploads", newUploadsGetCommand)
	registerCommand("uploads", newUploadsDeleteCommand)
}

func newUploadsCreateCommand(app *App) *cobra.Command {
	var name string
	cmd := &cobra.Command{
		Use:   "create <file>",
		Short: "Upload a newline-separated list file",
		Long: "Upload a newline-separated list file (- reads stdin). Every non-empty line, trimmed, becomes one " +
			"analysis of a list-template scan that references the upload by id in its scan config. Uploads are " +
			"content-addressed: uploading the same content again returns the existing upload.",
		Example: `  scantor uploads create domains.txt
  scantor scans start origins@latest --scan-config '{"upload": "<upload id>"}'`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			source := args[0]
			data := app.Stdin
			if source != "-" {
				f, err := os.Open(source) //nolint:gosec // the user names the file to upload
				if err != nil {
					return ValidationError(err)
				}
				defer f.Close()
				if info, err := f.Stat(); err != nil {
					return ValidationError(err)
				} else if info.IsDir() {
					return ValidationError(fmt.Errorf("%s is a directory", source))
				}
				data = f
				if name == "" {
					name = filepath.Base(source)
				}
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx, stop := InterruptContext(cmd.Context())
			defer stop()
			upload, err := client.CreateUpload(ctx, name, "text/plain", data)
			if err != nil {
				if ctx.Err() != nil {
					return Interrupted()
				}
				return err
			}
			return app.Output().Print(upload, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "uploaded %s (id %s, %d lines, %s)\nreference it in a scan config: {\"upload\": %q}\n",
					apiUploadName(upload), upload.ID, upload.Lines, HumanBytes(upload.Bytes), upload.ID)
				return err
			})
		},
	}
	cmd.Flags().StringVar(&name, "name", "", "display name (default: the file name)")
	return cmd
}

func apiUploadName(u *api.Upload) string {
	if u.Name == "" {
		return "-"
	}
	return u.Name
}

func newUploadsListCommand(app *App) *cobra.Command {
	var page api.PageQuery
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List uploaded files",
		Long:  "List your uploaded list files, newest first.",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := apiCheckLimit(page.Limit, 200); err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			list, err := client.ListUploads(cmd.Context(), page)
			if err != nil {
				return err
			}
			err = app.Output().Print(list, func(w io.Writer) error {
				t := Table{Headers: []string{"UPLOAD", "NAME", "LINES", "SIZE", "LAST USED", "CREATED"}}
				for i := range list.Items {
					u := &list.Items[i]
					t.Add(u.ID, apiUploadName(u), fmt.Sprintf("%d", u.Lines), HumanBytes(u.Bytes), apiTime(u.LastUsedAt), apiTimeValue(u.CreatedAt))
				}
				return t.Write(w)
			})
			if err == nil {
				apiPrintMore(app, list.NextCursor, "--cursor")
			}
			return err
		},
	}
	apiPageFlags(cmd, &page, 200)
	return cmd
}

func newUploadsGetCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "get <upload>",
		Short: "Show an uploaded file",
		Long:  "Show an uploaded list file: name, size, line count, SHA-256 and when a scan last used it.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			upload, err := client.GetUpload(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			return app.Output().Print(upload, func(w io.Writer) error {
				var kv apiKV
				kv.add("upload", upload.ID)
				kv.add("name", apiUploadName(upload))
				kv.add("kind", upload.Kind)
				kv.add("size", fmt.Sprintf("%d lines, %s (%s)", upload.Lines, HumanBytes(upload.Bytes), upload.ContentType))
				kv.add("sha256", upload.SHA256)
				kv.add("last used", apiTime(upload.LastUsedAt))
				kv.add("created", apiTimeValue(upload.CreatedAt))
				return kv.write(w)
			})
		},
	}
}

func newUploadsDeleteCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "delete <upload>",
		Short: "Delete an uploaded file",
		Long:  "Delete an uploaded list file. Fails while a scan references it.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			if err := client.DeleteUpload(cmd.Context(), args[0]); err != nil {
				return apiWithHint(err, api.CodeUploadInUse, "delete the scans that use it first")
			}
			return app.Output().Print(apiDeleted{ID: args[0], Deleted: true}, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "deleted upload %s\n", args[0])
				return err
			})
		},
	}
}
