package node

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"testing"

	dcontainer "github.com/moby/moby/api/types/container"
)

// writeMountinfo writes a /proc/self/mountinfo excerpt of a container whose id is id.
func writeMountinfo(t *testing.T, id string) string {
	t.Helper()
	content := "1386 1379 0:100 / / rw,relatime master:1 - overlay overlay rw\n" +
		"1394 1386 254:1 /docker/containers/" + id + "/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/vda1 rw\n" +
		"1395 1386 254:1 /docker/containers/" + id + "/hostname /etc/hostname rw,relatime - ext4 /dev/vda1 rw\n"
	path := filepath.Join(t.TempDir(), "mountinfo")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestAPIVersionAtLeast(t *testing.T) {
	cases := []struct {
		have string
		want bool
	}{{"1.44", true}, {"1.56", true}, {"2.0", true}, {"1.43", false}, {"1.9", false}, {"", false}, {"x.y", false}}
	for _, tc := range cases {
		if got := apiVersionAtLeast(tc.have, minAPIVersion); got != tc.want {
			t.Errorf("apiVersionAtLeast(%q) = %v", tc.have, got)
		}
	}
}

func TestProbeHostRejectsOldEngines(t *testing.T) {
	docker := newFakeDocker()
	docker.apiVersion = "1.43"
	if _, err := probeHost(t.Context(), docker); err == nil {
		t.Error("Docker Engine < 25 must be rejected")
	}
	docker.apiVersion = "1.56"
	docker.runtimes = []string{"sysbox-runc"}
	h, err := probeHost(t.Context(), docker)
	if err != nil {
		t.Fatal(err)
	}
	if h.engineID != docker.engineID || h.cpus != 8 || h.memoryBytes != 16<<30 || !slices.Equal(h.runtimes, []string{"runc", "sysbox-runc"}) || h.os != "linux" || h.arch != "arm64" {
		t.Errorf("host = %+v", h)
	}
}

func TestInstanceID(t *testing.T) {
	a, err := newInstanceID("4c6f2b1e-9a8d-4e7f-b6c5-3d2e1f0a9b8c")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := newInstanceID("4c6f2b1e-9a8d-4e7f-b6c5-3d2e1f0a9b8c")
	if !regexp.MustCompile(`^4c6f2b1e-9a8d-4e7f-b6c5-3d2e1f0a9b8c:[0-9a-f]{8}$`).MatchString(a) || a == b {
		t.Errorf("instance ids %q, %q: want <engine id>:<8 random hex>", a, b)
	}
}

func TestSelfInspection(t *testing.T) {
	docker := newFakeDocker()
	self := docker.addContainer("scantor-node", nil, dcontainer.StateRunning)
	img := docker.addImage("scantor:dev")
	self.imageID = img.id
	candidates := selfCandidates(writeMountinfo(t, self.id))
	if len(candidates) == 0 || candidates[0] != self.id {
		t.Fatalf("candidates = %v", candidates)
	}
	got, err := inspectSelf(t.Context(), docker, candidates)
	if err != nil || got.containerID != self.id || got.imageID != img.id {
		t.Errorf("self = %+v, %v", got, err)
	}
	// A hostname that is the name of another container is not mistaken for the daemon itself.
	impostor := docker.addContainer("scantor-node-host", nil, dcontainer.StateRunning)
	impostor.imageID = img.id
	if _, err := inspectSelf(t.Context(), docker, []string{"scantor-node-host"}); err == nil {
		t.Error("a container found by name but with another hostname was accepted")
	}
	// Outside a container of this engine (DOCKER_HOST elsewhere), self-inspection fails.
	if _, err := inspectSelf(t.Context(), docker, []string{"0123456789ab"}); err == nil {
		t.Error("an unknown candidate was accepted")
	}
}
