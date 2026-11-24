package node

import (
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/lonetis/scantor/internal/api"
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
	defaultURL                 = "http://localhost:3000"
	defaultEgressDeny          = "169.254.0.0/16,fd00:ec2::254/128,100.100.100.200/32"
	defaultPidsLimit           = 4096
	defaultShmSize             = 256 * envconf.MiB
	defaultNofile              = 65536
	defaultLogMaxSize          = 20 * envconf.MiB
	defaultLogMaxFiles         = 3
	defaultImageRetention      = 24 * time.Hour
	defaultPullTimeout         = 30 * time.Minute
	defaultDNSMode             = api.ResolverModeRecursive
	defaultDNSUpstreams        = "1.1.1.1,1.0.0.1,8.8.8.8,8.8.4.4,2606:4700:4700::1111,2606:4700:4700::1001,2001:4860:4860::8888,2001:4860:4860::8844"
	defaultDNSCacheSize        = 256 * envconf.MiB
	defaultDNSMaxLookups       = 1000
	defaultDNSUpstreamQPS      = 0
	defaultDNSAuthoritativeQPS = 200
	defaultOverrides           = OverridesAll
)

// EgressDenyOff is the SCANTOR_NODE_EGRESS_DENY value that disables the egress helper. An empty value
// means the default list like every other variable, because compose passes an unset variable on as an
// empty one: a missing .env line must never switch off the metadata blocking.
const EgressDenyOff = "none"

// UpstreamHost is the SCANTOR_NODE_DNS_UPSTREAMS entry (and dns.upstreams override entry) that stands for
// the host nameservers: the /etc/resolv.conf servers of the resolver container.
const UpstreamHost = "host"

// SCANTOR_NODE_OVERRIDES keywords: every override key, or none.
const (
	OverridesAll  = "all"
	OverridesNone = "none"
)

// LookupEnv is the signature of os.LookupEnv, which internal/cli passes in. Unset and empty values are
// treated alike.
type LookupEnv func(string) (string, bool)

// Settings are the daemon settings a daemon override can replace (docs/nodes.md §6.12). Config.Settings
// holds the environment's values (or the defaults); the daemon applies overrides to a copy.
type Settings struct {
	// MaxWorkers is SCANTOR_NODE_MAX_WORKERS; 0 means "number of CPUs" (an override is never 0).
	MaxWorkers int
	// Worker container settings.
	PidsLimit      int64
	ShmSize        int64
	Nofile         int64
	LogMaxSize     int64
	LogMaxFiles    int
	ImageRetention time.Duration
	PullTimeout    time.Duration
	// LogLevel is the level of the daemon logger (SCANTOR_LOG_LEVEL).
	LogLevel slog.Level
	// DNS configures the node resolver.
	DNS DNSSettings
}

// DNSSettings configure the node resolver (SCANTOR_NODE_DNS_*, docs/nodes.md §6.11).
type DNSSettings struct {
	// Mode is recursive, iterative or disabled.
	Mode string
	// Upstreams are the upstream servers of recursive mode as configured: an IP address (port 53),
	// ip:port, [v6]:port, or UpstreamHost.
	Upstreams []string
	// RootServers are the root servers of iterative mode (empty: the IANA root servers).
	RootServers []string
	// LocalDomains are domains resolved through the host nameservers (lowercase, no trailing dot).
	LocalDomains []string
	// CacheSize bounds the resolver's answer cache in bytes.
	CacheSize int64
	// MaxLookups bounds the resolver's lookups in flight.
	MaxLookups int
	// UpstreamQPS and AuthoritativeQPS limit queries per second per server (0 = no limit).
	UpstreamQPS      int
	AuthoritativeQPS int
}

// EffectiveMaxWorkers returns MaxWorkers, or cpus when it is 0.
func (s Settings) EffectiveMaxWorkers(cpus int) int {
	if s.MaxWorkers > 0 {
		return s.MaxWorkers
	}
	return cpus
}

// clone returns a copy that shares no slice with s.
func (s Settings) clone() Settings {
	s.DNS.Upstreams = slices.Clone(s.DNS.Upstreams)
	s.DNS.RootServers = slices.Clone(s.DNS.RootServers)
	s.DNS.LocalDomains = slices.Clone(s.DNS.LocalDomains)
	return s
}

// OverrideAllowList is SCANTOR_NODE_OVERRIDES: the daemon override keys this daemon accepts.
type OverrideAllowList struct {
	// All accepts every key; otherwise only Keys (sorted; empty means none).
	All  bool
	Keys []string
}

// Allows reports whether the daemon accepts an override of key.
func (l OverrideAllowList) Allows(key string) bool { return l.All || slices.Contains(l.Keys, key) }

// String renders the list as configured: all, none or the comma-separated keys.
func (l OverrideAllowList) String() string {
	switch {
	case l.All:
		return OverridesAll
	case len(l.Keys) == 0:
		return OverridesNone
	default:
		return strings.Join(l.Keys, ",")
	}
}

// Config is the daemon configuration (docs/nodes.md §2): the fixed values and the overridable Settings.
// Everything else comes from the orchestrator in the hello response and the assignments.
type Config struct {
	// URL is the orchestrator base URL (SCANTOR_URL).
	URL string
	// Token is the node token: SCANTOR_NODE_TOKEN, or derived from SCANTOR_SECRET on the built-in node.
	Token string
	// BuiltIn is true for the master's built-in node (SCANTOR_NODE_BUILTIN).
	BuiltIn bool
	// DinD is the configured DinD mode (disabled, sysbox, privileged).
	DinD string
	// EgressDeny are the CIDRs workers must not reach; empty (SCANTOR_NODE_EGRESS_DENY=none) disables
	// the egress helper.
	EgressDeny []netip.Prefix
	// AllowUnisolatedNetworks is SCANTOR_ALLOW_UNISOLATED_NETWORKS: a remote node whose Docker daemon
	// cannot disable inter-container traffic uses a plain scantor-workers network (docs/nodes.md §6.8).
	AllowUnisolatedNetworks bool
	// CACert is the PEM bundle of SCANTOR_CA_CERT (normalised), passed on to workers.
	CACert string
	// AllowInsecure is SCANTOR_ALLOW_INSECURE_TRANSPORT, passed on to workers.
	AllowInsecure bool
	// LogFormat configures the daemon logger.
	LogFormat string
	// Overrides is SCANTOR_NODE_OVERRIDES.
	Overrides OverrideAllowList
	// Settings are the values daemon overrides can replace, as the environment sets them.
	Settings Settings
	// Sources maps the key of every daemon configuration value (configKeys) to envconf.SourceEnv or
	// envconf.SourceDefault.
	Sources map[string]string
	// Warnings lists invalid non-security variables that fell back to their defaults.
	Warnings []string
}

// ConfigError is an invalid daemon configuration; the daemon exits with code 2.
type ConfigError struct{ Err error }

func (e *ConfigError) Error() string { return "invalid node configuration: " + e.Err.Error() }

func (e *ConfigError) Unwrap() error { return e.Err }

// configKeys maps the key of every value of the daemon configuration (docs/nodes.md §6.12; dotted for
// the dns object) to its variable. The override keys among them come from overrideSpecs.
var configKeys = func() map[string]string {
	m := map[string]string{
		"url":                     "SCANTOR_URL",
		"builtIn":                 "SCANTOR_NODE_BUILTIN",
		"dind":                    "SCANTOR_NODE_DIND",
		"egressDeny":              "SCANTOR_NODE_EGRESS_DENY",
		"allowUnisolatedNetworks": "SCANTOR_ALLOW_UNISOLATED_NETWORKS",
		"allowInsecureTransport":  "SCANTOR_ALLOW_INSECURE_TRANSPORT",
		"caCertificates":          "SCANTOR_CA_CERT",
		"logFormat":               "SCANTOR_LOG_FORMAT",
		"overrides":               "SCANTOR_NODE_OVERRIDES",
	}
	for _, s := range overrideSpecs {
		m[s.key] = s.env
	}
	return m
}()

// LoadConfig reads the daemon variables. Security-relevant problems (URL, token sources, DinD mode,
// egress CIDRs, CA bundle, the insecure-transport and unisolated-network switches, the resolver's mode,
// servers and local domains, and the override allow-list) are returned as a *ConfigError; other invalid
// values fall back to their defaults and are listed in Config.Warnings. The bounds of the overridable
// settings are those of their daemon overrides (overrideSpecs).
func LoadConfig(lookup LookupEnv) (Config, error) {
	getenv := func(name string) string {
		v, _ := lookup(name)
		return v
	}
	r := envconf.NewReader(getenv)
	cfg := Config{
		URL:           r.URL("SCANTOR_URL", defaultURL, []string{"http", "https"}, envconf.Security()),
		BuiltIn:       r.Bool("SCANTOR_NODE_BUILTIN", false, envconf.Security()),
		DinD:          r.Enum("SCANTOR_NODE_DIND", DinDDisabled, []string{DinDDisabled, DinDSysbox, DinDPrivileged}, envconf.Security()),
		CACert:        r.PEMCertificates("SCANTOR_CA_CERT", envconf.Security()),
		AllowInsecure: r.Bool("SCANTOR_ALLOW_INSECURE_TRANSPORT", false, envconf.Security()),
		LogFormat:     r.Enum("SCANTOR_LOG_FORMAT", redact.FormatJSON, []string{redact.FormatJSON, redact.FormatText}),

		AllowUnisolatedNetworks: r.Bool("SCANTOR_ALLOW_UNISOLATED_NETWORKS", false, envconf.Security()),
	}
	cfg.Settings = loadSettings(r)

	if deny := strings.TrimSpace(r.String("SCANTOR_NODE_EGRESS_DENY", defaultEgressDeny)); deny != EgressDenyOff {
		prefixes, err := ParseCIDRs(deny)
		if err != nil {
			r.Fail("SCANTOR_NODE_EGRESS_DENY", fmt.Errorf("%w (or %s to disable the egress helper)", err, EgressDenyOff))
		}
		cfg.EgressDeny = prefixes
	}
	overrides, err := ParseOverrideAllowList(r.String("SCANTOR_NODE_OVERRIDES", defaultOverrides))
	if err != nil {
		r.Fail("SCANTOR_NODE_OVERRIDES", err)
	}
	cfg.Overrides = overrides

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
	cfg.Sources = make(map[string]string, len(configKeys))
	for key, env := range configKeys {
		cfg.Sources[key] = r.Source(env)
	}
	cfg.Warnings = append(r.Warnings(), cfg.Warnings...)
	if err := r.Err(); err != nil {
		return cfg, &ConfigError{Err: err}
	}
	return cfg, nil
}

// loadSettings reads the overridable settings with the bounds of their overrides. SCANTOR_NODE_MAX_WORKERS
// may also be 0 (the number of CPUs).
func loadSettings(r *envconf.Reader) Settings {
	maxWorkers := specOf("maxWorkers")
	s := Settings{
		MaxWorkers:     int(r.Int(maxWorkers.env, 0, 0, maxWorkers.max)),
		PidsLimit:      readInt(r, specOf("pidsLimit"), defaultPidsLimit),
		ShmSize:        readByteSize(r, specOf("shmSizeBytes"), defaultShmSize),
		Nofile:         readInt(r, specOf("nofile"), defaultNofile),
		LogMaxSize:     readByteSize(r, specOf("workerLogMaxSizeBytes"), defaultLogMaxSize),
		LogMaxFiles:    int(readInt(r, specOf("workerLogMaxFiles"), defaultLogMaxFiles)),
		ImageRetention: readDuration(r, specOf("imageRetentionMs"), defaultImageRetention),
		PullTimeout:    readDuration(r, specOf("pullTimeoutMs"), defaultPullTimeout),
		DNS: DNSSettings{
			Mode:             r.Enum("SCANTOR_NODE_DNS_MODE", defaultDNSMode, specOf("dns.mode").enum, envconf.Security()),
			Upstreams:        readList(r, specOf("dns.upstreams"), defaultDNSUpstreams),
			RootServers:      readList(r, specOf("dns.rootServers"), ""),
			LocalDomains:     readList(r, specOf("dns.localDomains"), ""),
			CacheSize:        readByteSize(r, specOf("dns.cacheSizeBytes"), defaultDNSCacheSize),
			MaxLookups:       int(readInt(r, specOf("dns.maxLookups"), defaultDNSMaxLookups)),
			UpstreamQPS:      int(readInt(r, specOf("dns.upstreamQps"), defaultDNSUpstreamQPS)),
			AuthoritativeQPS: int(readInt(r, specOf("dns.authoritativeQps"), defaultDNSAuthoritativeQPS)),
		},
	}
	// The Enum fallback guarantees a parsable level.
	s.LogLevel, _ = redact.ParseLevel(r.Enum("SCANTOR_LOG_LEVEL", "info", specOf("logLevel").enum))
	return s
}

func readInt(r *envconf.Reader, spec overrideSpec, def int64) int64 {
	return r.Int(spec.env, def, spec.min, spec.max)
}

func readByteSize(r *envconf.Reader, spec overrideSpec, def int64) int64 {
	n := r.ByteSize(spec.env, def)
	if n < spec.min || n > spec.max {
		r.Invalid(spec.env, fmt.Errorf("invalid value: must be between %s and %s", envconf.FormatByteSize(spec.min), envconf.FormatByteSize(spec.max)))
		return def
	}
	return n
}

func readDuration(r *envconf.Reader, spec overrideSpec, def time.Duration) time.Duration {
	d := r.Duration(spec.env, def)
	if ms := d.Milliseconds(); ms < spec.min || ms > spec.max || d%time.Millisecond != 0 {
		r.Invalid(spec.env, fmt.Errorf("invalid value: must be between %s and %s in whole milliseconds",
			time.Duration(spec.min)*time.Millisecond, time.Duration(spec.max)*time.Millisecond))
		return def
	}
	return d
}

// readList reads a security-relevant list setting (dns servers, local domains): an invalid entry or count
// aborts startup, because a typo must never send the node's lookups somewhere else.
func readList(r *envconf.Reader, spec overrideSpec, def string) []string {
	list, err := spec.parseList(r.List(spec.env, envconf.ParseList(def)))
	if err != nil {
		r.Fail(spec.env, err)
		return []string{}
	}
	return list
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

// ParseDNSServer parses a DNS server of SCANTOR_NODE_DNS_UPSTREAMS, SCANTOR_NODE_DNS_ROOT_SERVERS or a dns
// override: an IPv4 or IPv6 address (port 53), ip:port or [v6]:port with a port from 1 to 65535. Zoned
// addresses, IPv6 link-local addresses (fe80::/10, which need a zone to be dialled), multicast addresses
// and the unspecified addresses are refused; an IPv4-mapped IPv6 address counts as its IPv4 address. IPv4
// link-local addresses such as the cloud resolvers 169.254.169.253 and 169.254.169.254 are valid here, but
// like every private or special-purpose address only the node's environment may name them
// (checkOverrideServers).
func ParseDNSServer(s string) (netip.AddrPort, error) {
	s = strings.TrimSpace(s)
	var ap netip.AddrPort
	if a, err := netip.ParseAddr(s); err == nil {
		ap = netip.AddrPortFrom(a, 53)
	} else if ap, err = netip.ParseAddrPort(s); err != nil {
		return netip.AddrPort{}, fmt.Errorf("invalid DNS server %q: use an IP address, ip:port or [v6]:port", s)
	}
	a := ap.Addr()
	if a.Zone() != "" {
		return netip.AddrPort{}, fmt.Errorf("invalid DNS server %q: zones are not supported", s)
	}
	a = a.Unmap()
	switch {
	case a.Is6() && a.IsLinkLocalUnicast():
		return netip.AddrPort{}, fmt.Errorf("invalid DNS server %q: IPv6 link-local addresses are not supported", s)
	case a.IsUnspecified() || a.IsMulticast():
		return netip.AddrPort{}, fmt.Errorf("invalid DNS server %q: not a unicast address", s)
	case ap.Port() == 0:
		return netip.AddrPort{}, fmt.Errorf("invalid DNS server %q: port 0", s)
	}
	return netip.AddrPortFrom(a, ap.Port()), nil
}

// domainName matches a lowercase domain name without trailing dot (underscores allowed, as in service
// names).
var domainName = regexp.MustCompile(`^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$`)

// ParseDomain normalises a domain of SCANTOR_NODE_DNS_LOCAL_DOMAINS or the dns.localDomains override:
// lowercase without a trailing dot.
func ParseDomain(s string) (string, error) {
	d := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(s)), ".")
	if d == "" || len(d) > 253 || !domainName.MatchString(d) {
		return "", fmt.Errorf("invalid domain %q", strings.TrimSpace(s))
	}
	return d, nil
}

// ParseOverrideAllowList parses SCANTOR_NODE_OVERRIDES: all, none, or a comma list of override keys.
func ParseOverrideAllowList(s string) (OverrideAllowList, error) {
	switch strings.TrimSpace(s) {
	case "", OverridesAll:
		return OverrideAllowList{All: true}, nil
	case OverridesNone:
		return OverrideAllowList{Keys: []string{}}, nil
	}
	list := OverrideAllowList{Keys: []string{}}
	for _, key := range envconf.ParseList(s) {
		if _, ok := overrideSpecByKey[key]; !ok {
			return OverrideAllowList{}, fmt.Errorf("unknown override key %q: use %s, %s or a comma list of %s",
				key, OverridesAll, OverridesNone, strings.Join(overrideKeyNames(), ", "))
		}
		if !slices.Contains(list.Keys, key) {
			list.Keys = append(list.Keys, key)
		}
	}
	slices.Sort(list.Keys)
	return list, nil
}

// levelName returns the SCANTOR_LOG_LEVEL name of a level.
func levelName(l slog.Level) string {
	switch {
	case l <= slog.LevelDebug:
		return "debug"
	case l <= slog.LevelInfo:
		return "info"
	case l <= slog.LevelWarn:
		return "warn"
	default:
		return "error"
	}
}
