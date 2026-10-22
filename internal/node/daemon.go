// Package node is the node daemon (`scantor node`, docs/nodes.md): it registers its instance with the
// orchestrator (hello and the instance lease), long-polls the desired worker set, reconciles worker
// containers on the local Docker engine level-triggered with one actor per worker, reports status
// snapshots, tails worker logs on request, keeps images and disk tidy and applies the egress deny list.
//
// The daemon is stateless: its inputs are its environment (Config), the Docker engine and the
// orchestrator's desired set. It rebuilds its state from container labels whenever it starts, and it
// manages only containers it created itself, identified by the managed labels it set plus the name
// prefix scantor-w- (docs/security.md LBL-5). It only makes outbound requests to SCANTOR_URL.
//
// Structure:
//   - config.go: LoadConfig (the only place that reads the environment).
//   - daemon.go, host.go: start-up, the hello loop and the Docker host facts.
//   - session.go: one registered instance: its lifecycle (conflict, unauthorized mode, shutdown), the
//     desired set, Docker events and the worker network.
//   - loops.go: the assignments long-poll, status reports, on-demand log tails, image GC and the egress
//     loop.
//   - reconcile.go: worker container recognition (LBL-5) and the level-triggered reconcile pass that
//     maps containers and the desired set onto actors.
//   - actor.go: the per-worker state machine (pull, create, inject, start, limits, exits, removal).
//   - spec.go, validate.go, dind.go: the worker container spec, assignment validation and DinD modes.
//   - images.go, logs.go, netpol.go, health.go: pulls and image GC, log tails, the egress helper, the
//     status file, healthcheck and clock offset.
package node

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
	"github.com/lonetis/scantor/internal/version"
)

// Options are the dependencies of a daemon.
type Options struct {
	Config Config
	// Docker is the Engine API client (container.NewClient with User-Agent scantor-node/<version>).
	Docker client.APIClient
	// Logger is a redacting logger (redact.NewLogger).
	Logger *slog.Logger
}

// Daemon is one node daemon process.
type Daemon struct {
	cfg    Config
	docker client.APIClient
	log    *slog.Logger
	api    *api.Client
	t      timings

	// Hooks replaced by tests.
	now          func() time.Time
	statusFile   string
	diskFree     func() (int64, error)
	mountinfo    string
	binarySource func(context.Context) (*container.Binary, error)
	httpClient   *http.Client
	// workerNetwork overrides the worker network name (integration tests).
	workerNetwork string
	// helperNetwork overrides the egress helper's network mode (integration tests).
	helperNetwork string

	started    time.Time
	host       hostInfo
	dind       string // effective DinD mode
	self       *selfInfo
	instanceID string
	clock      clockEstimate
	gc         *imageGC
	egressOK   atomic.Bool
	// current is the running session (nil between sessions).
	current atomic.Pointer[session]

	binaryMu sync.Mutex
	binary   *container.Binary
}

// New returns a daemon for opts.
func New(opts Options) (*Daemon, error) {
	if opts.Docker == nil || opts.Logger == nil {
		return nil, errors.New("node daemon: Docker client and logger are required")
	}
	d := &Daemon{
		cfg:        opts.Config,
		docker:     opts.Docker,
		log:        opts.Logger.With("component", "node"),
		t:          defaultTimings(),
		now:        time.Now,
		statusFile: StatusFile,
		diskFree:   func() (int64, error) { return diskFree("/") },
		mountinfo:  "/proc/self/mountinfo",
	}
	d.binarySource = d.resolveOwnBinary
	return d, nil
}

// Run runs the daemon until ctx ends (SIGTERM), then shuts down gracefully: workers keep running and
// are adopted by the next daemon instance (docs/nodes.md §7.5). It returns a *ConfigError when the
// transport check refuses SCANTOR_URL.
func (d *Daemon) Run(ctx context.Context) error {
	d.started = d.now()
	d.gc = newImageGC(d.started)
	for _, w := range d.cfg.Warnings {
		d.log.Warn(w)
	}
	if err := d.checkTransport(ctx); err != nil {
		return err
	}
	if err := d.connect(ctx); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return nil
	}
	var hello *api.NodeHelloResponse
	for {
		if hello == nil {
			h, err := d.helloLoop(ctx)
			if err != nil {
				return err
			}
			if h == nil { // ctx ended
				return nil
			}
			hello = h
		}
		next := d.runSession(ctx, hello)
		if ctx.Err() != nil {
			d.log.Info("node daemon stopped; workers keep running")
			return nil
		}
		hello = next
	}
}

// checkTransport applies the plaintext rule to SCANTOR_URL before the first connection
// (docs/nodes.md §5.1 step 2). A refusal is a configuration error; other failures (DNS) are retried.
func (d *Daemon) checkTransport(ctx context.Context) error {
	policy := d.policy()
	b := backoff{min: d.t.apiBackoffMin, max: d.t.apiBackoffMax}
	for {
		err := policy.CheckTransport(ctx, d.cfg.URL)
		switch {
		case err == nil:
			return nil
		case errors.Is(err, api.ErrPlaintextRefused):
			return &ConfigError{Err: fmt.Errorf("SCANTOR_URL: %w", err)}
		case ctx.Err() != nil:
			return nil
		}
		d.log.Warn("cannot check the transport of SCANTOR_URL yet; retrying", "err", err)
		if !sleep(ctx, b.next()) {
			return nil
		}
	}
}

func (d *Daemon) policy() api.Policy {
	return api.Policy{CACertPEM: d.cfg.CACert, AllowInsecure: d.cfg.AllowInsecure, EnforcePlaintext: true}
}

// connect creates the API client and learns about the Docker host (docs/nodes.md §5.1 steps 3–5).
// Docker errors are retried until the engine answers.
func (d *Daemon) connect(ctx context.Context) error {
	c, err := api.New(api.Options{
		BaseURL:    d.cfg.URL,
		Credential: api.Credential{Kind: api.PrincipalNode, Token: d.cfg.Token},
		Policy:     d.policy(),
		HTTPClient: d.httpClient,
		Logger:     d.log,
	})
	if err != nil {
		return &ConfigError{Err: err}
	}
	d.api = c
	b := backoff{min: d.t.apiBackoffMin, max: d.t.apiBackoffMax}
	for {
		host, err := probeHost(ctx, d.docker)
		if err == nil {
			d.host = host
			break
		}
		if ctx.Err() != nil {
			return nil
		}
		d.log.Warn("Docker is not available yet; retrying", "err", err)
		if !sleep(ctx, b.next()) {
			return nil
		}
	}
	d.dind, err = effectiveDinD(d.cfg.DinD, d.host.runtimes)
	if err != nil {
		d.log.Error(err.Error())
	}
	if self, err := inspectSelf(ctx, d.docker, selfCandidates(d.mountinfo)); err != nil {
		d.log.Warn("self-inspection failed; the egress helper is disabled", "err", err)
	} else {
		d.self = &self
	}
	if d.instanceID, err = newInstanceID(d.host.engineID); err != nil {
		return err
	}
	d.log.Info("node daemon starting",
		"version", version.Version, "instanceId", d.instanceID, "builtIn", d.cfg.BuiltIn,
		"os", d.host.os, "arch", d.host.arch, "dockerVersion", d.host.dockerVersion,
		"cpus", d.host.cpus, "dindMode", d.dind, "maxWorkers", d.maxWorkers())
	return nil
}

func (d *Daemon) maxWorkers() int { return d.cfg.EffectiveMaxWorkers(d.host.cpus) }

// workerNetworkName is scantor-sandbox on the built-in node and scantor-workers elsewhere.
func (d *Daemon) workerNetworkName() string {
	switch {
	case d.workerNetwork != "":
		return d.workerNetwork
	case d.cfg.BuiltIn:
		return container.NetworkSandbox
	default:
		return container.NetworkWorkers
	}
}

// diskFreeBytes measures free disk; failures are logged and reported as 0.
func (d *Daemon) diskFreeBytes() int64 {
	n, err := d.diskFree()
	if err != nil {
		d.log.Warn("cannot measure free disk space", "err", err)
		return 0
	}
	return n
}

// observeClock feeds a response's serverTime into the clock estimate.
func (d *Daemon) observeClock(serverTimeMs int64, resp *api.Response) {
	if serverTimeMs <= 0 || resp == nil {
		return
	}
	d.clock.observe(api.ClockOffset(serverTimeMs, resp.Sent, resp.Received))
}

// runtimeBinary returns the binary injected into workers, resolved once.
func (d *Daemon) runtimeBinary(ctx context.Context) (*container.Binary, error) {
	d.binaryMu.Lock()
	defer d.binaryMu.Unlock()
	if d.binary != nil {
		return d.binary, nil
	}
	b, err := d.binarySource(ctx)
	if err != nil {
		return nil, err
	}
	d.binary = b
	return b, nil
}

// resolveOwnBinary returns the daemon's own executable when it is a linux binary of the engine's
// architecture (always the case in the scantor image), and otherwise the linux binary extracted from
// the scantor image (a natively run daemon during development).
func (d *Daemon) resolveOwnBinary(ctx context.Context) (*container.Binary, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("own executable: %w", err)
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		cache = os.TempDir()
	}
	return container.RuntimeBinary{Docker: d.docker, CacheDir: cache, Executable: exe}.Resolve(ctx)
}

// helloRequest builds the hello body with the managed containers found now.
func (d *Daemon) helloRequest(found []api.NodeContainer) api.NodeHelloRequest {
	return api.NodeHelloRequest{
		InstanceID: d.instanceID,
		Version:    version.Version,
		Info: api.NodeHelloInfo{
			Hostname:          d.host.hostname,
			OS:                d.host.os,
			Arch:              d.host.arch,
			Kernel:            d.host.kernel,
			DockerVersion:     d.host.dockerVersion,
			CPUs:              d.host.cpus,
			MemoryBytes:       d.host.memoryBytes,
			DiskFreeBytes:     d.diskFreeBytes(),
			DinDMode:          d.dind,
			MaxWorkers:        d.maxWorkers(),
			EgressDenyApplied: d.egressOK.Load(),
		},
		Containers: found,
	}
}

// helloLoop calls hello until it succeeds (docs/nodes.md §5.2). It returns nil, nil when ctx ends.
func (d *Daemon) helloLoop(ctx context.Context) (*api.NodeHelloResponse, error) {
	b := backoff{min: d.t.apiBackoffMin, max: d.t.apiBackoffMax}
	for {
		resp, retry, _ := d.helloOnce(ctx, &b)
		if resp != nil {
			return resp, nil
		}
		if !sleep(ctx, retry) {
			return nil, nil
		}
	}
}

// helloOnce performs one hello. It returns the response, or the delay before the next attempt per the
// retry table of docs/nodes.md §5.2 and the kind of the failure.
func (d *Daemon) helloOnce(ctx context.Context, b *backoff) (*api.NodeHelloResponse, time.Duration, apiErrKind) {
	found, err := listWorkerContainers(ctx, d.docker)
	if err != nil {
		d.log.Warn("cannot list worker containers", "err", err)
		return nil, b.next(), errTransient
	}
	resp, meta, err := d.api.NodeHello(ctx, d.helloRequest(helloContainers(found)))
	if err == nil {
		d.observeClock(resp.ServerTime, meta)
		b.reset()
		d.log.Info("registered with the orchestrator", "nodeId", resp.Node.ID, "node", resp.Node.Name, "builtIn", resp.Node.BuiltIn)
		return resp, 0, errTransient
	}
	if ctx.Err() != nil {
		return nil, 0, errTransient
	}
	switch kindOf(err) {
	case errUnauthorized:
		d.log.Warn("the orchestrator rejected the node token (401); retrying hello", "retryIn", d.t.unauthorizedRetry, "err", err)
		return nil, d.t.unauthorizedRetry, errUnauthorized
	case errConflict:
		retry := conflictRetry(err)
		d.log.Warn("another daemon instance holds this node's lease (409 nodeInstanceConflict)", "retryIn", retry)
		return nil, retry, errConflict
	case errIncompatible:
		var details api.IncompatibleVersionDetails
		if e, ok := api.AsError(err); ok {
			_ = e.DecodeDetails(&details)
		}
		d.log.Error("the orchestrator does not accept this daemon version (426 incompatibleVersion); update the node",
			"version", version.Version, "minVersion", details.MinVersion, "serverVersion", details.ServerVersion, "retryIn", d.t.incompatibleRetry)
		return nil, d.t.incompatibleRetry, errIncompatible
	default:
		delay := b.next()
		d.log.Warn("hello failed; retrying", "retryIn", delay.Round(time.Millisecond), "err", err)
		return nil, delay, errTransient
	}
}

// conflictRetry returns details.retryAfterMs plus jitter (at least one second).
func conflictRetry(err error) time.Duration {
	var details api.NodeInstanceConflictDetails
	if e, ok := api.AsError(err); ok {
		_ = e.DecodeDetails(&details)
	}
	base := time.Duration(max(details.RetryAfterMs, 0)) * time.Millisecond
	return base + jitter(max(base/5, time.Second), 0.5)
}

// apiErrKind classifies node API errors.
type apiErrKind int

const (
	errTransient apiErrKind = iota
	errUnauthorized
	errConflict
	errIncompatible
)

func kindOf(err error) apiErrKind {
	e, ok := api.AsError(err)
	switch {
	case !ok:
		return errTransient
	case e.Status == http.StatusUnauthorized:
		return errUnauthorized
	case e.Status == http.StatusConflict && e.Code == api.CodeNodeInstanceConflict:
		return errConflict
	case e.Status == http.StatusUpgradeRequired:
		return errIncompatible
	default:
		return errTransient
	}
}
