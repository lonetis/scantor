// Command scantor is the single scantor binary: CLI, node daemon, runtime, task pipeline and workspace
// helpers (docs/architecture.md §4.2).
package main

import (
	"os"

	"github.com/lonetis/scantor/internal/cli"
)

func main() {
	err := cli.NewRootCommand().Execute()
	os.Exit(cli.ExitCode(err))
}
