package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
)

func init() {
	registerGroup("", "revisions", "Publish and inspect task revisions", false)
	registerCommand("revisions", newRevisionsListCommand)
	registerCommand("revisions", newRevisionsGetCommand)
	registerCommand("revisions", newRevisionsPublishCommand)
	registerCommand("revisions", newRevisionsLogsCommand)
}

const apiRevisionRefHelp = "A revision is addressed as <task>@<number>, <task>@latest (the newest ready revision), " +
	"<task>@<revisionId> or <task> (= <task>@latest)."

const apiRevisionFailedHelp = "A failed build exits with code 2 when the task content is invalid (pack, " +
	"static, build, describe or check errors) and 3 when it failed for a platform reason (push, platform)."

func newRevisionsListCommand(app *App) *cobra.Command {
	var state string
	var page api.PageQuery
	cmd := &cobra.Command{
		Use:     "list <task>",
		Short:   "List the revisions of a task",
		Long:    "List the revisions of a task, newest first. " + apiTaskArgHelp,
		Example: "  scantor revisions list echo --state ready",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := apiCheckLimit(page.Limit, 200); err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			list, err := client.ListRevisions(cmd.Context(), args[0], state, page)
			if err != nil {
				return err
			}
			err = app.Output().Print(list, func(w io.Writer) error {
				t := Table{Headers: []string{"REVISION", "STATE", "SOURCE", "ERRORS", "CREATED", "FINISHED"}}
				for _, r := range list.Items {
					t.Add(r.Ref, r.State, r.Source.Kind, fmt.Sprintf("%d", r.ErrorsCount), apiTimeValue(r.CreatedAt), apiTime(r.FinishedAt))
				}
				return t.Write(w)
			})
			if err == nil {
				apiPrintMore(app, list.NextCursor, "--cursor")
			}
			return err
		},
	}
	cmd.Flags().StringVar(&state, "state", "", "only revisions in this state (queued, building, ready, failed)")
	apiPageFlags(cmd, &page, 200)
	return cmd
}

func newRevisionsGetCommand(app *App) *cobra.Command {
	var wait apiWaitOptions
	cmd := &cobra.Command{
		Use:   "get <task>[@<revision>]",
		Short: "Show a revision",
		Long: "Show a revision: state, source, image, described schedule, settings defaults and structured " +
			"errors. With --wait the command waits until the revision is ready or failed. " + apiRevisionFailedHelp +
			" " + apiRevisionRefHelp,
		Example: `  scantor revisions get echo@3
  scantor revisions get echo@latest -o json`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := wait.validate(); err != nil {
				return err
			}
			task, revision, err := apiSplitRevisionRef(args[0])
			if err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx, stop := InterruptContext(cmd.Context())
			defer stop()
			var rev *api.Revision
			if wait.wait {
				rev, err = apiWaitRevision(ctx, client, task, revision, wait.timeout)
			} else {
				rev, err = client.GetRevision(ctx, task, revision, 0)
			}
			if err != nil {
				return apiRevisionRefHint(args[0], err)
			}
			if err := app.Output().Print(rev, func(w io.Writer) error { return apiWriteRevision(w, rev) }); err != nil {
				return err
			}
			if wait.wait {
				return apiRevisionOutcome(rev)
			}
			return nil
		},
	}
	apiWaitFlags(cmd, &wait, "the revision is ready or failed")
	return cmd
}

func newRevisionsPublishCommand(app *App) *cobra.Command {
	var body api.PublishRevision
	var wait apiWaitOptions
	cmd := &cobra.Command{
		Use:   "publish <task>",
		Short: "Publish the task's workspace as a new revision",
		Long: "Snapshot the task's current workspace on the platform and build it into a new numbered revision. " +
			"When a queued, building or ready revision with the same content exists, that revision is returned " +
			"instead. With --wait the command waits for the build. " + apiRevisionFailedHelp + " To publish a " +
			"local folder, use 'scantor push'. " + apiTaskArgHelp,
		Example: `  scantor revisions publish echo --message "add greeting option" --wait`,
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
			rev, err := client.PublishRevision(ctx, args[0], body, 0)
			if err != nil {
				return err
			}
			out := app.Output()
			if wait.wait && !apiRevisionSettled(rev.State) {
				if !out.JSON() {
					out.Infof("published %s; waiting for the build…", rev.Ref)
				}
				if rev, err = apiWaitRevision(ctx, client, args[0], rev.ID, wait.timeout); err != nil {
					return err
				}
			}
			if err := out.Print(rev, func(w io.Writer) error { return apiWriteRevision(w, rev) }); err != nil {
				return err
			}
			if wait.wait {
				return apiRevisionOutcome(rev)
			}
			return nil
		},
	}
	cmd.Flags().StringVarP(&body.Message, "message", "m", "", "revision message")
	apiWaitFlags(cmd, &wait, "the revision is built (ready or failed)")
	return cmd
}

func apiRevisionSettled(state string) bool {
	return state == api.RevisionReady || state == api.RevisionFailed
}

// apiWaitRevision long-polls getRevision until the revision is ready or failed.
func apiWaitRevision(ctx context.Context, client *api.Client, task, revision string, timeout time.Duration) (*api.Revision, error) {
	return apiPollUntil(ctx, timeout, "revision "+task+"@"+revision, func(ctx context.Context, wait int) (*api.Revision, bool, error) {
		rev, err := client.GetRevision(ctx, task, revision, wait)
		if err != nil {
			return nil, false, err
		}
		return rev, apiRevisionSettled(rev.State), nil
	})
}

// apiRevisionOutcome maps a settled revision to the exit classes of the task pipeline (docs/tasks.md
// §9.9): errors of the pack, static, build, describe and check phases mean invalid task content (2); push
// and platform errors, or a failure without recorded errors, are platform failures (3).
func apiRevisionOutcome(rev *api.Revision) error {
	if rev.State != api.RevisionFailed {
		return nil
	}
	err := fmt.Errorf("revision %s failed with %d error(s); see 'scantor revisions logs %s'", rev.Ref, len(rev.Errors), rev.Ref)
	if len(rev.Errors) == 0 {
		return PlatformError(err)
	}
	for _, e := range rev.Errors {
		if e.Phase == api.BuildPhasePush || e.Phase == api.BuildPhasePlatform {
			return PlatformError(err)
		}
	}
	return ValidationError(err)
}

func apiWriteRevision(w io.Writer, rev *api.Revision) error {
	var kv apiKV
	kv.add("revision", rev.Ref)
	kv.add("id", rev.ID)
	kv.add("state", rev.State)
	kv.add("message", rev.Message)
	kv.add("source", fmt.Sprintf("%s, %d files, %s, pack %s", rev.Source.Kind, rev.Source.FileCount, HumanBytes(rev.Source.PackBytes), apiShortCommit(rev.Source.PackSHA256)))
	if g := rev.Source.Git; g != nil {
		kv.add("git", fmt.Sprintf("%s %s at %s", g.URL, g.Path, apiShortCommit(g.Commit)))
	}
	kv.add("language", rev.Language)
	if d := rev.Description; d != nil {
		schedule := d.Schedule.Kind
		if d.Schedule.Template != "" {
			schedule += " " + d.Schedule.Template
		}
		kv.add("schedule", schedule)
		kv.add("connector", fmt.Sprintf("%s %s (protocol %d)", d.Connector.Language, d.Connector.Version, d.ProtocolVersion))
	}
	if img := rev.Image; img != nil {
		kv.add("image", fmt.Sprintf("%s@%s (%s/%s, %s)", img.Repository, img.Digest, img.Platform.OS, img.Platform.Arch, HumanBytes(img.Bytes)))
	}
	if b := rev.BaseImage; b != nil {
		kv.add("base image", b.Ref+"@"+b.Digest)
	}
	if s := rev.SettingsDefaults; s != nil {
		kv.add("defaults", apiSettingsSummary(*s))
	}
	if rev.Privileged {
		kv.add("privileged", "yes")
	}
	kv.add("created", apiTimeValue(rev.CreatedAt))
	kv.add("finished", apiTime(rev.FinishedAt))
	if err := kv.write(w); err != nil {
		return err
	}
	if len(rev.Errors) > 0 {
		if _, err := fmt.Fprintln(w, "errors:"); err != nil {
			return err
		}
		for _, e := range rev.Errors {
			if _, err := fmt.Fprintf(w, "  %s\n", FormatBuildError(e)); err != nil {
				return err
			}
		}
	}
	if rev.Description != nil && len(rev.Description.Warnings) > 0 {
		if _, err := fmt.Fprintln(w, "warnings:"); err != nil {
			return err
		}
		for _, warning := range rev.Description.Warnings {
			if _, err := fmt.Fprintf(w, "  %s\n", warning); err != nil {
				return err
			}
		}
	}
	return nil
}

// apiSettingsSummary renders scan settings on one line.
func apiSettingsSummary(s api.ScanSettings) string {
	parts := []string{
		fmt.Sprintf("workers %d", s.Workers),
		fmt.Sprintf("processes %d", s.Processes),
		"timeout " + HumanDuration(s.TimeoutMs),
		fmt.Sprintf("attempts %d", s.MaxAttempts),
		fmt.Sprintf("%g cpu / %d MiB per process", s.Resources.CPUs, s.Resources.MemoryMiB),
	}
	if s.NodeSelector != nil && s.NodeSelector.Pool != "" {
		parts = append(parts, "pool "+s.NodeSelector.Pool)
	}
	if s.Privileged {
		parts = append(parts, "privileged")
	}
	return strings.Join(parts, " · ")
}

func newRevisionsLogsCommand(app *App) *cobra.Command {
	var follow bool
	var afterLine int
	cmd := &cobra.Command{
		Use:   "logs <task>[@<revision>]",
		Short: "Print the build log of a revision",
		Long: "Print the build log of a revision: one entry per task-pipeline event (pack, static checks, image " +
			"build, describe, type check, push), ending with the result. --follow keeps printing new entries " +
			"until the build has finished. With -o json every entry is printed as one JSON object per line. " +
			apiRevisionRefHelp,
		Example: `  scantor revisions logs echo@4
  scantor revisions logs echo@5 --follow`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if afterLine < 0 {
				return UsageError(fmt.Errorf("--after-line must not be negative"))
			}
			task, revision, err := apiSplitRevisionRef(args[0])
			if err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx, stop := InterruptContext(cmd.Context())
			defer stop()
			return apiRevisionRefHint(args[0], apiFollowBuildLog(ctx, app, client, task, revision, afterLine, follow))
		},
	}
	cmd.Flags().BoolVar(&follow, "follow", false, "keep printing new entries until the build has finished")
	cmd.Flags().IntVar(&afterLine, "after-line", 0, "start after this line number")
	return cmd
}

// apiBuildLogPage is the page size of getRevisionBuildLog requests.
const apiBuildLogPage = 1000

// apiBuildLogPoll is the interval of --follow while no new entries arrive.
const apiBuildLogPoll = time.Second

func apiFollowBuildLog(ctx context.Context, app *App, client *api.Client, task, revision string, afterLine int, follow bool) error {
	out := app.Output()
	nd := out.NDJSON()
	for {
		before := afterLine
		log, err := client.GetRevisionBuildLog(ctx, task, revision, afterLine, apiBuildLogPage)
		if err != nil {
			if ctx.Err() != nil {
				return Interrupted()
			}
			return err
		}
		for _, line := range log.Lines {
			if out.JSON() {
				err = nd.Write(line)
			} else {
				_, err = fmt.Fprintln(out.Out, apiFormatBuildLogLine(line))
			}
			if err != nil {
				return PlatformError(fmt.Errorf("write output: %w", err))
			}
			afterLine = max(afterLine, line.Line)
		}
		// Only the returned line numbers advance the position: nextLine is not needed to resume.
		if len(log.Lines) > 0 {
			if afterLine == before {
				return PlatformError(fmt.Errorf("the build log of %s@%s did not advance past line %d", task, revision, afterLine))
			}
			continue
		}
		if log.Complete || !follow {
			return nil
		}
		if err := apiSleep(ctx, apiBuildLogPoll); err != nil {
			return err
		}
	}
}

// apiFormatBuildLogLine renders one build log entry for humans.
func apiFormatBuildLogLine(line api.BuildLogLine) string {
	switch line.Type {
	case "error":
		if line.Error != nil {
			return "error    " + FormatBuildError(*line.Error)
		}
		return "error    [" + line.Phase + "]"
	case "result":
		var result struct {
			OK     bool              `json:"ok"`
			Errors []json.RawMessage `json:"errors"`
		}
		if err := json.Unmarshal(line.Result, &result); err != nil {
			return "result   (unreadable)"
		}
		if result.OK {
			return "result   ok"
		}
		return fmt.Sprintf("result   failed (%d error(s))", len(result.Errors))
	default:
		text := line.Text
		if line.Level == "warning" {
			text = "warning: " + text
		}
		return fmt.Sprintf("%-8s %s", line.Phase, text)
	}
}
