package container

import (
	"archive/tar"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"

	"github.com/lonetis/scantor/internal/version"
)

// ImageBinaryPath is the path of the scantor binary inside the scantor image.
const ImageBinaryPath = "/usr/local/bin/scantor"

// maxBinaryBytes bounds an extracted binary.
const maxBinaryBytes = 512 << 20

// RuntimeBinary resolves the linux scantor binary to inject into task containers
// (docs/tasks.md §9.6): the consumer's own executable when it is a linux binary of the daemon's
// architecture; otherwise the binary extracted once from the scantor image <prefix>scantor:<tag> and
// cached under <CacheDir>/scantor/runtime/<image id>-linux-<arch>.
type RuntimeBinary struct {
	Docker client.APIClient
	// CacheDir is the user cache directory (os.UserCacheDir of the caller).
	CacheDir string
	// Images is the image-reference override (SCANTOR_IMAGE_PREFIX / SCANTOR_IMAGE_TAG).
	Images version.ImageOverride
	// Executable is the path of the running binary (os.Executable of the caller).
	Executable string
	// Progress receives pull progress of the scantor image; nil discards it.
	Progress func(string)
}

// Resolve returns the binary to inject.
func (r RuntimeBinary) Resolve(ctx context.Context) (*Binary, error) {
	daemonOS, arch, err := DaemonPlatform(ctx, r.Docker)
	if err != nil {
		return nil, err
	}
	if daemonOS != "linux" {
		return nil, fmt.Errorf("the Docker daemon runs %s containers; scantor needs a linux daemon", daemonOS)
	}
	if NativeFor(daemonOS, arch) {
		if r.Executable == "" {
			return nil, errors.New("runtime binary: unknown executable path")
		}
		return LoadBinary(r.Executable)
	}
	path, err := r.extract(ctx, arch)
	if err != nil {
		return nil, err
	}
	return LoadBinary(path)
}

// extract returns the cached path of the linux binary for arch, extracting it when needed.
func (r RuntimeBinary) extract(ctx context.Context, arch string) (string, error) {
	if r.CacheDir == "" {
		return "", errors.New("runtime binary: no cache directory")
	}
	ref := version.ImageRef("scantor", r.Images)
	platform := &ocispec.Platform{OS: "linux", Architecture: arch}
	// Inspect without a platform option: it needs no recent API version, and the daemon reports its
	// default (native) platform, which is the one needed.
	inspect, err := r.Docker.ImageInspect(ctx, ref)
	if err != nil && !IsNotFound(err) {
		return "", fmt.Errorf("inspect %s: %w", ref, err)
	}
	if err != nil || inspect.Architecture != arch {
		if r.Progress != nil {
			r.Progress(fmt.Sprintf("pulling %s (linux/%s) to extract the runtime", ref, arch))
		}
		if err := Pull(ctx, r.Docker, ref, PullOptions{Platform: platform}); err != nil {
			return "", fmt.Errorf("the runtime for linux/%s comes from %s: %w", arch, ref, err)
		}
		if inspect, err = r.Docker.ImageInspect(ctx, ref); err != nil {
			return "", fmt.Errorf("inspect %s: %w", ref, err)
		}
	}
	if inspect.Architecture != arch {
		return "", fmt.Errorf("%s is a %s image; the daemon needs %s", ref, inspect.Architecture, arch)
	}
	id := strings.TrimPrefix(inspect.ID, "sha256:")
	if id == "" {
		return "", fmt.Errorf("inspect %s: no image id", ref)
	}
	dir := filepath.Join(r.CacheDir, "scantor", "runtime")
	target := filepath.Join(dir, id+"-linux-"+arch)
	if st, err := os.Stat(target); err == nil && st.Mode().IsRegular() && st.Size() > 0 {
		return target, nil
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", fmt.Errorf("runtime cache: %w", err)
	}
	if err := r.copyOut(ctx, inspect.ID, platform, dir, target); err != nil {
		return "", fmt.Errorf("extract the runtime from %s: %w", ref, err)
	}
	return target, nil
}

// copyOut creates (never starts) a container of the image, copies the binary out and removes the
// container. The container carries the managed labels of kind build.
func (r RuntimeBinary) copyOut(ctx context.Context, imageID string, platform *ocispec.Platform, dir, target string) error {
	labels, err := ManagedLabels(KindBuild, Identity{})
	if err != nil {
		return err
	}
	created, err := r.Docker.ContainerCreate(ctx, client.ContainerCreateOptions{
		Name:     Name(KindBuild, uuid.NewString()),
		Platform: platform,
		Config: &container.Config{
			Image:      imageID,
			Entrypoint: []string{ImageBinaryPath},
			Cmd:        []string{"version"},
			Labels:     labels,
		},
		HostConfig: &container.HostConfig{NetworkMode: NetworkNone},
	})
	if err != nil {
		return fmt.Errorf("create extraction container: %w", err)
	}
	defer func() {
		// The extraction container never ran; removing it is cleanup on every path, including ctx
		// cancellation, so a fresh context is used.
		_, _ = r.Docker.ContainerRemove(context.WithoutCancel(ctx), created.ID, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true})
	}()
	res, err := r.Docker.CopyFromContainer(ctx, created.ID, client.CopyFromContainerOptions{SourcePath: ImageBinaryPath})
	if err != nil {
		return fmt.Errorf("copy %s: %w", ImageBinaryPath, err)
	}
	defer res.Content.Close()
	tmp, err := os.CreateTemp(dir, ".extract-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // no-op after the rename succeeded
	if err := firstRegularFile(res.Content, tmp); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o755); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), target)
}

func firstRegularFile(r io.Reader, w io.Writer) error {
	tr := tar.NewReader(r)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return errors.New("the archive contains no regular file")
		}
		if err != nil {
			return fmt.Errorf("read archive: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		if hdr.Size <= 0 || hdr.Size > maxBinaryBytes {
			return fmt.Errorf("unexpected binary size %d", hdr.Size)
		}
		if _, err := io.CopyN(w, tr, hdr.Size); err != nil {
			return fmt.Errorf("read binary: %w", err)
		}
		return nil
	}
}
