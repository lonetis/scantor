package cli

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/envconf"
	"github.com/lonetis/scantor/internal/manifest"
	"github.com/lonetis/scantor/internal/version"
)

// DevMode selects how `scantor dev run` executes.
type DevMode string

// Dev modes.
const (
	DevModeLocal  DevMode = "local"
	DevModeRemote DevMode = "remote"
)

// Compiled-in defaults, equal to the .env.example defaults (docs/architecture.md §10).
const (
	DefaultURL                = "http://localhost:3000"
	DefaultTrancoURL          = "https://tranco-list.eu"
	DefaultCruxURL            = "https://raw.githubusercontent.com/zakird/crux-top-lists/main"
	DefaultBuildTimeout       = 30 * time.Minute
	DefaultMaxImageBytes      = 10 * envconf.GiB
	DefaultDescribeTimeout    = 10 * time.Minute
	DefaultTaskMaxPackBytes   = 50 * envconf.MiB
	DefaultTaskMaxFiles       = 5000
	DefaultTaskMaxBytes       = 200 * envconf.MiB
	DefaultPublicURL          = "http://localhost:3000"
	DefaultRegistryPublicHost = "localhost:5000"
)

// Config is everything the CLI and the task pipeline (`scantor task …`, `scantor templates …`) read
// from the environment (docs/architecture.md §10, the CLI section of .env.example). Credentials come
// only from SCANTOR_URL and SCANTOR_TOKEN.
type Config struct {
	// URL is the orchestrator base URL (SCANTOR_URL).
	URL string
	// Token is the API key (SCANTOR_TOKEN); empty when unset.
	Token string
	// CACert holds extra trusted CA certificates (SCANTOR_CA_CERT, normalised PEM).
	CACert string
	// DevMode selects local or remote `dev run` (SCANTOR_DEV_MODE).
	DevMode DevMode
	// Workspace is the editor's workspace root (SCANTOR_WORKSPACE); inside it `push` only publishes.
	Workspace string
	// Images is the SCANTOR_IMAGE_PREFIX/SCANTOR_IMAGE_TAG override of image references (active only
	// when the tag is set).
	Images version.ImageOverride
	// DataSources are the template data source URLs of local runs (SCANTOR_TRANCO_URL, SCANTOR_CRUX_URL).
	DataSources api.DataSources
	// Limits are the manifest instance limits of rule M8 (SCANTOR_MAX_WORKERS_PER_SCAN,
	// SCANTOR_MAX_PROCESSES_PER_WORKER).
	Limits manifest.Limits
	// Pipeline holds the task-pipeline settings.
	Pipeline PipelineConfig
	// Warnings lists invalid non-security values that fell back to their defaults.
	Warnings []string
}

// PipelineConfig are the task-pipeline settings (docs/tasks.md §9.10).
type PipelineConfig struct {
	BuildTimeout  time.Duration // SCANTOR_BUILD_TIMEOUT
	MaxImageBytes int64         // SCANTOR_MAX_IMAGE_BYTES
	// BuildCacheMaxBytes is SCANTOR_BUILD_CACHE_MAX_BYTES. It stays 0 (no pruning) unless the variable
	// is set: docs/tasks.md §9.4 prunes only "when SCANTOR_BUILD_CACHE_MAX_BYTES is set", and the
	// BuildKit cache of a developer machine is shared with other projects, so the CLI never prunes it
	// by default. The orchestrator always passes its value to `scantor task build`.
	BuildCacheMaxBytes int64
	DescribeTimeout    time.Duration // SCANTOR_DESCRIBE_TIMEOUT
	TaskMaxPackBytes   int64         // SCANTOR_TASK_MAX_PACK_BYTES
	TaskMaxFiles       int           // SCANTOR_TASK_MAX_FILES
	TaskMaxBytes       int64         // SCANTOR_TASK_MAX_BYTES
	// PublicURL and RegistryPublicHost feed Dockerfile rule D5 (SCANTOR_PUBLIC_URL,
	// SCANTOR_REGISTRY_PUBLIC_HOST).
	PublicURL          string
	RegistryPublicHost string
	// RegistryPushPassword is the internal contract SCANTOR_REGISTRY_PUSH_PASSWORD, set only by the
	// orchestrator for `scantor task build --push`.
	RegistryPushPassword string
}

// LoadConfig reads the CLI configuration. Invalid credentials, URLs, CA certificates and mode selectors
// are errors; other invalid values fall back to their defaults and are listed in Warnings.
func LoadConfig(getenv func(string) string) (Config, error) {
	r := envconf.NewReader(getenv)
	cfg := Config{
		URL:       r.URL("SCANTOR_URL", DefaultURL, []string{"http", "https"}, envconf.Security()),
		Token:     strings.TrimSpace(r.String("SCANTOR_TOKEN", "")),
		CACert:    r.PEMCertificates("SCANTOR_CA_CERT", envconf.Security()),
		DevMode:   DevMode(r.Enum("SCANTOR_DEV_MODE", string(DevModeLocal), []string{string(DevModeLocal), string(DevModeRemote)}, envconf.Security())),
		Workspace: strings.TrimSpace(r.String("SCANTOR_WORKSPACE", "")),
		Images: version.ImageOverride{
			Prefix: strings.TrimSpace(r.String("SCANTOR_IMAGE_PREFIX", "")),
			Tag:    strings.TrimSpace(r.String("SCANTOR_IMAGE_TAG", "")),
		},
		DataSources: api.DataSources{
			Tranco: r.URL("SCANTOR_TRANCO_URL", DefaultTrancoURL, []string{"http", "https"}),
			Crux:   r.URL("SCANTOR_CRUX_URL", DefaultCruxURL, []string{"http", "https"}),
		},
		Limits: manifest.Limits{
			MaxWorkersPerScan:     int(r.Int("SCANTOR_MAX_WORKERS_PER_SCAN", int64(manifest.DefaultLimits().MaxWorkersPerScan), 1, 1_000_000)),
			MaxProcessesPerWorker: int(r.Int("SCANTOR_MAX_PROCESSES_PER_WORKER", int64(manifest.DefaultLimits().MaxProcessesPerWorker), 1, 1_000_000)),
		},
		Pipeline: PipelineConfig{
			BuildTimeout:         r.Duration("SCANTOR_BUILD_TIMEOUT", DefaultBuildTimeout),
			MaxImageBytes:        r.ByteSize("SCANTOR_MAX_IMAGE_BYTES", DefaultMaxImageBytes),
			BuildCacheMaxBytes:   r.ByteSize("SCANTOR_BUILD_CACHE_MAX_BYTES", 0),
			DescribeTimeout:      r.Duration("SCANTOR_DESCRIBE_TIMEOUT", DefaultDescribeTimeout),
			TaskMaxPackBytes:     r.ByteSize("SCANTOR_TASK_MAX_PACK_BYTES", DefaultTaskMaxPackBytes),
			TaskMaxFiles:         int(r.Int("SCANTOR_TASK_MAX_FILES", DefaultTaskMaxFiles, 1, 10_000_000)),
			TaskMaxBytes:         r.ByteSize("SCANTOR_TASK_MAX_BYTES", DefaultTaskMaxBytes),
			PublicURL:            r.URL("SCANTOR_PUBLIC_URL", DefaultPublicURL, []string{"http", "https"}),
			RegistryPublicHost:   strings.TrimSpace(r.String("SCANTOR_REGISTRY_PUBLIC_HOST", DefaultRegistryPublicHost)),
			RegistryPushPassword: strings.TrimSpace(r.String("SCANTOR_REGISTRY_PUSH_PASSWORD", "")),
		},
	}
	if cfg.Token != "" && !strings.HasPrefix(cfg.Token, "sk_scantor_") {
		r.Fail("SCANTOR_TOKEN", errors.New("must be a scantor API key (sk_scantor_…)"))
	}
	if cfg.Images.Prefix != "" && !strings.HasSuffix(cfg.Images.Prefix, "/") {
		r.Fail("SCANTOR_IMAGE_PREFIX", errors.New(`must end with "/"`))
	}
	cfg.Warnings = r.Warnings()
	if err := r.Err(); err != nil {
		return cfg, ValidationError(fmt.Errorf("invalid configuration: %w", err))
	}
	return cfg, nil
}

// ContainerHost is the host name that reaches the Docker host from inside a container started by the
// CLI docker shim (`--add-host host.docker.internal:host-gateway`).
const ContainerHost = "host.docker.internal"

// EffectiveURL returns the orchestrator URL to use. When the CLI runs inside a container (the docker
// shim), a loopback host would point at the container itself, so localhost, 127.0.0.1 and ::1 are
// rewritten to host.docker.internal (the port is kept).
func (c Config) EffectiveURL(containerized bool) string {
	if !containerized {
		return c.URL
	}
	u, err := url.Parse(c.URL)
	if err != nil {
		return c.URL
	}
	host := u.Hostname()
	ip := net.ParseIP(host)
	if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return c.URL
	}
	if port := u.Port(); port != "" {
		u.Host = net.JoinHostPort(ContainerHost, port)
	} else {
		u.Host = ContainerHost
	}
	return u.String()
}
