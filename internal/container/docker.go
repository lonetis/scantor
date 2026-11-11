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
// (com.docker.network.bridge.enable_icc=false), no IPv6 and the managed labels of kind network, and
// reports whether the network it created or found is isolated. An existing network of that name (a 409,
// or a concurrent create) counts as success only when CheckWorkerNetwork accepts it; scantor never
// deletes these networks.
//
// With allowUnisolated (SCANTOR_ALLOW_UNISOLATED_NETWORKS), a daemon that cannot disable inter-container
// traffic, such as rootless Docker without br_netfilter, gets a plain bridge network instead, and
// isolated is false: containers on it can reach each other.
func EnsureNetwork(ctx context.Context, docker client.APIClient, name string, allowUnisolated bool) (isolated bool, err error) {
	labels, err := ManagedLabels(KindNetwork, Identity{})
	if err != nil {
		return false, err
	}
	ipv6 := false
	create := func(options map[string]string) error {
		_, err := docker.NetworkCreate(ctx, name, client.NetworkCreateOptions{
			Driver:     "bridge",
			EnableIPv6: &ipv6,
			Options:    options,
			Labels:     labels,
		})
		return err
	}
	// existing checks a network that already exists, because the create failed; found is false when
	// there is none.
	existing := func() (isolated, found bool, err error) {
		n, inspectErr := docker.NetworkInspect(ctx, name, client.NetworkInspectOptions{})
		if inspectErr != nil {
			return false, false, inspectErr
		}
		isolated, err = CheckWorkerNetwork(n.Network, allowUnisolated)
		return isolated, true, err
	}

	createErr := create(map[string]string{bridgeICCOption: "false"})
	if createErr == nil {
		return true, nil
	}
	isolated, found, err := existing()
	switch {
	case found:
		return isolated, err
	case !allowUnisolated || !IsNotFound(err):
		return false, fmt.Errorf("create network %s: %w (if this Docker daemon cannot disable inter-container traffic, "+
			"as rootless Docker without br_netfilter cannot, load br_netfilter or set SCANTOR_ALLOW_UNISOLATED_NETWORKS=true)", name, createErr)
	}
	if plainErr := create(nil); plainErr != nil {
		if isolated, found, err := existing(); found {
			return isolated, err
		}
		return false, fmt.Errorf("create network %s with inter-container isolation: %w; without it: %w", name, createErr, plainErr)
	}
	return false, nil
}

// InterContainerTrafficDisabled reports whether containers on n cannot reach each other.
func InterContainerTrafficDisabled(n network.Inspect) bool {
	return n.Options[bridgeICCOption] == "false"
}

// CheckWorkerNetwork returns an error naming every property in which an existing network differs from
// what EnsureNetwork creates: the bridge driver, inter-container traffic disabled, no IPv6 and the
// managed labels of kind network (docs/nodes.md §6.8). A network of the right name that someone else
// created, or that was edited, could let workers of different scans and users reach each other, so it is
// never used as is. allowUnisolated accepts inter-container traffic, which isolated then reports.
func CheckWorkerNetwork(n network.Inspect, allowUnisolated bool) (isolated bool, err error) {
	isolated = InterContainerTrafficDisabled(n)
	var problems []string
	if n.Driver != "bridge" {
		problems = append(problems, fmt.Sprintf("its driver is %q, not bridge", n.Driver))
	}
	if !isolated && !allowUnisolated {
		problems = append(problems, "inter-container traffic is enabled ("+bridgeICCOption+" is not false; "+
			"SCANTOR_ALLOW_UNISOLATED_NETWORKS=true accepts it)")
	}
	if n.EnableIPv6 {
		problems = append(problems, "IPv6 is enabled")
	}
	if s, err := Labels(); err != nil || !s.hasManagedLabels(KindNetwork, n.Labels) {
		problems = append(problems, "it lacks the managed labels of kind network")
	}
	if len(problems) == 0 {
		return isolated, nil
	}
	return false, fmt.Errorf("network %s was not created by scantor as a worker network: %s; remove it so that it is created again",
		n.Name, strings.Join(problems, ", "))
}
