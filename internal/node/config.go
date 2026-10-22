package node

import (
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"strings"
	"time"

	"github.com/lonetis/scantor/internal/envconf"
	"github.com/lonetis/scantor/internal/keys"
	"github.com/lonetis/scantor/internal/redact"
)

// Configured DinD modes (SCANTOR_NODE_DIND, docs/nodes.md §6.9).
const (
	DinDDisabled   = "disabled"
	DinDSysbox     = "sysbox"
	DinDPrivileged = "privileged"
)

// Defaults of the daemon variables; they equal the .env.example values.
const (
	defaultURL            = "http://localhost:3000"
	defaultEgressDeny     = "169.254.0.0/16,fd00:ec2::254/128,100.100.100.200/32"
	defaultPidsLimit      = 4096
	defaultShmSize        = 256 * envconf.MiB
	defaultNofile         = 65536
	defaultLogMaxSize     = 20 * envconf.MiB
	defaultLogMaxFiles    = 3
	defaultImageRetention = 24 * time.Hour
	defaultPullTimeout    = 30 * time.Minute
)

// LookupEnv is the signature of os.LookupEnv. The daemon needs it (rather than a plain getenv) because
// an empty SCANTOR_NODE_EGRESS_DENY disables the egress helper while an unset one keeps the default.
type LookupEnv func(string) (string, bool)

// Config is the daemon configuration (docs/nodes.md §2). Everything else comes from the orchestrator in
// the hello response and the assignments.
type Config struct {
	// URL is the orchestrator base URL (SCANTOR_URL).
	URL string
	// Token is the node token: SCANTOR_NODE_TOKEN, or derived from SCANTOR_SECRET on the built-in node.
	Token string
	// BuiltIn is true for the master's built-in node (SCANTOR_NODE_BUILTIN).
	BuiltIn bool
	// MaxWorkers is SCANTOR_NODE_MAX_WORKERS; 0 means "number of CPUs".
	MaxWorkers int
	// DinD is the configured DinD mode (disabled, sysbox, privileged).
	DinD string
	// EgressDeny are the CIDRs workers must not reach; empty disables the egress helper.
	EgressDeny []netip.Prefix
	// Worker container settings.
	PidsLimit      int64
	ShmSize        int64
	Nofile         int64
	LogMaxSize     int64
	LogMaxFiles    int
	ImageRetention time.Duration
	PullTimeout    time.Duration
	// CACert is the PEM bundle of SCANTOR_CA_CERT (normalised), passed on to workers.
	CACert string
	// AllowInsecure is SCANTOR_ALLOW_INSECURE_TRANSPORT, passed on to workers.
	AllowInsecure bool
	// LogLevel and LogFormat configure the daemon logger.
	LogLevel  slog.Level
	LogFormat string
	// Warnings lists invalid non-security variables that fell back to their defaults.
	Warnings []string
}

// ConfigError is an invalid daemon configuration; the daemon exits with code 2.
type ConfigError struct{ Err error }

func (e *ConfigError) Error() string { return "invalid node configuration: " + e.Err.Error() }

func (e *ConfigError) Unwrap() error { return e.Err }

// LoadConfig reads the daemon variables. Security-relevant problems (URL, token sources, DinD mode,
// egress CIDRs, CA bundle, the insecure-transport switch) are returned as a *ConfigError; other invalid
// values fall back to their defaults and are listed in Config.Warnings.
func LoadConfig(lookup LookupEnv) (Config, error) {
	getenv := func(name string) string {
		v, _ := lookup(name)
		return v
	}
	r := envconf.NewReader(getenv)
	cfg := Config{
		URL:            r.URL("SCANTOR_URL", defaultURL, []string{"http", "https"}, envconf.Security()),
		BuiltIn:        r.Bool("SCANTOR_NODE_BUILTIN", false, envconf.Security()),
		MaxWorkers:     int(r.Int("SCANTOR_NODE_MAX_WORKERS", 0, 0, 1<<20)),
		DinD:           r.Enum("SCANTOR_NODE_DIND", DinDDisabled, []string{DinDDisabled, DinDSysbox, DinDPrivileged}, envconf.Security()),
		PidsLimit:      r.Int("SCANTOR_NODE_PIDS_LIMIT", defaultPidsLimit, 1, 1<<30),
		ShmSize:        r.ByteSize("SCANTOR_NODE_SHM_SIZE", defaultShmSize),
		Nofile:         r.Int("SCANTOR_NODE_NOFILE", defaultNofile, 1, 1<<30),
		LogMaxSize:     r.ByteSize("SCANTOR_NODE_WORKER_LOG_MAX_SIZE", defaultLogMaxSize),
		LogMaxFiles:    int(r.Int("SCANTOR_NODE_WORKER_LOG_MAX_FILES", defaultLogMaxFiles, 1, 1000)),
		ImageRetention: r.Duration("SCANTOR_NODE_IMAGE_RETENTION", defaultImageRetention),
		PullTimeout:    r.Duration("SCANTOR_NODE_PULL_TIMEOUT", defaultPullTimeout),
		CACert:         r.PEMCertificates("SCANTOR_CA_CERT", envconf.Security()),
		AllowInsecure:  r.Bool("SCANTOR_ALLOW_INSECURE_TRANSPORT", false, envconf.Security()),
		LogFormat:      r.Enum("SCANTOR_LOG_FORMAT", redact.FormatJSON, []string{redact.FormatJSON, redact.FormatText}),
	}
	// The Enum fallback guarantees a parsable level.
	cfg.LogLevel, _ = redact.ParseLevel(r.Enum("SCANTOR_LOG_LEVEL", "info", []string{"debug", "info", "warn", "error"}))
	if cfg.LogMaxSize <= 0 {
		cfg.LogMaxSize = defaultLogMaxSize
		cfg.Warnings = append(cfg.Warnings, "SCANTOR_NODE_WORKER_LOG_MAX_SIZE: must be greater than 0; using the default")
	}
	if cfg.PullTimeout <= 0 {
		cfg.PullTimeout = defaultPullTimeout
		cfg.Warnings = append(cfg.Warnings, "SCANTOR_NODE_PULL_TIMEOUT: must be greater than 0; using the default")
	}

	deny := defaultEgressDeny
	if v, set := lookup("SCANTOR_NODE_EGRESS_DENY"); set {
		deny = v
	}
	prefixes, err := ParseCIDRs(deny)
	if err != nil {
		r.Fail("SCANTOR_NODE_EGRESS_DENY", err)
	}
	cfg.EgressDeny = prefixes

	token, tokenSet := r.Lookup("SCANTOR_NODE_TOKEN")
	token = strings.TrimSpace(token)
	secret, secretSet := r.Lookup("SCANTOR_SECRET")
	switch {
	case cfg.BuiltIn && tokenSet:
		r.Fail("SCANTOR_NODE_TOKEN", errors.New("must not be set together with SCANTOR_NODE_BUILTIN=true (the built-in node derives its token from SCANTOR_SECRET)"))
	case cfg.BuiltIn && !secretSet:
		r.Fail("SCANTOR_SECRET", errors.New("is required when SCANTOR_NODE_BUILTIN=true"))
	case cfg.BuiltIn:
		derived, err := keys.BuiltinNodeToken(secret)
		if err != nil {
			r.Fail("SCANTOR_SECRET", err)
		}
		cfg.Token = derived
	case !tokenSet:
		r.Fail("SCANTOR_NODE_TOKEN", errors.New("is required (snt_…, shown by Admin → Nodes → Add node)"))
	case !keys.ValidNodeToken(token):
		r.Fail("SCANTOR_NODE_TOKEN", errors.New("must have the form snt_ followed by 43 base64url characters"))
	default:
		cfg.Token = token
		if secretSet {
			cfg.Warnings = append(cfg.Warnings, "SCANTOR_SECRET is set on a remote node; it is not used there and should be removed")
		}
	}
	cfg.Warnings = append(r.Warnings(), cfg.Warnings...)
	if err := r.Err(); err != nil {
		return cfg, &ConfigError{Err: err}
	}
	return cfg, nil
}

// ParseCIDRs parses a comma-separated CIDR list (SCANTOR_NODE_EGRESS_DENY, `egress-apply --deny`). An
// empty list is valid. Every entry must be a CIDR in canonical form (no host bits set).
func ParseCIDRs(s string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, entry := range envconf.ParseList(s) {
		p, err := netip.ParsePrefix(entry)
		if err != nil {
			return nil, fmt.Errorf("invalid CIDR %q", entry)
		}
		if p != p.Masked() {
			return nil, fmt.Errorf("invalid CIDR %q: host bits are set (use %s)", entry, p.Masked())
		}
		out = append(out, p)
	}
	return out, nil
}

// EffectiveMaxWorkers returns SCANTOR_NODE_MAX_WORKERS, or cpus when it is 0.
func (c Config) EffectiveMaxWorkers(cpus int) int {
	if c.MaxWorkers > 0 {
		return c.MaxWorkers
	}
	return cpus
}
