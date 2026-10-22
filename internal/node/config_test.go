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
		"SCANTOR_URL":                       "https://scantor.example.com/",
		"SCANTOR_NODE_TOKEN":                testToken,
		"SCANTOR_NODE_MAX_WORKERS":          "8",
		"SCANTOR_NODE_DIND":                 "sysbox",
		"SCANTOR_NODE_EGRESS_DENY":          "169.254.0.0/16, fd00:ec2::254/128",
		"SCANTOR_NODE_PIDS_LIMIT":           "1024",
		"SCANTOR_NODE_SHM_SIZE":             "1GiB",
		"SCANTOR_NODE_NOFILE":               "4096",
		"SCANTOR_NODE_WORKER_LOG_MAX_SIZE":  "10MiB",
		"SCANTOR_NODE_WORKER_LOG_MAX_FILES": "5",
		"SCANTOR_NODE_IMAGE_RETENTION":      "2h",
		"SCANTOR_NODE_PULL_TIMEOUT":         "5m",
		"SCANTOR_ALLOW_INSECURE_TRANSPORT":  "true",
		"SCANTOR_LOG_LEVEL":                 "debug",
		"SCANTOR_LOG_FORMAT":                "text",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := Config{
		URL: "https://scantor.example.com", Token: testToken, MaxWorkers: 8, DinD: DinDSysbox,
		EgressDeny: []netip.Prefix{netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("fd00:ec2::254/128")},
		PidsLimit:  1024, ShmSize: 1 << 30, Nofile: 4096, LogMaxSize: 10 << 20, LogMaxFiles: 5,
		ImageRetention: 2 * time.Hour, PullTimeout: 5 * time.Minute, AllowInsecure: true,
		LogLevel: -4, LogFormat: "text",
	}
	if !reflect.DeepEqual(cfg, want) {
		t.Errorf("config =\n%+v\nwant\n%+v", cfg, want)
	}
	if cfg.EffectiveMaxWorkers(16) != 8 {
		t.Error("an explicit SCANTOR_NODE_MAX_WORKERS must win over the CPU count")
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
	if cfg.EffectiveMaxWorkers(6) != 6 {
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

func TestLoadConfigEgressDenyEmptyDisablesUnsetDefaults(t *testing.T) {
	unset, err := load(t, map[string]string{"SCANTOR_NODE_TOKEN": testToken})
	if err != nil {
		t.Fatal(err)
	}
	if len(unset.EgressDeny) != 3 || unset.EgressDeny[2] != netip.MustParsePrefix("100.100.100.200/32") {
		t.Errorf("unset SCANTOR_NODE_EGRESS_DENY = %v, want the shipped deny list", unset.EgressDeny)
	}
	empty, err := load(t, map[string]string{"SCANTOR_NODE_TOKEN": testToken, "SCANTOR_NODE_EGRESS_DENY": ""})
	if err != nil {
		t.Fatal(err)
	}
	if len(empty.EgressDeny) != 0 {
		t.Errorf("empty SCANTOR_NODE_EGRESS_DENY = %v, want the helper disabled", empty.EgressDeny)
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
	if cfg.PidsLimit != defaultPidsLimit || cfg.ShmSize != defaultShmSize || cfg.LogMaxSize != defaultLogMaxSize || cfg.PullTimeout != defaultPullTimeout || cfg.LogLevel != 0 {
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
	if !reflect.DeepEqual(defaults, fromExample) {
		t.Errorf("defaults differ from .env.example:\n%+v\n%+v", defaults, fromExample)
	}
}
