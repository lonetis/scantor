package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
)

func init() {
	registerCommand("", newExportCommand)
	registerGroup("", "exports", "Manage background exports of scan results", false)
	registerCommand("exports", newExportsListCommand)
	registerCommand("exports", newExportsGetCommand)
	registerCommand("exports", newExportsDeleteCommand)
}

type apiExportOptions struct {
	format     string
	statuses   []string
	filter     string
	fields     []string
	afterSeq   int64
	background bool
	wait       apiWaitOptions
	target     apiOutputTarget
}

func newExportCommand(app *App) *cobra.Command {
	var o apiExportOptions
	cmd := &cobra.Command{
		Use:   "export <scan>",
		Short: "Export the analyses of a scan as JSONL or CSV",
		Long: "Export the analyses of a scan, sorted by seq, as JSON Lines (whole analysis documents or the --fields " +
			"projection) or CSV. Secret config values are masked.\n\n" +
			"By default the export streams directly to --file or stdout; this works up to the instance's inline " +
			"limit. Larger exports run in the background with --background: the command prints the export, or " +
			"with --wait (implied by --file) waits until it is ready and downloads it. Background exports are kept " +
			"for a limited time; see 'scantor exports'.",
		Example: `  scantor export 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f > results.jsonl
  scantor export 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --format csv --status succeeded --fields seq,config,result --file results.csv
  scantor export 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --background --file results.jsonl`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if o.format != api.ExportJSONL && o.format != api.ExportCSV {
				return UsageError(fmt.Errorf("--format must be %s or %s", api.ExportJSONL, api.ExportCSV))
			}
			if err := o.wait.validate(); err != nil {
				return err
			}
			if !o.background && (o.wait.wait || o.wait.timeout > 0) {
				return UsageError(errors.New("--wait and --timeout need --background"))
			}
			filter, err := newAPIInputs(app).object("--filter", o.filter)
			if err != nil {
				return err
			}
			var afterSeq *int64
			if cmd.Flags().Changed("after-seq") {
				afterSeq = &o.afterSeq
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx, stop := InterruptContext(cmd.Context())
			defer stop()
			if o.background {
				return o.runBackground(ctx, app, client, args[0], filter, afterSeq)
			}
			return o.runInline(ctx, app, client, args[0], filter, afterSeq)
		},
	}
	f := cmd.Flags()
	f.StringVar(&o.format, "format", api.ExportJSONL, "jsonl or csv")
	f.StringSliceVar(&o.statuses, "status", nil, "only analyses with these statuses (comma-separated)")
	f.StringVar(&o.filter, "filter", "", "MongoDB filter (JSON object, @file or -)")
	f.StringSliceVar(&o.fields, "fields", nil, "fields to export (dot paths, comma-separated; CSV columns)")
	f.Int64Var(&o.afterSeq, "after-seq", 0, "start after this seq")
	f.BoolVar(&o.background, "background", false, "run the export as a background job (for large scans)")
	apiWaitFlags(cmd, &o.wait, "the background export is ready (implied by --file)")
	apiOutputFlags(cmd, &o.target, "the export")
	return cmd
}

// runInline streams exportScanInline to the target (stdout by default).
func (o *apiExportOptions) runInline(ctx context.Context, app *App, client *api.Client, scanID string, filter json.RawMessage, afterSeq *int64) error {
	body, err := client.ExportScanInline(ctx, scanID, api.ExportInlineQuery{
		Format: o.format, Statuses: o.statuses, Filter: filter, Fields: o.fields, AfterSeq: afterSeq,
	})
	if err != nil {
		if ctx.Err() != nil {
			return Interrupted()
		}
		return apiWithHint(err, api.CodeExportTooLarge, "use --background")
	}
	defer body.Close()
	target := o.target
	if target.path == "" {
		target.path = "-"
	}
	saved, err := target.write(app, body, apiExpect{})
	if err != nil {
		if ctx.Err() != nil {
			return Interrupted()
		}
		return err
	}
	return apiPrintSaved(app, saved)
}

// runBackground creates an export job; with --wait or --file it waits and downloads.
func (o *apiExportOptions) runBackground(ctx context.Context, app *App, client *api.Client, scanID string, filter json.RawMessage, afterSeq *int64) error {
	if len(o.statuses) > 0 {
		// exportScan has no status parameter; the same restriction is expressed as a filter.
		statusFilter, err := json.Marshal(map[string]any{"status": map[string]any{"$in": o.statuses}})
		if err != nil {
			return PlatformError(err)
		}
		if filter == nil {
			filter = statusFilter
		} else {
			filter = json.RawMessage(fmt.Sprintf(`{"$and":[%s,%s]}`, filter, statusFilter))
		}
	}
	export, err := client.ExportScan(ctx, scanID, api.ExportScan{Format: o.format, Filter: filter, Fields: o.fields, AfterSeq: afterSeq}, 0)
	if err != nil {
		return err
	}
	return apiFinishExport(ctx, app, client, export, o.wait.wait || o.target.path != "", o.wait.timeout, o.target)
}

// apiFinishExport prints an export, or waits until it is ready, downloads it to target (when set) and
// prints the result. A failed export is a platform error.
func apiFinishExport(ctx context.Context, app *App, client *api.Client, export *api.Export, wait bool, timeout time.Duration, target apiOutputTarget) error {
	out := app.Output()
	if wait && !export.Settled() {
		if !out.JSON() {
			out.Infof("export %s is %s; waiting…", export.ID, export.State)
		}
		var err error
		export, err = apiPollUntil(ctx, timeout, "export "+export.ID, func(ctx context.Context, wait int) (*api.Export, bool, error) {
			e, err := client.GetExport(ctx, export.ID, wait)
			if err != nil {
				return nil, false, err
			}
			return e, e.Settled(), nil
		})
		if err != nil {
			return err
		}
	}
	if export.State == api.ExportFailed {
		if err := out.Print(export, func(w io.Writer) error { return apiWriteExport(w, export) }); err != nil {
			return err
		}
		msg := "export " + export.ID + " failed"
		if export.Error != nil {
			msg += fmt.Sprintf(": %s (%s)", export.Error.Message, export.Error.Code)
		}
		return PlatformError(errors.New(msg))
	}
	if target.path == "" || export.State != api.ExportReady {
		return out.Print(export, func(w io.Writer) error { return apiWriteExport(w, export) })
	}
	if export.Download == nil || export.Download.URL == "" {
		return PlatformError(fmt.Errorf("export %s is ready but has no download URL", export.ID))
	}
	saved, err := apiDownload(ctx, app, client, export.Download.URL, target, apiExpect{size: export.Bytes})
	if err != nil {
		return err
	}
	return apiPrintSaved(app, saved)
}

// apiPrintSaved reports a written file: nothing for stdout, the path, size and digest otherwise.
func apiPrintSaved(app *App, saved *apiSavedFile) error {
	if saved.Path == "-" {
		return nil
	}
	return app.Output().Print(saved, func(w io.Writer) error {
		_, err := fmt.Fprintf(w, "saved %s (%s, sha256 %s)\n", saved.Path, HumanBytes(saved.Bytes), saved.SHA256)
		return err
	})
}

func apiWriteExport(w io.Writer, e *api.Export) error {
	var kv apiKV
	kv.add("export", e.ID)
	kv.add("scan", e.ScanID)
	kv.add("format", e.Format)
	kv.add("state", e.State)
	if e.State == api.ExportReady {
		kv.add("size", fmt.Sprintf("%d rows, %s", e.Rows, HumanBytes(e.Bytes)))
	}
	if e.Error != nil {
		kv.add("error", fmt.Sprintf("%s (%s)", e.Error.Message, e.Error.Code))
	}
	if e.Download != nil {
		kv.add("download", e.Download.URL)
		kv.add("link expires", apiTimeValue(e.Download.ExpiresAt))
	}
	kv.add("created", apiTimeValue(e.CreatedAt))
	kv.add("expires", apiTimeValue(e.ExpiresAt))
	return kv.write(w)
}

func newExportsListCommand(app *App) *cobra.Command {
	var scanID string
	var page api.PageQuery
	cmd := &cobra.Command{
		Use:     "list",
		Short:   "List background exports",
		Long:    "List your background exports, newest first.",
		Example: "  scantor exports list --scan 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := apiCheckLimit(page.Limit, 200); err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			list, err := client.ListExports(cmd.Context(), scanID, page)
			if err != nil {
				return err
			}
			err = app.Output().Print(list, func(w io.Writer) error {
				t := Table{Headers: []string{"EXPORT", "SCAN", "FORMAT", "STATE", "ROWS", "SIZE", "CREATED"}}
				for _, e := range list.Items {
					t.Add(e.ID, apiShortID(e.ScanID), e.Format, e.State, fmt.Sprintf("%d", e.Rows), HumanBytes(e.Bytes), apiTimeValue(e.CreatedAt))
				}
				return t.Write(w)
			})
			if err == nil {
				apiPrintMore(app, list.NextCursor, "--cursor")
			}
			return err
		},
	}
	cmd.Flags().StringVar(&scanID, "scan", "", "only exports of this scan")
	apiPageFlags(cmd, &page, 200)
	return cmd
}

func newExportsGetCommand(app *App) *cobra.Command {
	var wait apiWaitOptions
	var target apiOutputTarget
	cmd := &cobra.Command{
		Use:   "get <export>",
		Short: "Show or download a background export",
		Long: "Show a background export. With --wait the command waits until it is ready or failed; with --file " +
			"it also downloads the export (implies --wait).",
		Example: "  scantor exports get 8c1f6d0e-2a3b-4c5d-8e9f-0a1b2c3d4e5f --file results.jsonl",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := wait.validate(); err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx, stop := InterruptContext(cmd.Context())
			defer stop()
			export, err := client.GetExport(ctx, args[0], 0)
			if err != nil {
				return err
			}
			return apiFinishExport(ctx, app, client, export, wait.wait || target.path != "", wait.timeout, target)
		},
	}
	apiWaitFlags(cmd, &wait, "the export is ready or failed")
	apiOutputFlags(cmd, &target, "the export")
	return cmd
}

func newExportsDeleteCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "delete <export>",
		Short: "Delete a background export",
		Long:  "Delete a background export and its file before it expires.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			if err := client.DeleteExport(cmd.Context(), args[0]); err != nil {
				return err
			}
			return app.Output().Print(apiDeleted{ID: args[0], Deleted: true}, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "deleted export %s\n", args[0])
				return err
			})
		},
	}
}
