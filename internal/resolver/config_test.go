package resolver

import (
	"encoding/json"
	"fmt"
	"net/netip"
	"reflect"
	"strings"
	"testing"
)

func validConfigJSON() map[string]any {
	return map[string]any{
		"nodeId":             testNodeID,
		"listen":             "10.10.0.1:53",
		"clients":            []string{"10.10.0.0/24"},
		"mode":               "recursive",
		"upstreams":          []string{"1.1.1.1:53", "[2606:4700:4700::1111]:53"},
		"useHostNameservers": false,
		"rootServers":        []string{},
		"localNames":         []string{"amqp.scantor.example.com", "scantor.example.com"},
		"localDomains":       []string{"corp.example"},
		"denyServers":        []string{"169.254.0.0/16", "fd00:ec2::254/128"},
		"trustedServers":     []string{},
		"cacheBytes":         268435456,
		"maxLookups":         1000,
		"upstreamQps":        0,
		"authoritativeQps":   200,
		"logLevel":           "info",
		"logFormat":          "json",
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestParseConfig(t *testing.T) {
	cfg, err := ParseConfig(mustJSON(t, validConfigJSON()))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Mode != ModeRecursive || cfg.MaxLookups != 1000 || len(cfg.Upstreams) != 2 {
		t.Errorf("parsed = %+v", cfg)
	}
	// Strict: unknown fields and trailing data are errors.
	withUnknown := validConfigJSON()
	withUnknown["upstream"] = []string{"8.8.8.8:53"}
	if _, err := ParseConfig(mustJSON(t, withUnknown)); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Errorf("unknown field: %v", err)
	}
	if _, err := ParseConfig(append(mustJSON(t, validConfigJSON()), []byte(` {}`)...)); err == nil {
		t.Error("trailing data accepted")
	}
	if _, err := ParseConfig([]byte(`{"nodeId": 1}`)); err == nil {
		t.Error("wrong type accepted")
	}
}

func TestConfigValidation(t *testing.T) {
	cases := map[string]struct {
		edit func(map[string]any)
		want string // substring of the error; "" = valid
	}{
		"valid":                   {func(map[string]any) {}, ""},
		"iterative without roots": {func(m map[string]any) { m["mode"] = "iterative"; m["upstreams"] = []string{} }, ""},
		"host upstreams only":     {func(m map[string]any) { m["upstreams"] = []string{}; m["useHostNameservers"] = true }, ""},
		"empty log settings":      {func(m map[string]any) { m["logLevel"] = ""; m["logFormat"] = "" }, ""},
		"bad node id":             {func(m map[string]any) { m["nodeId"] = "a b" }, "nodeId"},
		"wildcard listen":         {func(m map[string]any) { m["listen"] = "0.0.0.0:53" }, "never a wildcard"},
		"ipv6 listen":             {func(m map[string]any) { m["listen"] = "[fd00::1]:53" }, "IPv4"},
		"listen without port":     {func(m map[string]any) { m["listen"] = "10.10.0.1" }, "listen"},
		"listen port 0":           {func(m map[string]any) { m["listen"] = "10.10.0.1:0" }, "listen"},
		"bad client":              {func(m map[string]any) { m["clients"] = []string{"10.10.0.0/33"} }, "clients"},
		"bad mode":                {func(m map[string]any) { m["mode"] = "disabled" }, "mode"},
		"recursive w/o servers":   {func(m map[string]any) { m["upstreams"] = []string{} }, "at least one upstream"},
		"upstream w/o port":       {func(m map[string]any) { m["upstreams"] = []string{"1.1.1.1"} }, "ip:port"},
		"upstream port 0":         {func(m map[string]any) { m["upstreams"] = []string{"1.1.1.1:0"} }, "port 0"},
		"link-local upstream":     {func(m map[string]any) { m["upstreams"] = []string{"[fe80::1]:53"} }, "link-local"},
		"zoned upstream":          {func(m map[string]any) { m["upstreams"] = []string{"[fe80::1%eth0]:53"} }, "link-local"},
		"ipv4 link-local server":  {func(m map[string]any) { m["upstreams"] = []string{"169.254.169.254:53"} }, ""},
		"multicast upstream":      {func(m map[string]any) { m["upstreams"] = []string{"239.1.1.1:53"} }, "unicast"},
		"ipv6 multicast root":     {func(m map[string]any) { m["rootServers"] = []string{"[ff02::1]:53"} }, "unicast"},
		"unspecified upstream":    {func(m map[string]any) { m["upstreams"] = []string{"0.0.0.0:53"} }, "unicast"},
		"unspecified v6 upstream": {func(m map[string]any) { m["upstreams"] = []string{"[::]:53"} }, "unicast"},
		"malformed v6 upstream":   {func(m map[string]any) { m["upstreams"] = []string{"[2001:db8::1::2]:53"} }, "ip:port"},
		"too many upstreams":      {func(m map[string]any) { m["upstreams"] = distinctServers(17) }, "at most 16"},
		"bad root":                {func(m map[string]any) { m["rootServers"] = []string{"a.root-servers.net"} }, "rootServers"},
		"bad trusted":             {func(m map[string]any) { m["trustedServers"] = []string{"172.17.0.1"} }, "trustedServers"},
		"bad local name":          {func(m map[string]any) { m["localNames"] = []string{"a..b"} }, "localNames"},
		"escaped local domain":    {func(m map[string]any) { m["localDomains"] = []string{`a\.b`} }, "localDomains"},
		"long local domain":       {func(m map[string]any) { m["localDomains"] = []string{strings.Repeat("a.", 127) + "aa"} }, "localDomains"},
		"bad deny":                {func(m map[string]any) { m["denyServers"] = []string{"169.254.0.0"} }, "denyServers"},
		"cache too small":         {func(m map[string]any) { m["cacheBytes"] = 1 << 20 }, "cacheBytes"},
		"cache too large":         {func(m map[string]any) { m["cacheBytes"] = int64(65) << 30 }, "cacheBytes"},
		"no lookups":              {func(m map[string]any) { m["maxLookups"] = 0 }, "maxLookups"},
		"too many lookups":        {func(m map[string]any) { m["maxLookups"] = 20001 }, "maxLookups"},
		"negative upstream qps":   {func(m map[string]any) { m["upstreamQps"] = -1 }, "upstreamQps"},
		"too high auth qps":       {func(m map[string]any) { m["authoritativeQps"] = 1000001 }, "authoritativeQps"},
		"bad log level":           {func(m map[string]any) { m["logLevel"] = "verbose" }, "logLevel"},
		"bad log format":          {func(m map[string]any) { m["logFormat"] = "xml" }, "logFormat"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			m := validConfigJSON()
			tc.edit(m)
			_, err := ParseConfig(mustJSON(t, m))
			switch {
			case tc.want == "" && err != nil:
				t.Errorf("valid config rejected: %v", err)
			case tc.want != "" && (err == nil || !strings.Contains(err.Error(), tc.want)):
				t.Errorf("error = %v, want one mentioning %q", err, tc.want)
			}
		})
	}
}

func distinctServers(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("198.51.100.%d:53", i+1)
	}
	return out
}

func TestConfigCompile(t *testing.T) {
	cfg, err := ParseConfig(mustJSON(t, validConfigJSON()))
	if err != nil {
		t.Fatal(err)
	}
	cfg.Upstreams = append(cfg.Upstreams, "[::ffff:8.8.8.8]:53")
	cfg.TrustedServers = []string{"172.17.0.1:53"}
	s, err := cfg.compile()
	if err != nil {
		t.Fatal(err)
	}
	if s.listen != netip.MustParseAddrPort("10.10.0.1:53") {
		t.Errorf("listen = %v", s.listen)
	}
	// v4-mapped servers are unmapped, names become lowercase FQDNs, built-in local domains are added.
	if s.upstreams[len(s.upstreams)-1] != netip.MustParseAddrPort("8.8.8.8:53") {
		t.Errorf("upstreams = %v", s.upstreams)
	}
	if !s.localNames["scantor.example.com."] || !s.trusted[netip.MustParseAddrPort("172.17.0.1:53")] {
		t.Errorf("localNames = %v, trusted = %v", s.localNames, s.trusted)
	}
	if s.localDomains[0] != "localhost." || s.localDomains[len(s.localDomains)-1] != "corp.example." {
		t.Errorf("localDomains = %v", s.localDomains)
	}
}

func TestSpecHashIgnoresOrderAndLogSettings(t *testing.T) {
	a, err := ParseConfig(mustJSON(t, validConfigJSON()))
	if err != nil {
		t.Fatal(err)
	}
	b := a
	b.Upstreams = []string{a.Upstreams[1], a.Upstreams[0], a.Upstreams[0]}
	b.LocalNames = []string{"Scantor.Example.com.", "amqp.scantor.example.com"}
	b.LogLevel, b.LogFormat = "debug", "text"
	if SpecHash("img", a) != SpecHash("img", b) {
		t.Error("equal configurations hash differently")
	}
	c := a
	c.Mode = ModeIterative
	if SpecHash("img", a) == SpecHash("img", c) || SpecHash("img", a) == SpecHash("other", a) {
		t.Error("different configurations hash equally")
	}
	if !reflect.DeepEqual(b.Normalize().Upstreams, a.Normalize().Upstreams) {
		t.Errorf("Normalize: %v vs %v", b.Normalize().Upstreams, a.Normalize().Upstreams)
	}
}
