package node

import (
	"bufio"
	"errors"
	"net/netip"
	"os"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/keys"
)

// envMap is a LookupEnv over a map; it records every variable read.
type envMap struct {
	vars map[string]string
	read []string
}

func (e *envMap) lookup(name string) (string, bool) {
	if !slices.Contains(e.read, name) {
		e.read = append(e.read, name)
	}
	v, ok := e.vars[name]
	return v, ok
}

func load(t *testing.T, vars map[string]string) (Config, error) {
	t.Helper()
	e := &envMap{vars: vars}
	return LoadConfig(e.lookup)
}

func TestLoadConfigRemoteNode(t *testing.T) {
	cfg, err := load(t, map[string]string{
		"SCANTOR_URL":                        "https://scantor.example.com/",
		"SCANTOR_NODE_TOKEN":                 testToken,
		"SCANTOR_NODE_MAX_WORKERS":           "8",
		"SCANTOR_NODE_DIND":                  "sysbox",
		"SCANTOR_NODE_EGRESS_DENY":           "169.254.0.0/16, fd00:ec2::254/128",
		"SCANTOR_NODE_PIDS_LIMIT":            "1024",
		"SCANTOR_NODE_SHM_SIZE":              "1GiB",
		"SCANTOR_NODE_NOFILE":                "4096",
		"SCANTOR_NODE_WORKER_LOG_MAX_SIZE":   "10MiB",
		"SCANTOR_NODE_WORKER_LOG_MAX_FILES":  "5",
		"SCANTOR_NODE_IMAGE_RETENTION":       "2h",
		"SCANTOR_NODE_PULL_TIMEOUT":          "5m",
		"SCANTOR_ALLOW_INSECURE_TRANSPORT":   "true",
		"SCANTOR_LOG_LEVEL":                  "debug",
		"SCANTOR_LOG_FORMAT":                 "text",
		"SCANTOR_NODE_DNS_MODE":              "iterative",
		"SCANTOR_NODE_DNS_UPSTREAMS":         "host, 9.9.9.9:5353,[2620:fe::fe]:53",
		"SCANTOR_NODE_DNS_ROOT_SERVERS":      "172.17.0.1:1053",
		"SCANTOR_NODE_DNS_LOCAL_DOMAINS":     "Corp.Example., lab.internal",
		"SCANTOR_NODE_DNS_CACHE_SIZE":        "1GiB",
		"SCANTOR_NODE_DNS_MAX_LOOKUPS":       "100",
		"SCANTOR_NODE_DNS_UPSTREAM_QPS":      "1500",
		"SCANTOR_NODE_DNS_AUTHORITATIVE_QPS": "0",
		"SCANTOR_NODE_OVERRIDES":             "dns.mode, maxWorkers",
	})
	if err != nil {
		t.Fatal(err)
	}
	sources := cfg.Sources
	cfg.Sources = nil
	want := Config{
		URL: "https://scantor.example.com", Token: testToken, DinD: DinDSysbox,
		EgressDeny:    []netip.Prefix{netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("fd00:ec2::254/128")},
		AllowInsecure: true, LogFormat: "text",
		Overrides: OverrideAllowList{Keys: []string{"dns.mode", "maxWorkers"}},
		Settings: Settings{
			MaxWorkers: 8, PidsLimit: 1024, ShmSize: 1 << 30, Nofile: 4096, LogMaxSize: 10 << 20, LogMaxFiles: 5,
			ImageRetention: 2 * time.Hour, PullTimeout: 5 * time.Minute, LogLevel: -4,
			DNS: DNSSettings{
				Mode: "iterative", Upstreams: []string{"host", "9.9.9.9:5353", "[2620:fe::fe]:53"}, RootServers: []string{"172.17.0.1:1053"},
				LocalDomains: []string{"corp.example", "lab.internal"}, CacheSize: 1 << 30, MaxLookups: 100, UpstreamQPS: 1500, AuthoritativeQPS: 0,
			},
		},
	}
	if !reflect.DeepEqual(cfg, want) {
		t.Errorf("config =\n%+v\nwant\n%+v", cfg, want)
	}
	if cfg.Settings.EffectiveMaxWorkers(16) != 8 {
		t.Error("an explicit SCANTOR_NODE_MAX_WORKERS must win over the CPU count")
	}
	// Every value of the daemon configuration has a source; the variables set above are env.
	if len(sources) != len(configKeys) {
		t.Errorf("sources = %v, want one per key of %v", sources, configKeys)
	}
	for key, want := range map[string]string{
		"url": "env", "maxWorkers": "env", "dind": "env", "egressDeny": "env", "pidsLimit": "env", "logLevel": "env",
		"dns.mode": "env", "dns.upstreams": "env", "dns.localDomains": "env", "dns.authoritativeQps": "env", "overrides": "env",
		"builtIn": "default", "caCertificates": "default", "allowUnisolatedNetworks": "default",
	} {
		if sources[key] != want {
			t.Errorf("source of %s = %q, want %q", key, sources[key], want)
		}
	}
}

// The resolver's mode, servers and local domains and the override allow-list are security-relevant: a
// typo must never send the node's lookups elsewhere, so the daemon exits instead of using the default.
func TestLoadConfigResolverSettingsAreSecurityRelevant(t *testing.T) {
	cases := []struct {
		name, variable, value, msg string
	}{
		{"unknown mode", "SCANTOR_NODE_DNS_MODE", "off", "use one of recursive, iterative, disabled"},
		{"upstream that is no address", "SCANTOR_NODE_DNS_UPSTREAMS", "1.1.1.1,dns.google", `invalid DNS server "dns.google"`},
		{"upstream port 0", "SCANTOR_NODE_DNS_UPSTREAMS", "1.1.1.1:0", "port 0"},
		{"upstream with a zone", "SCANTOR_NODE_DNS_UPSTREAMS", "fe80::1%eth0", "invalid DNS server"},
		{"IPv6 link-local upstream", "SCANTOR_NODE_DNS_UPSTREAMS", "1.1.1.1,fe80::1", `invalid DNS server "fe80::1": IPv6 link-local addresses are not supported`},
		{"multicast upstream", "SCANTOR_NODE_DNS_UPSTREAMS", "ff02::fb", "not a unicast address"},
		{"IPv6 link-local root server", "SCANTOR_NODE_DNS_ROOT_SERVERS", "[fe80::53]:53", "IPv6 link-local addresses are not supported"},
		{"mapped unspecified root server", "SCANTOR_NODE_DNS_ROOT_SERVERS", "::ffff:0.0.0.0", "not a unicast address"},
		{"no upstream", "SCANTOR_NODE_DNS_UPSTREAMS", ", ,", "between 1 and 16 entries"},
		{"too many upstreams", "SCANTOR_NODE_DNS_UPSTREAMS", strings.Repeat("1.1.1.1,", 17), "between 1 and 16 entries"},
		{"host as root server", "SCANTOR_NODE_DNS_ROOT_SERVERS", "host", `invalid DNS server "host"`},
		{"unspecified root server", "SCANTOR_NODE_DNS_ROOT_SERVERS", "0.0.0.0", "not a unicast address"},
		{"invalid local domain", "SCANTOR_NODE_DNS_LOCAL_DOMAINS", "corp.example,bad domain", `invalid domain "bad domain"`},
		{"unknown override key", "SCANTOR_NODE_OVERRIDES", "maxWorkers,dns.servers", `unknown override key "dns.servers"`},
		{"all in a list", "SCANTOR_NODE_OVERRIDES", "all,maxWorkers", `unknown override key "all"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := load(t, map[string]string{"SCANTOR_NODE_TOKEN": testToken, tc.variable: tc.value})
			var cfgErr *ConfigError
			if !errors.As(err, &cfgErr) || !strings.Contains(err.Error(), tc.variable) || !strings.Contains(err.Error(), tc.msg) {
				t.Fatalf("err = %v, want a *ConfigError naming %s and %q", err, tc.variable, tc.msg)
			}
		})
	}
	for value, want := range map[string]OverrideAllowList{
		"all": {All: true}, " none ": {Keys: []string{}}, "logLevel,dns.mode,logLevel": {Keys: []string{"dns.mode", "logLevel"}},
	} {
		cfg, err := load(t, map[string]string{"SCANTOR_NODE_TOKEN": testToken, "SCANTOR_NODE_OVERRIDES": value})
		if err != nil || !reflect.DeepEqual(cfg.Overrides, want) {
			t.Errorf("SCANTOR_NODE_OVERRIDES=%q: %+v, %v; want %+v", value, cfg.Overrides, err, want)
		}
	}
}

// The environment may name private and special-purpose servers, such as the cloud resolvers at
// 169.254.169.253 and 169.254.169.254 (inside the default deny list), a host-local resolver or a site
// resolver: the operator chose them, and the node resolver trusts them.
func TestLoadConfigAcceptsPrivateServers(t *testing.T) {
	cfg, err := load(t, map[string]string{
		"SCANTOR_NODE_TOKEN":            testToken,
		"SCANTOR_NODE_DNS_UPSTREAMS":    "169.254.169.253, 127.0.0.53, [fd00::53]:5353, 100.100.100.100, host",
		"SCANTOR_NODE_DNS_ROOT_SERVERS": "10.0.0.1:1053,[::1]:53",
	})
	if err != nil {
		t.Fatal(err)
	}
	if dns := cfg.Settings.DNS; !slices.Equal(dns.Upstreams, []string{"169.254.169.253", "127.0.0.53", "[fd00::53]:5353", "100.100.100.100", "host"}) ||
		!slices.Equal(dns.RootServers, []string{"10.0.0.1:1053", "[::1]:53"}) || len(cfg.EgressDeny) != 3 {
		t.Errorf("dns = %+v, deny %v", dns, cfg.EgressDeny)
	}
}

// The overridable settings have the bounds of their overrides; an invalid value falls back to the default
// with a warning, and its source is default.
func TestLoadConfigSettingBounds(t *testing.T) {
	cfg, err := load(t, map[string]string{
		"SCANTOR_NODE_TOKEN":                 testToken,
		"SCANTOR_NODE_MAX_WORKERS":           "100001",
		"SCANTOR_NODE_SHM_SIZE":              "128GiB",
		"SCANTOR_NODE_IMAGE_RETENTION":       "9000h",
		"SCANTOR_NODE_PULL_TIMEOUT":          "500ms",
		"SCANTOR_NODE_DNS_CACHE_SIZE":        "1MiB",
		"SCANTOR_NODE_DNS_MAX_LOOKUPS":       "20001",
		"SCANTOR_NODE_DNS_UPSTREAM_QPS":      "-1",
		"SCANTOR_NODE_DNS_AUTHORITATIVE_QPS": "lots",
	})
	if err != nil {
		t.Fatal(err)
	}
	s := cfg.Settings
	if s.MaxWorkers != 0 || s.ShmSize != defaultShmSize || s.ImageRetention != defaultImageRetention || s.PullTimeout != defaultPullTimeout ||
		s.DNS.CacheSize != defaultDNSCacheSize || s.DNS.MaxLookups != defaultDNSMaxLookups || s.DNS.UpstreamQPS != 0 || s.DNS.AuthoritativeQPS != defaultDNSAuthoritativeQPS {
		t.Errorf("fallbacks = %+v", s)
	}
	joined := strings.Join(cfg.Warnings, "\n")
	for _, name := range []string{
		"SCANTOR_NODE_MAX_WORKERS", "SCANTOR_NODE_SHM_SIZE", "SCANTOR_NODE_IMAGE_RETENTION", "SCANTOR_NODE_PULL_TIMEOUT",
		"SCANTOR_NODE_DNS_CACHE_SIZE", "SCANTOR_NODE_DNS_MAX_LOOKUPS", "SCANTOR_NODE_DNS_UPSTREAM_QPS", "SCANTOR_NODE_DNS_AUTHORITATIVE_QPS",
	} {
		if !strings.Contains(joined, name) {
			t.Errorf("no warning for %s in %q", name, joined)
		}
	}
	for _, key := range []string{"maxWorkers", "shmSizeBytes", "imageRetentionMs", "pullTimeoutMs", "dns.cacheSizeBytes", "dns.maxLookups", "dns.upstreamQps", "dns.authoritativeQps"} {
		if cfg.Sources[key] != "default" {
			t.Errorf("source of the invalid %s = %q, want default", key, cfg.Sources[key])
		}
	}
	// SCANTOR_NODE_MAX_WORKERS=0 stays the number of CPUs.
	cfg, err = load(t, map[string]string{"SCANTOR_NODE_TOKEN": testToken, "SCANTOR_NODE_MAX_WORKERS": "0"})
	if err != nil || cfg.Settings.MaxWorkers != 0 || cfg.Sources["maxWorkers"] != "env" || len(cfg.Warnings) != 0 {
		t.Errorf("SCANTOR_NODE_MAX_WORKERS=0: %+v, %v", cfg, err)
	}
}

func TestParseDNSServer(t *testing.T) {
	// IPv4 link-local, loopback and private servers are valid servers (only the environment may name them).
	for in, want := range map[string]string{
		"1.1.1.1": "1.1.1.1:53", " 9.9.9.9:5353 ": "9.9.9.9:5353", "2606:4700:4700::1111": "[2606:4700:4700::1111]:53",
		"[2620:fe::fe]:853": "[2620:fe::fe]:853", "::ffff:1.2.3.4": "1.2.3.4:53", "169.254.169.253": "169.254.169.253:53",
		"[::ffff:169.254.169.254]:53": "169.254.169.254:53", "127.0.0.53:5353": "127.0.0.53:5353", "[::1]:53": "[::1]:53",
		"10.0.0.2:65535": "10.0.0.2:65535", "fd00::53": "[fd00::53]:53",
	} {
		got, err := ParseDNSServer(in)
		if err != nil || got.String() != want {
			t.Errorf("ParseDNSServer(%q) = %v, %v; want %s", in, got, err, want)
		}
	}
	for in, msg := range map[string]string{
		"": "use an IP address", "host": "use an IP address", "dns.google": "use an IP address", "1.1.1.1:": "use an IP address",
		"1.1.1.1:65536": "use an IP address", "[::1]": "use an IP address", "1.1.1.1/32": "use an IP address", "2001:db8::g": "use an IP address",
		"1.1.1.1:0": "port 0", "::": "not a unicast address", "0.0.0.0": "not a unicast address", "::ffff:0.0.0.0": "not a unicast address",
		"224.0.0.251": "not a unicast address", "ff02::fb": "not a unicast address", "[::ffff:224.0.0.1]:53": "not a unicast address",
		"fe80::1%eth0": "zones are not supported", "[fe80::1%eth0]:53": "zones are not supported",
		"fe80::1": "IPv6 link-local addresses are not supported", "[febf::1]:5353": "IPv6 link-local addresses are not supported",
	} {
		if _, err := ParseDNSServer(in); err == nil || !strings.Contains(err.Error(), msg) {
			t.Errorf("ParseDNSServer(%q) = %v, want an error with %q", in, err, msg)
		}
	}
	for in, want := range map[string]string{"Corp.Example.": "corp.example", "_dns-sd._udp.local": "_dns-sd._udp.local", "x": "x"} {
		if got, err := ParseDomain(in); err != nil || got != want {
			t.Errorf("ParseDomain(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", ".", "a..b", "-a.example", "a b", strings.Repeat("a", 64) + ".example", strings.Repeat("abcdefghi.", 26)} {
		if _, err := ParseDomain(in); err == nil {
			t.Errorf("ParseDomain(%q) accepted an invalid domain", in)
		}
	}
}

func TestLoadConfigBuiltInNodeDerivesItsToken(t *testing.T) {
	cfg, err := load(t, map[string]string{"SCANTOR_NODE_BUILTIN": "true", "SCANTOR_SECRET": "scantor-secret-insecure-dev"})
	if err != nil {
		t.Fatal(err)
	}
	want, err := keys.BuiltinNodeToken("scantor-secret-insecure-dev")
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.BuiltIn || cfg.Token != want || !keys.ValidNodeToken(cfg.Token) {
		t.Errorf("built-in token = %q, want %q", cfg.Token, want)
	}
	if cfg.Settings.EffectiveMaxWorkers(6) != 6 {
		t.Error("SCANTOR_NODE_MAX_WORKERS=0 must mean the number of CPUs")
	}
}

func TestLoadConfigErrors(t *testing.T) {
	cases := []struct {
		name     string
		vars     map[string]string
		variable string
	}{
		{"both token sources", map[string]string{"SCANTOR_NODE_BUILTIN": "true", "SCANTOR_SECRET": "s", "SCANTOR_NODE_TOKEN": testToken}, "SCANTOR_NODE_TOKEN"},
		{"built-in without secret", map[string]string{"SCANTOR_NODE_BUILTIN": "true"}, "SCANTOR_SECRET"},
		{"remote without token", map[string]string{}, "SCANTOR_NODE_TOKEN"},
		{"malformed token", map[string]string{"SCANTOR_NODE_TOKEN": "snt_short"}, "SCANTOR_NODE_TOKEN"},
		{"unknown DinD mode", map[string]string{"SCANTOR_NODE_TOKEN": testToken, "SCANTOR_NODE_DIND": "rootless"}, "SCANTOR_NODE_DIND"},
		{"malformed CIDR", map[string]string{"SCANTOR_NODE_TOKEN": testToken, "SCANTOR_NODE_EGRESS_DENY": "169.254.0.0/16,metadata"}, "SCANTOR_NODE_EGRESS_DENY"},
		{"CIDR with host bits", map[string]string{"SCANTOR_NODE_TOKEN": testToken, "SCANTOR_NODE_EGRESS_DENY": "169.254.169.254/16"}, "SCANTOR_NODE_EGRESS_DENY"},
		{"invalid URL", map[string]string{"SCANTOR_NODE_TOKEN": testToken, "SCANTOR_URL": "ftp://scantor.example.com"}, "SCANTOR_URL"},
		{"invalid CA bundle", map[string]string{"SCANTOR_NODE_TOKEN": testToken, "SCANTOR_CA_CERT": "not a certificate"}, "SCANTOR_CA_CERT"},
		{"invalid insecure switch", map[string]string{"SCANTOR_NODE_TOKEN": testToken, "SCANTOR_ALLOW_INSECURE_TRANSPORT": "maybe"}, "SCANTOR_ALLOW_INSECURE_TRANSPORT"},
		{"invalid built-in switch", map[string]string{"SCANTOR_NODE_TOKEN": testToken, "SCANTOR_NODE_BUILTIN": "yes please"}, "SCANTOR_NODE_BUILTIN"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := load(t, tc.vars)
			var cfgErr *ConfigError
			if !errors.As(err, &cfgErr) {
				t.Fatalf("err = %v, want a *ConfigError", err)
			}
			if !strings.Contains(err.Error(), tc.variable) {
				t.Errorf("error %q does not name %s", err, tc.variable)
			}
			if strings.Contains(err.Error(), testToken) || strings.Contains(err.Error(), "scantor-secret") {
				t.Errorf("error %q leaks a secret", err)
			}
		})
	}
}

// Compose passes an unset SCANTOR_NODE_EGRESS_DENY on as an empty one, so empty must keep the shipped
// deny list like unset; only the explicit value none disables the egress helper.
func TestLoadConfigEgressDenyOnlyNoneDisables(t *testing.T) {
	for name, vars := range map[string]map[string]string{
		"unset":      {"SCANTOR_NODE_TOKEN": testToken},
		"empty":      {"SCANTOR_NODE_TOKEN": testToken, "SCANTOR_NODE_EGRESS_DENY": ""},
		"whitespace": {"SCANTOR_NODE_TOKEN": testToken, "SCANTOR_NODE_EGRESS_DENY": "  "},
	} {
		cfg, err := load(t, vars)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(cfg.EgressDeny) != 3 || cfg.EgressDeny[0] != netip.MustParsePrefix("169.254.0.0/16") || cfg.EgressDeny[2] != netip.MustParsePrefix("100.100.100.200/32") {
			t.Errorf("%s SCANTOR_NODE_EGRESS_DENY = %v, want the shipped deny list", name, cfg.EgressDeny)
		}
	}
	off, err := load(t, map[string]string{"SCANTOR_NODE_TOKEN": testToken, "SCANTOR_NODE_EGRESS_DENY": " none "})
	if err != nil {
		t.Fatal(err)
	}
	if len(off.EgressDeny) != 0 {
		t.Errorf("SCANTOR_NODE_EGRESS_DENY=none = %v, want the helper disabled", off.EgressDeny)
	}
	_, err = load(t, map[string]string{"SCANTOR_NODE_TOKEN": testToken, "SCANTOR_NODE_EGRESS_DENY": "off"})
	var cfgErr *ConfigError
	if !errors.As(err, &cfgErr) || !strings.Contains(err.Error(), "or none to disable") {
		t.Errorf("SCANTOR_NODE_EGRESS_DENY=off: err = %v, want a configuration error naming none", err)
	}
}

func TestLoadConfigInvalidValuesFallBackWithWarnings(t *testing.T) {
	cfg, err := load(t, map[string]string{
		"SCANTOR_NODE_TOKEN":               testToken,
		"SCANTOR_SECRET":                   "should-not-be-here",
		"SCANTOR_NODE_PIDS_LIMIT":          "lots",
		"SCANTOR_NODE_SHM_SIZE":            "huge",
		"SCANTOR_NODE_WORKER_LOG_MAX_SIZE": "0",
		"SCANTOR_NODE_PULL_TIMEOUT":        "0s",
		"SCANTOR_LOG_LEVEL":                "verbose",
	})
	if err != nil {
		t.Fatal(err)
	}
	if s := cfg.Settings; s.PidsLimit != defaultPidsLimit || s.ShmSize != defaultShmSize || s.LogMaxSize != defaultLogMaxSize || s.PullTimeout != defaultPullTimeout || s.LogLevel != 0 {
		t.Errorf("fallbacks = %+v", cfg)
	}
	joined := strings.Join(cfg.Warnings, "\n")
	for _, name := range []string{"SCANTOR_SECRET", "SCANTOR_NODE_PIDS_LIMIT", "SCANTOR_NODE_SHM_SIZE", "SCANTOR_NODE_WORKER_LOG_MAX_SIZE", "SCANTOR_NODE_PULL_TIMEOUT", "SCANTOR_LOG_LEVEL"} {
		if !strings.Contains(joined, name) {
			t.Errorf("no warning for %s in %q", name, joined)
		}
	}
	if strings.Contains(joined, "should-not-be-here") {
		t.Error("a warning leaks the secret value")
	}
}

func TestLoadConfigCACertIsNormalised(t *testing.T) {
	ca := testCACert(t)
	escaped := strings.ReplaceAll(strings.TrimSpace(ca), "\n", `\n`)
	cfg, err := load(t, map[string]string{"SCANTOR_NODE_TOKEN": testToken, "SCANTOR_CA_CERT": escaped})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(cfg.CACert, "-----BEGIN CERTIFICATE-----\n") {
		t.Errorf("CA bundle not normalised: %q", cfg.CACert)
	}
}

var envLine = regexp.MustCompile(`^([A-Z][A-Z0-9_]*)=(.*)$`)

// readEnvExample returns the variables of the repository's .env.example.
func readEnvExample(t *testing.T) map[string]string {
	t.Helper()
	f, err := os.Open("../../.env.example")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	vars := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if m := envLine.FindStringSubmatch(sc.Text()); m != nil {
			vars[m[1]] = strings.Trim(m[2], `"`)
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return vars
}

// Every variable the daemon reads is documented in .env.example, and its defaults are the documented
// values.
func TestDefaultsMatchEnvExample(t *testing.T) {
	example := readEnvExample(t)
	unset := &envMap{vars: map[string]string{"SCANTOR_NODE_TOKEN": testToken}}
	defaults, err := LoadConfig(unset.lookup)
	if err != nil {
		t.Fatal(err)
	}
	documented := map[string]string{"SCANTOR_NODE_TOKEN": testToken}
	for _, name := range unset.read {
		v, ok := example[name]
		if !ok {
			t.Errorf("%s is read by the node daemon but missing from .env.example", name)
			continue
		}
		if name != "SCANTOR_NODE_TOKEN" && name != "SCANTOR_SECRET" {
			documented[name] = v
		}
	}
	fromExample, err := load(t, documented)
	if err != nil {
		t.Fatal(err)
	}
	// Only the sources differ: default without the variables, env with the documented values.
	defaults.Sources, fromExample.Sources = nil, nil
	if !reflect.DeepEqual(defaults, fromExample) {
		t.Errorf("defaults differ from .env.example:\n%+v\n%+v", defaults, fromExample)
	}
}
