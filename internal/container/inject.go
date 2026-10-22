package container

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
)

// Paths of the injected runtime (docs/runtime.md §3.1).
const (
	BinaryPath = "/scantor/scantor"
	InDir      = "/scantor/in"
	OutDir     = "/scantor/out"
	SpecPath   = "/scantor/in/spec.json"
	UploadsDir = "/scantor/in/uploads"
)

// Runtime modes.
const (
	ModeWorker   = "worker"
	ModeLocal    = "local"
	ModeDescribe = "describe"
	ModeCheck    = "check"
)

// RuntimeEntrypoint returns ["/scantor/scantor", "runtime", mode, args...].
func RuntimeEntrypoint(mode string, args ...string) []string {
	return append([]string{BinaryPath, "runtime", mode}, args...)
}

// Binary is a static linux scantor binary to inject, held in memory (read once per process).
type Binary struct {
	data []byte
}

// LoadBinary reads the binary at path.
func LoadBinary(path string) (*Binary, error) {
	data, err := os.ReadFile(path) //nolint:gosec // the caller passes its own executable or the runtime cache path
	if err != nil {
		return nil, fmt.Errorf("read runtime binary: %w", err)
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("read runtime binary %s: empty file", path)
	}
	return &Binary{data: data}, nil
}

// NewBinary wraps binary content (tests, extraction).
func NewBinary(data []byte) *Binary { return &Binary{data: data} }

// Size returns the binary size in bytes.
func (b *Binary) Size() int { return len(b.data) }

// File is an extra entry of the injection archive. Path is relative to "/" and must lie below
// "scantor/" (for example "scantor/in/spec.json"); parent directories are added with mode 0755.
type File struct {
	Path string
	Mode int64
	Data []byte
	// Dir marks a directory entry (Data must be empty).
	Dir bool
}

// LocalModeFiles returns the extra entries of a local-mode container: scantor/in/ (0755),
// scantor/in/spec.json (0644), scantor/in/uploads/<id> (0644) for each referenced upload, and
// scantor/out/ (01777).
func LocalModeFiles(spec []byte, uploads map[string][]byte) []File {
	files := []File{
		{Path: "scantor/in", Dir: true, Mode: 0o755},
		{Path: "scantor/in/spec.json", Mode: 0o644, Data: spec},
		{Path: "scantor/out", Dir: true, Mode: 0o1777},
	}
	ids := make([]string, 0, len(uploads))
	for id := range uploads {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	if len(ids) > 0 {
		files = append(files, File{Path: "scantor/in/uploads", Dir: true, Mode: 0o755})
	}
	for _, id := range ids {
		files = append(files, File{Path: "scantor/in/uploads/" + id, Mode: 0o644, Data: uploads[id]})
	}
	return files
}

// InjectionArchive writes the injection tar to w: the directory scantor/ (0755), the file
// scantor/scantor (0755) and the extra entries, all owned by 0:0 with a fixed mtime.
func InjectionArchive(w io.Writer, bin *Binary, extra []File) error {
	if bin == nil || len(bin.data) == 0 {
		return errors.New("injection archive: no runtime binary")
	}
	entries := []File{{Path: "scantor", Dir: true, Mode: 0o755}, {Path: "scantor/scantor", Mode: 0o755, Data: bin.data}}
	seen := map[string]bool{"scantor": true, "scantor/scantor": true}
	for _, f := range extra {
		p := path.Clean(f.Path)
		if p != f.Path || !strings.HasPrefix(p, "scantor/") || strings.Contains(p, "..") {
			return fmt.Errorf("injection archive: invalid path %q", f.Path)
		}
		if seen[p] {
			continue
		}
		for dir := path.Dir(p); dir != "scantor" && !seen[dir]; dir = path.Dir(dir) {
			entries = append(entries, File{Path: dir, Dir: true, Mode: 0o755})
			seen[dir] = true
		}
		seen[p] = true
		entries = append(entries, f)
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	tw := tar.NewWriter(w)
	mtime := time.Unix(0, 0)
	for _, e := range entries {
		hdr := &tar.Header{Name: e.Path, Mode: e.Mode, ModTime: mtime, Uid: 0, Gid: 0, Format: tar.FormatPAX}
		if e.Dir {
			if len(e.Data) > 0 {
				return fmt.Errorf("injection archive: directory %q has data", e.Path)
			}
			hdr.Typeflag = tar.TypeDir
			hdr.Name += "/"
		} else {
			hdr.Typeflag = tar.TypeReg
			hdr.Size = int64(len(e.Data))
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return fmt.Errorf("injection archive: %w", err)
		}
		if !e.Dir {
			if _, err := tw.Write(e.Data); err != nil {
				return fmt.Errorf("injection archive: %w", err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		return fmt.Errorf("injection archive: %w", err)
	}
	return nil
}

// Inject copies the runtime binary and the extra entries into a created (not yet started) container
// with one CopyToContainer at "/".
func Inject(ctx context.Context, docker client.APIClient, containerID string, bin *Binary, extra []File) error {
	var buf bytes.Buffer
	if err := InjectionArchive(&buf, bin, extra); err != nil {
		return err
	}
	if _, err := docker.CopyToContainer(ctx, containerID, client.CopyToContainerOptions{
		DestinationPath: "/",
		Content:         &buf,
	}); err != nil {
		return fmt.Errorf("inject runtime into %s: %w", shortID(containerID), err)
	}
	return nil
}

// Injected reports whether the runtime binary already exists in the container (an exited container
// restarted in place keeps its writable layer).
func Injected(ctx context.Context, docker client.APIClient, containerID string) (bool, error) {
	_, err := docker.ContainerStatPath(ctx, containerID, client.ContainerStatPathOptions{Path: BinaryPath})
	if err == nil {
		return true, nil
	}
	if isNotFound(err) {
		return false, nil
	}
	return false, fmt.Errorf("stat %s in %s: %w", BinaryPath, shortID(containerID), err)
}

// RuntimeContainer describes a task container whose entrypoint is the injected runtime.
type RuntimeContainer struct {
	Name    string
	Image   string
	Mode    string
	Args    []string
	Env     []string
	Labels  map[string]string
	Profile Profile
	// StopTimeoutSeconds is the grace between SIGTERM and SIGKILL; 0 keeps Docker's default.
	StopTimeoutSeconds int
}

// CreateOptions returns the ContainerCreate options: entrypoint /scantor/scantor runtime <mode>,
// an explicit empty Cmd, the image's WORKDIR and USER, the managed labels as run-time labels, the
// hardening profile and exactly one network.
func (r RuntimeContainer) CreateOptions() (client.ContainerCreateOptions, error) {
	if r.Name == "" || r.Image == "" || r.Mode == "" {
		return client.ContainerCreateOptions{}, errors.New("runtime container: name, image and mode are required")
	}
	if r.Labels[LabelManaged] != "true" {
		return client.ContainerCreateOptions{}, errors.New("runtime container: managed labels are required")
	}
	hc, err := r.Profile.HostConfig()
	if err != nil {
		return client.ContainerCreateOptions{}, err
	}
	cfg := &container.Config{
		Image:      r.Image,
		Entrypoint: RuntimeEntrypoint(r.Mode, r.Args...),
		Cmd:        []string{},
		Env:        r.Env,
		Labels:     r.Labels,
		StopSignal: "SIGTERM",
	}
	if r.StopTimeoutSeconds > 0 {
		t := r.StopTimeoutSeconds
		cfg.StopTimeout = &t
	}
	opts := client.ContainerCreateOptions{Name: r.Name, Config: cfg, HostConfig: hc}
	if nm := r.Profile.NetworkMode; nm != NetworkNone && nm != NetworkHost {
		opts.NetworkingConfig = &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{nm: {}}}
	}
	return opts, nil
}

func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}
