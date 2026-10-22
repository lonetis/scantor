package node

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/container"
)

// minAPIVersion is the oldest Engine API the daemon supports (Docker Engine 25, docs/nodes.md §2).
const minAPIVersion = "1.44"

// hostInfo is what the daemon learns about its Docker host at start (docs/nodes.md §5.1 step 4).
type hostInfo struct {
	engineID      string
	hostname      string
	os            string
	arch          string
	kernel        string
	dockerVersion string
	cpus          int
	memoryBytes   int64
	runtimes      []string
}

// probeHost reads /info and /version of the Docker daemon.
func probeHost(ctx context.Context, docker client.APIClient) (hostInfo, error) {
	v, err := docker.ServerVersion(ctx, client.ServerVersionOptions{})
	if err != nil {
		return hostInfo{}, fmt.Errorf("docker version: %w", err)
	}
	if !apiVersionAtLeast(v.APIVersion, minAPIVersion) {
		return hostInfo{}, fmt.Errorf("docker API %s is too old: Docker Engine 25 or newer (API %s) is required", v.APIVersion, minAPIVersion)
	}
	res, err := docker.Info(ctx, client.InfoOptions{})
	if err != nil {
		return hostInfo{}, fmt.Errorf("docker info: %w", err)
	}
	info := res.Info
	if info.ID == "" {
		return hostInfo{}, errors.New("docker info: the daemon reported no engine ID")
	}
	h := hostInfo{
		engineID:      info.ID,
		hostname:      info.Name,
		os:            v.Os,
		arch:          v.Arch,
		kernel:        info.KernelVersion,
		dockerVersion: info.ServerVersion,
		cpus:          info.NCPU,
		memoryBytes:   info.MemTotal,
	}
	for name := range info.Runtimes {
		h.runtimes = append(h.runtimes, name)
	}
	slices.Sort(h.runtimes)
	return h, nil
}

// apiVersionAtLeast compares "major.minor" API versions.
func apiVersionAtLeast(have, want string) bool {
	hMaj, hMin, ok1 := splitVersion(have)
	wMaj, wMin, ok2 := splitVersion(want)
	if !ok1 || !ok2 {
		return false
	}
	return hMaj > wMaj || (hMaj == wMaj && hMin >= wMin)
}

func splitVersion(v string) (int, int, bool) {
	majS, minS, ok := strings.Cut(v, ".")
	if !ok {
		return 0, 0, false
	}
	maj, err1 := strconv.Atoi(majS)
	mnr, err2 := strconv.Atoi(minS)
	return maj, mnr, err1 == nil && err2 == nil
}

// newInstanceID returns "<engine id>:<8 random hex characters>" (docs/nodes.md §5.1 step 5).
func newInstanceID(engineID string) (string, error) {
	var nonce [4]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", fmt.Errorf("instance nonce: %w", err)
	}
	return engineID + ":" + hex.EncodeToString(nonce[:]), nil
}

// selfInfo is the daemon's own container, found by self-inspection.
type selfInfo struct {
	containerID string
	imageID     string
}

var containerIDInMountinfo = regexp.MustCompile(`/containers/([0-9a-f]{64})/`)

// selfCandidates returns ids or names that may identify the daemon's own container: the container id
// that Docker's bind mounts of /etc/hostname, /etc/hosts and /etc/resolv.conf reveal in
// /proc/self/mountinfo, then the hostname (Docker's default hostname is the short container id).
func selfCandidates(mountinfoPath string) []string {
	var out []string
	if f, err := os.Open(mountinfoPath); err == nil { //nolint:gosec // a fixed /proc path
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			if m := containerIDInMountinfo.FindStringSubmatch(sc.Text()); m != nil && !slices.Contains(out, m[1]) {
				out = append(out, m[1])
			}
		}
		_ = f.Close()
	}
	if h, err := os.Hostname(); err == nil && h != "" && !slices.Contains(out, h) {
		out = append(out, h)
	}
	return out
}

// inspectSelf finds the daemon's own container among the candidates. It fails when the daemon does not
// run as a container of this Docker daemon (for example with DOCKER_HOST pointing at another engine).
func inspectSelf(ctx context.Context, docker client.APIClient, candidates []string) (selfInfo, error) {
	for _, c := range candidates {
		res, err := docker.ContainerInspect(ctx, c, client.ContainerInspectOptions{})
		if err != nil {
			if container.IsNotFound(err) {
				continue
			}
			return selfInfo{}, fmt.Errorf("inspect own container: %w", err)
		}
		// A candidate must be the container itself: its full id, or its hostname (a name lookup could
		// otherwise hit an unrelated container that happens to carry that name).
		ctr := res.Container
		if ctr.Image == "" || (ctr.ID != c && (ctr.Config == nil || ctr.Config.Hostname != c)) {
			continue
		}
		return selfInfo{containerID: ctr.ID, imageID: ctr.Image}, nil
	}
	return selfInfo{}, errors.New("the daemon's own container was not found on this Docker daemon")
}
