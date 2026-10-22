package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
)

func init() {
	registerGroup("", "analyses", "Inspect and query the analyses of a scan", false)
	registerCommand("analyses", newAnalysesListCommand)
	registerCommand("analyses", newAnalysesGetCommand)
	registerCommand("analyses", newAnalysesQueryCommand)
	registerCommand("analyses", newAnalysesAggregateCommand)
}

const apiQueryHelp = "Filters, projections, sorts and pipelines are MongoDB documents given inline, as @file or as - " +
	"(stdin); they always apply to this scan only. Operators that execute code or read other collections " +
	"($where, $function, $lookup, $out, …) are rejected."

func newAnalysesListCommand(app *App) *cobra.Command {
	var query api.ListAnalysesQuery
	var afterSeq int64
	cmd := &cobra.Command{
		Use:   "list <scan>",
		Short: "List the analyses of a scan by seq",
		Long: "List the analyses of a scan in schedule order (seq ascending). Resume a listing with --after-seq " +
			"(the last seq printed). --fields limits the returned fields to dot paths.",
		Example: `  scantor analyses list 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --status failed
  scantor analyses list 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --after-seq 999 --limit 1000 -o json`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := apiCheckLimit(query.Limit, 1000); err != nil {
				return err
			}
			if cmd.Flags().Changed("after-seq") {
				query.AfterSeq = &afterSeq
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			page, err := client.ListAnalyses(cmd.Context(), args[0], query)
			if err != nil {
				return err
			}
			err = app.Output().Print(page, func(w io.Writer) error {
				t := Table{Headers: []string{"SEQ", "STATUS", "ATTEMPT", "ROUND", "DURATION", "ERROR"}}
				for _, a := range page.Items {
					duration := "-"
					if a.Timings != nil && a.Timings.DurationMs > 0 {
						duration = HumanDuration(a.Timings.DurationMs)
					}
					errText := ""
					if a.Error != nil {
						errText = apiTruncate(string(a.Error.Type)+": "+a.Error.Message, 80)
					}
					t.Add(fmt.Sprintf("%d", a.Seq), a.Status, fmt.Sprintf("%d", a.Attempt), fmt.Sprintf("%d", a.Round), duration, errText)
				}
				return t.Write(w)
			})
			if err == nil {
				apiPrintMore(app, page.NextCursor, "--after-seq")
			}
			return err
		},
	}
	cmd.Flags().StringSliceVar(&query.Statuses, "status", nil, "only analyses with these statuses (pending, retrying, succeeded, failed, lost, cancelled)")
	cmd.Flags().Int64Var(&afterSeq, "after-seq", 0, "start after this seq")
	cmd.Flags().IntVar(&query.Limit, "limit", 0, "maximum number of analyses (server default 50, max 1000)")
	cmd.Flags().StringSliceVar(&query.Fields, "fields", nil, "return only these fields (dot paths, comma-separated)")
	return cmd
}

func newAnalysesGetCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "get <analysis>",
		Short: "Show one analysis",
		Long: "Show one analysis, addressed as <scanId>-<seq>: status, config, result, error, attempts, files and " +
			"log tail. Download its files with 'scantor files get'.",
		Example: "  scantor analyses get 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f-42",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			a, err := client.GetAnalysis(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			return app.Output().Print(a, func(w io.Writer) error { return apiWriteAnalysis(w, a) })
		},
	}
}

func apiWriteAnalysis(w io.Writer, a *api.Analysis) error {
	var kv apiKV
	kv.add("analysis", a.ID)
	kv.add("status", a.Status)
	kv.add("attempt", fmt.Sprintf("%d (round %d)", a.Attempt, a.Round))
	if a.Timings != nil {
		kv.add("started", apiTime(a.Timings.StartedAt))
		kv.add("duration", HumanDuration(a.Timings.DurationMs))
	}
	if a.WorkerID != "" {
		kv.add("worker", a.WorkerID)
	}
	kv.add("config", apiIndentJSON(a.Config))
	kv.add("result", apiIndentJSON(a.Result))
	if e := a.Error; e != nil {
		retry := "not retryable"
		if e.Retryable {
			retry = "retryable"
		}
		kv.add("error", fmt.Sprintf("%s in %s (attempt %d, %s): %s", e.Type, e.Phase, e.Attempt, retry, e.Message))
	}
	if err := kv.write(w); err != nil {
		return err
	}
	if len(a.Files) > 0 {
		t := Table{Headers: []string{"FILE", "NAME", "SIZE", "TYPE"}}
		for _, f := range a.Files {
			t.Add(f.ID, f.Name, HumanBytes(f.Size), f.ContentType)
		}
		if _, err := fmt.Fprintln(w, "files:"); err != nil {
			return err
		}
		if err := t.Write(w); err != nil {
			return err
		}
	}
	if len(a.Attempts) > 1 {
		if _, err := fmt.Fprintln(w, "attempts:"); err != nil {
			return err
		}
		for _, at := range a.Attempts {
			outcome := "succeeded"
			if at.Error != nil {
				outcome = fmt.Sprintf("%s: %s", at.Error.Type, apiTruncate(at.Error.Message, 100))
			}
			if _, err := fmt.Fprintf(w, "  #%d %s %s\n", at.Attempt, HumanDuration(at.DurationMs), outcome); err != nil {
				return err
			}
		}
	}
	if a.LogTail != "" {
		if _, err := fmt.Fprintf(w, "log tail:\n%s", a.LogTail); err != nil {
			return err
		}
		if !strings.HasSuffix(a.LogTail, "\n") {
			_, err := fmt.Fprintln(w)
			return err
		}
	}
	return nil
}

// apiIndentJSON renders a JSON value indented for detail views; empty for absent values.
func apiIndentJSON(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var buf bytes.Buffer
	if err := json.Indent(&buf, raw, "", "  "); err != nil {
		return string(raw)
	}
	return buf.String()
}

func newAnalysesQueryCommand(app *App) *cobra.Command {
	var filter, projection, sort string
	var limit int
	var afterSeq int64
	cmd := &cobra.Command{
		Use:   "query <scan>",
		Short: "Query the analyses of a scan with a MongoDB filter",
		Long: "Find analyses of a scan with a MongoDB filter, optionally with a projection and a sort. Results are " +
			"sorted by seq unless --sort is given; continue an unsorted query with --after-seq (the cursor it " +
			"printed). Humans get one compact JSON document per line. " + apiQueryHelp,
		Example: `  scantor analyses query 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --filter '{"result.status": {"$gte": 500}}' --projection '{"config": 1, "result.status": 1}'
  scantor analyses query 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --filter @filter.json --limit 1000 -o json`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := apiCheckLimit(limit, 1000); err != nil {
				return err
			}
			in := newAPIInputs(app)
			body := api.QueryAnalyses{Limit: limit}
			var err error
			if body.Filter, err = in.object("--filter", filter); err != nil {
				return err
			}
			if body.Filter == nil {
				body.Filter = json.RawMessage(`{}`)
			}
			if body.Projection, err = in.object("--projection", projection); err != nil {
				return err
			}
			if body.Sort, err = in.object("--sort", sort); err != nil {
				return err
			}
			if cmd.Flags().Changed("after-seq") {
				body.AfterSeq = &afterSeq
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			res, err := client.QueryAnalyses(cmd.Context(), args[0], body)
			if err != nil {
				return err
			}
			err = app.Output().Print(res, func(w io.Writer) error { return apiWriteDocuments(w, res.Items) })
			if err == nil {
				apiPrintMore(app, res.NextCursor, "--after-seq")
			}
			return err
		},
	}
	cmd.Flags().StringVar(&filter, "filter", "", "MongoDB filter (JSON object, @file or -; default {})")
	cmd.Flags().StringVar(&projection, "projection", "", "MongoDB projection (JSON object, @file or -)")
	cmd.Flags().StringVar(&sort, "sort", "", "MongoDB sort (JSON object, @file or -)")
	cmd.Flags().IntVar(&limit, "limit", 0, "maximum number of documents (server default 20, max 1000)")
	cmd.Flags().Int64Var(&afterSeq, "after-seq", 0, "continue after this seq (unsorted queries)")
	return cmd
}

func newAnalysesAggregateCommand(app *App) *cobra.Command {
	var pipeline string
	var limit int
	cmd := &cobra.Command{
		Use:   "aggregate <scan>",
		Short: "Run a MongoDB aggregation over the analyses of a scan",
		Long: "Run a MongoDB aggregation pipeline (a JSON array of stages) over the analyses of a scan. Allowed " +
			"stages: $match, $project, $addFields, $set, $unset, $group, $sort, $limit, $skip, $count, $unwind, " +
			"$bucket, $bucketAuto, $sortByCount, $facet, $replaceRoot, $replaceWith and $sample. Pipelines that " +
			"reference secret config values are rejected. Humans get one compact JSON document per line. " + apiQueryHelp,
		Example: `  scantor analyses aggregate 5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f --pipeline '[{"$group": {"_id": "$status", "n": {"$sum": 1}}}]'`,
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if pipeline == "" {
				return UsageError(errors.New("--pipeline is required"))
			}
			if limit < 0 {
				return UsageError(errors.New("--limit must not be negative"))
			}
			raw, err := newAPIInputs(app).json("--pipeline", pipeline, apiJSONArray)
			if err != nil {
				return err
			}
			var stages []json.RawMessage
			if err := json.Unmarshal(raw, &stages); err != nil {
				return ValidationError(fmt.Errorf("--pipeline: %w", err))
			}
			for i, stage := range stages {
				if !bytes.HasPrefix(bytes.TrimSpace(stage), []byte("{")) {
					return ValidationError(fmt.Errorf("--pipeline: stage %d must be an object", i))
				}
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			res, err := client.AggregateAnalyses(cmd.Context(), args[0], api.AggregateAnalyses{Pipeline: stages, Limit: limit})
			if err != nil {
				return err
			}
			out := app.Output()
			err = out.Print(res, func(w io.Writer) error { return apiWriteDocuments(w, res.Items) })
			if err == nil && res.Truncated && !out.JSON() {
				out.Warnf("the output is truncated at the instance's document limit")
			}
			return err
		},
	}
	cmd.Flags().StringVar(&pipeline, "pipeline", "", "aggregation pipeline (JSON array, @file or -)")
	cmd.Flags().IntVar(&limit, "limit", 0, "maximum number of output documents (≤ the instance limit)")
	return cmd
}

// apiWriteDocuments writes one compact JSON document per line.
func apiWriteDocuments(w io.Writer, items []json.RawMessage) error {
	for _, item := range items {
		var buf bytes.Buffer
		if err := json.Compact(&buf, item); err != nil {
			buf.Reset()
			buf.Write(item)
		}
		buf.WriteByte('\n')
		if _, err := w.Write(buf.Bytes()); err != nil {
			return err
		}
	}
	return nil
}
