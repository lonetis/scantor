//go:build integration

package container

import (
	"archive/tar"
	"bytes"
	"context"
	"flag"
	"io"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/version"
)

// Integration tests need the host Docker socket (just test-go-integration). Every object they create is
// named scantor-test-* and labelled scantor.test=true, and removed in t.Cleanup.

const baseImage = "alpine:3.24"

// namePrefix prefixes every test object; `-args -name-prefix=…` lets a caller namespace them further.
var namePrefix = flag.String("name-prefix", "scantor-test-", "prefix of the containers and images the integration tests create")

// runtimeImagePrefix and runtimeImageTag select the scantor image (<prefix>scantor:<tag>) the extraction
// test reads.
var (
	runtimeImagePrefix = flag.String("runtime-image-prefix", "", "image prefix of the local scantor image used by the runtime extraction test")
	runtimeImageTag    = flag.String("runtime-image-tag", "dev", "tag of the local scantor image used by the runtime extraction test")
)

func dockerClient(t *testing.T) *client.Client {
	t.Helper()
	c, err := NewClient(version.UserAgent("scantor-test"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := c.Ping(ctx, client.PingOptions{}); err != nil {
		t.Skipf("no Docker daemon: %v", err)
	}
	if _, err := c.ImageInspect(ctx, baseImage); err != nil {
		if err := Pull(ctx, c, baseImage, PullOptions{}); err != nil {
			t.Fatalf("pull %s: %v", baseImage, err)
		}
	}
	return c
}

// buildHostileImage builds an image whose LABELs try to join the scantor compose project and enable
// Traefik routing.
func buildHostileImage(t *testing.T, c *client.Client) string {
	t.Helper()
	ctx := context.Background()
	tag := *namePrefix + "hostile-labels:" + uuid.NewString()[:8]
	dockerfile := "FROM " + baseImage + "\nLABEL traefik.enable=true com.docker.compose.project=scantor scantor.managed=false scantor.kind=editor\n"
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	_ = tw.WriteHeader(&tar.Header{Name: "Dockerfile", Mode: 0o644, Size: int64(len(dockerfile))})
	_, _ = tw.Write([]byte(dockerfile))
	_ = tw.Close()
	resp, err := c.ImageBuild(ctx, &buf, client.ImageBuildOptions{Tags: []string{tag}, Remove: true, Labels: map[string]string{"scantor.test": "true"}})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	t.Cleanup(func() {
		_, _ = c.ImageRemove(context.Background(), tag, client.ImageRemoveOptions{Force: true, PruneChildren: true})
	})
	return tag
}

func TestInjectionHardeningAndLabelOverride(t *testing.T) {
	c := dockerClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	image := buildHostileImage(t, c)

	labels, err := ManagedLabels(KindBuild, Identity{})
	if err != nil {
		t.Fatal(err)
	}
	labels["scantor.test"] = "true"
	name := *namePrefix + uuid.NewString()
	rc := RuntimeContainer{
		Name: name, Image: image, Mode: ModeLocal, Args: []string{"--spec", SpecPath},
		Labels: labels, Profile: BuildProfile(api.Resources{CPUs: 1, MemoryMiB: 64}),
	}
	opts, err := rc.CreateOptions()
	if err != nil {
		t.Fatal(err)
	}
	created, err := c.ContainerCreate(ctx, opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = c.ContainerRemove(context.Background(), created.ID, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true})
	})

	// The "runtime" is a shell script here: it proves the entrypoint, the injected files and their modes.
	script := "#!/bin/sh\necho \"mode=$2 spec=$(cat $4) uid=$(id -u)\"\nls -ld /scantor/out | cut -c1-10\n"
	ok, err := Injected(ctx, c, created.ID)
	if err != nil || ok {
		t.Fatalf("Injected before injection = %v, %v", ok, err)
	}
	if err := Inject(ctx, c, created.ID, NewBinary([]byte(script)), LocalModeFiles([]byte(`{"v":1}`), nil)); err != nil {
		t.Fatal(err)
	}
	if ok, err := Injected(ctx, c, created.ID); err != nil || !ok {
		t.Fatalf("Injected after injection = %v, %v", ok, err)
	}

	inspect, err := c.ContainerInspect(ctx, created.ID, client.ContainerInspectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	got := inspect.Container.Config.Labels
	for k, v := range map[string]string{"traefik.enable": "false", "com.docker.compose.project": "scantor-managed", "scantor.managed": "true", "scantor.kind": "build"} {
		if got[k] != v {
			t.Errorf("run-time label %s = %q, want %q (image labels must be overridden)", k, got[k], v)
		}
	}
	hc := inspect.Container.HostConfig
	if hc.PidsLimit == nil || *hc.PidsLimit != BuildPidsLimit || len(hc.CapDrop) == 0 || hc.Init == nil || !*hc.Init || hc.LogConfig.Type != "local" {
		t.Errorf("host config = %+v", hc)
	}

	if _, err := c.ContainerStart(ctx, created.ID, client.ContainerStartOptions{}); err != nil {
		t.Fatal(err)
	}
	wait := c.ContainerWait(ctx, created.ID, client.ContainerWaitOptions{})
	select {
	case res := <-wait.Result:
		if res.StatusCode != 0 {
			t.Errorf("exit code %d", res.StatusCode)
		}
	case err := <-wait.Error:
		t.Fatal(err)
	}
	logs, err := c.ContainerLogs(ctx, created.ID, client.ContainerLogsOptions{ShowStdout: true, ShowStderr: true})
	if err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	_, _ = stdcopy.StdCopy(&stdout, &stderr, logs)
	_ = logs.Close()
	out := stdout.String()
	if !strings.Contains(out, `mode=local spec={"v":1} uid=0`) || !strings.Contains(out, "drwxrwxrwt") {
		t.Fatalf("container output = %q (stderr %q)", out, stderr.String())
	}
}

func TestRuntimeBinaryExtraction(t *testing.T) {
	c := dockerClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	override := version.ImageOverride{Prefix: *runtimeImagePrefix, Tag: *runtimeImageTag}
	if _, err := c.ImageInspect(ctx, version.ImageRef("scantor", override)); err != nil {
		t.Skipf("%s is not built (just build-images scantor)", version.ImageRef("scantor", override))
	}
	exe, _ := os.Executable()
	r := RuntimeBinary{Docker: c, CacheDir: t.TempDir(), Images: override, Executable: exe}
	bin, err := r.Resolve(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if bin.Size() < 1<<20 {
		t.Fatalf("binary of %d bytes", bin.Size())
	}
	if runtime.GOOS != "linux" && !bytes.HasPrefix(bin.data, []byte("\x7fELF")) {
		t.Fatal("extracted binary is not an ELF file")
	}
}
