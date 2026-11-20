package taskpipe

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/distribution/reference"
	"github.com/google/uuid"
	"github.com/moby/moby/client"
	"github.com/moby/moby/client/pkg/versions"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/bundle"
	"github.com/lonetis/scantor/internal/container"
	"github.com/lonetis/scantor/internal/version"
)

// BundleOptions are the flags of `scantor task bundle` (docs/tasks.md §9.11).
type BundleOptions struct {
	// Image is the local reference of the revision image (--image, required).
	Image string
	// Pull is the revision image by digest, <registry host>/<repository>@sha256:<hex> (--pull). With it
	// the local Image is used only when it carries that digest; otherwise Pull is pulled with the
	// `orchestrator` registry credential, because the built-in node's image GC may have removed the
	// local tag.
	Pull string
}

const (
	// BundleTempRepository is the repository of the temporary tags of the bundle step:
	// scantor-bundle/<uuid>:src (the revision image) and scantor-bundle/<uuid>:build (the bundle image).
	// The step removes both; the tasks GC removes leftovers of an interrupted step.
	BundleTempRepository = "scantor-bundle"
	// bundleMode is the runtime mode of the bundle image's entrypoint (`scantor runtime bundle`).
	bundleMode = "bundle"
	// bundleDockerfile and bundleInfoFile are the build-context paths of the generated Dockerfile and of
	// the bundle info; the runtime binary is scantor/scantor (container.InjectionArchive).
	bundleDockerfile = "scantor/Dockerfile"
	bundleInfoFile   = "scantor/bundle.json"
	// bundleSaveDuration is the durationsMs key of the save, rewrite and compression of the archive.
	bundleSaveDuration = "save"
	// bundleContextOverhead bounds the tar headers and padding of the build context.
	bundleContextOverhead = 16 << 10
)

// Bundle runs `scantor task bundle` (docs/tasks.md §9.11): it derives the bundle image of a revision
// image and writes the gzip `docker save` archive of it to out. info is the bundle info
// (/scantor/bundle.json) the orchestrator built from the revision; only its re-marshalled, allowlisted
// form reaches the image.
//
// The steps: parse info (bundle.Parse); find the source image (opts.Image, or a pull of opts.Pull); check
// that the image, the info and the daemon share one linux platform, because the baked runtime binary is
// the daemon's native one; tag the source scantor-bundle/<uuid>:src; build scantor-bundle/<uuid>:build
// with BuildKit from a context of the runtime binary, the info and a generated Dockerfile (entrypoint
// `scantor runtime bundle`, the runtime healthcheck, WORKDIR /work); check its size and labels like a
// task build; then save it, rename it to info.image in the stream (RewriteSaveNames), gzip it and count
// and hash the bytes written to out. Both temporary tags are removed before the result event, which is
// always the last event. The registry credential is sent only to the host of opts.Pull and never
// reaches the image (docs/security.md BDL-2, BDL-6).
//
// Build errors (build timeout, image size, forbidden labels, a failing build step) are reported in the
// build phase (exit 2); everything else is a platform error (exit 3).
func (p *Pipeline) Bundle(ctx context.Context, info []byte, opts BundleOptions, out io.Writer) *BundleResult {
	r := p.newRun()
	r.last = api.BuildPhasePlatform
	switch {
	case p.docker == nil || p.runtime == nil:
		r.failf(api.BuildPhasePlatform, "bundle needs a Docker daemon")
		return r.finishBundle(nil)
	case opts.Image == "":
		r.failf(api.BuildPhasePlatform, "bundle needs the revision image (--image)")
		return r.finishBundle(nil)
	case out == nil:
		r.failf(api.BuildPhasePlatform, "bundle needs an output")
		return r.finishBundle(nil)
	}
	s := &bundleStep{run: r, opts: opts}
	if !s.parse(info) {
		return r.finishBundle(nil)
	}
	var archive *BundleArchive
	if r.phase(api.BuildPhaseBuild, func() bool { return s.build(ctx) }) && !r.interrupted(ctx) {
		archive = s.save(ctx, out)
	}
	s.cleanup(ctx)
	return r.finishBundle(archive)
}

// finishBundle emits the result event of a bundle step and returns it. The archive is reported only
// when no error was recorded.
func (r *run) finishBundle(archive *BundleArchive) *BundleResult {
	r.settle()
	if r.res.OK && archive == nil {
		r.failf(api.BuildPhasePlatform, "no bundle archive was written")
		r.res.OK = false
	}
	res := &BundleResult{OK: r.res.OK, Errors: r.res.Errors, Warnings: r.res.Warnings, DurationsMs: r.res.DurationsMs}
	if res.OK {
		res.Bundle = archive
	}
	r.p.events.BundleResult(r.last, res)
	return res
}

// bundleStep is the state of one bundle step.
type bundleStep struct {
	*run
	opts BundleOptions
	// pull is the parsed opts.Pull, nil without --pull.
	pull reference.Canonical
	info *bundle.Info
	// data is the re-marshalled info written into the image.
	data []byte
	// srcTag and buildTag are the temporary tags; they are set once the source image is tagged.
	srcTag, buildTag string
	// built is the build of the bundle image.
	built *builder
}

// parse checks the bundle info and --pull.
func (s *bundleStep) parse(info []byte) bool {
	parsed, err := bundle.Parse(info)
	if err != nil {
		s.failf(api.BuildPhasePlatform, "invalid bundle info: %v", err)
		return false
	}
	data, err := parsed.Marshal()
	if err != nil {
		s.failf(api.BuildPhasePlatform, "%v", err)
		return false
	}
	s.info, s.data = parsed, data
	if s.opts.Pull != "" {
		pull, err := parsePullReference(s.opts.Pull)
		if err != nil {
			s.failf(api.BuildPhasePlatform, "%v", err)
			return false
		}
		s.pull = pull
	}
	return true
}

// parsePullReference checks --pull: a digest reference on an explicit registry host, so the platform
// credential is never sent to Docker Hub or any other implied registry.
func parsePullReference(ref string) (reference.Canonical, error) {
	invalid := fmt.Errorf("the pull reference %q must be <registry host>/<repository>@sha256:<digest>", ref)
	named, err := reference.ParseNormalizedNamed(ref)
	if err != nil {
		return nil, invalid
	}
	canonical, ok := named.(reference.Canonical)
	_, tagged := named.(reference.Tagged)
	domain := reference.Domain(named)
	if !ok || tagged || domain == "docker.io" || !strings.HasPrefix(ref, domain+"/") {
		return nil, invalid
	}
	return canonical, nil
}

// build finds and checks the source image, tags it and builds the bundle image (the build phase).
func (s *bundleStep) build(ctx context.Context) bool {
	src, ok := s.source(ctx)
	if !ok || !s.checkSource(ctx, src) {
		return false
	}
	id := uuid.NewString()
	srcTag, buildTag := BundleTempRepository+"/"+id+":src", BundleTempRepository+"/"+id+":build"
	if _, err := s.p.docker.ImageTag(ctx, client.ImageTagOptions{Source: src.ID, Target: srcTag}); err != nil {
		if !s.interrupted(ctx) {
			s.failf(api.BuildPhasePlatform, "tag %s as %s: %v", src.ID, srcTag, err)
		}
		return false
	}
	s.srcTag, s.buildTag = srcTag, buildTag
	s.log(api.BuildPhaseBuild, "tagged %s as %s", src.ID, srcTag)

	b := &builder{run: s.run, tag: buildTag, noun: "bundle"}
	s.built = b
	bin, ok := b.binary(ctx)
	if !ok {
		return false
	}
	dockerfile := bundleDockerfileText(srcTag, s.info)
	files := []container.File{
		{Path: bundleInfoFile, Mode: 0o644, Data: s.data},
		{Path: bundleDockerfile, Mode: 0o644, Data: dockerfile},
	}
	// The context is built in memory (one copy of the runtime binary) and sent with its length: a build
	// context of unknown length (chunked) of about 1 MiB or more stalls at "load remote build context"
	// (seen on Docker Desktop with Engine 29), so it is never streamed.
	var buildContext bytes.Buffer
	buildContext.Grow(bin.Size() + len(s.data) + len(dockerfile) + bundleContextOverhead)
	if err := container.InjectionArchive(&buildContext, bin, files); err != nil {
		s.failf(api.BuildPhasePlatform, "write the build context: %v", err)
		return false
	}
	built := b.imageBuild(ctx, bytes.NewReader(buildContext.Bytes()), bundleDockerfile, nil)
	if built {
		built = b.inspect(ctx)
	}
	b.pruneCache(ctx)
	return built
}

// source returns the inspected revision image: opts.Image when it exists and (with --pull) carries the
// pulled digest, otherwise opts.Pull after pulling it.
func (s *bundleStep) source(ctx context.Context) (client.ImageInspectResult, bool) {
	local, err := s.p.docker.ImageInspect(ctx, s.opts.Image)
	switch {
	case err == nil && (s.pull == nil || hasRepoDigest(local.RepoDigests, s.pull.Name(), s.pull.Digest().String())):
		s.log(api.BuildPhaseBuild, "using the local image %s (%s)", s.opts.Image, local.ID)
		return local, true
	case err != nil && !container.IsNotFound(err):
		if !s.interrupted(ctx) {
			s.failf(api.BuildPhasePlatform, "inspect %s: %v", s.opts.Image, err)
		}
		return client.ImageInspectResult{}, false
	case s.pull == nil:
		s.failf(api.BuildPhasePlatform, "the image %s does not exist", s.opts.Image)
		return client.ImageInspectResult{}, false
	case err == nil:
		s.log(api.BuildPhaseBuild, "the local image %s is not %s; pulling it", s.opts.Image, s.opts.Pull)
	default:
		s.log(api.BuildPhaseBuild, "the local image %s does not exist; pulling %s", s.opts.Image, s.opts.Pull)
	}
	var auth string
	if password := s.p.cfg.RegistryPushPassword; password != "" {
		if auth, err = container.RegistryAuth(RegistryPushUser, password, reference.Domain(s.pull)); err != nil {
			s.failf(api.BuildPhasePlatform, "encode the registry credential: %v", err)
			return client.ImageInspectResult{}, false
		}
	}
	if err := container.Pull(ctx, s.p.docker, s.opts.Pull, container.PullOptions{RegistryAuth: auth}); err != nil {
		if !s.interrupted(ctx) {
			s.failf(api.BuildPhasePlatform, "%v", err)
		}
		return client.ImageInspectResult{}, false
	}
	pulled, err := s.p.docker.ImageInspect(ctx, s.opts.Pull)
	if err != nil {
		s.failf(api.BuildPhasePlatform, "inspect %s: %v", s.opts.Pull, err)
		return client.ImageInspectResult{}, false
	}
	s.log(api.BuildPhaseBuild, "pulled %s (%s)", s.opts.Pull, pulled.ID)
	return pulled, true
}

// checkSource checks that the source image, the bundle info and the daemon share one linux platform
// (the baked runtime binary is the daemon's native one), and that the image has no ONBUILD triggers,
// which would run in the bundle build.
func (s *bundleStep) checkSource(ctx context.Context, src client.ImageInspectResult) bool {
	want := s.info.Platform
	if src.Os != "linux" || src.Architecture != want.Arch || (want.Variant != "" && src.Variant != "" && src.Variant != want.Variant) {
		s.failf(api.BuildPhasePlatform, "the image is %s; the bundle info names %s", platformString(api.Platform{OS: src.Os, Arch: src.Architecture, Variant: src.Variant}), platformString(want))
		return false
	}
	daemonOS, daemonArch, err := container.DaemonPlatform(ctx, s.p.docker)
	if err != nil {
		s.failf(api.BuildPhasePlatform, "%v", err)
		return false
	}
	if daemonOS != "linux" || daemonArch != want.Arch {
		s.failf(api.BuildPhasePlatform, "the Docker daemon is %s/%s; a bundle of a %s image is built on a daemon of the same platform, whose native runtime binary it contains", daemonOS, daemonArch, platformString(want))
		return false
	}
	if src.Config != nil && len(src.Config.OnBuild) > 0 {
		s.failf(api.BuildPhaseBuild, "the image %s has ONBUILD triggers, which are not allowed in bundle builds", src.ID)
		return false
	}
	return true
}

// platformString renders os/arch[/variant].
func platformString(p api.Platform) string {
	s := p.OS + "/" + p.Arch
	if p.Variant != "" {
		s += "/" + p.Variant
	}
	return s
}

// bundleDockerfileText returns the Dockerfile of the bundle image (docs/tasks.md §9.11): the revision
// image plus the runtime binary and the bundle info in /scantor, the recipient's mount /work as working
// directory, the bundle mode as entrypoint, the runtime healthcheck of long-running runtime containers,
// SIGTERM as stop signal (the task Dockerfile's STOPSIGNAL is ignored, W1) and the revision reference as
// OCI title. It takes no build arguments.
func bundleDockerfileText(from string, info *bundle.Info) []byte {
	hc := container.RuntimeHealthcheck(container.ModeWorker)
	var b strings.Builder
	fmt.Fprintf(&b, "FROM %s\n", from)
	fmt.Fprintf(&b, "COPY scantor/scantor %s %s/\n", bundleInfoFile, path.Dir(container.BinaryPath))
	fmt.Fprintf(&b, "WORKDIR %s\n", bundle.WorkDir)
	fmt.Fprintf(&b, "ENTRYPOINT %s\n", execForm(container.RuntimeEntrypoint(bundleMode)))
	b.WriteString("CMD []\n")
	fmt.Fprintf(&b, "HEALTHCHECK --interval=%s --timeout=%s --start-period=%s --start-interval=%s --retries=%d CMD %s\n",
		formatDuration(hc.Interval), formatDuration(hc.Timeout), formatDuration(hc.StartPeriod), formatDuration(hc.StartInterval),
		hc.Retries, execForm(hc.Test[1:]))
	b.WriteString("STOPSIGNAL SIGTERM\n")
	fmt.Fprintf(&b, "LABEL org.opencontainers.image.title=%s\n", strconv.Quote(info.Ref))
	return []byte(b.String())
}

// execForm renders a command in the JSON (exec) form of a Dockerfile instruction.
func execForm(args []string) string {
	parts := make([]string, len(args))
	for i, a := range args {
		q, err := json.Marshal(a)
		if err != nil {
			panic(err) // a string always encodes
		}
		parts[i] = string(q)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// save writes the gzip archive of the bundle image to out: ImageSave of the build tag (for the image's
// platform where the API supports it, so no attestation manifest is included), names rewritten to
// info.image, gzip at the default level, and the bytes written to out counted and hashed.
func (s *bundleStep) save(ctx context.Context, out io.Writer) *BundleArchive {
	start := time.Now()
	defer func() { s.res.DurationsMs[bundleSaveDuration] = time.Since(start).Milliseconds() }()
	img := s.built.image
	var opts []client.ImageSaveOption
	if cv, ok := s.p.docker.(interface{ ClientVersion() string }); ok && !versions.LessThan(cv.ClientVersion(), "1.48") {
		opts = append(opts, client.ImageSaveWithPlatforms(ocispec.Platform{OS: img.Platform.OS, Architecture: img.Platform.Arch, Variant: img.Platform.Variant}))
	}
	s.log(api.BuildPhaseBuild, "saving %s as %s", s.buildTag, s.info.Image)
	saved, err := s.p.docker.ImageSave(ctx, []string{s.buildTag}, opts...)
	if err != nil {
		if !s.interrupted(ctx) {
			s.failf(api.BuildPhasePlatform, "save %s: %v", s.buildTag, err)
		}
		return nil
	}
	defer saved.Close()
	hash := sha256.New()
	var count byteCounter
	gz := gzip.NewWriter(io.MultiWriter(out, hash, &count))
	err = RewriteSaveNames(gz, saved, s.info.Image)
	if err == nil {
		err = gz.Close()
	}
	if err != nil {
		if !s.interrupted(ctx) {
			s.failf(api.BuildPhasePlatform, "write the bundle archive: %v", err)
		}
		return nil
	}
	archive := &BundleArchive{
		Image:          s.info.Image,
		Platform:       img.Platform,
		ImageBytes:     img.Bytes,
		Bytes:          int64(count),
		SHA256:         hex.EncodeToString(hash.Sum(nil)),
		ScantorVersion: version.Version,
	}
	s.log(api.BuildPhaseBuild, "wrote the bundle of %s: %s, sha256 %s", archive.Image, formatBytes(archive.Bytes), archive.SHA256)
	return archive
}

// byteCounter counts the bytes written to it.
type byteCounter int64

func (c *byteCounter) Write(p []byte) (int, error) {
	*c += byteCounter(len(p))
	return len(p), nil
}

// cleanup removes both temporary tags, even after an interruption: the build image is removed, the
// revision image only loses its temporary tag.
func (s *bundleStep) cleanup(ctx context.Context) {
	if s.srcTag == "" {
		return
	}
	ctx = context.WithoutCancel(ctx)
	for _, tag := range []string{s.buildTag, s.srcTag} {
		if _, err := s.p.docker.ImageRemove(ctx, tag, client.ImageRemoveOptions{}); err != nil && !container.IsNotFound(err) {
			s.warn(api.BuildPhaseBuild, fmt.Sprintf("remove the temporary tag %s: %v", tag, err))
		}
	}
}
