package bundlerun

import (
	"fmt"
	"strings"

	"github.com/lonetis/scantor/internal/bundle"
)

// Usage is the help of a bundle image (`docker run --rm <image> --help`): the real docker run command
// lines with the image's name, the bundle flags and -o. The runtime's own commands stay hidden.
func Usage(info *bundle.Info) string {
	run := fmt.Sprintf(`docker run --rm -v "$PWD:%s" %s`, bundle.WorkDir, info.Image)
	var b strings.Builder
	line := func(format string, args ...any) { fmt.Fprintf(&b, format+"\n", args...) }
	line("Run %s (%s, %s) with only Docker: the schedule and every analysis run in this container, and the", info.Ref, info.Language, platformText(info.Platform))
	line("results are written to %s/<UTC time>/ in the folder mounted at %s.", ResultsDir, bundle.WorkDir)
	line("")
	line("Usage:")
	line("  %s [flags]", run)
	line("")
	line("Examples:")
	line("  %s", run)
	line("  %s --scan-config @scan.json --processes 4 --limit 100", run)
	line(`  docker run --rm -i -v "$PWD:%s" %s --task-config - < task.json`, bundle.WorkDir, info.Image)
	line("  docker run --rm %s --describe", info.Image)
	line("")
	line("Flags:")
	width := len("-o, --output format")
	for _, f := range FlagDocs {
		width = max(width, len(flagName(f)))
	}
	for _, f := range FlagDocs {
		line("      %-*s   %s", width, flagName(f), f.Help)
	}
	line("  -o, --%-*s   %s", width-2, "output format", "output: human, or json (the events as NDJSON; --describe as one document)")
	line("  -h, --%-*s   %s", width-2, "help", "show this help")
	line("")
	line("The mount is %s in PowerShell and %s in cmd; in Git Bash, start the command with MSYS_NO_PATHCONV=1.",
		`-v "${PWD}:`+bundle.WorkDir+`"`, `-v "%cd%:`+bundle.WorkDir+`"`)
	line("Data sources: -e SCANTOR_TRANCO_URL, -e SCANTOR_CRUX_URL, -e SCANTOR_CRUX_CACHE_URL; a proxy's CA: -e SCANTOR_CA_CERT.")
	line("Exit codes: 0 every analysis succeeded, 1 analyses or the schedule failed, 2 invalid flags, configs or run")
	line("directory, 3 platform failure, total timeout, interrupt or a run directory that cannot be written.")
	line("Run only bundles you trust, in a folder of their own: the task can read the mounted folder.")
	return b.String()
}

func flagName(f FlagDoc) string {
	if f.Value == "" {
		return "--" + f.Name
	}
	return "--" + f.Name + " " + f.Value
}
