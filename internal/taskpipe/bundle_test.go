package taskpipe

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/types/build"
	"github.com/moby/moby/api/types/image"
	"github.com/moby/moby/api/types/jsonstream"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/bundle"
	"github.com/lonetis/scantor/internal/container"
	"github.com/lonetis/scantor/internal/version"
)

const (
	revisionImageTag = "localhost:5000/tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c:c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
	revisionImageID  = "sha256:4444444444444444444444444444444444444444444444444444444444444444"
	revisionDigest   = "sha256:5555555555555555555555555555555555555555555555555555555555555555"
	revisionPull     = "localhost:5000/tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c@" + revisionDigest
	bundleBuiltID    = "sha256:6666666666666666666666666666666666666666666666666666666666666666"
)

// tempTag matches the temporary tags of the bundle step; group 1 is the uuid, group 2 the role.
var tempTag = regexp.MustCompile(`^scantor-bundle/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(src|build)$`)

// bundleEnv is a fake engine with the revision image (tagged and carrying its pushed digest), a bundle
// build that succeeds and a save of the build image.
type bundleEnv struct {
	docker *fakeDocker
	cfg    Config
	events syncBuffer
}

func revisionImage() image.InspectResponse {
	img := imageWithConfig(revisionImageID, map[string]any{"Env": []string{"SCANTOR_LANGUAGE=python"}})
	img.Os, img.Architecture, img.Size = "linux", "arm64", 100<<20
	img.RepoDigests = []string{revisionPull}
	return img
}

func bundleBuiltImage(labels map[string]string) *image.InspectResponse {
	img := imageWithConfig(bundleBuiltID, map[string]any{"Labels": labels, "WorkingDir": "/work"})
	img.Os, img.Architecture, img.Size = "linux", "arm64", 120<<20
	return &img
}

func newBundleEnv(t *testing.T) *bundleEnv {
	t.Helper()
	env := &bundleEnv{docker: newFakeDocker(), cfg: testConfig()}
	env.cfg.BuildTimeout = time.Minute
	env.cfg.MaxImageBytes = 1 << 30
	env.cfg.BuildCacheMaxBytes = 20 << 30
	env.cfg.RegistryPushPassword = "derived-password"
	env.docker.addImage(revisionImage(), revisionImageTag)
	env.docker.build = func(client.ImageBuildOptions) ([]jsonstream.Message, *image.InspectResponse, bool) {
		return []jsonstream.Message{{Stream: "#5 [2/2] COPY scantor/scantor scantor/bundle.json /scantor/\n"}}, bundleBuiltImage(map[string]string{"org.opencontainers.image.title": "echo@3"}), false
	}
	env.docker.save = func(refs []string) ([]byte, error) { return savedArchive(t, refs[0]), nil }
	return env
}

// savedArchive is the `docker save` archive of ref the way the containerd image store writes it.
func savedArchive(t *testing.T, ref string) []byte {
	t.Helper()
	tag := ref[strings.LastIndex(ref, ":")+1:]
	return writeTar(t, []saveEntry{
		dirEntry("blobs/"),
		dirEntry("blobs/sha256/"),
		regEntry("blobs/sha256/cccc", 0o444, `{"architecture":"arm64","os":"linux"}`),
		regEntry("blobs/sha256/llll", 0o444, "layer"),
		regEntry("index.json", 0o644, `{"schemaVersion":2,"manifests":[{"digest":"sha256:mmmm","annotations":{"io.containerd.image.name":"docker.io/`+ref+`","org.opencontainers.image.ref.name":"`+tag+`"}}]}`),
		regEntry("manifest.json", 0o644, `[{"Config":"blobs/sha256/cccc","RepoTags":["`+ref+`"],"Layers":["blobs/sha256/llll"]}]`),
		regEntry("oci-layout", 0o444, `{"imageLayoutVersion":"1.0.0"}`),
	})
}

func (e *bundleEnv) pipeline() *Pipeline {
	return New(e.cfg, NewEmitter(&e.events, EventsNDJSON), e.docker, fakeRuntime{})
}

// testBundleInfo is the bundle info of internal/bundle/testdata (as the orchestrator writes it:
// indented) for linux/arm64, changed by mutate.
func testBundleInfo(t *testing.T, mutate func(m map[string]any)) []byte {
	t.Helper()
	data, err := os.ReadFile("../bundle/testdata/bundle.json")
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	m["platform"] = map[string]any{"os": "linux", "arch": "arm64"}
	if mutate != nil {
		mutate(m)
	}
	out, err := json.MarshalIndent(m, "", "    ")
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func (e *bundleEnv) bundle(t *testing.T, info []byte, opts BundleOptions, out io.Writer) *BundleResult {
	t.Helper()
	if opts.Image == "" {
		opts.Image = revisionImageTag
	}
	return e.pipeline().Bundle(context.Background(), info, opts, out)
}

// eventList decodes the emitted events and checks the stream invariants: v 1, consecutive seq, the
// result last.
func (e *bundleEnv) eventList(t *testing.T) []BundleEvent {
	t.Helper()
	var out []BundleEvent
	dec := json.NewDecoder(bytes.NewReader(e.events.Bytes()))
	for {
		var ev BundleEvent
		if err := dec.Decode(&ev); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		out = append(out, ev)
	}
	for i, ev := range out {
		if ev.V != 1 || ev.Seq != int64(i) || (ev.Type == EventResult) != (i == len(out)-1) {
			t.Fatalf("event %d: %+v", i, ev)
		}
	}
	return out
}

// noTemporaryTags checks that no scantor-bundle/ reference is left in the fake engine and returns the
// temporary tags the step created.
func (e *bundleEnv) noTemporaryTags(t *testing.T) []string {
	t.Helper()
	e.docker.mu.Lock()
	defer e.docker.mu.Unlock()
	for ref := range e.docker.images {
		if strings.HasPrefix(ref, BundleTempRepository+"/") {
			t.Errorf("the temporary tag %s survived", ref)
		}
	}
	var created []string
	for _, tag := range e.docker.imageTags {
		created = append(created, tag.Target)
	}
	for _, opts := range e.docker.buildOpts {
		created = append(created, opts.Tags...)
	}
	for _, ref := range created {
		if !slices.Contains(e.docker.removedImages, ref) {
			t.Errorf("the temporary tag %s was not removed (removed: %v)", ref, e.docker.removedImages)
		}
	}
	return created
}

func onlyBundleError(t *testing.T, res *BundleResult, phase api.BuildPhase, substr string) {
	t.Helper()
	if res.OK || res.Bundle != nil || len(res.Errors) != 1 || res.Errors[0].Phase != phase || !strings.Contains(res.Errors[0].Message, substr) {
		t.Fatalf("result %+v, want one %s error containing %q", res, phase, substr)
	}
	want := 2
	if phase == api.BuildPhasePlatform {
		want = 3
	}
	if res.ExitCode() != want {
		t.Fatalf("exit code %d, want %d", res.ExitCode(), want)
	}
}

func TestBundleReusesTheLocalImage(t *testing.T) {
	env := newBundleEnv(t)
	info := testBundleInfo(t, nil)
	var out bytes.Buffer
	res := env.bundle(t, info, BundleOptions{Pull: revisionPull}, &out)
	if !res.OK {
		t.Fatalf("errors %+v\n%s", res.Errors, env.events.String())
	}
	sum := sha256.Sum256(out.Bytes())
	want := BundleArchive{
		Image: "localhost/scantor/echo:3", Platform: api.Platform{OS: "linux", Arch: "arm64"}, ImageBytes: 120 << 20,
		Bytes: int64(out.Len()), SHA256: hex.EncodeToString(sum[:]), ScantorVersion: version.Version,
	}
	if res.Bundle == nil || *res.Bundle != want || res.ExitCode() != 0 {
		t.Fatalf("bundle %+v, want %+v", res.Bundle, want)
	}
	if len(env.docker.pulls) != 0 {
		t.Fatalf("the local image carries the digest; pulls %v", env.docker.pulls)
	}

	// One source tag of the revision image, one build tag, the same uuid.
	if len(env.docker.imageTags) != 1 || env.docker.imageTags[0].Source != revisionImageID {
		t.Fatalf("tags %+v", env.docker.imageTags)
	}
	src := tempTag.FindStringSubmatch(env.docker.imageTags[0].Target)
	opts := env.docker.buildOpts[0]
	built := tempTag.FindStringSubmatch(strings.Join(opts.Tags, ","))
	if src == nil || src[2] != "src" || built == nil || built[2] != "build" || built[1] != src[1] {
		t.Fatalf("temporary tags %v and %v", env.docker.imageTags[0].Target, opts.Tags)
	}
	if len(env.docker.buildOpts) != 1 || opts.Dockerfile != "scantor/Dockerfile" || len(opts.BuildArgs) != 0 || opts.PullParent ||
		opts.Version != build.BuilderBuildKit || len(opts.AuthConfigs) != 0 || len(opts.Labels) != 0 || opts.BuildID == "" {
		t.Fatalf("build options %+v", opts)
	}

	// The build context: the runtime, the re-marshalled info and the generated Dockerfile only.
	files := tarFiles(t, env.docker.buildContexts[0])
	parsed, err := bundle.Parse(info)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := parsed.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(canonical, info) {
		t.Fatal("the test info must differ from its canonical form")
	}
	wantFiles := map[string]string{
		"scantor/":            "",
		"scantor/scantor":     "#!fake-runtime",
		"scantor/bundle.json": string(canonical),
		"scantor/Dockerfile": "FROM " + env.docker.imageTags[0].Target + "\n" +
			"COPY scantor/scantor scantor/bundle.json /scantor/\n" +
			"WORKDIR /work\n" +
			`ENTRYPOINT ["/scantor/scantor", "runtime", "bundle"]` + "\n" +
			"CMD []\n" +
			`HEALTHCHECK --interval=30s --timeout=10s --start-period=2m --start-interval=5s --retries=3 CMD ["/scantor/scantor", "runtime", "healthcheck"]` + "\n" +
			"STOPSIGNAL SIGTERM\n" +
			`LABEL org.opencontainers.image.title="echo@3"` + "\n",
	}
	if len(files) != len(wantFiles) {
		t.Fatalf("build context entries %v", slices.Sorted(maps.Keys(files)))
	}
	for name, content := range wantFiles {
		if got, ok := files[name]; !ok || got != content {
			t.Errorf("build context %s:\n%s\nwant:\n%s", name, got, content)
		}
	}

	// The save of the build tag with the platform option, renamed in the stream and gzipped.
	if len(env.docker.saves) != 1 || !slices.Equal(env.docker.saves[0], opts.Tags) || env.docker.saveOpts[0] != 1 {
		t.Fatalf("saves %v options %v", env.docker.saves, env.docker.saveOpts)
	}
	zr, err := gzip.NewReader(bytes.NewReader(out.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	tarData, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	entries := readTar(t, tarData)
	rewritten := checkRewritten(t, readTar(t, savedArchive(t, opts.Tags[0])), entries)
	if !strings.Contains(string(rewritten["manifest.json"]), `"RepoTags":["localhost/scantor/echo:3"]`) ||
		!strings.Contains(string(rewritten["index.json"]), `"io.containerd.image.name":"localhost/scantor/echo:3"`) ||
		strings.Contains(string(tarData), "scantor-bundle") {
		t.Fatalf("names %s %s", rewritten["manifest.json"], rewritten["index.json"])
	}

	env.noTemporaryTags(t)
	if _, err := env.docker.ImageInspect(context.Background(), revisionImageTag); err != nil {
		t.Fatalf("the revision image must stay: %v", err)
	}
	if len(env.docker.pruned) != 1 {
		t.Fatalf("pruned %v", env.docker.pruned)
	}
	events := env.eventList(t)
	last := events[len(events)-1]
	if last.Phase != api.BuildPhaseBuild || last.Result == nil || last.Result.Bundle == nil || last.Result.Bundle.SHA256 != want.SHA256 {
		t.Fatalf("result event %+v", last)
	}
	if _, ok := last.Result.DurationsMs["build"]; !ok {
		t.Fatalf("durations %v", last.Result.DurationsMs)
	}
	if _, ok := last.Result.DurationsMs["save"]; !ok {
		t.Fatalf("durations %v", last.Result.DurationsMs)
	}
	text := env.events.String()
	for _, w := range []string{"using the local image " + revisionImageTag, "#5 [2/2] COPY", "saving scantor-bundle/", "wrote the bundle of localhost/scantor/echo:3"} {
		if !strings.Contains(text, w) {
			t.Errorf("events lack %q:\n%s", w, text)
		}
	}
	if strings.Contains(text, "derived-password") {
		t.Fatal("the registry credential must never appear in events")
	}
}

func decodeAuth(t *testing.T, auth string) (cred struct{ Username, Password, ServerAddress string }) {
	t.Helper()
	data, err := base64.URLEncoding.DecodeString(auth)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &cred); err != nil {
		t.Fatal(err)
	}
	return cred
}

func TestBundlePullsTheRevisionImage(t *testing.T) {
	pulledImage := revisionImage()
	pulledImage.ID = "sha256:7777777777777777777777777777777777777777777777777777777777777777"
	cases := map[string]func(env *bundleEnv){
		// The built-in node's image GC removed the local tag.
		"missing": func(env *bundleEnv) { delete(env.docker.images, revisionImageTag) },
		// The local tag names another image than the digest.
		"other digest": func(env *bundleEnv) {
			img := revisionImage()
			img.RepoDigests = []string{"localhost:5000/tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c@" + pushedDig}
			env.docker.addImage(img, revisionImageTag)
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			env := newBundleEnv(t)
			setup(env)
			env.docker.remote[revisionPull] = pulledImage
			res := env.bundle(t, testBundleInfo(t, nil), BundleOptions{Pull: revisionPull}, io.Discard)
			if !res.OK {
				t.Fatalf("errors %+v", res.Errors)
			}
			if !slices.Equal(env.docker.pulls, []string{revisionPull}) {
				t.Fatalf("pulls %v", env.docker.pulls)
			}
			cred := decodeAuth(t, env.docker.pullAuths[0])
			if cred.Username != "orchestrator" || cred.Password != "derived-password" || cred.ServerAddress != "localhost:5000" {
				t.Fatalf("pull credential %+v", cred)
			}
			if env.docker.imageTags[0].Source != pulledImage.ID {
				t.Fatalf("the pulled image must be the source: %+v", env.docker.imageTags)
			}
			env.noTemporaryTags(t)
		})
	}

	// Without the push password the pull is anonymous; a failed pull is a platform error.
	env := newBundleEnv(t)
	env.cfg.RegistryPushPassword = ""
	delete(env.docker.images, revisionImageTag)
	res := env.bundle(t, testBundleInfo(t, nil), BundleOptions{Pull: revisionPull}, io.Discard)
	onlyBundleError(t, res, api.BuildPhasePlatform, "pull access denied")
	if len(env.docker.pullAuths) != 1 || env.docker.pullAuths[0] != "" {
		t.Fatalf("pull auths %q", env.docker.pullAuths)
	}
	if len(env.docker.imageTags) != 0 || len(env.docker.buildOpts) != 0 {
		t.Fatal("nothing may be tagged or built")
	}

	// Without --pull a missing image is a platform error.
	env = newBundleEnv(t)
	delete(env.docker.images, revisionImageTag)
	onlyBundleError(t, env.bundle(t, testBundleInfo(t, nil), BundleOptions{}, io.Discard), api.BuildPhasePlatform, "does not exist")
	if len(env.docker.pulls) != 0 {
		t.Fatalf("pulls %v", env.docker.pulls)
	}
}

func TestBundlePlatformMismatch(t *testing.T) {
	cases := map[string]struct {
		setup func(env *bundleEnv)
		info  func(m map[string]any)
		want  string
	}{
		"info names another architecture": {
			info: func(m map[string]any) { m["platform"] = map[string]any{"os": "linux", "arch": "amd64"} },
			want: "the image is linux/arm64; the bundle info names linux/amd64",
		},
		"daemon of another architecture": {
			setup: func(env *bundleEnv) { env.docker.daemonArch = "amd64" },
			want:  "the Docker daemon is linux/amd64",
		},
		"variant differs": {
			setup: func(env *bundleEnv) {
				img := revisionImage()
				img.Variant = "v7"
				env.docker.addImage(img, revisionImageTag)
			},
			info: func(m map[string]any) {
				m["platform"] = map[string]any{"os": "linux", "arch": "arm64", "variant": "v8"}
			},
			want: "the image is linux/arm64/v7",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			env := newBundleEnv(t)
			if tc.setup != nil {
				tc.setup(env)
			}
			var out bytes.Buffer
			res := env.bundle(t, testBundleInfo(t, tc.info), BundleOptions{Pull: revisionPull}, &out)
			onlyBundleError(t, res, api.BuildPhasePlatform, tc.want)
			if len(env.docker.imageTags) != 0 || len(env.docker.buildOpts) != 0 || out.Len() != 0 {
				t.Fatal("nothing may be tagged, built or written")
			}
		})
	}
}

func TestBundleRemovesTemporaryTagsOnFailure(t *testing.T) {
	cases := map[string]struct {
		setup func(env *bundleEnv)
		out   io.Writer
		phase api.BuildPhase
		want  string
	}{
		"build step fails": {
			setup: func(env *bundleEnv) {
				env.docker.build = func(client.ImageBuildOptions) ([]jsonstream.Message, *image.InspectResponse, bool) {
					return []jsonstream.Message{{Error: &jsonstream.Error{Message: "failed to compute cache key"}}}, nil, false
				}
			},
			phase: api.BuildPhaseBuild, want: "failed to compute cache key",
		},
		"image too large": {
			setup: func(env *bundleEnv) { env.cfg.MaxImageBytes = 110 << 20 },
			phase: api.BuildPhaseBuild, want: "SCANTOR_MAX_IMAGE_BYTES",
		},
		"forbidden label": {
			setup: func(env *bundleEnv) {
				env.docker.build = func(client.ImageBuildOptions) ([]jsonstream.Message, *image.InspectResponse, bool) {
					return nil, bundleBuiltImage(map[string]string{"scantor.kind": "worker"}), false
				}
			},
			phase: api.BuildPhaseBuild, want: "reserved",
		},
		"save fails": {
			setup: func(env *bundleEnv) {
				env.docker.save = func([]string) ([]byte, error) { return nil, errors.New("no space left on device") }
			},
			phase: api.BuildPhasePlatform, want: "no space left on device",
		},
		"save is not a tar": {
			setup: func(env *bundleEnv) {
				env.docker.save = func([]string) ([]byte, error) { return bytes.Repeat([]byte("x"), 2048), nil }
			},
			phase: api.BuildPhasePlatform, want: "read the image archive",
		},
		"output fails": {
			out:   failingWriter{},
			phase: api.BuildPhasePlatform, want: "write the bundle archive",
		},
		"runtime binary": {
			setup: func(env *bundleEnv) {},
			phase: api.BuildPhasePlatform, want: "resolve the scantor runtime",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			env := newBundleEnv(t)
			if tc.setup != nil {
				tc.setup(env)
			}
			out := tc.out
			if out == nil {
				out = io.Discard
			}
			var rt RuntimeResolver = fakeRuntime{}
			if name == "runtime binary" {
				rt = failingRuntime{}
			}
			res := New(env.cfg, NewEmitter(&env.events, EventsNDJSON), env.docker, rt).
				Bundle(context.Background(), testBundleInfo(t, nil), BundleOptions{Image: revisionImageTag, Pull: revisionPull}, out)
			onlyBundleError(t, res, tc.phase, tc.want)
			if created := env.noTemporaryTags(t); len(created) == 0 {
				t.Fatal("the source must have been tagged")
			}
			env.eventList(t)
			if _, err := env.docker.ImageInspect(context.Background(), revisionImageTag); err != nil {
				t.Fatalf("the revision image must stay: %v", err)
			}
		})
	}
}

// failingRuntime cannot resolve a runtime binary.
type failingRuntime struct{}

func (failingRuntime) Resolve(context.Context) (*container.Binary, error) {
	return nil, errors.New("no scantor image")
}

func TestBundleInterruptedBuild(t *testing.T) {
	env := newBundleEnv(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	env.docker.build = func(client.ImageBuildOptions) ([]jsonstream.Message, *image.InspectResponse, bool) {
		cancel()
		return nil, nil, true
	}
	res := env.pipeline().Bundle(ctx, testBundleInfo(t, nil), BundleOptions{Image: revisionImageTag}, io.Discard)
	onlyBundleError(t, res, api.BuildPhasePlatform, "interrupted")
	if len(env.docker.cancelled) != 1 {
		t.Fatalf("the build must be cancelled on the daemon: %v", env.docker.cancelled)
	}
	env.noTemporaryTags(t)
}

func TestBundleRejectsInvalidInput(t *testing.T) {
	cases := map[string]struct {
		info []byte
		opts BundleOptions
		want string
	}{
		"not json":            {info: []byte("{"), want: "invalid bundle info"},
		"unknown key":         {info: testBundleInfo(t, func(m map[string]any) { m["secrets"] = map[string]any{"token": "x"} }), want: "invalid bundle info"},
		"workers in settings": {info: testBundleInfo(t, func(m map[string]any) { m["settings"].(map[string]any)["workers"] = 2 }), want: "invalid bundle info"},
		"image of another task": {
			info: testBundleInfo(t, func(m map[string]any) { m["image"] = "localhost/scantor/other:3" }),
			want: "invalid bundle info",
		},
		"pull with a tag":     {info: testBundleInfo(t, nil), opts: BundleOptions{Pull: "localhost:5000/tasks/x:1"}, want: "must be <registry host>/<repository>@sha256:<digest>"},
		"pull on docker hub":  {info: testBundleInfo(t, nil), opts: BundleOptions{Pull: "tasks/x@" + revisionDigest}, want: "must be <registry host>"},
		"pull tag and digest": {info: testBundleInfo(t, nil), opts: BundleOptions{Pull: "localhost:5000/tasks/x:1@" + revisionDigest}, want: "must be <registry host>"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			env := newBundleEnv(t)
			res := env.bundle(t, tc.info, tc.opts, io.Discard)
			onlyBundleError(t, res, api.BuildPhasePlatform, tc.want)
			events := env.eventList(t)
			if last := events[len(events)-1]; last.Phase != api.BuildPhasePlatform {
				t.Fatalf("result phase %s", last.Phase)
			}
			if len(env.docker.imageTags) != 0 || len(env.docker.buildOpts) != 0 || len(env.docker.pulls) != 0 {
				t.Fatal("nothing may run before the input is valid")
			}
		})
	}

	var events bytes.Buffer
	res := New(testConfig(), NewEmitter(&events, EventsNDJSON), nil, nil).Bundle(context.Background(), testBundleInfo(t, nil), BundleOptions{Image: "x"}, io.Discard)
	onlyBundleError(t, res, api.BuildPhasePlatform, "needs a Docker daemon")
	env := newBundleEnv(t)
	onlyBundleError(t, env.pipeline().Bundle(context.Background(), testBundleInfo(t, nil), BundleOptions{}, io.Discard), api.BuildPhasePlatform, "--image")
	onlyBundleError(t, env.pipeline().Bundle(context.Background(), testBundleInfo(t, nil), BundleOptions{Image: "x"}, nil), api.BuildPhasePlatform, "needs an output")
}

func TestBundleRejectsOnbuildTriggers(t *testing.T) {
	env := newBundleEnv(t)
	img := imageWithConfig(revisionImageID, map[string]any{"OnBuild": []string{"RUN echo triggered"}})
	img.Os, img.Architecture = "linux", "arm64"
	env.docker.addImage(img, revisionImageTag)
	onlyBundleError(t, env.bundle(t, testBundleInfo(t, nil), BundleOptions{}, io.Discard), api.BuildPhaseBuild, "ONBUILD")
	if len(env.docker.imageTags) != 0 {
		t.Fatal("nothing may be tagged")
	}
}

func TestBundleSaveWithoutPlatformOnOldAPI(t *testing.T) {
	env := newBundleEnv(t)
	res := New(env.cfg, NewEmitter(&env.events, EventsText), oldAPIDocker{env.docker}, fakeRuntime{}).
		Bundle(context.Background(), testBundleInfo(t, nil), BundleOptions{Image: revisionImageTag}, io.Discard)
	if !res.OK || env.docker.saveOpts[0] != 0 {
		t.Fatalf("result %+v save options %v", res, env.docker.saveOpts)
	}
	if text := env.events.String(); !strings.Contains(text, "[result] ok: bundle localhost/scantor/echo:3 (linux/arm64, ") {
		t.Fatalf("text events:\n%s", text)
	}
}

// oldAPIDocker negotiates API 1.47, before the platform option of ImageSave.
type oldAPIDocker struct{ *fakeDocker }

func (oldAPIDocker) ClientVersion() string { return "1.47" }

func TestBundleResultJSON(t *testing.T) {
	res := &BundleResult{Errors: []api.BuildError{}, Warnings: []string{}, DurationsMs: map[string]int64{}}
	data, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != `{"ok":false,"bundle":null,"errors":[],"warnings":[],"durationsMs":{}}` {
		t.Fatalf("json %s", data)
	}
	res.OK, res.Bundle = true, &BundleArchive{Image: "localhost/scantor/echo:3", Platform: api.Platform{OS: "linux", Arch: "amd64"}, ImageBytes: 2, Bytes: 1, SHA256: "ab", ScantorVersion: "1.6.0"}
	if data, _ = json.Marshal(res); !strings.Contains(string(data), `"bundle":{"image":"localhost/scantor/echo:3","platform":{"os":"linux","arch":"amd64"},"imageBytes":2,"bytes":1,"sha256":"ab","scantorVersion":"1.6.0"}`) {
		t.Fatalf("json %s", data)
	}
}

// tarNames lists the entry names of a tar.
func tarNames(t *testing.T, data []byte) []string {
	t.Helper()
	var list []string
	tr := tar.NewReader(bytes.NewReader(data))
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return list
		}
		if err != nil {
			t.Fatal(err)
		}
		list = append(list, h.Name)
	}
}

func TestBundleContextHasOnlyAllowlistedFiles(t *testing.T) {
	env := newBundleEnv(t)
	if res := env.bundle(t, testBundleInfo(t, nil), BundleOptions{}, io.Discard); !res.OK {
		t.Fatal(res.Errors)
	}
	want := []string{"scantor/", "scantor/Dockerfile", "scantor/bundle.json", "scantor/scantor"}
	if got := tarNames(t, env.docker.buildContexts[0]); !slices.Equal(got, want) {
		t.Fatalf("context %v, want %v", got, want)
	}
}
