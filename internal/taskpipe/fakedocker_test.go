package taskpipe

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"iter"
	"net"
	"strings"
	"sync"
	"testing"

	cerrdefs "github.com/containerd/errdefs"
	containertypes "github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/image"
	"github.com/moby/moby/api/types/jsonstream"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/container"
)

// fakeDocker is an in-memory Docker engine with the subset of client.APIClient the task pipeline uses.
// Calls to other methods panic through the nil embedded interface.
type fakeDocker struct {
	client.APIClient

	mu     sync.Mutex
	seq    int
	images map[string]image.InspectResponse // by reference and id
	// remote holds the images a pull can fetch.
	remote map[string]image.InspectResponse
	pulls  []string
	// registry holds the digest references a distribution inspect finds.
	registry           map[string]bool
	distributionChecks []string

	// build decides the outcome of ImageBuild: the stream messages and the built image (nil: none).
	// block makes the build hang until its context ends.
	build func(opts client.ImageBuildOptions) (msgs []jsonstream.Message, built *image.InspectResponse, block bool)
	// buildOpts and buildContexts record every build.
	buildOpts     []client.ImageBuildOptions
	buildContexts [][]byte
	cancelled     []string
	pruned        []client.BuildCachePruneOptions
	removedImages []string

	containers []*fakeContainer
	// run decides what a started container prints and how it exits.
	run func(c *fakeContainer) fakeRun

	pushes   []fakePushCall
	pushMsgs []jsonstream.Message
}

type fakePushCall struct {
	Ref  string
	Opts client.ImagePushOptions
}

// fakeRun is the scripted behaviour of a container: stdout and stderr lines, then the exit code. With
// hang the container runs until it is killed (exit 137).
type fakeRun struct {
	stdout, stderr []string
	code           int64
	hang           bool
	// out is the tar CopyFromContainer returns for /scantor/out; nil answers not found.
	out []byte
}

type fakeContainer struct {
	id       string
	opts     client.ContainerCreateOptions
	injected []byte
	server   net.Conn
	waitCh   chan containertypes.WaitResponse
	killCh   chan string
	killed   []string
	started  bool
	removed  bool
	rmOpts   client.ContainerRemoveOptions
	out      []byte
	once     sync.Once
}

func newFakeDocker() *fakeDocker {
	return &fakeDocker{images: map[string]image.InspectResponse{}, remote: map[string]image.InspectResponse{}, registry: map[string]bool{}}
}

// addImage registers a local image under refs (its id is added too).
func (f *fakeDocker) addImage(img image.InspectResponse, refs ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.addImageLocked(img, refs...)
}

func (f *fakeDocker) addImageLocked(img image.InspectResponse, refs ...string) {
	for _, r := range refs {
		f.images[r] = img
	}
	f.images[img.ID] = img
}

// ClientVersion is the negotiated API version.
func (f *fakeDocker) ClientVersion() string { return "1.56" }

func notFound(what string) error { return fmt.Errorf("no such %s: %w", what, cerrdefs.ErrNotFound) }

func (f *fakeDocker) ImageInspect(_ context.Context, ref string, _ ...client.ImageInspectOption) (client.ImageInspectResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	img, ok := f.images[ref]
	if !ok {
		return client.ImageInspectResult{}, notFound("image " + ref)
	}
	return client.ImageInspectResult{InspectResponse: img}, nil
}

// fakeStream is an ImagePullResponse / ImagePushResponse with fixed messages.
type fakeStream struct {
	io.Reader
	msgs []jsonstream.Message
}

func (s *fakeStream) Close() error               { return nil }
func (s *fakeStream) Wait(context.Context) error { return nil }
func (s *fakeStream) JSONMessages(context.Context) iter.Seq2[jsonstream.Message, error] {
	return func(yield func(jsonstream.Message, error) bool) {
		for _, m := range s.msgs {
			if !yield(m, nil) {
				return
			}
		}
	}
}

func (f *fakeDocker) ImagePull(_ context.Context, ref string, _ client.ImagePullOptions) (client.ImagePullResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pulls = append(f.pulls, ref)
	img, ok := f.remote[ref]
	if !ok {
		return &fakeStream{Reader: strings.NewReader(""), msgs: []jsonstream.Message{{Error: &jsonstream.Error{Message: "pull access denied for " + ref}}}}, nil
	}
	f.addImageLocked(img, ref)
	return &fakeStream{Reader: strings.NewReader(""), msgs: []jsonstream.Message{{Status: "Pull complete"}}}, nil
}

func (f *fakeDocker) DistributionInspect(_ context.Context, ref string, _ client.DistributionInspectOptions) (client.DistributionInspectResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.distributionChecks = append(f.distributionChecks, ref)
	if !f.registry[ref] {
		return client.DistributionInspectResult{}, errors.New("unauthorized: authentication required")
	}
	return client.DistributionInspectResult{}, nil
}

func (f *fakeDocker) ImageBuild(ctx context.Context, buildContext io.Reader, opts client.ImageBuildOptions) (client.ImageBuildResult, error) {
	data, err := io.ReadAll(buildContext)
	if err != nil {
		return client.ImageBuildResult{}, err
	}
	f.mu.Lock()
	f.buildOpts = append(f.buildOpts, opts)
	f.buildContexts = append(f.buildContexts, data)
	build := f.build
	f.mu.Unlock()
	msgs, built, block := build(opts)
	if block {
		pr, pw := io.Pipe()
		go func() {
			<-ctx.Done()
			pw.CloseWithError(ctx.Err())
		}()
		return client.ImageBuildResult{Body: pr}, nil
	}
	if built != nil {
		f.addImage(*built, opts.Tags...)
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	for _, m := range msgs {
		if err := enc.Encode(m); err != nil {
			return client.ImageBuildResult{}, err
		}
	}
	return client.ImageBuildResult{Body: io.NopCloser(&buf)}, nil
}

func (f *fakeDocker) BuildCancel(_ context.Context, id string, _ client.BuildCancelOptions) (client.BuildCancelResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cancelled = append(f.cancelled, id)
	return client.BuildCancelResult{}, nil
}

func (f *fakeDocker) BuildCachePrune(_ context.Context, opts client.BuildCachePruneOptions) (client.BuildCachePruneResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pruned = append(f.pruned, opts)
	return client.BuildCachePruneResult{}, nil
}

func (f *fakeDocker) ImageRemove(_ context.Context, ref string, _ client.ImageRemoveOptions) (client.ImageRemoveResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removedImages = append(f.removedImages, ref)
	delete(f.images, ref)
	return client.ImageRemoveResult{}, nil
}

func (f *fakeDocker) ImagePush(_ context.Context, ref string, opts client.ImagePushOptions) (client.ImagePushResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pushes = append(f.pushes, fakePushCall{Ref: ref, Opts: opts})
	return &fakeStream{Reader: strings.NewReader(""), msgs: f.pushMsgs}, nil
}

func (f *fakeDocker) find(id string) (*fakeContainer, error) {
	for _, c := range f.containers {
		if c.id == id && !c.removed {
			return c, nil
		}
	}
	return nil, notFound("container " + id)
}

func (f *fakeDocker) ContainerCreate(_ context.Context, opts client.ContainerCreateOptions) (client.ContainerCreateResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seq++
	c := &fakeContainer{
		id:     fmt.Sprintf("c%d", f.seq),
		opts:   opts,
		waitCh: make(chan containertypes.WaitResponse, 1),
		killCh: make(chan string, 4),
	}
	f.containers = append(f.containers, c)
	return client.ContainerCreateResult{ID: c.id}, nil
}

func (f *fakeDocker) CopyToContainer(_ context.Context, id string, opts client.CopyToContainerOptions) (client.CopyToContainerResult, error) {
	data, err := io.ReadAll(opts.Content)
	if err != nil {
		return client.CopyToContainerResult{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	c, err := f.find(id)
	if err != nil {
		return client.CopyToContainerResult{}, err
	}
	if opts.DestinationPath != "/" {
		return client.CopyToContainerResult{}, fmt.Errorf("unexpected destination %s", opts.DestinationPath)
	}
	c.injected = data
	return client.CopyToContainerResult{}, nil
}

func (f *fakeDocker) ContainerAttach(_ context.Context, id string, _ client.ContainerAttachOptions) (client.ContainerAttachResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, err := f.find(id)
	if err != nil {
		return client.ContainerAttachResult{}, err
	}
	local, remote := net.Pipe()
	c.server = remote
	return client.ContainerAttachResult{HijackedResponse: client.NewHijackedResponse(local, "application/vnd.docker.multiplexed-stream")}, nil
}

func (f *fakeDocker) ContainerWait(_ context.Context, id string, _ client.ContainerWaitOptions) client.ContainerWaitResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	errCh := make(chan error, 1)
	c, err := f.find(id)
	if err != nil {
		errCh <- err
		return client.ContainerWaitResult{Error: errCh}
	}
	return client.ContainerWaitResult{Result: c.waitCh, Error: errCh}
}

func (f *fakeDocker) ContainerStart(_ context.Context, id string, _ client.ContainerStartOptions) (client.ContainerStartResult, error) {
	f.mu.Lock()
	c, err := f.find(id)
	if err != nil {
		f.mu.Unlock()
		return client.ContainerStartResult{}, err
	}
	c.started = true
	run := f.run(c)
	c.out = run.out
	f.mu.Unlock()
	go func() {
		for _, l := range run.stdout {
			writeFrame(c.server, 1, l+"\n")
		}
		for _, l := range run.stderr {
			writeFrame(c.server, 2, l+"\n")
		}
		code := run.code
		if run.hang {
			<-c.killCh
			code = 137
		}
		_ = c.server.Close()
		c.waitCh <- containertypes.WaitResponse{StatusCode: code}
	}()
	return client.ContainerStartResult{}, nil
}

// writeFrame writes one frame of Docker's multiplexed attach stream.
func writeFrame(w io.Writer, stream byte, payload string) {
	hdr := make([]byte, 8)
	hdr[0] = stream
	binary.BigEndian.PutUint32(hdr[4:], uint32(len(payload))) //nolint:gosec // test payloads are small
	_, _ = w.Write(append(hdr, payload...))
}

func (f *fakeDocker) ContainerKill(_ context.Context, id string, opts client.ContainerKillOptions) (client.ContainerKillResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, err := f.find(id)
	if err != nil {
		return client.ContainerKillResult{}, err
	}
	c.killed = append(c.killed, opts.Signal)
	if opts.Signal == "SIGKILL" {
		c.once.Do(func() { c.killCh <- opts.Signal })
	}
	return client.ContainerKillResult{}, nil
}

func (f *fakeDocker) ContainerRemove(_ context.Context, id string, opts client.ContainerRemoveOptions) (client.ContainerRemoveResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, err := f.find(id)
	if err != nil {
		return client.ContainerRemoveResult{}, err
	}
	c.removed, c.rmOpts = true, opts
	return client.ContainerRemoveResult{}, nil
}

func (f *fakeDocker) CopyFromContainer(_ context.Context, id string, opts client.CopyFromContainerOptions) (client.CopyFromContainerResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, err := f.find(id)
	if err != nil {
		return client.CopyFromContainerResult{}, err
	}
	if opts.SourcePath != container.OutDir || c.out == nil {
		return client.CopyFromContainerResult{}, notFound("path " + opts.SourcePath)
	}
	return client.CopyFromContainerResult{Content: io.NopCloser(bytes.NewReader(c.out))}, nil
}

// fakeRuntime resolves a fixed runtime binary.
type fakeRuntime struct{}

func (fakeRuntime) Resolve(context.Context) (*container.Binary, error) {
	return container.NewBinary([]byte("#!fake-runtime")), nil
}

// tarFiles lists the entries of a tar with their content.
func tarFiles(t *testing.T, data []byte) map[string]string {
	t.Helper()
	out := map[string]string{}
	tr := tar.NewReader(bytes.NewReader(data))
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		out[h.Name] = string(b)
	}
}
