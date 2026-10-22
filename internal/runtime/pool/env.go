package pool

import (
	"slices"
	"strconv"
	"strings"

	"github.com/lonetis/scantor/internal/protocol"
)

// ConnectorEnv derives the environment of a connector process from the runtime's environment
// (docs/runtime.md §3.4, docs/protocol.md §10.2): the runtime-only variables are removed, TMPDIR is the
// per-process directory, and the protocol variables are set. SCANTOR_DIND stays, so user code can detect
// Docker-in-Docker.
func ConnectorEnv(environ []string, tmpDir string, slot int) []string {
	set := map[string]string{
		"TMPDIR":                 tmpDir,
		protocol.EnvInFD:         strconv.Itoa(protocol.InFD),
		protocol.EnvOutFD:        strconv.Itoa(protocol.OutFD),
		protocol.EnvVersions:     protocol.SupportedVersions(),
		protocol.EnvProcessIndex: strconv.Itoa(slot),
	}
	out := make([]string, 0, len(environ)+len(set))
	for _, kv := range environ {
		name, _, ok := strings.Cut(kv, "=")
		if !ok || slices.Contains(protocol.RuntimeOnlyEnv, name) {
			continue
		}
		if _, overridden := set[name]; overridden {
			continue
		}
		out = append(out, kv)
	}
	names := make([]string, 0, len(set))
	for name := range set {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		out = append(out, name+"="+set[name])
	}
	return out
}

// WithoutRuntimeOnly returns environ without the runtime-only variables (for the check command, which
// also runs user tooling).
func WithoutRuntimeOnly(environ []string) []string {
	out := make([]string, 0, len(environ))
	for _, kv := range environ {
		name, _, _ := strings.Cut(kv, "=")
		if !slices.Contains(protocol.RuntimeOnlyEnv, name) {
			out = append(out, kv)
		}
	}
	return out
}
