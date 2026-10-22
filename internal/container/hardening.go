package container

import (
	"errors"
	"fmt"
	"slices"
	"strconv"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"

	"github.com/lonetis/scantor/internal/api"
)

// AllowedCapAdd is the capability allowlist of task containers (SCANTOR_WORKER_CAP_ADD ⊆ it).
var AllowedCapAdd = []string{"NET_BIND_SERVICE", "NET_RAW"}

// DinD modes of a worker container (docs/nodes.md §6.9); the empty mode is a normal worker.
type DinDMode string

// DinD modes.
const (
	DinDNone       DinDMode = ""
	DinDSysbox     DinDMode = "sysbox"
	DinDPrivileged DinDMode = "privileged"
)

// SysboxRuntime is the OCI runtime of sysbox DinD workers.
const SysboxRuntime = "sysbox-runc"

// Fixed values of the hardening profile for containers that are not node workers.
const (
	// BuildPidsLimit is the PIDs limit of describe and check containers (docs/tasks.md §9.5).
	BuildPidsLimit = 256
	// TestRunPidsLimit is the PIDs limit of test-run containers (docs/tasks.md §11.2).
	TestRunPidsLimit = 4096
	// DefaultNofile is the fixed nofile ulimit of describe, check and test-run containers; it equals the
	// .env.example default of SCANTOR_NODE_NOFILE.
	DefaultNofile = 65536
	// DefaultLogMaxSize and DefaultLogMaxFiles rotate the logs of describe, check and test-run containers;
	// they equal the .env.example defaults of SCANTOR_NODE_WORKER_LOG_MAX_SIZE/_FILES.
	DefaultLogMaxSize  = 20 << 20
	DefaultLogMaxFiles = 3
	// MemoryOverheadBytes is added to the per-process memory of every task container.
	MemoryOverheadBytes = 256 << 20
)

// Network modes without a user-defined network.
const (
	NetworkNone = "none"
	NetworkHost = "host"
)

// Profile is the hardening profile of task containers (docs/security.md SB-1, docs/nodes.md §6.3): one
// function builds the HostConfig of workers, describe/check containers and test-run containers.
type Profile struct {
	// CapAdd must be a subset of AllowedCapAdd; it is ignored in DinD modes.
	CapAdd []string
	// PidsLimit is required.
	PidsLimit int64
	// MemoryBytes is the memory limit (MemorySwap is set to the same value: no swap); required.
	MemoryBytes int64
	// NanoCPUs is the CPU limit; required.
	NanoCPUs int64
	// ShmSizeBytes sets /dev/shm (0 keeps Docker's default).
	ShmSizeBytes int64
	// Nofile is the soft and hard nofile ulimit; required.
	Nofile int64
	// LogMaxSizeBytes and LogMaxFiles rotate the `local` log driver; required.
	LogMaxSizeBytes int64
	LogMaxFiles     int
	// NetworkMode is the only network of the container (a network name, "none" or "host").
	NetworkMode string
	// DinD selects a Docker-in-Docker mode (workers of privileged revisions only).
	DinD DinDMode
}

// HostConfig builds the Engine API HostConfig of the profile: CapDrop ALL plus the allowlisted CapAdd,
// no-new-privileges with Docker's default seccomp and AppArmor profiles, Init, PidsLimit, memory without
// swap, NanoCpus, a fixed nofile ulimit, rotated `local` logs, no restart policy, no mounts. DinD modes
// differ only as docs/nodes.md §6.9 lists.
func (p Profile) HostConfig() (*container.HostConfig, error) {
	if err := p.validate(); err != nil {
		return nil, err
	}
	pids := p.PidsLimit
	initOn := true
	hc := &container.HostConfig{
		NetworkMode:   container.NetworkMode(p.NetworkMode),
		RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyDisabled},
		LogConfig: container.LogConfig{Type: "local", Config: map[string]string{
			"max-size": dockerSize(p.LogMaxSizeBytes),
			"max-file": strconv.Itoa(p.LogMaxFiles),
		}},
		ShmSize: p.ShmSizeBytes,
		Init:    &initOn,
		Resources: container.Resources{
			Memory:     p.MemoryBytes,
			MemorySwap: p.MemoryBytes,
			NanoCPUs:   p.NanoCPUs,
			PidsLimit:  &pids,
			Ulimits:    []*container.Ulimit{{Name: "nofile", Soft: p.Nofile, Hard: p.Nofile}},
		},
	}
	switch p.DinD {
	case DinDNone:
		hc.CapDrop = []string{"ALL"}
		hc.CapAdd = slices.Clone(p.CapAdd)
		hc.SecurityOpt = []string{"no-new-privileges:true"}
	case DinDSysbox:
		hc.Runtime = SysboxRuntime
		hc.Mounts = []mount.Mount{{Type: mount.TypeVolume, Target: "/var/lib/docker"}}
	case DinDPrivileged:
		hc.Privileged = true
		hc.Mounts = []mount.Mount{{Type: mount.TypeVolume, Target: "/var/lib/docker"}}
	}
	return hc, nil
}

func (p Profile) validate() error {
	switch {
	case p.PidsLimit <= 0:
		return errors.New("hardening profile: PidsLimit is required")
	case p.MemoryBytes <= 0:
		return errors.New("hardening profile: MemoryBytes is required")
	case p.NanoCPUs <= 0:
		return errors.New("hardening profile: NanoCPUs is required")
	case p.Nofile <= 0:
		return errors.New("hardening profile: Nofile is required")
	case p.LogMaxSizeBytes <= 0 || p.LogMaxFiles <= 0:
		return errors.New("hardening profile: log rotation is required")
	case p.NetworkMode == "":
		return errors.New("hardening profile: NetworkMode is required")
	case p.DinD != DinDNone && p.DinD != DinDSysbox && p.DinD != DinDPrivileged:
		return fmt.Errorf("hardening profile: unknown DinD mode %q", p.DinD)
	}
	if p.DinD == DinDNone {
		for _, c := range p.CapAdd {
			if !slices.Contains(AllowedCapAdd, c) {
				return fmt.Errorf("hardening profile: capability %s is not in the allowlist %v", c, AllowedCapAdd)
			}
		}
	}
	return nil
}

// dockerSize renders a byte count for the log driver's max-size ("20m", "512k" or plain bytes).
func dockerSize(n int64) string {
	switch {
	case n%(1<<20) == 0:
		return strconv.FormatInt(n>>20, 10) + "m"
	case n%(1<<10) == 0:
		return strconv.FormatInt(n>>10, 10) + "k"
	default:
		return strconv.FormatInt(n, 10)
	}
}

// WorkerResources returns the container limits of a worker: processes × memoryMiB MiB + 256 MiB and
// processes × cpus CPUs (docs/api.md §7.2).
func WorkerResources(processes int, perProcess api.Resources) (memoryBytes, nanoCPUs int64) {
	memoryBytes = int64(processes)*perProcess.MemoryMiB<<20 + MemoryOverheadBytes
	nanoCPUs = int64(float64(processes) * perProcess.CPUs * 1e9)
	return memoryBytes, nanoCPUs
}

// BuildResources returns the limits of describe and check containers: memory max(1 GiB, per-process
// memory + 256 MiB), CPUs max(1, per-process cpus) (docs/tasks.md §9.5).
func BuildResources(perProcess api.Resources) (memoryBytes, nanoCPUs int64) {
	memoryBytes = max(1<<30, perProcess.MemoryMiB<<20+MemoryOverheadBytes)
	nanoCPUs = int64(max(1, perProcess.CPUs) * 1e9)
	return memoryBytes, nanoCPUs
}

// TestRunResources returns the limits of a test-run container: per-process memory + 256 MiB and the
// per-process CPUs (processes is always 1, docs/tasks.md §11.2).
func TestRunResources(perProcess api.Resources) (memoryBytes, nanoCPUs int64) {
	return WorkerResources(1, perProcess)
}

// BuildProfile returns the profile of describe and check containers: no capabilities, network none,
// PIDs limit 256, never privileged.
func BuildProfile(perProcess api.Resources) Profile {
	mem, cpus := BuildResources(perProcess)
	return Profile{
		PidsLimit: BuildPidsLimit, MemoryBytes: mem, NanoCPUs: cpus, Nofile: DefaultNofile,
		LogMaxSizeBytes: DefaultLogMaxSize, LogMaxFiles: DefaultLogMaxFiles, NetworkMode: NetworkNone,
	}
}

// TestRunProfile returns the profile of test-run containers on network (scantor-egress): the worker
// capabilities capAdd, PIDs limit 4096, never privileged.
func TestRunProfile(perProcess api.Resources, network string, capAdd []string) Profile {
	mem, cpus := TestRunResources(perProcess)
	return Profile{
		CapAdd: capAdd, PidsLimit: TestRunPidsLimit, MemoryBytes: mem, NanoCPUs: cpus, Nofile: DefaultNofile,
		LogMaxSizeBytes: DefaultLogMaxSize, LogMaxFiles: DefaultLogMaxFiles, NetworkMode: network,
	}
}
