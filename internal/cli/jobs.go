package cli

import (
	"context"
	"fmt"
	"io"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
)

func init() {
	registerGroup("", "jobs", "Inspect background jobs (deletions, retries, exports, builds)", false)
	registerCommand("jobs", newJobsListCommand)
	registerCommand("jobs", newJobsGetCommand)
}

func newJobsListCommand(app *App) *cobra.Command {
	var query api.ListJobsQuery
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List background jobs",
		Long: "List your background jobs, newest first: revision builds, test runs, scan deletions, retry-failed " +
			"runs, exports, task deletions and (admins) user purges.",
		Example: `  scantor jobs list
  scantor jobs list --kind scanDelete --state running`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := apiCheckLimit(query.Limit, 200); err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			page, err := client.ListJobs(cmd.Context(), query)
			if err != nil {
				return err
			}
			err = app.Output().Print(page, func(w io.Writer) error {
				t := Table{Headers: []string{"ID", "KIND", "SUBJECT", "STATE", "PROGRESS", "CREATED"}}
				for _, j := range page.Items {
					t.Add(j.ID, j.Kind, j.Subject.Kind+" "+apiShortID(j.Subject.ID), j.State, apiJobProgress(j.Progress), apiTimeValue(j.CreatedAt))
				}
				return t.Write(w)
			})
			if err == nil {
				apiPrintMore(app, page.NextCursor, "--cursor")
			}
			return err
		},
	}
	cmd.Flags().StringVar(&query.Kind, "kind", "", "only jobs of this kind (revisionBuild, testRun, scanDelete, scanRetryFailed, export, taskDelete, userPurge)")
	cmd.Flags().StringVar(&query.State, "state", "", "only jobs in this state (queued, running, succeeded, failed, cancelled)")
	cmd.Flags().StringVar(&query.UserID, "user", "", "only jobs of this user id (admins)")
	apiPageFlags(cmd, &query.PageQuery, 200)
	return cmd
}

func newJobsGetCommand(app *App) *cobra.Command {
	var wait apiWaitOptions
	cmd := &cobra.Command{
		Use:   "get <job>",
		Short: "Show a background job",
		Long: "Show a background job. With --wait the command waits until the job has succeeded, failed or " +
			"been cancelled, and exits with code 3 unless it succeeded.",
		Example: "  scantor jobs get d4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f7a --wait",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := wait.validate(); err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			var job *api.Job
			var outcome error
			if wait.wait {
				job, outcome = apiWaitJob(ctx, client, args[0], wait.timeout)
				if job == nil {
					return outcome
				}
			} else if job, err = client.GetJob(ctx, args[0], 0); err != nil {
				return err
			}
			if err := app.Output().Print(job, func(w io.Writer) error { return apiWriteJob(w, job) }); err != nil {
				return err
			}
			return outcome
		},
	}
	apiWaitFlags(cmd, &wait, "the job has finished")
	return cmd
}

func apiJobProgress(p api.Progress) string {
	if p.Total == nil {
		if p.Done == 0 {
			return "-"
		}
		return fmt.Sprintf("%d", p.Done)
	}
	return fmt.Sprintf("%d/%d", p.Done, *p.Total)
}

func apiWriteJob(w io.Writer, job *api.Job) error {
	var kv apiKV
	kv.add("job", job.ID)
	kv.add("kind", job.Kind)
	kv.add("subject", job.Subject.Kind+" "+job.Subject.ID)
	kv.add("state", job.State)
	kv.add("progress", apiJobProgress(job.Progress))
	kv.add("attempts", fmt.Sprintf("%d", job.Attempts))
	if job.Error != nil {
		kv.add("error", fmt.Sprintf("%s (%s)", job.Error.Message, job.Error.Code))
	}
	kv.add("created", apiTimeValue(job.CreatedAt))
	kv.add("started", apiTime(job.StartedAt))
	kv.add("finished", apiTime(job.FinishedAt))
	return kv.write(w)
}

// apiPrintJobRef prints the job of an asynchronous operation, or waits for it with --wait and prints the
// finished job.
func apiPrintJobRef(ctx context.Context, app *App, client *api.Client, ref api.JobRef, wait apiWaitOptions, what string) error {
	out := app.Output()
	if !wait.wait {
		return out.Print(ref, func(w io.Writer) error {
			_, err := fmt.Fprintf(w, "%s (job %s, %s)\n", what, ref.ID, ref.State)
			return err
		})
	}
	if !out.JSON() {
		out.Infof("%s (job %s); waiting…", what, ref.ID)
	}
	job, jobErr := apiWaitJob(ctx, client, ref.ID, wait.timeout)
	if job == nil {
		return jobErr
	}
	if err := out.Print(job, func(w io.Writer) error { return apiWriteJob(w, job) }); err != nil {
		return err
	}
	return jobErr
}
