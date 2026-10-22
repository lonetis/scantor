package node

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"iter"
	"slices"
	"strings"
	"sync"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	dcontainer "github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/events"
	"github.com/moby/moby/api/types/image"
	"github.com/moby/moby/api/types/jsonstream"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/api/types/system"
	"github.com/moby/moby/client"
)

// fakeDocker is an in-memory Docker engine implementing the subset of client.APIClient the daemon uses.
// Calls to other methods panic through the nil embedded interface.
type fakeDocker struct {
	client.APIClient

	mu         sync.Mutex
	seq        int
	containers map[string]*fakeContainer // by id
	images     map[string]*fakeImage     // by id
	networks   map[string]bool
	subs       []chan events.Message
	calls      []string

	// Behaviour knobs.
	engineID   string
	os, arch   string
	apiVersion string
	ncpu       int
	memTotal   int64
	runtimes   []string
	// pullErr fails pulls of matching references.
	pullErr func(ref string) error
	// pullImage decides the platform of pulled images (default: the engine's).
	pullPlatform func(ref string) (string, string)
	// onStart runs after a container started (for example to let it exit at once).
	onStart func(f *fakeDocker, c *fakeContainer)
	// updateErr fails ContainerUpdate.
	updateErr error
	// createErr fails ContainerCreate.
	createErr func(opts client.ContainerCreateOptions) error
	// logs are the log lines of containers by name.
	logs map[string]string
	// pulls records X-Registry-Auth values per reference.
	pullAuth                        map[string]string
	pullsInFlight, maxPullsInFlight int
	pullDelay                       time.Duration
}

type fakeContainer struct {
	id       string
	name     string
	config   dcontainer.Config
	host     dcontainer.HostConfig
	netCfg   *network.NetworkingConfig
	state    dcontainer.State
	files    map[string][]byte
	imageID  string
	waiters  []chan dcontainer.WaitResponse
	updates  int
	starts   int
	stopArgs []int
}

type fakeImage struct {
	id          string
	repoTags    []string
	repoDigests []string
	os, arch    string
}

func newFakeDocker() *fakeDocker {
	return &fakeDocker{
		containers: map[string]*fakeContainer{},
		images:     map[string]*fakeImage{},
		networks:   map[string]bool{"bridge": true, "host": true, "none": true},
		engineID:   "4c6f2b1e-9a8d-4e7f-b6c5-3d2e1f0a9b8c",
		os:         "linux",
		arch:       "arm64",
		apiVersion: "1.56",
		ncpu:       8,
		memTotal:   16 << 30,
		logs:       map[string]string{},
		pullAuth:   map[string]string{},
	}
}

var errFakeNotFound = cerrdefs.ErrNotFound
var errFakeConflict = cerrdefs.ErrConflict

func (f *fakeDocker) record(call string) {
	f.calls = append(f.calls, call)
}

func (f *fakeDocker) callCount(prefix string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func (f *fakeDocker) nextID() string {
	f.seq++
	return fmt.Sprintf("%064x", f.seq)
}

// addImage registers a local image.
func (f *fakeDocker) addImage(refs ...string) *fakeImage {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.addImageLocked(f.os, f.arch, refs...)
}

func (f *fakeDocker) addImageLocked(osName, arch string, refs ...string) *fakeImage {
	img := &fakeImage{id: "sha256:" + f.nextID(), os: osName, arch: arch}
	for _, r := range refs {
		if strings.Contains(r, "@") {
			img.repoDigests = append(img.repoDigests, r)
		} else {
			img.repoTags = append(img.repoTags, r)
		}
	}
	f.images[img.id] = img
	return img
}

func (f *fakeDocker) findImage(ref string) *fakeImage {
	for _, img := range f.images {
		if img.id == ref || slices.Contains(img.repoTags, ref) || slices.Contains(img.repoDigests, ref) {
			return img
		}
	}
	return nil
}

func (f *fakeDocker) findContainer(ref string) *fakeContainer {
	ref = strings.TrimPrefix(ref, "/")
	if c, ok := f.containers[ref]; ok {
		return c
	}
	for _, c := range f.containers {
		if c.name == ref || (len(ref) >= 12 && strings.HasPrefix(c.id, ref)) {
			return c
		}
	}
	return nil
}

// addContainer creates a container directly (adoption scenarios, foreign containers).
func (f *fakeDocker) addContainer(name string, labels map[string]string, status dcontainer.ContainerState) *fakeContainer {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := &fakeContainer{
		id: f.nextID(), name: name,
		config: dcontainer.Config{Labels: labels, Image: "img"},
		host:   dcontainer.HostConfig{Resources: dcontainer.Resources{Memory: 1 << 30, NanoCPUs: 1e9}},
		state:  dcontainer.State{Status: status, Running: status == dcontainer.StateRunning, StartedAt: time.Now().UTC().Format(time.RFC3339Nano), FinishedAt: "0001-01-01T00:00:00Z"},
		files:  map[string][]byte{},
	}
	f.containers[c.id] = c
	return c
}

func (f *fakeDocker) container(name string) *fakeContainer {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.findContainer(name)
}

func (f *fakeDocker) emit(c *fakeContainer, action events.Action) {
	msg := events.Message{Type: events.ContainerEventType, Action: action, Actor: events.Actor{ID: c.id, Attributes: c.config.Labels}}
	for _, ch := range f.subs {
		select {
		case ch <- msg:
		default:
		}
	}
}

// exit lets a running container exit.
func (f *fakeDocker) exit(name string, code int, oom bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.findContainer(name)
	f.exitLocked(c, code, oom)
}

func (f *fakeDocker) exitLocked(c *fakeContainer, code int, oom bool) {
	c.state.Status = dcontainer.StateExited
	c.state.Running = false
	c.state.ExitCode = code
	c.state.OOMKilled = oom
	c.state.FinishedAt = time.Now().UTC().Format(time.RFC3339Nano)
	for _, w := range c.waiters {
		w <- dcontainer.WaitResponse{StatusCode: int64(code)}
	}
	c.waiters = nil
	f.emit(c, events.ActionDie)
}

// Engine API subset.

func (f *fakeDocker) ServerVersion(context.Context, client.ServerVersionOptions) (client.ServerVersionResult, error) {
	return client.ServerVersionResult{Version: "29.9.1", APIVersion: f.apiVersion, Os: f.os, Arch: f.arch}, nil
}

func (f *fakeDocker) Info(context.Context, client.InfoOptions) (client.SystemInfoResult, error) {
	rt := map[string]system.RuntimeWithStatus{"runc": {}}
	for _, r := range f.runtimes {
		rt[r] = system.RuntimeWithStatus{}
	}
	return client.SystemInfoResult{Info: system.Info{
		ID: f.engineID, Name: "fake-host", KernelVersion: "6.8.0", ServerVersion: "29.9.1",
		NCPU: f.ncpu, MemTotal: f.memTotal, Runtimes: rt,
	}}, nil
}

func (f *fakeDocker) inspectLocked(c *fakeContainer) dcontainer.InspectResponse {
	cfg := c.config
	host := c.host
	state := c.state
	return dcontainer.InspectResponse{ID: c.id, Name: "/" + c.name, Image: c.imageID, Config: &cfg, HostConfig: &host, State: &state}
}

func (f *fakeDocker) ContainerInspect(_ context.Context, ref string, _ client.ContainerInspectOptions) (client.ContainerInspectResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("inspect " + ref)
	c := f.findContainer(ref)
	if c == nil {
		return client.ContainerInspectResult{}, fmt.Errorf("no such container %s: %w", ref, errFakeNotFound)
	}
	return client.ContainerInspectResult{Container: f.inspectLocked(c)}, nil
}

func (f *fakeDocker) ContainerList(_ context.Context, opts client.ContainerListOptions) (client.ContainerListResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []dcontainer.Summary
	for _, c := range f.containers {
		if !opts.All && c.state.Status != dcontainer.StateRunning {
			continue
		}
		if !matchesFilters(c, opts.Filters) {
			continue
		}
		out = append(out, dcontainer.Summary{ID: c.id, Names: []string{"/" + c.name}, Labels: c.config.Labels, State: c.state.Status, ImageID: c.imageID})
	}
	return client.ContainerListResult{Items: out}, nil
}

func matchesFilters(c *fakeContainer, filters client.Filters) bool {
	for term, values := range filters {
		for v := range values {
			switch term {
			case "label":
				k, val, _ := strings.Cut(v, "=")
				if c.config.Labels[k] != val {
					return false
				}
			case "name":
				if !strings.Contains(c.name, v) {
					return false
				}
			}
		}
	}
	return true
}

func (f *fakeDocker) ContainerCreate(_ context.Context, opts client.ContainerCreateOptions) (client.ContainerCreateResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("create " + opts.Name)
	if f.createErr != nil {
		if err := f.createErr(opts); err != nil {
			return client.ContainerCreateResult{}, err
		}
	}
	if f.findContainer(opts.Name) != nil {
		return client.ContainerCreateResult{}, fmt.Errorf("the container name %q is already in use: %w", opts.Name, errFakeConflict)
	}
	img := f.findImage(opts.Config.Image)
	if img == nil {
		return client.ContainerCreateResult{}, fmt.Errorf("no such image %s: %w", opts.Config.Image, errFakeNotFound)
	}
	if opts.HostConfig != nil && opts.HostConfig.NetworkMode != "" && !f.networks[string(opts.HostConfig.NetworkMode)] && !strings.HasPrefix(string(opts.HostConfig.NetworkMode), "container:") {
		return client.ContainerCreateResult{}, fmt.Errorf("network %s not found: %w", opts.HostConfig.NetworkMode, errFakeNotFound)
	}
	c := &fakeContainer{
		id: f.nextID(), name: opts.Name, config: *opts.Config, netCfg: opts.NetworkingConfig,
		state: dcontainer.State{Status: dcontainer.StateCreated, StartedAt: "0001-01-01T00:00:00Z", FinishedAt: "0001-01-01T00:00:00Z"},
		files: map[string][]byte{}, imageID: img.id,
	}
	if opts.HostConfig != nil {
		c.host = *opts.HostConfig
	}
	f.containers[c.id] = c
	f.emit(c, events.ActionCreate)
	return client.ContainerCreateResult{ID: c.id}, nil
}

func (f *fakeDocker) ContainerStart(_ context.Context, ref string, _ client.ContainerStartOptions) (client.ContainerStartResult, error) {
	f.mu.Lock()
	f.record("start " + ref)
	c := f.findContainer(ref)
	if c == nil {
		f.mu.Unlock()
		return client.ContainerStartResult{}, fmt.Errorf("no such container: %w", errFakeNotFound)
	}
	if c.state.Status == dcontainer.StateRunning {
		f.mu.Unlock()
		return client.ContainerStartResult{}, nil
	}
	if _, ok := c.files["/scantor/scantor"]; !ok && len(c.config.Entrypoint) > 0 && c.config.Entrypoint[0] == "/scantor/scantor" {
		f.mu.Unlock()
		return client.ContainerStartResult{}, errors.New("exec: /scantor/scantor: no such file or directory")
	}
	c.starts++
	c.state.Status = dcontainer.StateRunning
	c.state.Running = true
	c.state.ExitCode = 0
	c.state.OOMKilled = false
	c.state.StartedAt = time.Now().UTC().Format(time.RFC3339Nano)
	f.emit(c, events.ActionStart)
	onStart := f.onStart
	f.mu.Unlock()
	if onStart != nil {
		onStart(f, c)
	}
	return client.ContainerStartResult{}, nil
}

func (f *fakeDocker) ContainerStop(_ context.Context, ref string, opts client.ContainerStopOptions) (client.ContainerStopResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("stop " + ref)
	c := f.findContainer(ref)
	if c == nil {
		return client.ContainerStopResult{}, fmt.Errorf("no such container: %w", errFakeNotFound)
	}
	if opts.Timeout != nil {
		c.stopArgs = append(c.stopArgs, *opts.Timeout)
	}
	if c.state.Status == dcontainer.StateRunning {
		f.exitLocked(c, 0, false)
	}
	return client.ContainerStopResult{}, nil
}

func (f *fakeDocker) ContainerRemove(_ context.Context, ref string, opts client.ContainerRemoveOptions) (client.ContainerRemoveResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record(fmt.Sprintf("remove %s force=%v v=%v", ref, opts.Force, opts.RemoveVolumes))
	c := f.findContainer(ref)
	if c == nil {
		return client.ContainerRemoveResult{}, fmt.Errorf("no such container: %w", errFakeNotFound)
	}
	if c.state.Status == dcontainer.StateRunning && !opts.Force {
		return client.ContainerRemoveResult{}, fmt.Errorf("container is running: %w", errFakeConflict)
	}
	delete(f.containers, c.id)
	f.emit(c, events.ActionDestroy)
	return client.ContainerRemoveResult{}, nil
}

func (f *fakeDocker) ContainerUpdate(_ context.Context, ref string, opts client.ContainerUpdateOptions) (client.ContainerUpdateResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("update " + ref)
	if f.updateErr != nil {
		return client.ContainerUpdateResult{}, f.updateErr
	}
	c := f.findContainer(ref)
	if c == nil {
		return client.ContainerUpdateResult{}, fmt.Errorf("no such container: %w", errFakeNotFound)
	}
	c.updates++
	if r := opts.Resources; r != nil {
		c.host.Memory, c.host.MemorySwap, c.host.NanoCPUs = r.Memory, r.MemorySwap, r.NanoCPUs
	}
	return client.ContainerUpdateResult{}, nil
}

func (f *fakeDocker) ContainerWait(_ context.Context, ref string, _ client.ContainerWaitOptions) client.ContainerWaitResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	res := make(chan dcontainer.WaitResponse, 1)
	errs := make(chan error, 1)
	c := f.findContainer(ref)
	if c == nil {
		errs <- fmt.Errorf("no such container: %w", errFakeNotFound)
		return client.ContainerWaitResult{Result: res, Error: errs}
	}
	c.waiters = append(c.waiters, res)
	return client.ContainerWaitResult{Result: res, Error: errs}
}

// ContainerLogs returns the configured log text of the container in Docker's multiplexed format.
func (f *fakeDocker) ContainerLogs(_ context.Context, ref string, _ client.ContainerLogsOptions) (client.ContainerLogsResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.findContainer(ref)
	if c == nil {
		return nil, fmt.Errorf("no such container: %w", errFakeNotFound)
	}
	var buf bytes.Buffer
	text := f.logs[c.name]
	for len(text) > 0 {
		chunk := text[:min(len(text), 1000)]
		text = text[len(chunk):]
		hdr := [8]byte{1}
		binary.BigEndian.PutUint32(hdr[4:], uint32(len(chunk))) //nolint:gosec // test data
		buf.Write(hdr[:])
		buf.WriteString(chunk)
	}
	return io.NopCloser(&buf), nil
}

func (f *fakeDocker) CopyToContainer(_ context.Context, ref string, opts client.CopyToContainerOptions) (client.CopyToContainerResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("copy " + ref)
	c := f.findContainer(ref)
	if c == nil {
		return client.CopyToContainerResult{}, fmt.Errorf("no such container: %w", errFakeNotFound)
	}
	tr := tar.NewReader(opts.Content)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return client.CopyToContainerResult{}, err
		}
		data, _ := io.ReadAll(tr)
		c.files[strings.TrimSuffix(opts.DestinationPath, "/")+"/"+strings.TrimSuffix(hdr.Name, "/")] = data
	}
	return client.CopyToContainerResult{}, nil
}

func (f *fakeDocker) ContainerStatPath(_ context.Context, ref string, opts client.ContainerStatPathOptions) (client.ContainerStatPathResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.findContainer(ref)
	if c == nil {
		return client.ContainerStatPathResult{}, fmt.Errorf("no such container: %w", errFakeNotFound)
	}
	if _, ok := c.files[opts.Path]; !ok {
		return client.ContainerStatPathResult{}, fmt.Errorf("no such file: %w", errFakeNotFound)
	}
	return client.ContainerStatPathResult{Stat: dcontainer.PathStat{Name: opts.Path}}, nil
}

func (f *fakeDocker) ImageInspect(_ context.Context, ref string, _ ...client.ImageInspectOption) (client.ImageInspectResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	img := f.findImage(ref)
	if img == nil {
		return client.ImageInspectResult{}, fmt.Errorf("no such image %s: %w", ref, errFakeNotFound)
	}
	return client.ImageInspectResult{InspectResponse: image.InspectResponse{ID: img.id, RepoTags: img.repoTags, RepoDigests: img.repoDigests, Os: img.os, Architecture: img.arch}}, nil
}

type fakePull struct {
	io.Reader
	msgs []jsonstream.Message
}

func (p *fakePull) Close() error { return nil }
func (p *fakePull) JSONMessages(context.Context) iter.Seq2[jsonstream.Message, error] {
	return func(yield func(jsonstream.Message, error) bool) {
		for _, m := range p.msgs {
			if !yield(m, nil) {
				return
			}
		}
	}
}
func (p *fakePull) Wait(context.Context) error { return nil }

func (f *fakeDocker) ImagePull(ctx context.Context, ref string, opts client.ImagePullOptions) (client.ImagePullResponse, error) {
	f.mu.Lock()
	f.record("pull " + ref)
	f.pullAuth[ref] = opts.RegistryAuth
	f.pullsInFlight++
	f.maxPullsInFlight = max(f.maxPullsInFlight, f.pullsInFlight)
	delay := f.pullDelay
	f.mu.Unlock()
	defer func() {
		f.mu.Lock()
		f.pullsInFlight--
		f.mu.Unlock()
	}()
	if delay > 0 {
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.pullErr != nil {
		if err := f.pullErr(ref); err != nil {
			return &fakePull{Reader: strings.NewReader(""), msgs: []jsonstream.Message{{Error: &jsonstream.Error{Message: err.Error()}}}}, nil
		}
	}
	if f.findImage(ref) == nil {
		osName, arch := f.os, f.arch
		if f.pullPlatform != nil {
			osName, arch = f.pullPlatform(ref)
		}
		f.addImageLocked(osName, arch, ref)
	}
	return &fakePull{Reader: strings.NewReader(""), msgs: []jsonstream.Message{{Status: "Pull complete"}}}, nil
}

func (f *fakeDocker) ImageList(context.Context, client.ImageListOptions) (client.ImageListResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []image.Summary
	for _, img := range f.images {
		out = append(out, image.Summary{ID: img.id, RepoTags: img.repoTags, RepoDigests: img.repoDigests})
	}
	return client.ImageListResult{Items: out}, nil
}

func (f *fakeDocker) ImageRemove(_ context.Context, ref string, opts client.ImageRemoveOptions) (client.ImageRemoveResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record(fmt.Sprintf("rmi %s force=%v", ref, opts.Force))
	img := f.findImage(ref)
	if img == nil {
		return client.ImageRemoveResult{}, fmt.Errorf("no such image: %w", errFakeNotFound)
	}
	if ref == img.id && len(img.repoTags) > 1 && !opts.Force {
		return client.ImageRemoveResult{}, fmt.Errorf("image is referenced in multiple repositories: %w", errFakeConflict)
	}
	if ref != img.id {
		img.repoTags = slices.DeleteFunc(img.repoTags, func(t string) bool { return t == ref })
		if len(img.repoTags) > 0 {
			return client.ImageRemoveResult{}, nil
		}
	}
	delete(f.images, img.id)
	return client.ImageRemoveResult{}, nil
}

func (f *fakeDocker) NetworkInspect(_ context.Context, name string, _ client.NetworkInspectOptions) (client.NetworkInspectResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.networks[name] {
		return client.NetworkInspectResult{}, fmt.Errorf("network %s not found: %w", name, errFakeNotFound)
	}
	return client.NetworkInspectResult{}, nil
}

func (f *fakeDocker) NetworkCreate(_ context.Context, name string, _ client.NetworkCreateOptions) (client.NetworkCreateResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("network create " + name)
	if f.networks[name] {
		return client.NetworkCreateResult{}, fmt.Errorf("network with name %s already exists: %w", name, errFakeConflict)
	}
	f.networks[name] = true
	return client.NetworkCreateResult{ID: name}, nil
}

func (f *fakeDocker) Events(ctx context.Context, _ client.EventsListOptions) client.EventsResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	ch := make(chan events.Message, 64)
	errs := make(chan error, 1)
	f.subs = append(f.subs, ch)
	go func() {
		<-ctx.Done()
		errs <- ctx.Err()
	}()
	return client.EventsResult{Messages: ch, Err: errs}
}
