package taskpipe

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"

	"github.com/distribution/reference"
	"github.com/google/uuid"
	"github.com/moby/moby/api/types/build"
	"github.com/moby/moby/api/types/jsonstream"
	"github.com/moby/moby/client"
	"github.com/moby/moby/client/pkg/versions"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
	"github.com/lonetis/scantor/internal/envconf"
	"github.com/lonetis/scantor/internal/taskpipe/dockerfile"
)

// GCFlagsArg is the build argument of Go debug builds; DebugGCFlags is its value for `dev debug`.
const (
	GCFlagsArg   = "SCANTOR_GCFLAGS"
	DebugGCFlags = "all=-N -l"
)

// builder runs the phases after check-static.
type builder struct {
	*run
	opts  BuildOptions
	tag   string
	image *Image
	bin   *container.Binary
}

// build is the build phase (docs/tasks.md §9.4 row 3): resolve and pin the base image, pull and inspect
// the external images of the Dockerfile, build with BuildKit through the Engine API, check the image and
// prune the build cache. With ReuseExisting an image already tagged b.tag that was built on the current
// base image is used instead of building.
func (b *builder) build(ctx context.Context) bool {
	pinned, baseLayers, ok := b.pinBase(ctx)
	if !ok {
		return false
	}
	if b.opts.ReuseExisting {
		if reused, ok := b.reuse(ctx, baseLayers); reused || !ok {
			return ok
		}
	}
	if !b.checkExternal(ctx) {
		return false
	}
	built := b.imageBuild(ctx, pinned)
	if built {
		built = b.inspect(ctx)
	}
	b.pruneCache(ctx)
	return built
}

// reuse inspects an existing image tagged b.tag. reused is true when the image exists and was built on
// the current base image (ok then reports whether it passed the image checks). Draft tags are keyed by
// the pack hash only, so after an upgrade that changes the base image (SCANTOR_IMAGE_TAG) a draft of an
// unchanged task must be rebuilt: the final stage descends from ${SCANTOR_BASE} (D4), so an image built
// on the current base starts with all of its layers.
func (b *builder) reuse(ctx context.Context, baseLayers []string) (reused, ok bool) {
	existing, err := b.p.docker.ImageInspect(ctx, b.tag)
	switch {
	case container.IsNotFound(err):
		return false, true
	case err != nil:
		b.failf(api.BuildPhasePlatform, "inspect %s: %v", b.tag, err)
		return true, false
	}
	if !builtOn(existing.RootFS.Layers, baseLayers) {
		b.log(api.BuildPhaseBuild, "the existing image %s was built on another base image; rebuilding", b.tag)
		return false, true
	}
	b.log(api.BuildPhaseBuild, "reusing the existing image %s", b.tag)
	return true, b.inspect(ctx)
}

// builtOn reports whether an image with the layers image descends from a base image with the layers
// base. A base without layers cannot be recognised.
func builtOn(image, base []string) bool {
	return len(base) > 0 && len(image) >= len(base) && slices.Equal(image[:len(base)], base)
}

// pinBase resolves the base image of the manifest language, pulls it anonymously when it is absent
// and returns the SCANTOR_BASE value and the base image's layers: <repository>@<digest> when the
// registry serves that digest, else the tag reference with the local image id recorded as the digest
// (local development images).
//
// BuildKit resolves a digest reference against the registry even when the image exists locally, and
// the containerd image store gives locally built images repo digests too, so a repo digest alone does
// not prove that the registry has the image. Development builds name their base images without
// registry and namespace (docs/architecture.md §4.2) and are never looked up; for any other reference
// the daemon checks the digest anonymously (distribution inspect) before it is pinned.
func (b *builder) pinBase(ctx context.Context) (string, []string, bool) {
	ref := b.static.Manifest.Language.BaseImageRef(b.p.cfg.Images)
	named, err := reference.ParseNormalizedNamed(ref)
	if err != nil {
		b.failf(api.BuildPhasePlatform, "invalid base image reference %q: %v", ref, err)
		return "", nil, false
	}
	inspect, err := b.p.docker.ImageInspect(ctx, ref)
	if container.IsNotFound(err) {
		b.log(api.BuildPhaseBuild, "pulling the base image %s", ref)
		if err := container.Pull(ctx, b.p.docker, ref, container.PullOptions{}); err != nil {
			b.failf(api.BuildPhasePlatform, "pull the base image: %v", err)
			return "", nil, false
		}
		inspect, err = b.p.docker.ImageInspect(ctx, ref)
	}
	if err != nil {
		b.failf(api.BuildPhasePlatform, "inspect the base image %s: %v", ref, err)
		return "", nil, false
	}
	pinned, digest := ref, inspect.ID
	if !localDevelopmentImage(named) {
		if d := repoDigest(inspect.RepoDigests, named.Name()); d != "" {
			canonical := named.Name() + "@" + d
			if err := b.inRegistry(ctx, canonical); err == nil {
				pinned, digest = canonical, d
			} else {
				b.log(api.BuildPhaseBuild, "the registry does not serve %s (%s); building from the local image %s", canonical, oneLine(err.Error()), ref)
			}
		}
	}
	b.res.BaseImage = &api.ImageRef{Ref: ref, Digest: digest}
	b.log(api.BuildPhaseBuild, "base image %s (%s)", ref, digest)
	return pinned, inspect.RootFS.Layers, true
}

// registryCheckTimeout bounds the registry lookup of the base image digest.
const registryCheckTimeout = 20 * time.Second

// inRegistry asks the daemon whether the registry serves a digest reference, anonymously.
func (b *builder) inRegistry(ctx context.Context, canonical string) error {
	ctx, cancel := context.WithTimeout(ctx, registryCheckTimeout)
	defer cancel()
	_, err := b.p.docker.DistributionInspect(ctx, canonical, client.DistributionInspectOptions{})
	return err
}

// oneLine joins the lines of a daemon error message.
func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

// localDevelopmentImage reports whether a reference has no registry and no namespace (docker.io/library
// is implied), which is how development builds name the scantor images.
func localDevelopmentImage(named reference.Named) bool {
	return reference.Domain(named) == "docker.io" && strings.HasPrefix(reference.Path(named), "library/")
}

// repoDigest returns the digest of the repo digest entry of repository, or "".
func repoDigest(repoDigests []string, repository string) string {
	for _, rd := range repoDigests {
		named, err := reference.ParseNormalizedNamed(rd)
		if err != nil {
			continue
		}
		if canonical, ok := named.(reference.Canonical); ok && named.Name() == repository {
			return canonical.Digest().String()
		}
	}
	return ""
}

// checkExternal pulls every literal external image of the Dockerfile anonymously when it is absent and
// rejects images with ONBUILD triggers, which the static parser cannot see (docs/security.md BLD-7).
func (b *builder) checkExternal(ctx context.Context) bool {
	ok := true
	for _, ext := range b.static.External {
		if err := ctx.Err(); err != nil {
			b.interrupted(ctx)
			return false
		}
		inspect, err := b.p.docker.ImageInspect(ctx, ext.Ref)
		if container.IsNotFound(err) {
			b.log(api.BuildPhaseBuild, "pulling %s", ext.Ref)
			if err := container.Pull(ctx, b.p.docker, ext.Ref, container.PullOptions{}); err != nil {
				b.fail(api.BuildError{Phase: api.BuildPhaseBuild, File: DockerfileName, Line: ext.Line, Message: fmt.Sprintf("cannot pull %s: %v", ext.Ref, err)})
				ok = false
				continue
			}
			inspect, err = b.p.docker.ImageInspect(ctx, ext.Ref)
		}
		if err != nil {
			b.failf(api.BuildPhasePlatform, "inspect %s: %v", ext.Ref, err)
			ok = false
			continue
		}
		if inspect.Config != nil && len(inspect.Config.OnBuild) > 0 {
			b.fail(api.BuildError{Phase: api.BuildPhaseBuild, File: DockerfileName, Line: ext.Line,
				Message: fmt.Sprintf("the image %s has ONBUILD triggers, which are not allowed in task builds", ext.Ref)})
			ok = false
		}
	}
	return ok
}

// imageBuild runs the BuildKit build of the pack with the timeout SCANTOR_BUILD_TIMEOUT. No registry
// credentials, no labels and no parent pulls are passed (docs/security.md BLD-8).
func (b *builder) imageBuild(ctx context.Context, pinned string) bool {
	buildCtx, cancel := context.WithTimeout(ctx, b.p.cfg.BuildTimeout)
	defer cancel()
	args := map[string]*string{dockerfile.BaseArg: &pinned}
	if b.opts.DebugBuild {
		gc := DebugGCFlags
		args[GCFlagsArg] = &gc
	}
	buildID := uuid.NewString()
	b.log(api.BuildPhaseBuild, "building %s", b.tag)
	resp, err := b.p.docker.ImageBuild(buildCtx, b.pack.Tar(), client.ImageBuildOptions{
		Tags:        []string{b.tag},
		Dockerfile:  DockerfileName,
		BuildArgs:   args,
		Remove:      true,
		ForceRemove: true,
		PullParent:  false,
		Version:     build.BuilderBuildKit,
		BuildID:     buildID,
	})
	if err != nil {
		if b.buildCancelled(ctx, buildCtx, buildID) {
			return false
		}
		b.failf(api.BuildPhasePlatform, "start the build: %v", err)
		return false
	}
	defer resp.Body.Close()
	buildErr, streamErr := b.readBuildStream(resp.Body)
	if b.buildCancelled(ctx, buildCtx, buildID) {
		return false
	}
	switch {
	case buildErr != "":
		b.fail(api.BuildError{Phase: api.BuildPhaseBuild, Message: buildErr})
		return false
	case streamErr != nil:
		b.failf(api.BuildPhasePlatform, "read the build output: %v", streamErr)
		return false
	}
	return true
}

// buildCancelled reports (and records) a build that ended because it exceeded SCANTOR_BUILD_TIMEOUT
// or because the pipeline was interrupted. The build is cancelled on the daemon too.
func (b *builder) buildCancelled(ctx, buildCtx context.Context, buildID string) bool {
	if buildCtx.Err() == nil {
		return false
	}
	if _, err := b.p.docker.BuildCancel(context.WithoutCancel(ctx), buildID, client.BuildCancelOptions{}); err != nil {
		b.warn(api.BuildPhaseBuild, fmt.Sprintf("cancel the build on the daemon: %v", err))
	}
	if ctx.Err() != nil {
		b.interrupted(ctx)
		return true
	}
	b.failf(api.BuildPhaseBuild, "build exceeded %s (SCANTOR_BUILD_TIMEOUT)", formatDuration(b.p.cfg.BuildTimeout))
	return true
}

// readBuildStream decodes the build's JSON message stream into build log events. It returns the error
// reported by the build (task content) separately from stream failures (platform).
func (b *builder) readBuildStream(body io.Reader) (buildErr string, streamErr error) {
	trace := newTraceRenderer(func(level, text string) {
		b.p.events.Log(api.BuildPhaseBuild, StreamBuild, level, text)
	})
	defer trace.close()
	dec := json.NewDecoder(body)
	for {
		var msg jsonstream.Message
		if err := dec.Decode(&msg); err != nil {
			if errors.Is(err, io.EOF) {
				return "", nil
			}
			return "", err
		}
		switch {
		case msg.Error != nil:
			return msg.Error.Message, nil
		case msg.ID == "moby.buildkit.trace" && msg.Aux != nil:
			st, err := decodeTraceAux(*msg.Aux)
			if err != nil {
				b.warn(api.BuildPhaseBuild, err.Error())
				continue
			}
			trace.render(st)
		case msg.Stream != "":
			b.p.events.Log(api.BuildPhaseBuild, StreamBuild, LevelInfo, msg.Stream)
		}
	}
}

// inspect checks the built image (docs/tasks.md §9.4): size within SCANTOR_MAX_IMAGE_BYTES and no
// forbidden label among the effective labels, including inherited ones (docs/security.md LBL-3). A
// rejected image is removed so it cannot be used.
func (b *builder) inspect(ctx context.Context) bool {
	inspect, err := b.p.docker.ImageInspect(ctx, b.tag)
	if err != nil {
		b.failf(api.BuildPhasePlatform, "inspect %s: %v", b.tag, err)
		return false
	}
	ok := true
	if limit := b.p.cfg.MaxImageBytes; limit > 0 && inspect.Size > limit {
		b.failf(api.BuildPhaseBuild, "the image is %s; the limit is %s (SCANTOR_MAX_IMAGE_BYTES)", formatBytes(inspect.Size), envconf.FormatByteSize(limit))
		ok = false
	}
	if inspect.Config != nil {
		keys := make([]string, 0, len(inspect.Config.Labels))
		for k := range inspect.Config.Labels {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		for _, k := range keys {
			if container.ForbiddenImageLabel(k) {
				b.failf(api.BuildPhaseBuild, "the image carries the label %q; traefik.*, com.docker.compose.* and scantor.* labels are reserved", k)
				ok = false
			}
		}
	}
	if !ok {
		b.removeRejected(ctx)
		return false
	}
	b.image = &Image{
		Ref:      b.tag,
		ID:       inspect.ID,
		Bytes:    inspect.Size,
		Platform: api.Platform{OS: inspect.Os, Arch: inspect.Architecture, Variant: inspect.Variant},
	}
	b.res.Image = b.image
	return true
}

func (b *builder) removeRejected(ctx context.Context) {
	if _, err := b.p.docker.ImageRemove(context.WithoutCancel(ctx), b.tag, client.ImageRemoveOptions{}); err != nil && !container.IsNotFound(err) {
		b.warn(api.BuildPhaseBuild, fmt.Sprintf("remove the rejected image %s: %v", b.tag, err))
	}
}

// pruneCache prunes the build cache to SCANTOR_BUILD_CACHE_MAX_BYTES, least recently used records first
// (All: every unused record is a candidate, not only dangling ones). A failed prune is reported as a
// warning: it never fails the build.
func (b *builder) pruneCache(ctx context.Context) {
	limit := b.p.cfg.BuildCacheMaxBytes
	if limit <= 0 {
		return
	}
	opts := client.BuildCachePruneOptions{All: true, MaxUsedSpace: limit}
	if cv, ok := b.p.docker.(interface{ ClientVersion() string }); ok && versions.LessThan(cv.ClientVersion(), "1.48") {
		// Daemons before API 1.48 only know keep-storage, which the client sends for ReservedSpace.
		opts = client.BuildCachePruneOptions{All: true, ReservedSpace: limit}
	}
	res, err := b.p.docker.BuildCachePrune(context.WithoutCancel(ctx), opts)
	if err != nil {
		b.warn(api.BuildPhaseBuild, fmt.Sprintf("prune the build cache: %v", err))
		return
	}
	if res.Report.SpaceReclaimed > 0 {
		b.log(api.BuildPhaseBuild, "pruned %s of build cache", formatBytes(int64(res.Report.SpaceReclaimed))) //nolint:gosec // a byte count
	}
}
