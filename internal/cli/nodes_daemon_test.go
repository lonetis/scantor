package cli

import (
	"encoding/json"
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/api"
)

// apiDaemonConfigFixture is a daemon configuration as getNode returns it: maxWorkers and dns.mode are
// overridden, a newer override revision is not applied yet, and the daemon rejected one key.
func apiDaemonConfigFixture() map[string]any {
	return map[string]any{
		"values": map[string]any{
			"url": "https://scantor.example.com", "builtIn": false, "maxWorkers": 16, "dind": "disabled",
			"egressDeny":              []string{"169.254.0.0/16", "100.100.100.200/32"},
			"allowUnisolatedNetworks": false, "allowInsecureTransport": false,
			"caCertificates": []any{map[string]any{"subject": "CN=corp root", "sha256": "ab12", "notAfter": "2030-01-01T00:00:00.000Z"}},
			"pidsLimit":      4096, "shmSizeBytes": 268435456, "nofile": 65536, "workerLogMaxSizeBytes": 20971520,
			"workerLogMaxFiles": 3, "imageRetentionMs": 86400000, "pullTimeoutMs": 1800000, "logLevel": "info",
			"logFormat": "json", "overrides": "all",
			"dns": map[string]any{
				"mode": "iterative", "upstreams": []string{"host"}, "rootServers": []string{}, "localDomains": []string{"corp.example"},
				"cacheSizeBytes": 268435456, "maxLookups": 1000, "upstreamQps": 0, "authoritativeQps": 200,
			},
		},
		"sources": map[string]any{
			"url": "env", "builtIn": "default", "maxWorkers": "override", "imageRetentionMs": "env",
			"dns": map[string]any{"mode": "override", "upstreams": "env", "localDomains": "env"},
		},
		"warnings":            []string{"SCANTOR_NODE_PIDS_LIMIT: invalid integer; using the default"},
		"overrides":           map[string]any{"maxWorkers": 16, "dns": map[string]any{"mode": "iterative", "rootServers": []string{}}},
		"overridesRev":        3,
		"appliedOverridesRev": 2,
		"pending":             true,
		"rejected":            map[string]any{"dns": map[string]any{"upstreams": "not allowed on this node"}},
		"overriddenBy":        "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
		"overriddenAt":        "2026-11-24T09:00:00.000Z",
		"reportedAt":          "2026-11-24T09:00:05.000Z",
	}
}

func apiOnlineNodeFixture(daemonConfig map[string]any) map[string]any {
	n := apiNodeFixture("scan-eu-1")
	n["state"] = "online"
	n["info"] = map[string]any{
		"version": "1.4.0", "hostname": "scan-eu-1", "os": "linux", "arch": "amd64", "kernel": "6.8.0", "dockerVersion": "29.9.2",
		"cpus": 16, "memoryBytes": 1 << 30, "diskFreeBytes": 1 << 30, "dindMode": "disabled", "maxWorkers": 16,
		"egressDenyApplied": true, "clockOffsetMs": 0,
		"resolver": map[string]any{
			"mode": "iterative", "state": "ready", "address": "10.10.0.1", "kept": false, "error": nil,
			"since": "2026-11-24T09:00:00.000Z", "spec": "sha256:00", "ipv6": false, "upstreamOk": true, "stats": nil,
		},
	}
	if daemonConfig != nil {
		n["daemonConfig"] = daemonConfig
	}
	return n
}

// apiLine reports whether out has a line whose whitespace-separated cells are exactly cells.
func apiLine(out string, cells ...string) bool {
	parts := make([]string, len(cells))
	for i, c := range cells {
		parts[i] = regexp.QuoteMeta(c)
	}
	return regexp.MustCompile(`(?m)^` + strings.Join(parts, `\s+`) + `\s*$`).MatchString(out)
}

func TestAPINodesDaemonConfig(t *testing.T) {
	f := newAPIFake(t)
	f.reply("GET", "/api/nodes", 200, map[string]any{"items": []any{apiOnlineNodeFixture(apiDaemonConfigFixture())}})
	f.reply("GET", "/api/nodes/"+apiNodeID, 200, apiOnlineNodeFixture(apiDaemonConfigFixture()))

	code, out, errOut := f.exec("nodes", "daemon-config", "scan-eu-1")
	if code != 0 {
		t.Fatalf("daemon-config: exit %d, %q", code, errOut)
	}
	for _, row := range [][]string{
		{"KEY", "VALUE", "SOURCE", "ENV"},
		{"url", "https://scantor.example.com", "env", "SCANTOR_URL"},
		{"builtIn", "false", "default", "SCANTOR_NODE_BUILTIN"},
		{"maxWorkers", "16", "override", "SCANTOR_NODE_MAX_WORKERS"},
		{"egressDeny", "169.254.0.0/16,100.100.100.200/32", "default", "SCANTOR_NODE_EGRESS_DENY"},
		{"caCertificates", "CN=corp root (until 2030-01-01)", "default", "SCANTOR_CA_CERT"},
		{"shmSizeBytes", "256MiB", "default", "SCANTOR_NODE_SHM_SIZE"},
		{"workerLogMaxSizeBytes", "20MiB", "default", "SCANTOR_NODE_WORKER_LOG_MAX_SIZE"},
		{"imageRetentionMs", "24h", "env", "SCANTOR_NODE_IMAGE_RETENTION"},
		{"pullTimeoutMs", "30m", "default", "SCANTOR_NODE_PULL_TIMEOUT"},
		{"logFormat", "json", "default", "SCANTOR_LOG_FORMAT"},
		{"overrides", "all", "default", "SCANTOR_NODE_OVERRIDES"},
		{"dns.mode", "iterative", "override", "SCANTOR_NODE_DNS_MODE"},
		{"dns.upstreams", "host", "env", "SCANTOR_NODE_DNS_UPSTREAMS"},
		{"dns.rootServers", "IANA root servers", "default", "SCANTOR_NODE_DNS_ROOT_SERVERS"},
		{"dns.localDomains", "corp.example", "env", "SCANTOR_NODE_DNS_LOCAL_DOMAINS"},
		{"dns.cacheSizeBytes", "256MiB", "default", "SCANTOR_NODE_DNS_CACHE_SIZE"},
		{"dns.upstreamQps", "0 (no limit)", "default", "SCANTOR_NODE_DNS_UPSTREAM_QPS"},
		{"dns.authoritativeQps", "200", "default", "SCANTOR_NODE_DNS_AUTHORITATIVE_QPS"},
		{"overrides", "maxWorkers=16, dns.mode=iterative, dns.rootServers=IANA root servers"},
		{"pending", "yes: revision 3 is set, the daemon has applied revision 2"},
		{"rejected", "dns.upstreams: not allowed on this node"},
		{"warnings", "SCANTOR_NODE_PIDS_LIMIT: invalid integer; using the default"},
	} {
		if !apiLine(out, row...) {
			t.Errorf("no line %q in\n%s", row, out)
		}
	}
	if !regexp.MustCompile(`(?m)^changed\s+\S+ \S+ by 0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11$`).MatchString(out) {
		t.Errorf("no changed line in\n%s", out)
	}
	// The table lists every value of the daemon configuration once.
	if got := regexp.MustCompile(`(?m)\sSCANTOR_[A-Z_]+$`).FindAllString(out, -1); len(got) != len(apiDaemonSettings) {
		t.Errorf("table has %d rows, want %d", len(got), len(apiDaemonSettings))
	}

	code, out, _ = f.exec("nodes", "daemon-config", apiNodeID, "-o", "json")
	want, _ := json.Marshal(apiDaemonConfigFixture())
	if code != 0 {
		t.Fatalf("json: exit %d", code)
	}
	apiJSONEqual(t, []byte(out), string(want))

	// Before a daemon of the current instance reported, there is no daemon configuration.
	f.reply("GET", "/api/nodes/"+apiNodeID, 200, apiNodeFixture("scan-eu-1"))
	if code, out, _ := f.exec("nodes", "daemon-config", apiNodeID); code != 0 || !strings.Contains(out, "has not reported a valid daemon configuration") {
		t.Fatalf("not reported: exit %d, out %q", code, out)
	}
	if code, out, _ := f.exec("nodes", "daemon-config", apiNodeID, "-o", "json"); code != 0 || strings.TrimSpace(out) != "null" {
		t.Fatalf("not reported json: exit %d, out %q", code, out)
	}
}

func TestAPINodesDaemonOverridesSet(t *testing.T) {
	f := newAPIFake(t)
	path := "/api/nodes/" + apiNodeID + "/daemon-overrides"
	f.reply("PATCH", path, 200, apiOnlineNodeFixture(apiDaemonConfigFixture()))

	code, out, errOut := f.exec("nodes", "daemon-overrides", "set", apiNodeID,
		"--max-workers", "16", "--pids-limit", "2048", "--shm-size", "1GiB", "--nofile", "1048576",
		"--worker-log-max-size", "50MiB", "--worker-log-max-files", "5", "--image-retention", "48h", "--pull-timeout", "1m30s",
		"--log-level", "debug", "--dns-mode", "iterative", "--dns-upstreams", "host, 1.1.1.1:53,[2606:4700::1111]:53,2001:4860:4860::8888",
		"--dns-root-servers", "", "--dns-local-domains", "Corp.Example.,lab.internal", "--dns-cache-size", "512MiB",
		"--dns-max-lookups", "2000", "--dns-upstream-qps", "100", "--dns-authoritative-qps", "0")
	if code != 0 {
		t.Fatalf("set: exit %d, %q", code, errOut)
	}
	apiJSONEqual(t, f.last("PATCH", path).Body, `{"maxWorkers":16,"pidsLimit":2048,"shmSizeBytes":1073741824,"nofile":1048576,
		"workerLogMaxSizeBytes":52428800,"workerLogMaxFiles":5,"imageRetentionMs":172800000,"pullTimeoutMs":90000,"logLevel":"debug",
		"dns":{"mode":"iterative","upstreams":["host","1.1.1.1:53","[2606:4700::1111]:53","2001:4860:4860::8888"],"rootServers":[],
		"localDomains":["corp.example","lab.internal"],"cacheSizeBytes":536870912,"maxLookups":2000,"upstreamQps":100,"authoritativeQps":0}}`)
	for _, row := range [][]string{
		{"node", "scan-eu-1"},
		{"overrides", "maxWorkers=16, dns.mode=iterative, dns.rootServers=IANA root servers"},
		{"pending", "yes: revision 3 is set, the daemon has applied revision 2"},
		{"rejected", "dns.upstreams: not allowed on this node"},
	} {
		if !apiLine(out, row...) {
			t.Errorf("no line %q in\n%s", row, out)
		}
	}
	if code, out, _ := f.exec("nodes", "daemon-overrides", "set", apiNodeID, "--max-workers", "4", "-o", "json"); code != 0 ||
		apiDecode[api.Node](t, []byte(out)).DaemonConfig == nil {
		t.Fatalf("json: exit %d, out %q", code, out)
	}

	// --unset sends null; dns removes every dns override.
	for _, c := range []struct {
		args []string
		body string
	}{
		{[]string{"--unset", "maxWorkers", "--unset", "dns.mode,dns.upstreams", "--unset", "maxWorkers"}, `{"maxWorkers":null,"dns":{"mode":null,"upstreams":null}}`},
		{[]string{"--unset", "dns", "--max-workers", "4"}, `{"maxWorkers":4,"dns":null}`},
		{[]string{"--unset", "dns.cacheSizeBytes", "--dns-mode", "recursive"}, `{"dns":{"mode":"recursive","cacheSizeBytes":null}}`},
		{[]string{"--image-retention", "0s"}, `{"imageRetentionMs":0}`},
	} {
		args := append([]string{"nodes", "daemon-overrides", "set", apiNodeID}, c.args...)
		if code, _, errOut := f.exec(args...); code != 0 {
			t.Fatalf("%v: exit %d, %q", c.args, code, errOut)
		}
		apiJSONEqual(t, f.last("PATCH", path).Body, c.body)
	}

	// Usage errors exit 2 before any request.
	sent := len(f.calls("PATCH", path))
	for _, c := range []struct {
		args    []string
		message string
	}{
		{nil, "nothing to change"},
		{[]string{"--max-workers", "0"}, `--max-workers "0": must be between 1 and 100000`},
		{[]string{"--max-workers", "100001"}, "must be between 1 and 100000"},
		{[]string{"--max-workers", "x"}, "invalid integer"},
		{[]string{"--shm-size", "5"}, `--shm-size "5": must be between 1MiB and 64GiB`},
		{[]string{"--shm-size", "1GB"}, "invalid byte size"},
		{[]string{"--image-retention", "1500us"}, "whole milliseconds"},
		{[]string{"--image-retention", "-1s"}, "must not be negative"},
		{[]string{"--pull-timeout", "500ms"}, "must be between 1s and 24h"},
		{[]string{"--log-level", "trace"}, "must be debug, info, warn or error"},
		{[]string{"--dns-mode", "stub"}, "must be recursive, iterative or disabled"},
		{[]string{"--dns-upstreams", ""}, "needs at least 1 entry"},
		{[]string{"--dns-upstreams", strings.Repeat("1.1.1.1,", 17)}, "allows at most 16 entries"},
		{[]string{"--dns-upstreams", "1.1.1.1:0"}, `"1.1.1.1:0" is not an IP address, ip:port, [v6]:port or host`},
		{[]string{"--dns-upstreams", "dns.google"}, "is not an IP address"},
		{[]string{"--dns-upstreams", "fe80::1%eth0"}, `"fe80::1%eth0" has a zone: zoned addresses are not supported`},
		{[]string{"--dns-upstreams", "[1.2.3.4]:53"}, "is not an IP address"},
		{[]string{"--dns-upstreams", "0.0.0.0"}, `"0.0.0.0" is not a unicast address`},
		{[]string{"--dns-upstreams", "fe80::1"}, `"fe80::1": IPv6 link-local addresses are not supported`},
		{[]string{"--dns-upstreams", "10.0.0.2"}, `"10.0.0.2": private and special-purpose servers can only be configured in the node environment (SCANTOR_NODE_DNS_*)`},
		{[]string{"--dns-root-servers", "172.17.0.1:1053"}, `"172.17.0.1:1053": private and special-purpose servers`},
		{[]string{"--dns-root-servers", "host"}, `"host" is not an IP address, ip:port or [v6]:port`},
		{[]string{"--dns-local-domains", "bad domain"}, `"bad domain" is not a domain name`},
		{[]string{"--dns-local-domains", "-a.example"}, "is not a domain name"},
		{[]string{"--unset", "nope"}, `--unset "nope": unknown key`},
		{[]string{"--unset", "url"}, "unknown key"},
		{[]string{"--max-workers", "4", "--unset", "maxWorkers"}, "--max-workers and --unset maxWorkers exclude each other"},
		{[]string{"--dns-mode", "iterative", "--unset", "dns"}, "--dns-mode and --unset dns exclude each other"},
		{[]string{"--unset", "dns", "--unset", "dns.mode"}, "--unset dns already removes dns.mode"},
	} {
		args := append([]string{"nodes", "daemon-overrides", "set", apiNodeID}, c.args...)
		code, _, errOut := f.exec(args...)
		if code != ExitValidation || !strings.Contains(errOut, c.message) {
			t.Errorf("%v: exit %d, %q; want 2 and %q", c.args, code, errOut, c.message)
		}
	}
	if got := len(f.calls("PATCH", path)); got != sent {
		t.Fatalf("usage errors sent %d requests", got-sent)
	}

	// A refused override is a validation error with a hint per reason.
	for _, c := range []struct {
		details map[string]any
		hint    string
	}{
		{map[string]any{"reason": "notAllowed", "keys": []string{"dns.upstreams"}}, "SCANTOR_NODE_OVERRIDES of the node does not allow overriding dns.upstreams (see scantor nodes daemon-config " + apiNodeID + ")"},
		{map[string]any{"reason": "noInstance"}, "daemon overrides apply only to a running daemon"},
		{map[string]any{"reason": "notReported"}, "the node has not reported a valid daemon configuration (an old daemon or an invalid report"},
		{map[string]any{"reason": "somethingNew"}, "overrides unavailable"},
	} {
		f.fail("PATCH", path, 409, "daemonOverridesUnavailable", "overrides unavailable", c.details)
		code, _, errOut := f.exec("nodes", "daemon-overrides", "set", apiNodeID, "--dns-upstreams", "host")
		if code != ExitValidation || !strings.Contains(errOut, c.hint) {
			t.Errorf("%v: exit %d, %q", c.details, code, errOut)
		}
	}
}

func TestAPINodesDaemonOverridesReset(t *testing.T) {
	f := newAPIFake(t)
	path := "/api/nodes/" + apiNodeID + "/daemon-overrides"
	reset := apiDaemonConfigFixture()
	reset["overrides"] = map[string]any{}
	reset["overridesRev"] = 4
	reset["rejected"] = map[string]any{}
	f.reply("GET", "/api/nodes", 200, map[string]any{"items": []any{apiNodeFixture("scan-eu-1")}})
	f.reply("DELETE", path, 200, apiOnlineNodeFixture(reset))

	code, out, errOut := f.exec("nodes", "daemon-overrides", "reset", "scan-eu-1")
	if code != 0 {
		t.Fatalf("reset: exit %d, %q", code, errOut)
	}
	if len(f.calls("DELETE", path)) != 1 || !apiLine(out, "overrides", "none") ||
		!apiLine(out, "pending", "yes: revision 4 is set, the daemon has applied revision 2") || strings.Contains(out, "rejected") {
		t.Fatalf("reset: out %q", out)
	}

	applied := apiDaemonConfigFixture()
	applied["overrides"] = map[string]any{}
	applied["overridesRev"] = 4
	applied["appliedOverridesRev"] = 4
	applied["pending"] = false
	f.reply("DELETE", path, 200, apiOnlineNodeFixture(applied))
	if code, out, _ := f.exec("nodes", "daemon-overrides", "reset", apiNodeID); code != 0 || !apiLine(out, "pending", "no: the daemon has applied revision 4") {
		t.Fatalf("applied: exit %d, out %q", code, out)
	}
	f.reply("DELETE", path, 200, apiNodeFixture("scan-eu-1"))
	if code, out, _ := f.exec("nodes", "daemon-overrides", "reset", apiNodeID); code != 0 || !strings.Contains(out, "none (no daemon of the node's current instance has reported its configuration)") {
		t.Fatalf("not reported: exit %d, out %q", code, out)
	}
	if code, out, _ := f.exec("nodes", "daemon-overrides", "reset", apiNodeID, "-o", "json"); code != 0 || apiDecode[api.Node](t, []byte(out)).Name != "scan-eu-1" {
		t.Fatalf("json: exit %d, out %q", code, out)
	}
	f.fail("DELETE", path, 403, "adminRequired", "admin only", nil)
	if code, _, _ := f.exec("nodes", "daemon-overrides", "reset", apiNodeID); code != ExitValidation {
		t.Fatalf("non-admin: exit %d", code)
	}
}

// nodes get shows the node resolver and the daemon overrides.
func TestAPINodeGetResolver(t *testing.T) {
	f := newAPIFake(t)
	f.reply("GET", "/api/nodes/"+apiNodeID, 200, apiOnlineNodeFixture(apiDaemonConfigFixture()))
	code, out, _ := f.exec("nodes", "get", apiNodeID)
	if code != 0 || !apiLine(out, "dns resolver", "ready (iterative, 10.10.0.1)") ||
		!apiLine(out, "daemon overrides", "maxWorkers=16, dns.mode=iterative, dns.rootServers=IANA root servers (not applied yet)") ||
		!apiLine(out, "workers", "0/8 (daemon 16 by daemon override, admin worker limit 8)") {
		t.Fatalf("get: exit %d, out\n%s", code, out)
	}
	f.reply("GET", "/api/nodes/"+apiNodeID, 200, apiNodeFixture("scan-eu-1"))
	if code, out, _ := f.exec("nodes", "get", apiNodeID); code != 0 || strings.Contains(out, "dns resolver") || strings.Contains(out, "daemon overrides") {
		t.Fatalf("pending node: exit %d, out\n%s", code, out)
	}

	text := func(s string) *string { return &s }
	for _, c := range []struct {
		report api.NodeResolverReport
		want   string
	}{
		{api.NodeResolverReport{Mode: "recursive", State: "ready", Address: "10.10.0.1"}, "ready (recursive, 10.10.0.1)"},
		{api.NodeResolverReport{Mode: "recursive", State: "starting"}, "starting (recursive)"},
		{api.NodeResolverReport{Mode: "recursive", State: "failed", Address: "10.10.0.1", Error: text("bindInUse"), Detail: "10.10.0.1:53"}, "failed (recursive, 10.10.0.1): bindInUse, 10.10.0.1:53"},
		{api.NodeResolverReport{Mode: "iterative", State: "degraded", Address: "10.10.0.1", Error: text("upstreamUnreachable")}, "degraded (iterative, 10.10.0.1): upstreamUnreachable"},
		{api.NodeResolverReport{Mode: "disabled", State: "disabled", Address: "10.10.0.1", Kept: true}, "disabled (10.10.0.1, kept for existing workers)"},
		{api.NodeResolverReport{Mode: "disabled", State: "disabled"}, "disabled"},
		{api.NodeResolverReport{Error: text("")}, "unknown"},
	} {
		if got := apiResolverSummary(&c.report); got != c.want {
			t.Errorf("apiResolverSummary(%+v) = %q, want %q", c.report, got, c.want)
		}
	}
}

// The flags of daemon-overrides set cover exactly the keys of schemas/daemon-overrides.json, named after
// their environment variables, with matching value types.
func TestDaemonOverrideFlagsMatchSchema(t *testing.T) {
	specs, err := apiOverrideSpecs()
	if err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(specs))
	for key := range specs {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	overridable := apiOverridableKeys()
	sort.Strings(overridable)
	if !slices.Equal(keys, overridable) {
		t.Fatalf("schema keys %v, flags for %v", keys, overridable)
	}
	types := map[apiSettingKind]string{apiKindText: "string", apiKindInt: "integer", apiKindBytes: "integer", apiKindDuration: "integer", apiKindList: "array"}
	for _, s := range apiDaemonSettings {
		spec, ok := specs[s.key]
		if !ok {
			continue
		}
		if spec.Env != s.env {
			t.Errorf("%s: env %s, schema %s", s.key, s.env, spec.Env)
		}
		flag := strings.ReplaceAll(strings.ToLower(strings.TrimPrefix(strings.TrimPrefix(s.env, "SCANTOR_NODE_"), "SCANTOR_")), "_", "-")
		if s.flag != flag {
			t.Errorf("%s: flag --%s, want --%s (from %s)", s.key, s.flag, flag, s.env)
		}
		if types[s.kind] != spec.Type {
			t.Errorf("%s: kind %d, schema type %s", s.key, s.kind, spec.Type)
		}
		if (s.kind == apiKindBytes) != strings.HasSuffix(s.key, "Bytes") || (s.kind == apiKindDuration) != strings.HasSuffix(s.key, "Ms") {
			t.Errorf("%s: kind %d does not match the unit of the key", s.key, s.kind)
		}
		if spec.Type == "array" {
			if _, err := apiOverrideItem(spec.Format, "1.1.1.1"); err != nil && spec.Format != "domain" {
				t.Errorf("%s: format %q: %v", s.key, spec.Format, err)
			}
			if _, err := apiOverrideItem(spec.Format, "example.com"); err != nil && spec.Format == "domain" {
				t.Errorf("%s: format %q: %v", s.key, spec.Format, err)
			}
		}
		if apiOverrideBounds(s, spec) == "" {
			t.Errorf("%s: no bounds", s.key)
		}
	}

	app, out, _ := testApp(nil)
	if code := run(app, "nodes", "daemon-overrides", "set", "--help"); code != 0 {
		t.Fatalf("help: exit %d", code)
	}
	for _, want := range []string{
		"--shm-size bytes", "(SCANTOR_NODE_SHM_SIZE; 1MiB to 64GiB)", "--image-retention duration", "(SCANTOR_NODE_IMAGE_RETENTION; 0s to 8760h)",
		"--dns-upstreams list", "(SCANTOR_NODE_DNS_UPSTREAMS; 1 to 16 entries)", "(SCANTOR_NODE_DNS_LOCAL_DOMAINS; up to 64 entries)",
		"(SCANTOR_NODE_DNS_MODE; recursive, iterative or disabled)", "--max-workers int", "--unset strings",
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("help lacks %q:\n%s", want, out)
		}
	}
}

// The configuration table has one row per value of api.DaemonConfigValues.
func TestDaemonConfigTableCoversValues(t *testing.T) {
	raw, err := json.Marshal(api.DaemonConfigValues{})
	if err != nil {
		t.Fatal(err)
	}
	values, err := apiFlattenTree(raw)
	if err != nil {
		t.Fatal(err)
	}
	var keys, rows []string
	for key := range values {
		keys = append(keys, key)
	}
	for _, s := range apiDaemonSettings {
		rows = append(rows, s.key)
	}
	sort.Strings(keys)
	sort.Strings(rows)
	if !slices.Equal(keys, rows) {
		t.Fatalf("values %v, rows %v", keys, rows)
	}
	if got := apiOrderedKeys(map[string]json.RawMessage{"zeta": nil, "dns.mode": nil, "alpha": nil, "maxWorkers": nil}); !slices.Equal(got, []string{"maxWorkers", "dns.mode", "alpha", "zeta"}) {
		t.Fatalf("apiOrderedKeys = %v", got)
	}
	if text, err := apiOverridesText(json.RawMessage(`{"future":{"knob":true},"logLevel":"warn"}`)); err != nil || text != "logLevel=warn, future.knob=true" {
		t.Fatalf("apiOverridesText = %q, %v", text, err)
	}
	if _, err := apiOverridesText(json.RawMessage(`[1]`)); err == nil {
		t.Fatal("a malformed overrides object is an error")
	}
}

// A bound the schema leaves open is not checked.
func TestParseOverrideOpenBounds(t *testing.T) {
	bound := func(n int64) *int64 { return &n }
	maxWorkers, _ := apiDaemonSettingOf("maxWorkers")
	for _, c := range []struct {
		spec apiOverrideSpec
		text string
		err  string
	}{
		{apiOverrideSpec{Type: "integer", Min: bound(2)}, "1", "must be at least 2"},
		{apiOverrideSpec{Type: "integer", Min: bound(2)}, "1000000000", ""},
		{apiOverrideSpec{Type: "integer", Max: bound(2)}, "3", "must be at most 2"},
		{apiOverrideSpec{Type: "integer", Max: bound(2)}, "-5", ""},
		{apiOverrideSpec{Type: "integer"}, "-5", ""},
	} {
		_, err := apiParseOverride(maxWorkers, c.spec, c.text)
		if (c.err == "" && err != nil) || (c.err != "" && (err == nil || err.Error() != c.err)) {
			t.Errorf("%+v %q: err %v, want %q", c.spec, c.text, err, c.err)
		}
	}
	if _, err := apiOverrideItem("hostname", "x"); err == nil {
		t.Fatal("an unknown item format is an error")
	}
}

// The DNS servers of daemon overrides follow the orchestrator's rules (orchestrator/test/shared/dns-servers.test.ts
// checks the same cases): the syntax, no zone, unicast, not IPv6 link-local, and nothing the node resolver refuses
// unless the node environment names it.
func TestDNSServerCheck(t *testing.T) {
	const (
		syntax  = "is not an IP address, ip:port or [v6]:port"
		zone    = "zoned addresses are not supported"
		unicast = "is not a unicast address"
		link    = "IPv6 link-local addresses are not supported"
		refused = apiDNSServerRefusedMessage
	)
	for s, want := range map[string]string{
		"1.1.1.1": "", "1.1.1.1:53": "", "1.1.1.1:5353": "", "2606:4700::1111": "", "[2606:4700::1111]:53": "",
		"[::ffff:1.2.3.4]:53": "", "::ffff:9.9.9.9": "", "192.0.2.1:53": "", "100.128.0.1": "", "172.32.0.1": "",
		"2001:4860:4860::8888": "", "[2620:fe::fe]:65535": "",
		"host": syntax, "": syntax, "1.1.1": syntax, "01.1.1.1": syntax, "1.1.1.1:0": syntax, "1.1.1.1:053": syntax,
		"1.1.1.1:65536": syntax, "[1.1.1.1]:53": syntax, "[2606:4700::1111]": syntax, "dns.google": syntax,
		"1.1.1.1:": syntax, strings.Repeat("1", 65): syntax, "1.2.3.4::53": syntax, ":::": syntax, "::::": syntax,
		"[1.2.3.4:5]:53": syntax, "1.2.3.4:53:": syntax, "::ffff:1.2.3.4:53": syntax, "abc:def": syntax,
		"1:2:3:4:5:6:7:8:9": syntax, "[a:b]:53": syntax, "1.1.1.1:53.5": syntax, "1.2.3.4:53:53": syntax,
		"fe80::1%eth0": zone, "[fe80::1%eth0]:53": zone,
		"0.0.0.0": unicast, "::": unicast, "[::]:53": unicast, "224.0.0.1": unicast, "239.255.255.250:1900": unicast,
		"ff02::1": unicast, "::ffff:0.0.0.0": unicast,
		"fe80::1": link, "[febf::1]:53": link,
		"10.0.0.2": refused, "127.0.0.1:5353": refused, "100.100.100.100": refused, "169.254.169.254": refused,
		"172.17.0.1:1053": refused, "192.168.1.1": refused, "192.0.0.8": refused, "198.18.0.1": refused,
		"240.0.0.1": refused, "0.1.2.3": refused, "::1": refused, "[::1]:53": refused, "fd00::53": refused,
		"64:ff9b::808:808": refused, "64:ff9b:1::1": refused, "::ffff:10.0.0.1": refused,
	} {
		err := apiCheckDNSServer(s, false)
		if (want == "") != (err == nil) || (err != nil && !strings.Contains(err.Error(), want)) {
			t.Errorf("apiCheckDNSServer(%q) = %v, want %q", s, err, want)
		}
	}
	if err := apiCheckDNSServer("x", true); err == nil || !strings.Contains(err.Error(), "[v6]:port or host") {
		t.Errorf("an upstream names the host keyword in its syntax error: %v", err)
	}
	for _, c := range []struct{ format, item, want string }{
		{"serverOrHost", "host", ""}, {"serverOrHost", "9.9.9.9", ""}, {"server", "host", "is not an IP address, ip:port or [v6]:port"},
		{"serverOrHost", "10.0.0.53", refused}, {"server", "[2001:503:ba3e::2:30]:53", ""},
	} {
		_, err := apiOverrideItem(c.format, c.item)
		if (c.want == "") != (err == nil) || (err != nil && !strings.Contains(err.Error(), c.want)) {
			t.Errorf("apiOverrideItem(%s, %q) = %v, want %q", c.format, c.item, err, c.want)
		}
	}
}

func TestDaemonSettingText(t *testing.T) {
	for ms, want := range map[int64]string{
		0: "0s", 500: "500ms", 1000: "1s", 90_000: "1m30s", 1_800_000: "30m", 5_400_000: "1h30m", 86_400_000: "24h",
		31_536_000_000: "8760h", 3_600_500: "1h0m0.5s",
	} {
		if got := apiDurationText(ms); got != want {
			t.Errorf("apiDurationText(%d) = %q, want %q", ms, got, want)
		}
	}
	setting := func(key string) apiDaemonSetting {
		s, ok := apiDaemonSettingOf(key)
		if !ok {
			t.Fatalf("no setting %s", key)
		}
		return s
	}
	for _, c := range []struct {
		key, raw, want string
	}{
		{"maxWorkers", `0`, "0 (number of CPUs)"},
		{"maxWorkers", `"x"`, `"x"`},
		{"egressDeny", `[]`, "none"},
		{"overrides", `["maxWorkers","dns.mode"]`, "maxWorkers,dns.mode"},
		{"overrides", `"none"`, "none"},
		{"overrides", `[]`, "none"},
		{"caCertificates", `[]`, "none"},
		{"dns.upstreams", `[]`, "-"},
		{"dns.mode", `null`, "-"},
		{"dns.mode", `""`, "-"},
		{"allowInsecureTransport", `true`, "true"},
		{"url", `7`, "7"},
		{"dns.cacheSizeBytes", `1073741824`, "1GiB"},
		{"workerLogMaxSizeBytes", `1000`, "1000"},
	} {
		if got := apiSettingText(setting(c.key), json.RawMessage(c.raw)); got != c.want {
			t.Errorf("apiSettingText(%s, %s) = %q, want %q", c.key, c.raw, got, c.want)
		}
	}
}
