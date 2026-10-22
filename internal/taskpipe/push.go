package taskpipe

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"

	"github.com/distribution/reference"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
)

// RegistryPushUser is the registry user of the push credential (docs/auth.md §10.4).
const RegistryPushUser = "orchestrator"

// PushGateWaiting is the text of the event that asks for the push go-ahead (docs/tasks.md §9.7).
const PushGateWaiting = "waiting for push gate"

// pushAux is the final aux message of a push stream.
type pushAux struct {
	Tag    string `json:"Tag"`
	Digest string `json:"Digest"`
	Size   int64  `json:"Size"`
}

// pushDigestLine is the status line "<tag>: digest: sha256:… size: <n>" that ends a push. Docker 29 with
// the containerd image store sends only this line, no {Tag, Digest, Size} aux message.
var pushDigestLine = regexp.MustCompile(`^(\S+): digest: (sha256:[0-9a-f]{64}) size: [0-9]+$`)

// checkPushTarget verifies before anything runs that --push can succeed: the credential is present and
// the tag names a task repository on an explicit registry host, so the platform credential is never
// sent to Docker Hub or any other implied registry.
func checkPushTarget(tag, password string) error {
	if password == "" {
		return errors.New("--push needs the registry push credential in SCANTOR_REGISTRY_PUSH_PASSWORD")
	}
	named, err := reference.ParseNormalizedNamed(tag)
	if err != nil {
		return fmt.Errorf("invalid push reference %q: %w", tag, err)
	}
	domain := reference.Domain(named)
	if _, ok := named.(reference.NamedTagged); !ok || domain == "docker.io" || !strings.HasPrefix(tag, domain+"/") ||
		!strings.HasPrefix(reference.Path(named), "tasks/") {
		return fmt.Errorf("the push reference %q must be <registry host>/tasks/<taskId>:<revisionId>", tag)
	}
	return nil
}

// push is the push phase: wait for the gate when there is one, then push the tag with the
// `orchestrator` registry credential and record the digest.
func (b *builder) push(ctx context.Context) bool {
	named, err := reference.ParseNormalizedNamed(b.tag)
	if err != nil {
		b.failf(api.BuildPhasePush, "invalid push reference %q: %v", b.tag, err)
		return false
	}
	tagged, ok := named.(reference.NamedTagged)
	if !ok {
		b.failf(api.BuildPhasePush, "the push reference %q has no tag", b.tag)
		return false
	}
	if b.opts.PushGate != nil && !b.waitGate(ctx) {
		return false
	}
	auth, err := container.RegistryAuth(RegistryPushUser, b.p.cfg.RegistryPushPassword, reference.Domain(named))
	if err != nil {
		b.failf(api.BuildPhasePush, "encode the registry credential: %v", err)
		return false
	}
	b.log(api.BuildPhasePush, "pushing %s", b.tag)
	resp, err := b.p.docker.ImagePush(ctx, b.tag, client.ImagePushOptions{RegistryAuth: auth})
	if err != nil {
		b.failf(api.BuildPhasePush, "push %s: %v", b.tag, err)
		return false
	}
	defer resp.Close()
	var auxDigest, statusDigest string
	for msg, err := range resp.JSONMessages(ctx) {
		if err != nil {
			b.failf(api.BuildPhasePush, "push %s: %v", b.tag, err)
			return false
		}
		if msg.Error != nil {
			b.failf(api.BuildPhasePush, "push %s: %s", b.tag, msg.Error.Message)
			return false
		}
		if msg.Aux != nil {
			var a pushAux
			if json.Unmarshal(*msg.Aux, &a) == nil && a.Digest != "" {
				auxDigest = a.Digest
			}
		}
		if m := pushDigestLine.FindStringSubmatch(msg.Status); m != nil && m[1] == tagged.Tag() {
			statusDigest = m[2]
		}
	}
	digest := auxDigest
	if digest == "" {
		digest = statusDigest
	}
	if digest == "" {
		b.failf(api.BuildPhasePush, "push %s: the registry reported no digest", b.tag)
		return false
	}
	b.image.Repository = reference.Path(named)
	b.image.Tag = tagged.Tag()
	b.image.Digest = digest
	b.log(api.BuildPhasePush, "pushed %s@%s", named.Name(), digest)
	return true
}

// waitGate emits the gate event and blocks until one line arrives on the gate: "push" starts the
// push; end of file or any other line ends the pipeline with a push error.
func (b *builder) waitGate(ctx context.Context) bool {
	b.p.events.Log(api.BuildPhasePush, StreamPipeline, LevelInfo, PushGateWaiting)
	line := make(chan string, 1)
	errc := make(chan error, 1)
	go func() {
		s, err := bufio.NewReader(b.opts.PushGate).ReadString('\n')
		if err != nil && (!errors.Is(err, io.EOF) || s == "") {
			errc <- err
			return
		}
		line <- strings.TrimRight(s, "\r\n")
	}()
	select {
	case <-ctx.Done():
		b.interrupted(ctx)
		return false
	case err := <-errc:
		if errors.Is(err, io.EOF) {
			b.failf(api.BuildPhasePush, "push gate closed")
		} else {
			b.failf(api.BuildPhasePush, "push gate: %v", err)
		}
		return false
	case l := <-line:
		if l != "push" {
			b.failf(api.BuildPhasePush, "push gate closed")
			return false
		}
		return true
	}
}
