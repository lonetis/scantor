package node

import (
	"errors"
	"slices"

	"github.com/lonetis/scantor/internal/container"
)

// DinD support (docs/nodes.md §6.9, docs/security.md PRIV-2). Privileged revisions need both the user
// flag canRunPrivileged (checked by the orchestrator) and a node whose effective mode is not disabled.

// envDinD tells the runtime of a DinD worker to start the inner dockerd.
const envDinD = "SCANTOR_DIND"

// effectiveDinD returns the mode the daemon reports as info.dindMode and accepts in assignments: the
// configured mode, except that sysbox without the sysbox-runc runtime is downgraded to disabled (the
// returned error explains why), so a misconfigured node is never chosen for privileged workers.
func effectiveDinD(configured string, runtimes []string) (string, error) {
	if configured == DinDSysbox && !slices.Contains(runtimes, container.SysboxRuntime) {
		return DinDDisabled, errors.New("SCANTOR_NODE_DIND=sysbox, but the Docker daemon has no sysbox-runc runtime; DinD is disabled on this node")
	}
	return configured, nil
}

// containerDinD maps an assignment's dindMode to the container profile: null is a normal worker.
func containerDinD(mode *string) container.DinDMode {
	if mode == nil {
		return container.DinDNone
	}
	switch *mode {
	case DinDSysbox:
		return container.DinDSysbox
	case DinDPrivileged:
		return container.DinDPrivileged
	default:
		return container.DinDNone
	}
}
