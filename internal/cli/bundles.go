package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/lonetis/scantor/internal/api"
)

func init() {
	registerCommand("revisions", newRevisionsBundleCommand)
}

// apiBundleTimeout is the default --timeout of `revisions bundle`: a bundle job pulls, builds, saves and
// compresses a whole task image, which takes minutes for large images.
const apiBundleTimeout = 30 * time.Minute

// apiBundleOutput is the -o json output of `revisions bundle`; File is null with --no-download.
type apiBundleOutput struct {
	Bundle *api.Bundle   `json:"bundle"`
	File   *apiSavedFile `json:"file"`
}

func newRevisionsBundleCommand(app *App) *cobra.Command {
	var target apiOutputTarget
	var rebuild, noDownload bool
	var timeout time.Duration
	cmd := &cobra.Command{
		Use:   "bundle <task>[@<revision>]",
		Short: "Create and download a bundle of a revision",
		Long: "Create a bundle of a ready revision and download it. A bundle is a gzip Docker image archive of the " +
			"revision with the runtime and the revision's defaults baked in; it runs on any machine with only Docker, " +
			"without the platform. A queued, running or ready bundle of the revision is reused; --rebuild replaces a " +
			"ready one. The command waits until the bundle is ready (at most --timeout), then saves it under its " +
			"file name <task>-<number>-<os>-<arch>.bundle.tar.gz in the current directory unless --file names " +
			"another path (- writes to stdout), verifying its size and SHA-256; an existing file is only replaced " +
			"with --force. A failed bundle exits with code 3. Privileged revisions cannot be bundled.\n\n" +
			"The recipient loads the archive once with 'docker load -i <file>' and runs it with " +
			"'docker run --rm -v \"$PWD:/work\" localhost/scantor/<task>:<number>'; the command prints these lines on " +
			"stderr. " + apiRevisionRefHelp,
		Example: `  scantor revisions bundle echo@3
  scantor revisions bundle echo@latest --rebuild --file echo.bundle.tar.gz
  scantor revisions bundle echo@3 --file - | docker load`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if timeout < 0 {
				return UsageError(errors.New("--timeout must not be negative"))
			}
			if noDownload && (target.path != "" || target.force) {
				return UsageError(errors.New("--file and --force need a download; drop --no-download"))
			}
			task, revision, err := apiSplitRevisionRef(args[0])
			if err != nil {
				return err
			}
			// The file is checked before the wait as well, which can take minutes.
			if target.path != "" {
				if err := target.check(); err != nil {
					return err
				}
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			bundle, err := client.CreateRevisionBundle(ctx, task, revision, rebuild, 0)
			if err != nil {
				err = apiWithHint(err, api.CodeRevisionNotReady, "wait for the build with 'scantor revisions get "+args[0]+" --wait'")
				return apiRevisionRefHint(args[0], err)
			}
			// The default file name is the server's: <task>-<number>-<os>-<arch>.bundle.tar.gz.
			if !noDownload && target.path == "" {
				if err := (apiOutputTarget{path: apiBundleFallbackName(bundle), force: target.force}).check(); err != nil {
					return err
				}
			}
			if bundle, err = apiWaitBundle(ctx, app, client, task, bundle, timeout); err != nil {
				return err
			}
			out := app.Output()
			if bundle.State == api.BundleFailed {
				if out.JSON() && !target.stdout() {
					if err := out.PrintJSON(apiBundleOutput{Bundle: bundle}); err != nil {
						return err
					}
				}
				return apiBundleFailed(bundle)
			}
			if noDownload {
				if err := out.Print(apiBundleOutput{Bundle: bundle}, func(w io.Writer) error { return apiWriteBundle(w, bundle) }); err != nil {
					return err
				}
				apiPrintBundleCommands(app, bundle, "")
				return nil
			}
			if bundle.Download == nil || bundle.Download.URL == "" {
				return PlatformError(fmt.Errorf("bundle %s is ready but has no download URL", bundle.Revision.Ref))
			}
			if target.path == "" {
				target.path = apiSafeFileName(bundle.Download.FileName, apiBundleFallbackName(bundle))
			}
			if !out.JSON() && !target.stdout() {
				out.Infof("downloading %s (%s)…", bundle.Download.FileName, HumanBytes(apiDerefInt64(bundle.Bytes)))
			}
			saved, err := apiDownload(ctx, app, client, bundle.Download.URL, target, apiExpect{size: apiDerefInt64(bundle.Bytes), sha256: apiDeref(bundle.SHA256)})
			if err != nil {
				if ctx.Err() != nil {
					return Interrupted()
				}
				return err
			}
			if saved.Path != "-" {
				if err := out.Print(apiBundleOutput{Bundle: bundle, File: saved}, func(w io.Writer) error {
					_, err := fmt.Fprintf(w, "saved %s (%s, sha256 %s)\n", saved.Path, HumanBytes(saved.Bytes), saved.SHA256)
					return err
				}); err != nil {
					return err
				}
			}
			apiPrintBundleCommands(app, bundle, saved.Path)
			return nil
		},
	}
	apiOutputFlags(cmd, &target, "the bundle")
	cmd.Flags().BoolVar(&rebuild, "rebuild", false, "replace a ready bundle with a new one")
	cmd.Flags().BoolVar(&noDownload, "no-download", false, "wait until the bundle is ready, but do not download it")
	cmd.Flags().DurationVar(&timeout, "timeout", apiBundleTimeout, "give up waiting for the bundle after this duration (0 = no limit)")
	return cmd
}

// apiWaitBundle long-polls getRevisionBundle until the bundle is ready or failed. It follows the
// bundle's revision by number, so "<task>@latest" keeps addressing the same revision while it waits.
func apiWaitBundle(ctx context.Context, app *App, client *api.Client, task string, bundle *api.Bundle, timeout time.Duration) (*api.Bundle, error) {
	if bundle.Settled() {
		return bundle, nil
	}
	out := app.Output()
	if !out.JSON() {
		out.Infof("bundle of %s is %s; waiting…", bundle.Revision.Ref, bundle.State)
	}
	revision := strconv.Itoa(bundle.Revision.Number)
	return apiPollUntil(ctx, timeout, "the bundle of "+bundle.Revision.Ref, func(ctx context.Context, wait int) (*api.Bundle, bool, error) {
		b, err := client.GetRevisionBundle(ctx, task, revision, wait)
		if err != nil {
			return nil, false, err
		}
		return b, b.Settled(), nil
	})
}

// apiBundleFailed is the platform error of a failed bundle.
func apiBundleFailed(b *api.Bundle) error {
	msg := "bundle " + b.Revision.Ref + " failed"
	if b.Error != nil {
		msg += fmt.Sprintf(": %s (%s)", b.Error.Message, b.Error.Code)
	}
	return PlatformError(errors.New(msg))
}

// apiBundleFallbackName is the local file name when the server-provided one is unusable.
func apiBundleFallbackName(b *api.Bundle) string {
	name := fmt.Sprintf("%s-%s-%s.bundle.tar.gz", strings.ReplaceAll(b.Revision.Ref, "@", "-"), b.Platform.OS, b.Platform.Arch)
	return apiSafeFileName(name, "scantor.bundle.tar.gz")
}

// apiPrintBundleCommands prints the recipient's commands on stderr (human output only), so stdout stays
// clean for --file -. The load line names the saved file when it was saved under another path than its
// file name.
func apiPrintBundleCommands(app *App, b *api.Bundle, savedPath string) {
	out := app.Output()
	if out.JSON() {
		return
	}
	load := b.Commands.Load
	switch {
	case savedPath == "-":
		load = ""
	case savedPath != "" && b.Download != nil && savedPath != b.Download.FileName:
		load = "docker load -i " + apiShellQuote(savedPath)
	}
	out.Infof("run the bundle with Docker only:")
	if load != "" {
		out.Infof("  %s", load)
	}
	out.Infof("  %s", b.Commands.Run)
	out.Infof("  %s", b.Commands.Describe)
}

// apiShellSafe matches words a POSIX shell takes literally.
var apiShellSafe = regexp.MustCompile(`^[A-Za-z0-9_./:@%+=,-]+$`)

// apiShellQuote quotes s for a POSIX shell when it contains other characters.
func apiShellQuote(s string) string {
	if apiShellSafe.MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func apiDerefInt64(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

func apiWriteBundle(w io.Writer, b *api.Bundle) error {
	var kv apiKV
	kv.add("bundle", b.ID)
	kv.add("revision", b.Revision.Ref)
	kv.add("state", b.State)
	kv.add("image", b.Image)
	platform := b.Platform.OS + "/" + b.Platform.Arch
	if b.Platform.Variant != "" {
		platform += "/" + b.Platform.Variant
	}
	kv.add("platform", platform)
	if b.Bytes != nil {
		kv.add("size", HumanBytes(*b.Bytes))
	}
	kv.add("sha256", apiDeref(b.SHA256))
	kv.add("scantor", apiDeref(b.ScantorVersion))
	if b.Error != nil {
		kv.add("error", fmt.Sprintf("%s (%s)", b.Error.Message, b.Error.Code))
	}
	if d := b.Download; d != nil {
		kv.add("file", d.FileName)
		kv.add("download", d.URL)
		kv.add("link expires", apiTimeValue(d.ExpiresAt))
	}
	kv.add("created", apiTimeValue(b.CreatedAt))
	kv.add("finished", apiTime(b.FinishedAt))
	kv.add("expires", apiTimeValue(b.ExpiresAt))
	return kv.write(w)
}
