package node

import (
	"slices"

	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
)

// The worker container spec (docs/nodes.md §6.3): the task image by digest, the injected runtime as the
// entrypoint, the managed labels, the hardening profile with the assignment's limits, exactly one
// network, and an environment of the assignment env plus the daemon's transport settings.

// Variables the daemon passes on to workers when they are set on the daemon (docs/nodes.md §11).
const (
	envCACert        = "SCANTOR_CA_CERT"
	envAllowInsecure = "SCANTOR_ALLOW_INSECURE_TRANSPORT"
)

// workerSettings are the node-wide inputs of every worker container.
type workerSettings struct {
	nodeID        string
	network       string
	drainGraceMs  int64
	pidsLimit     int64
	shmSize       int64
	nofile        int64
	logMaxSize    int64
	logMaxFiles   int
	caCert        string
	allowInsecure bool
}

// workerName returns the container name of a worker: scantor-w-<workerId>.
func workerName(workerID string) string { return container.Name(container.KindWorker, workerID) }

// stopTimeoutSeconds is the grace between SIGTERM and SIGKILL: drainGraceMs/1000 + 5.
func stopTimeoutSeconds(drainGraceMs int64) int {
	return int(max(drainGraceMs, 0)/1000) + 5
}

// workerCreateOptions returns the ContainerCreate options of an assignment that passed
// validateAssignment.
func workerCreateOptions(a api.Assignment, ws workerSettings) (client.ContainerCreateOptions, error) {
	labels, err := container.ManagedLabels(container.KindWorker, container.Identity{
		Worker: a.WorkerID, Scan: a.ScanID, User: a.UserID, Node: ws.nodeID, SpecHash: a.SpecHash,
	})
	if err != nil {
		return client.ContainerCreateOptions{}, err
	}
	dind := containerDinD(a.DinDMode)
	var capAdd []string
	if dind == container.DinDNone {
		capAdd = slices.Clone(a.CapAdd)
	}
	rc := container.RuntimeContainer{
		Name:   workerName(a.WorkerID),
		Image:  a.Image,
		Mode:   container.ModeWorker,
		Env:    workerEnv(a, ws),
		Labels: labels,
		Profile: container.Profile{
			CapAdd:          capAdd,
			PidsLimit:       ws.pidsLimit,
			MemoryBytes:     a.Resources.MemoryBytes,
			NanoCPUs:        a.Resources.NanoCPUs,
			ShmSizeBytes:    ws.shmSize,
			Nofile:          ws.nofile,
			LogMaxSizeBytes: ws.logMaxSize,
			LogMaxFiles:     ws.logMaxFiles,
			NetworkMode:     ws.network,
			DinD:            dind,
		},
		StopTimeoutSeconds: stopTimeoutSeconds(ws.drainGraceMs),
	}
	return rc.CreateOptions()
}

// workerEnv returns the assignment env (sorted by key), plus SCANTOR_CA_CERT and
// SCANTOR_ALLOW_INSECURE_TRANSPORT=true when set on the daemon, plus SCANTOR_DIND=1 for DinD workers.
// No other variable is ever added.
func workerEnv(a api.Assignment, ws workerSettings) []string {
	keys := make([]string, 0, len(a.Env))
	for k := range a.Env {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	env := make([]string, 0, len(keys)+3)
	for _, k := range keys {
		env = append(env, k+"="+a.Env[k])
	}
	if ws.caCert != "" {
		env = append(env, envCACert+"="+ws.caCert)
	}
	if ws.allowInsecure {
		env = append(env, envAllowInsecure+"=true")
	}
	if a.DinDMode != nil {
		env = append(env, envDinD+"=1")
	}
	return env
}

// limitsOf returns the applied limits an assignment asks for.
func limitsOf(a api.Assignment) api.AppliedLimits {
	return api.AppliedLimits{Processes: a.Processes, NanoCPUs: a.Resources.NanoCPUs, MemoryBytes: a.Resources.MemoryBytes}
}
