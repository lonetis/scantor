package container

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"strings"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/pkg/authconfig"
	"github.com/moby/moby/api/types/jsonstream"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/api/types/registry"
	"github.com/moby/moby/client"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

// NewClient returns a Docker Engine API client configured from DOCKER_HOST and the related variables
// (moby's FromEnv), with API version negotiation and the given User-Agent (for example
// version.UserAgent("scantor-node")).
func NewClient(userAgent string) (*client.Client, error) {
	c, err := client.New(client.FromEnv, client.WithUserAgent(userAgent))
	if err != nil {
		return nil, fmt.Errorf("docker client: %w", err)
	}
	return c, nil
}

func isNotFound(err error) bool { return cerrdefs.IsNotFound(err) }

// IsNotFound reports whether a Docker API error means "no such object".
func IsNotFound(err error) bool { return cerrdefs.IsNotFound(err) }

// IsConflict reports whether a Docker API error is a conflict (for example a container name in use).
func IsConflict(err error) bool { return cerrdefs.IsConflict(err) }

// RegistryAuth encodes the X-Registry-Auth header value for one pull: base64url of the JSON auth config
// WITH '=' padding. Without padding the daemon silently pulls anonymously (docs/nodes.md §10.1), so the
// value is always produced by moby's authconfig.Encode, never by hand.
func RegistryAuth(username, password, serverAddress string) (string, error) {
	return authconfig.Encode(registry.AuthConfig{Username: username, Password: password, ServerAddress: serverAddress})
}

// PullOptions configure Pull.
type PullOptions struct {
	// RegistryAuth is the X-Registry-Auth value (RegistryAuth); empty pulls anonymously.
	RegistryAuth string
	// Platform selects the platform to pull; nil lets the daemon choose its own.
	Platform *ocispec.Platform
	// Progress receives every progress message; nil discards them.
	Progress func(jsonstream.Message)
}

// Pull pulls ref and waits for completion. An error message in the pull stream is returned as an
// error. The credential travels only in this request; it is never stored in the daemon's configuration.
func Pull(ctx context.Context, docker client.APIClient, ref string, opts PullOptions) error {
	pullOpts := client.ImagePullOptions{RegistryAuth: opts.RegistryAuth}
	if opts.Platform != nil {
		pullOpts.Platforms = []ocispec.Platform{*opts.Platform}
	}
	resp, err := docker.ImagePull(ctx, ref, pullOpts)
	if err != nil {
		return fmt.Errorf("pull %s: %w", ref, err)
	}
	for msg, err := range resp.JSONMessages(ctx) {
		if err != nil {
			return fmt.Errorf("pull %s: %w", ref, err)
		}
		if msg.Error != nil {
			return fmt.Errorf("pull %s: %w", ref, errors.New(msg.Error.Message))
		}
		if opts.Progress != nil {
			opts.Progress(msg)
		}
	}
	return nil
}

// DaemonPlatform returns the operating system and architecture (GOARCH spelling: amd64, arm64) of the
// Docker daemon.
func DaemonPlatform(ctx context.Context, docker client.APIClient) (os, arch string, err error) {
	v, err := docker.ServerVersion(ctx, client.ServerVersionOptions{})
	if err != nil {
		return "", "", fmt.Errorf("docker version: %w", err)
	}
	if v.Os == "" || v.Arch == "" {
		return "", "", errors.New("docker version: the daemon did not report its platform")
	}
	return v.Os, v.Arch, nil
}

// NativeFor reports whether the running binary is a linux binary of the daemon's architecture, so it can
// be injected as is.
func NativeFor(daemonOS, daemonArch string) bool {
	return runtime.GOOS == "linux" && daemonOS == "linux" && runtime.GOARCH == daemonArch
}

// Names of the networks scantor creates (docs/architecture.md §6.1).
const (
	NetworkEgress  = "scantor-egress"
	NetworkWorkers = "scantor-workers"
	// NetworkSandbox is created by compose, not by scantor.
	NetworkSandbox = "scantor-sandbox"
)

// bridgeICCOption is the bridge driver option that disables inter-container traffic when "false".
const bridgeICCOption = "com.docker.network.bridge.enable_icc"

// EnsureNetwork creates the bridge network name with inter-container traffic disabled
// (com.docker.network.bridge.enable_icc=false), no IPv6 and the managed labels of kind network. An
// existing network of that name (a 409, or a concurrent create) counts as success only when
// CheckIsolatedNetwork accepts it; scantor never deletes these networks.
func EnsureNetwork(ctx context.Context, docker client.APIClient, name string) error {
	labels, err := ManagedLabels(KindNetwork, Identity{})
	if err != nil {
		return err
	}
	ipv6 := false
	_, err = docker.NetworkCreate(ctx, name, client.NetworkCreateOptions{
		Driver:     "bridge",
		EnableIPv6: &ipv6,
		Options:    map[string]string{bridgeICCOption: "false"},
		Labels:     labels,
	})
	if err == nil {
		return nil
	}
	existing, inspectErr := docker.NetworkInspect(ctx, name, client.NetworkInspectOptions{})
	if inspectErr != nil {
		return fmt.Errorf("create network %s: %w", name, err)
	}
	return CheckIsolatedNetwork(existing.Network)
}

// CheckIsolatedNetwork returns an error naming every property in which an existing network differs
// from what EnsureNetwork creates: the bridge driver, inter-container traffic disabled, no IPv6 and the
// managed labels of kind network (docs/nodes.md §6.8). A network of the right name that someone else
// created, or that was edited, could let workers of different scans and users reach each other, so it is
// never used as is.
func CheckIsolatedNetwork(n network.Inspect) error {
	var problems []string
	if n.Driver != "bridge" {
		problems = append(problems, fmt.Sprintf("its driver is %q, not bridge", n.Driver))
	}
	if n.Options[bridgeICCOption] != "false" {
		problems = append(problems, "inter-container traffic is enabled ("+bridgeICCOption+" is not false)")
	}
	if n.EnableIPv6 {
		problems = append(problems, "IPv6 is enabled")
	}
	if s, err := Labels(); err != nil || !s.hasManagedLabels(KindNetwork, n.Labels) {
		problems = append(problems, "it lacks the managed labels of kind network")
	}
	if len(problems) == 0 {
		return nil
	}
	return fmt.Errorf("network %s was not created by scantor as an isolated worker network: %s; remove it so that it is created again",
		n.Name, strings.Join(problems, ", "))
}
