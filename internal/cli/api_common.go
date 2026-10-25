package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/google/uuid"
	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
)

// Shared helpers of the platform API commands (tasks, revisions, scans, analyses, exports, files,
// nodes, jobs, whoami). Identifiers carry an api prefix so they never collide with other command files
// of this package.

// apiPageFlags adds --limit and --cursor to a list command.
func apiPageFlags(cmd *cobra.Command, page *api.PageQuery, maxLimit int) {
	cmd.Flags().IntVar(&page.Limit, "limit", 0, fmt.Sprintf("maximum number of items (server default 50, max %d)", maxLimit))
	cmd.Flags().StringVar(&page.Cursor, "cursor", "", "continue a previous listing (the cursor it printed)")
}

// apiCheckLimit validates --limit.
func apiCheckLimit(limit, maxLimit int) error {
	if limit < 0 || limit > maxLimit {
		return UsageError(fmt.Errorf("--limit must be between 1 and %d", maxLimit))
	}
	return nil
}

// apiPrintMore tells a human where the next page starts (stderr; JSON output carries nextCursor).
func apiPrintMore(app *App, next *string, flag string) {
	out := app.Output()
	if out.JSON() || next == nil || *next == "" {
		return
	}
	out.Infof("more results: re-run with %s %s", flag, *next)
}

// apiKV renders aligned "key  value" lines for human detail views.
type apiKV struct {
	rows [][2]string
}

// add appends a row; empty values are skipped.
func (kv *apiKV) add(key, value string) {
	if value == "" {
		return
	}
	kv.rows = append(kv.rows, [2]string{key, value})
}

func (kv *apiKV) write(w io.Writer) error {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	for _, r := range kv.rows {
		value := strings.ReplaceAll(normaliseNewlines(r[1]), "\n", "\n\t")
		if _, err := fmt.Fprintf(tw, "%s\t%s\n", r[0], value); err != nil {
			return err
		}
	}
	return tw.Flush()
}

// apiIsUUID reports whether s is a uuid (the form of every platform id except analysis ids).
func apiIsUUID(s string) bool {
	return len(s) == 36 && uuid.Validate(s) == nil
}

// apiShortID shortens a uuid for tables ("5e1f0c2d").
func apiShortID(id string) string {
	if apiIsUUID(id) {
		return id[:8]
	}
	return id
}

// apiSplitRevisionRef splits "<task>@<revision>" into task and revision; "<task>" alone means
// "<task>@latest" (docs/api.md §1.4).
func apiSplitRevisionRef(ref string) (task, revision string, err error) {
	task, revision, found := strings.Cut(ref, "@")
	if !found {
		revision = "latest"
	}
	if task == "" || revision == "" || strings.Contains(revision, "@") {
		return "", "", UsageError(fmt.Errorf("invalid revision reference %q: use <task>@<number>, <task>@latest, <task>@<revisionId> or <task>", ref))
	}
	return task, revision, nil
}

// apiRevisionRefHint explains a notFound for a bare uuid reference. Such a reference addresses the latest
// revision of a task id; the revision routes need the task, so a revision id has to be given as
// <task>@<revisionId> (only startScan resolves bare revision ids, docs/api.md §1.4).
func apiRevisionRefHint(ref string, err error) error {
	if strings.Contains(ref, "@") || !apiIsUUID(ref) {
		return err
	}
	return apiWithHint(err, api.CodeNotFound, "a revision id must be given with its task, as <task>@<revisionId>")
}

// apiIsTerminal reports whether w is a terminal (a character device), for live progress lines.
func apiIsTerminal(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

// apiWithHint appends a CLI hint to the message of an API error with the given code; other errors pass
// through unchanged.
func apiWithHint(err error, code, hint string) error {
	apiErr, ok := api.AsError(err)
	if !ok || apiErr.Code != code {
		return err
	}
	withHint := *apiErr
	withHint.Message = strings.TrimRight(withHint.Message, ". ") + "; " + hint
	return &withHint
}

// apiTime renders a nullable timestamp for tables and detail views.
func apiTime(t *api.Time) string { return HumanTime(t) }

// apiTimeValue renders a non-nullable timestamp.
func apiTimeValue(t api.Time) string { return HumanTime(&t) }

// apiTruncate shortens s to n runes with an ellipsis, on one line.
func apiTruncate(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

// apiDeref returns *p or "" for nil.
func apiDeref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// apiDeleted is the JSON output of commands whose API call returns 204.
type apiDeleted struct {
	ID      string `json:"id"`
	Deleted bool   `json:"deleted"`
}

// countNoun renders "1 analysis" / "3 analyses".
func countNoun(n int, singular, plural string) string {
	if n == 1 {
		return "1 " + singular
	}
	return fmt.Sprintf("%d %s", n, plural)
}

// apiYesNo renders a boolean for tables.
func apiYesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// ── waiting ──────────────────────────────────────────────────────────────────

// apiWaitOptions are the --wait and --timeout flags of commands that can wait for a resource to settle.
type apiWaitOptions struct {
	wait    bool
	timeout time.Duration
}

// apiWaitFlags adds --wait and --timeout; what names the settled condition in the help text.
func apiWaitFlags(cmd *cobra.Command, w *apiWaitOptions, what string) {
	cmd.Flags().BoolVar(&w.wait, "wait", false, "wait until "+what)
	cmd.Flags().DurationVar(&w.timeout, "timeout", 0, "give up waiting after this duration (0 = no limit)")
}

func (w apiWaitOptions) validate() error {
	if w.timeout < 0 {
		return UsageError(errors.New("--timeout must not be negative"))
	}
	return nil
}

// apiMaxWaitSeconds is the longest server-side wait of one long-poll request (docs/api.md §1.9).
const apiMaxWaitSeconds = 120

// apiTransientBudget bounds how long a wait keeps retrying while the orchestrator is unreachable.
const apiTransientBudget = 2 * time.Minute

// apiPollMinInterval is the shortest time between two polls of a wait, for servers that answer a
// long-poll early without the resource having settled (tests lower it).
var apiPollMinInterval = time.Second

// errAPIWaitTimeout is wrapped by the error of a wait whose --timeout elapsed.
var errAPIWaitTimeout = errors.New("timed out")

// apiPollUntil long-polls until poll reports a settled resource. poll receives the server-side wait in
// seconds; every request stays within the remaining --timeout. Temporary failures (network, 429, 5xx)
// are retried with backoff for up to apiTransientBudget. An interrupt returns Interrupted().
func apiPollUntil[T any](ctx context.Context, timeout time.Duration, what string, poll func(ctx context.Context, wait int) (T, bool, error)) (T, error) {
	var zero T
	var deadline time.Time
	if timeout > 0 {
		deadline = time.Now().Add(timeout)
	}
	backoff := api.RetryPolicy{Initial: time.Second, Max: 15 * time.Second, Factor: 2, Jitter: api.JitterFull}
	var failingSince time.Time
	for attempt := 1; ; {
		wait := apiMaxWaitSeconds
		if !deadline.IsZero() {
			remaining := time.Until(deadline)
			if remaining <= 0 {
				return zero, PlatformError(fmt.Errorf("%w after %s waiting for %s", errAPIWaitTimeout, timeout, what))
			}
			wait = min(wait, max(1, int(remaining.Seconds())))
		}
		started := time.Now()
		value, settled, err := poll(ctx, wait)
		switch {
		case err == nil && settled:
			return value, nil
		case err == nil:
			failingSince, attempt = time.Time{}, 1
			// A server that answers before the wait elapsed without settling must not cause a hot loop.
			if elapsed := time.Since(started); elapsed < apiPollMinInterval {
				if err := apiSleep(ctx, apiPollMinInterval-elapsed); err != nil {
					return zero, err
				}
			}
		case ctx.Err() != nil:
			return zero, Interrupted()
		case !api.Temporary(err):
			return zero, err
		default:
			if failingSince.IsZero() {
				failingSince = time.Now()
			}
			if time.Since(failingSince) > apiTransientBudget {
				return zero, err
			}
			if err := apiSleep(ctx, backoff.Delay(attempt)); err != nil {
				return zero, err
			}
			attempt++
		}
	}
}

// apiSleep waits for d or until ctx ends (then it returns Interrupted()).
func apiSleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return Interrupted()
	case <-t.C:
		return nil
	}
}

// apiJobSettled reports whether a job reached a final state.
func apiJobSettled(state string) bool {
	return state == api.JobSucceeded || state == api.JobFailed || state == api.JobCancelled
}

// apiWaitJob waits until the job settles and returns it; a failed or cancelled job is a platform error.
func apiWaitJob(ctx context.Context, client *api.Client, jobID string, timeout time.Duration) (*api.Job, error) {
	job, err := apiPollUntil(ctx, timeout, "job "+jobID, func(ctx context.Context, wait int) (*api.Job, bool, error) {
		job, err := client.GetJob(ctx, jobID, wait)
		if err != nil {
			return nil, false, err
		}
		return job, apiJobSettled(job.State), nil
	})
	if err != nil {
		return nil, err
	}
	return job, apiJobOutcome(job)
}

// apiJobOutcome returns the error of a failed or cancelled job.
func apiJobOutcome(job *api.Job) error {
	switch job.State {
	case api.JobFailed:
		msg := "failed"
		if job.Error != nil {
			msg = fmt.Sprintf("failed: %s (%s)", job.Error.Message, job.Error.Code)
		}
		return PlatformError(fmt.Errorf("job %s (%s) %s", job.ID, job.Kind, msg))
	case api.JobCancelled:
		return PlatformError(fmt.Errorf("job %s (%s) was cancelled", job.ID, job.Kind))
	default:
		return nil
	}
}
