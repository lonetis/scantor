package node

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"net/netip"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	scantor "github.com/lonetis/scantor"
	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/redact"
)

// The Go table of overridable keys restates schemas/daemon-overrides.json, the source shared with the
// orchestrator's zod schemas: same keys, types, bounds, enums, item formats and variables.
func TestOverrideSpecsMatchTheBoundsFile(t *testing.T) {
	data, err := scantor.Schemas.ReadFile("schemas/daemon-overrides.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Version int `json:"version"`
		Keys    map[string]struct {
			Type     string   `json:"type"`
			Min      *int64   `json:"min"`
			Max      *int64   `json:"max"`
			Enum     []string `json:"enum"`
			MinItems *int     `json:"minItems"`
			MaxItems *int     `json:"maxItems"`
			Format   string   `json:"format"`
			Env      string   `json:"env"`
		} `json:"keys"`
	}
	if err := json.Unmarshal(data, &file); err != nil || file.Version != 1 {
		t.Fatalf("parse: %v (version %d)", err, file.Version)
	}
	if got, want := slices.Sorted(maps.Keys(file.Keys)), slices.Sorted(maps.Keys(overrideSpecByKey)); !slices.Equal(got, want) {
		t.Fatalf("keys of the bounds file %v, of the daemon %v", got, want)
	}
	for key, f := range file.Keys {
		s := overrideSpecByKey[key]
		if f.Type != s.typ || f.Env != s.env {
			t.Errorf("%s: type %q env %q, daemon %q %q", key, f.Type, f.Env, s.typ, s.env)
		}
		switch f.Type {
		case "integer":
			if f.Min == nil || f.Max == nil || *f.Min != s.min || *f.Max != s.max {
				t.Errorf("%s: bounds %v..%v, daemon %d..%d", key, f.Min, f.Max, s.min, s.max)
			}
		case "string":
			if !slices.Equal(f.Enum, s.enum) {
				t.Errorf("%s: enum %v, daemon %v", key, f.Enum, s.enum)
			}
		case "array":
			if f.MinItems == nil || f.MaxItems == nil || *f.MinItems != s.minItems || *f.MaxItems != s.maxItems || f.Format != s.format {
				t.Errorf("%s: items %v..%v %q, daemon %d..%d %q", key, f.MinItems, f.MaxItems, f.Format, s.minItems, s.maxItems, s.format)
			}
		default:
			t.Errorf("%s: unknown type %q", key, f.Type)
		}
		if configKeys[key] != f.Env {
			t.Errorf("%s: the daemon configuration names %q", key, configKeys[key])
		}
	}
}

// newOverridesDaemon returns a daemon (not started) for override tests and its log.
func newOverridesDaemon(t *testing.T, mutate func(*Config), level *slog.LevelVar) (*Daemon, *syncBuffer) {
	t.Helper()
	cfg := Config{
		URL: "https://scantor.example.com", Token: testToken, DinD: DinDDisabled, LogFormat: redact.FormatText,
		EgressDeny: prefixes("169.254.0.0/16", "fd00:ec2::254/128"), Overrides: OverrideAllowList{All: true}, Settings: testDaemonSettings(),
	}
	cfg.Settings.MaxWorkers = 4
	if mutate != nil {
		mutate(&cfg)
	}
	logs := &syncBuffer{}
	d, err := New(Options{Config: cfg, Docker: newFakeDocker(), Logger: redact.NewLogger(logs, redact.FormatText, slog.LevelDebug), LogLevel: level})
	if err != nil {
		t.Fatal(err)
	}
	return d, logs
}

func overrides(rev int64, values string) *api.DaemonOverrides {
	return &api.DaemonOverrides{Rev: rev, Values: json.RawMessage(values)}
}

func TestApplyOverrides(t *testing.T) {
	level := new(slog.LevelVar)
	d, logs := newOverridesDaemon(t, nil, level)
	log := d.log
	env := d.cfg.Settings

	changed, dnsChanged := d.applyOverrides(overrides(3, `{
		"maxWorkers": 16, "pidsLimit": 1024, "shmSizeBytes": 1073741824, "nofile": 4096, "workerLogMaxSizeBytes": 1048576,
		"workerLogMaxFiles": 5, "imageRetentionMs": 3600000, "pullTimeoutMs": 60000, "logLevel": "warn",
		"dns": {"mode": "iterative", "upstreams": ["host", "9.9.9.9"], "rootServers": ["192.0.2.53:5353"],
		        "localDomains": ["Corp.Example."], "cacheSizeBytes": 33554432, "maxLookups": 50, "upstreamQps": 10, "authoritativeQps": 0}
	}`), log)
	if !changed || !dnsChanged {
		t.Fatalf("changed=%v dnsChanged=%v", changed, dnsChanged)
	}
	e := d.settings()
	want := Settings{
		MaxWorkers: 16, PidsLimit: 1024, ShmSize: 1 << 30, Nofile: 4096, LogMaxSize: 1 << 20, LogMaxFiles: 5,
		ImageRetention: time.Hour, PullTimeout: time.Minute, LogLevel: slog.LevelWarn,
		DNS: DNSSettings{
			Mode: "iterative", Upstreams: []string{"host", "9.9.9.9"}, RootServers: []string{"192.0.2.53:5353"}, LocalDomains: []string{"corp.example"},
			CacheSize: 32 << 20, MaxLookups: 50, UpstreamQPS: 10, AuthoritativeQPS: 0,
		},
	}
	if !reflect.DeepEqual(e.settings, want) || e.rev != 3 || len(e.rejected) != 0 || len(e.overridden) != 17 {
		t.Errorf("effective = %+v rev %d rejected %v overridden %v", e.settings, e.rev, e.rejected, e.overridden)
	}
	if level.Level() != slog.LevelWarn {
		t.Errorf("logger level = %v, want warn at once", level.Level())
	}
	if !reflect.DeepEqual(d.cfg.Settings, env) {
		t.Error("an override changed the environment's settings")
	}
	if !strings.Contains(logs.String(), "daemon overrides applied") {
		t.Error("the applied overrides were not logged")
	}

	// The same overrides again change nothing; a new revision alone is reported, the resolver stays.
	if changed, _ := d.applyOverrides(overrides(3, `{"maxWorkers":16,"pidsLimit":1024,"shmSizeBytes":1073741824,"nofile":4096,"workerLogMaxSizeBytes":1048576,"workerLogMaxFiles":5,"imageRetentionMs":3600000,"pullTimeoutMs":60000,"logLevel":"warn","dns":{"mode":"iterative","upstreams":["host","9.9.9.9"],"rootServers":["192.0.2.53:5353"],"localDomains":["corp.example"],"cacheSizeBytes":33554432,"maxLookups":50,"upstreamQps":10,"authoritativeQps":0}}`), log); changed {
		t.Error("identical overrides replaced the snapshot")
	}
	before := d.settings()
	if changed, dnsChanged := d.applyOverrides(overrides(4, `{"maxWorkers":16,"pidsLimit":1024,"shmSizeBytes":1073741824,"nofile":4096,"workerLogMaxSizeBytes":1048576,"workerLogMaxFiles":5,"imageRetentionMs":3600000,"pullTimeoutMs":60000,"logLevel":"warn","dns":{"mode":"iterative","upstreams":["host","9.9.9.9"],"rootServers":["192.0.2.53:5353"],"localDomains":["corp.example"],"cacheSizeBytes":33554432,"maxLookups":50,"upstreamQps":10,"authoritativeQps":0}}`), log); !changed || dnsChanged {
		t.Errorf("a new revision: changed=%v dnsChanged=%v, want true/false", changed, dnsChanged)
	}
	if before.rev != 3 || d.settings().rev != 4 {
		t.Error("a stored snapshot was modified")
	}

	// Removing every override (another instance's hello resets the revision to 0) restores the
	// environment's settings.
	changed, dnsChanged = d.applyOverrides(overrides(0, `{}`), log)
	if !changed || !dnsChanged || !reflect.DeepEqual(d.settings().settings, env) || d.settings().rev != 0 || level.Level() != env.LogLevel {
		t.Errorf("after reset: changed=%v dnsChanged=%v settings %+v level %v", changed, dnsChanged, d.settings().settings, level.Level())
	}
	// An orchestrator without daemon overrides sends none: the environment's settings stay.
	if changed, _ := d.applyOverrides(nil, log); changed {
		t.Error("a response without overrides changed the snapshot")
	}
}

func TestApplyOverridesRejects(t *testing.T) {
	d, logs := newOverridesDaemon(t, func(c *Config) {
		c.Overrides = OverrideAllowList{Keys: []string{"dns.localDomains", "dns.mode", "dns.rootServers", "dns.upstreams", "logLevel", "maxWorkers"}}
	}, nil)
	log := redact.NewLogger(logs, redact.FormatText, slog.LevelDebug)
	d.applyOverrides(overrides(7, `{
		"maxWorkers": 0, "pidsLimit": 512, "logLevel": "debug", "frobnicate": true, "nofile": null,
		"dns": {"mode": "auto", "upstreams": ["169.254.169.254"], "rootServers": ["host"], "localDomains": ["bad domain"], "servers": [], "maxLookups": null}
	}`), log)
	e := d.settings()
	want := map[string]string{
		"maxWorkers":       "must be an integer between 1 and 100000",
		"pidsLimit":        "not allowed on this node (SCANTOR_NODE_OVERRIDES)",
		"logLevel":         "the log level of this daemon cannot change while it runs",
		"frobnicate":       "not supported by this daemon version",
		"dns.mode":         "must be one of recursive, iterative, disabled",
		"dns.upstreams":    "private and special-purpose servers can only be configured in the node environment (SCANTOR_NODE_DNS_*)",
		"dns.rootServers":  `invalid DNS server "host": use an IP address, ip:port or [v6]:port`,
		"dns.localDomains": `invalid domain "bad domain"`,
		"dns.servers":      "not supported by this daemon version",
	}
	if !reflect.DeepEqual(e.rejected, want) {
		t.Errorf("rejected =\n%v\nwant\n%v", e.rejected, want)
	}
	if len(e.overridden) != 0 || !reflect.DeepEqual(e.settings, d.cfg.Settings) || e.rev != 7 {
		t.Errorf("rejected overrides took effect: %+v %v", e.settings, e.overridden)
	}
	if !strings.Contains(logs.String(), "daemon overrides rejected") {
		t.Error("the rejected overrides were not logged")
	}
	// Malformed values: fractions, strings for numbers, a dns member that is no object, no object at all.
	for values, key := range map[string]string{
		`{"maxWorkers": 1.5}`: "maxWorkers", `{"maxWorkers": "8"}`: "maxWorkers", `{"dns": 5}`: "dns", `[1]`: "values",
		`{"dns": {"upstreams": "1.1.1.1"}}`: "dns.upstreams", `{"dns": {"upstreams": []}}`: "dns.upstreams",
	} {
		d.applyOverrides(overrides(8, values), log)
		if _, ok := d.settings().rejected[key]; !ok {
			t.Errorf("%s: rejected = %v, want %s", values, d.settings().rejected, key)
		}
	}
}

// Override upstream and root servers in a private or special-purpose range (the ranges the node resolver
// queries only when it trusts the server, which only the environment's are) or inside the egress deny
// list are refused, also when the environment names the same server; IPv6 link-local, zoned, multicast
// and unspecified addresses are no servers at all. Public servers and the host keyword pass.
func TestApplyOverridesRefusesEnvironmentOnlyServers(t *testing.T) {
	d, _ := newOverridesDaemon(t, func(c *Config) {
		c.EgressDeny = prefixes("169.254.0.0/16", "203.0.113.0/24", "::ffff:198.51.100.0/120")
		c.Settings.DNS.Upstreams = []string{"172.17.0.1", "1.1.1.1"}
		c.Settings.DNS.RootServers = []string{"10.0.0.1:1053"}
	}, nil)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	const envOnly = "private and special-purpose servers can only be configured in the node environment (SCANTOR_NODE_DNS_*)"
	for _, tc := range []struct{ key, servers, want string }{
		{"upstreams", `["10.0.0.2"]`, envOnly},
		{"upstreams", `["9.9.9.9", "127.0.0.1:5353"]`, envOnly},
		{"upstreams", `["100.100.100.100"]`, envOnly},
		{"upstreams", `["192.168.1.1"]`, envOnly},
		{"upstreams", `["169.254.169.253"]`, envOnly},
		{"upstreams", `["[fc00::53]:53"]`, envOnly},
		{"upstreams", `["::ffff:10.0.0.2"]`, envOnly},
		{"upstreams", `["64:ff9b::1.1.1.1"]`, envOnly},
		{"upstreams", `["172.17.0.1"]`, envOnly}, // named by the environment, still refused as an override
		{"upstreams", `["203.0.113.53"]`, envOnly},
		{"upstreams", `["198.51.100.7"]`, envOnly},
		{"upstreams", `["fe80::1"]`, `invalid DNS server "fe80::1": IPv6 link-local addresses are not supported, or host`},
		{"upstreams", `["[fe80::1%eth0]:53"]`, `invalid DNS server "[fe80::1%eth0]:53": zones are not supported, or host`},
		{"upstreams", `["ff02::fb"]`, `invalid DNS server "ff02::fb": not a unicast address, or host`},
		{"upstreams", `["::"]`, `invalid DNS server "::": not a unicast address, or host`},
		{"rootServers", `["10.0.0.1:1053"]`, envOnly},
		{"rootServers", `["[::1]:53"]`, envOnly},
		{"rootServers", `["240.0.0.1"]`, envOnly},
		{"rootServers", `["fe80::53"]`, `invalid DNS server "fe80::53": IPv6 link-local addresses are not supported`},
		{"upstreams", `["host", "9.9.9.9", "[2620:fe::fe]:53"]`, ""},
		{"rootServers", `["192.0.2.53:5353", "198.41.0.4"]`, ""},
	} {
		d.applyOverrides(overrides(1, `{"dns": {"`+tc.key+`": `+tc.servers+`}}`), log)
		e := d.settings()
		got, rejected := e.rejected["dns."+tc.key]
		switch {
		case tc.want == "" && (rejected || !e.overridden["dns."+tc.key]):
			t.Errorf("%s %s: rejected %q", tc.key, tc.servers, got)
		case tc.want != "" && got != tc.want:
			t.Errorf("%s %s: rejected %q, want %q", tc.key, tc.servers, got, tc.want)
		case tc.want != "" && (e.overridden["dns."+tc.key] || !reflect.DeepEqual(e.settings.DNS, d.cfg.Settings.DNS)):
			t.Errorf("%s %s: a refused server took effect: %+v", tc.key, tc.servers, e.settings.DNS)
		}
	}
}

// The daemon configuration report: every value with its source (env, default, override), the warnings,
// the applied overrides revision and the rejected overrides, structured like the values; never a secret.
func TestDaemonConfigReport(t *testing.T) {
	ca := testCACert(t)
	d, _ := newOverridesDaemon(t, func(c *Config) {
		c.URL = "https://node:pw@scantor.example.com/base"
		c.CACert = ca
		c.Overrides = OverrideAllowList{Keys: []string{"dns.mode", "maxWorkers"}}
		c.Warnings = []string{"SCANTOR_NODE_PIDS_LIMIT: invalid integer; using the default"}
		c.Sources = map[string]string{"url": "env", "maxWorkers": "env", "dns.mode": "env", "pidsLimit": "default"}
	}, nil)
	d.host.cpus = 8
	d.applyOverrides(overrides(2, `{"dns": {"mode": "iterative"}, "pidsLimit": 1}`), slog.New(slog.NewTextHandler(io.Discard, nil)))
	rep := d.daemonConfig()
	v := rep.Values
	if v.URL != "https://scantor.example.com/base" || v.MaxWorkers != 4 || v.DNS.Mode != "iterative" || v.PidsLimit != 4096 || v.LogLevel != "debug" ||
		!slices.Equal(v.EgressDeny, []string{"169.254.0.0/16", "fd00:ec2::254/128"}) || v.ImageRetentionMs != 86_400_000 || v.PullTimeoutMs != 5000 ||
		v.DNS.CacheSizeBytes != 256<<20 || !slices.Equal(v.DNS.Upstreams, []string{"1.1.1.1", "8.8.8.8"}) || v.DNS.RootServers == nil || v.DNS.LocalDomains == nil {
		t.Errorf("values = %+v", v)
	}
	if string(v.Overrides) != `["dns.mode","maxWorkers"]` {
		t.Errorf("overrides = %s", v.Overrides)
	}
	if len(v.CACertificates) != 1 || v.CACertificates[0].Subject != "CN=scantor test CA" || len(v.CACertificates[0].SHA256) != 64 {
		t.Errorf("caCertificates = %+v", v.CACertificates)
	}
	var sources map[string]any
	if err := json.Unmarshal(rep.Sources, &sources); err != nil {
		t.Fatal(err)
	}
	dns, _ := sources["dns"].(map[string]any)
	if sources["url"] != "env" || sources["maxWorkers"] != "env" || sources["pidsLimit"] != "default" || sources["builtIn"] != "default" ||
		dns["mode"] != "override" || dns["upstreams"] != "default" || len(sources) != 19 || len(dns) != 8 {
		t.Errorf("sources = %s", rep.Sources)
	}
	if string(rep.Rejected) != `{"pidsLimit":"not allowed on this node (SCANTOR_NODE_OVERRIDES)"}` || rep.AppliedOverridesRev != 2 {
		t.Errorf("rejected = %s, rev %d", rep.Rejected, rep.AppliedOverridesRev)
	}
	if len(rep.Warnings) != 1 {
		t.Errorf("warnings = %v", rep.Warnings)
	}
	body, _ := json.Marshal(rep)
	for _, secret := range []string{testToken, "pw@", ca[30:60]} {
		if strings.Contains(string(body), secret) {
			t.Errorf("the report contains %q", secret)
		}
	}
	for l, want := range map[string]string{"all": `"all"`, "none": `"none"`} {
		list, _ := ParseOverrideAllowList(l)
		if got := string(overridesJSON(list)); got != want {
			t.Errorf("overrides %s = %s", l, got)
		}
	}
}

// maximalDaemon returns a daemon whose configuration report is as large as the settings allow: the most
// and longest local domains, upstream and root servers, plus the given certificates, deny list and
// warnings.
func maximalDaemon(t *testing.T, certs []api.CACertificate, deny []netip.Prefix, warnings []string) *Daemon {
	t.Helper()
	d, _ := newOverridesDaemon(t, func(c *Config) {
		c.EgressDeny, c.Warnings = deny, warnings
		c.URL = "https://" + strings.Repeat("a", 63) + "." + strings.Repeat("b", 63) + ".example/" + strings.Repeat("p", 1800)
	}, nil)
	d.caCerts = certs
	var domains, upstreams, roots []string
	for i := range 64 {
		label := func(c byte) string { return fmt.Sprintf("%c%02d", c, i) + strings.Repeat(string(c), 60) }
		domains = append(domains, label('a')+"."+label('b')+"."+label('c')+"."+label('d')[:61])
	}
	for i := range 16 {
		upstreams = append(upstreams, fmt.Sprintf("[2001:db8:aaaa:aaaa:aaaa:aaaa:aaaa:%04x]:65535", i))
		roots = append(roots, fmt.Sprintf("[2001:db8:eeee:eeee:eeee:eeee:eeee:%04x]:65535", i))
	}
	values, _ := json.Marshal(map[string]any{"dns": map[string]any{"localDomains": domains, "upstreams": upstreams, "rootServers": roots}})
	d.applyOverrides(overrides(1, string(values)), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if e := d.settings(); len(e.rejected) != 0 || len(e.settings.DNS.LocalDomains) != 64 {
		t.Fatalf("overrides rejected: %v", e.rejected)
	}
	return d
}

// checkReportBounds checks a report against the orchestrator's limits and returns its warnings' note.
func checkReportBounds(t *testing.T, rep *api.DaemonConfigReport) string {
	t.Helper()
	body, err := json.Marshal(rep)
	if err != nil {
		t.Fatal(err)
	}
	v := rep.Values
	if len(body) > 64<<10 || len(v.CACertificates) > 32 || len(v.EgressDeny) > 256 || len(rep.Warnings) > 32 {
		t.Errorf("report of %d bytes, %d certificates, %d CIDRs, %d warnings", len(body), len(v.CACertificates), len(v.EgressDeny), len(rep.Warnings))
	}
	for _, c := range v.CACertificates {
		if utf8.RuneCountInString(c.Subject) > 256 {
			t.Errorf("subject of %d characters", utf8.RuneCountInString(c.Subject))
		}
	}
	for _, w := range rep.Warnings {
		if utf8.RuneCountInString(w) > 512 {
			t.Errorf("warning of %d characters", utf8.RuneCountInString(w))
		}
	}
	if len(rep.Warnings) == 0 {
		return ""
	}
	return rep.Warnings[len(rep.Warnings)-1]
}

// The report of every configuration the daemon accepts stays within the orchestrator's limits, which drop
// a larger report whole: at most 32 certificates with subjects of at most 256 characters, 256 egress
// deny CIDRs, 32 warnings of at most 512 characters, and 64 KiB of JSON. The last warning says what was
// cut; the daemon still applies every certificate and CIDR.
func TestDaemonConfigReportIsBounded(t *testing.T) {
	notAfter := api.NewTime(time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC))
	cert := func(i int, subject string) api.CACertificate {
		return api.CACertificate{Subject: subject, SHA256: fmt.Sprintf("%064x", i), NotAfter: notAfter}
	}
	var certs []api.CACertificate
	for i := range 200 {
		certs = append(certs, cert(i, fmt.Sprintf("CN=corporate CA %03d,", i)+strings.Repeat("O=Example Corporation,", 20)))
	}
	var deny []netip.Prefix
	for i := range 1000 {
		deny = append(deny, netip.MustParsePrefix(fmt.Sprintf("2001:db8:ffff:ffff:ffff:ffff:ffff:%04x/128", i)))
	}
	var warnings []string
	for i := range 40 {
		warnings = append(warnings, fmt.Sprintf("SCANTOR_NODE_%02d: ", i)+strings.Repeat("invalid value ", 60))
	}
	d := maximalDaemon(t, certs, deny, warnings)
	rep := d.daemonConfig()
	note := checkReportBounds(t, rep)
	if len(rep.Values.CACertificates) != 32 || len(rep.Values.EgressDeny) != 256 || len(rep.Warnings) != 32 ||
		rep.Values.CACertificates[31].SHA256 != certs[31].SHA256 || rep.Values.EgressDeny[0] != deny[0].String() || !strings.HasPrefix(rep.Warnings[30], "SCANTOR_NODE_30: ") {
		t.Errorf("%d certificates, %d CIDRs, %d warnings: the first entries must be kept", len(rep.Values.CACertificates), len(rep.Values.EgressDeny), len(rep.Warnings))
	}
	if want := "the daemon configuration report is truncated: it lists 32 of 200 certificates of SCANTOR_CA_CERT, 256 of 1000 CIDRs of " +
		"SCANTOR_NODE_EGRESS_DENY, 31 of 40 warnings (the daemon applies every certificate and CIDR)"; note != want {
		t.Errorf("note = %q", note)
	}
	if !strings.HasSuffix(rep.Values.CACertificates[0].Subject, "…") || !strings.HasSuffix(rep.Warnings[0], "…") {
		t.Error("long subjects and warnings must end with …")
	}
	if len(d.caCerts) != 200 || utf8.RuneCountInString(d.caCerts[0].Subject) <= 256 || len(d.cfg.EgressDeny) != 1000 || len(d.cfg.Warnings) != 40 {
		t.Error("the report cut the daemon's own configuration")
	}

	// Subjects whose JSON is six times their length (< escapes as <): the size bound drops
	// certificates from the end until the report fits.
	for i := range certs {
		certs[i] = cert(i, "CN="+strings.Repeat("<", 300))
	}
	d = maximalDaemon(t, certs, deny, warnings)
	rep = d.daemonConfig()
	note = checkReportBounds(t, rep)
	kept := len(rep.Values.CACertificates)
	if kept == 0 || kept >= 32 || len(rep.Values.EgressDeny) != 256 ||
		!strings.Contains(note, fmt.Sprintf("it lists %d of 200 certificates of SCANTOR_CA_CERT", kept)) {
		t.Errorf("%d certificates and %d CIDRs kept; note %q", kept, len(rep.Values.EgressDeny), note)
	}
	body, _ := json.Marshal(rep)
	if len(body) < 60<<10 {
		t.Errorf("the size bound dropped more than needed: %d bytes", len(body))
	}

	// A configuration within the caps is reported in full, without a note.
	d = maximalDaemon(t, certs[:2], deny[:3], warnings[:1])
	rep = d.daemonConfig()
	if note := checkReportBounds(t, rep); len(rep.Values.CACertificates) != 2 || len(rep.Values.EgressDeny) != 3 || len(rep.Warnings) != 1 || strings.Contains(note, "truncated") {
		t.Errorf("report = %+v", rep.Values)
	}
}

// Overrides arrive with the assignments: the status reports the new capacity and configuration, and
// workers created afterwards get the overridden container settings.
func TestDaemonOverridesThroughTheAssignments(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.Settings.MaxWorkers = 3 })
	h.start()
	eventually(t, 5*time.Second, "first status", func() bool { return h.orch.statusCount() > 0 })
	h.orch.mu.Lock()
	hello := h.orch.hellos[0]
	h.orch.mu.Unlock()
	if hello.DaemonConfig == nil || hello.DaemonConfig.Values.MaxWorkers != 3 || hello.DaemonConfig.AppliedOverridesRev != 0 {
		t.Fatalf("hello daemonConfig = %+v", hello.DaemonConfig)
	}

	h.orch.setOverrides(2, `{"maxWorkers": 12, "pidsLimit": 512, "nofile": 1024, "logLevel": "error", "frobnicate": 1}`)
	var st *api.NodeStatusRequest
	eventually(t, 5*time.Second, "status with the overrides", func() bool {
		st = h.orch.lastStatus()
		return st != nil && st.Info.MaxWorkers == 12 && st.DaemonConfig != nil && st.DaemonConfig.AppliedOverridesRev == 2
	})
	if !strings.Contains(string(st.DaemonConfig.Sources), `"maxWorkers":"override"`) || !strings.Contains(string(st.DaemonConfig.Rejected), `"frobnicate"`) {
		t.Errorf("daemonConfig = %+v", st.DaemonConfig)
	}
	if h.level.Level() != slog.LevelError {
		t.Errorf("log level = %v, want error", h.level.Level())
	}
	h.orch.setDesired(testAssignment(testWorker1))
	h.waitWorkerState(testWorker1, api.NodeWorkerRunning)
	c := h.docker.container(workerName(testWorker1))
	if c.host.PidsLimit == nil || *c.host.PidsLimit != 512 || len(c.host.Ulimits) != 1 || c.host.Ulimits[0].Soft != 1024 {
		t.Errorf("worker limits pids %v ulimits %+v", c.host.PidsLimit, c.host.Ulimits)
	}

	// Removing the overrides restores the environment's values; running workers keep theirs.
	h.orch.setOverrides(3, `{}`)
	eventually(t, 5*time.Second, "status without overrides", func() bool {
		st := h.orch.lastStatus()
		return st != nil && st.Info.MaxWorkers == 3 && st.DaemonConfig.AppliedOverridesRev == 3
	})
	if c := h.docker.container(workerName(testWorker1)); *c.host.PidsLimit != 512 || c.starts != 1 {
		t.Error("an override change touched a running worker")
	}
}
