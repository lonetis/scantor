package cidr

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/netip"
	"slices"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/templates/core"
)

func expand(t *testing.T, cfg Config) ([]AnalysisConfig, int64) {
	t.Helper()
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := New()
	if issues := tmpl.Validate(raw); len(issues) > 0 {
		t.Fatalf("%s: %v", raw, issues)
	}
	est, err := tmpl.Estimate(raw, core.Env{})
	if err != nil {
		t.Fatal(err)
	}
	res, err := tmpl.Resolve(context.Background(), core.Env{}, raw)
	if err != nil {
		t.Fatal(err)
	}
	if *res.ExpectedTotal != *est.ExpectedTotal {
		t.Fatalf("estimate %d, resolution %d", *est.ExpectedTotal, *res.ExpectedTotal)
	}
	var out []AnalysisConfig
	for item, err := range tmpl.Stream(context.Background(), core.Env{}, res) {
		if err != nil {
			t.Fatal(err)
		}
		var a AnalysisConfig
		if err := json.Unmarshal(item, &a); err != nil {
			t.Fatal(err)
		}
		out = append(out, a)
	}
	return out, *est.ExpectedTotal
}

// naive enumerates every address of a small universe and applies the rules of docs/templates.md §9.7.
func naive(universe netip.Prefix, cfg Config) []AnalysisConfig {
	in := func(list []string, a netip.Addr) bool {
		for _, s := range list {
			p, err := parseEntry(s)
			if err == nil && p.Contains(a) {
				return true
			}
		}
		return false
	}
	version := 4
	if universe.Addr().Is6() {
		version = 6
	}
	var out []AnalysisConfig
	if cfg.Prefix == nil {
		for a := universe.Addr(); universe.Contains(a); a = a.Next() {
			if in(cfg.Cidrs, a) && !in(cfg.Exclude, a) {
				out = append(out, AnalysisConfig{IP: a.String(), Prefix: a.BitLen(), Version: version})
			}
		}
		return out
	}
	size := 1 << (universe.Addr().BitLen() - *cfg.Prefix)
	for a := universe.Addr(); universe.Contains(a); {
		subnet := netip.PrefixFrom(a, *cfg.Prefix)
		covered, excluded := in(cfg.Cidrs, a), false
		b := a
		for range size {
			excluded = excluded || in(cfg.Exclude, b)
			b = b.Next()
		}
		if covered && !excluded {
			out = append(out, AnalysisConfig{IP: subnet.Addr().String(), Prefix: *cfg.Prefix, Version: version})
		}
		a = b
	}
	return out
}

func TestMatchesNaiveExpansion(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	universes := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/24"), netip.MustParsePrefix("2001:db8::/120")}
	for i := range 400 {
		universe := universes[i%2]
		width := universe.Addr().BitLen()
		random := func(minBits int) string {
			bits := minBits + rng.IntN(width-minBits+1)
			b := universe.Addr().As16()
			b[15] = byte(rng.IntN(256))
			a := netip.AddrFrom16(b)
			if universe.Addr().Is4() {
				a = a.Unmap()
			}
			if bits == width && rng.IntN(2) == 0 {
				return a.String() // a single address without /len
			}
			return netip.PrefixFrom(a, bits).String() // host bits set on purpose
		}
		cfg := Config{MaxAnalyses: 1 << 20, Exclude: []string{}}
		for range 1 + rng.IntN(4) {
			cfg.Cidrs = append(cfg.Cidrs, random(width-6))
		}
		for range rng.IntN(4) {
			cfg.Exclude = append(cfg.Exclude, random(width-5))
		}
		if rng.IntN(3) == 0 {
			longest := 0
			for _, s := range cfg.Cidrs {
				p, _ := parseEntry(s)
				longest = max(longest, p.Bits())
			}
			prefix := longest + rng.IntN(width-longest+1)
			cfg.Prefix = &prefix
		}
		got, count := expand(t, cfg)
		want := naive(universe, cfg)
		if count != int64(len(want)) || !slices.Equal(got, want) {
			t.Fatalf("config %+v (prefix %v):\n got %d %v\nwant %d %v", cfg, cfg.Prefix, count, got, len(want), want)
		}
	}
}

func TestFamiliesAndFormatting(t *testing.T) {
	prefix := 126
	got, _ := expand(t, Config{Cidrs: []string{"2001:db8:0:0:0:0:0:8/125"}, Prefix: &prefix, MaxAnalyses: 10, Exclude: []string{}})
	if len(got) != 2 || got[0].IP != "2001:db8::8" || got[1].IP != "2001:db8::c" || got[0].Prefix != 126 || got[0].Version != 6 {
		t.Fatalf("%v", got)
	}
	got, _ = expand(t, Config{Cidrs: []string{"::2/127", "255.255.255.254/31", "0.0.0.0"}, MaxAnalyses: 10})
	ips := make([]string, len(got))
	for i, a := range got {
		ips[i] = a.IP
	}
	if strings.Join(ips, " ") != "0.0.0.0 255.255.255.254 255.255.255.255 ::2 ::3" {
		t.Fatalf("%v", ips)
	}
}

func TestEndOfAddressSpace(t *testing.T) {
	prefix := 1
	got, count := expand(t, Config{Cidrs: []string{"::/0"}, Prefix: &prefix, MaxAnalyses: 10, Exclude: []string{"::1"}})
	if count != 1 || len(got) != 1 || got[0].IP != "8000::" {
		t.Fatalf("%d %v", count, got)
	}
	got, _ = expand(t, Config{Cidrs: []string{"ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe/127"}, MaxAnalyses: 10, Exclude: []string{"ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe"}})
	if len(got) != 1 || got[0].IP != "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff" {
		t.Fatalf("%v", got)
	}
	got, _ = expand(t, Config{Cidrs: []string{"ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffc/126"}, MaxAnalyses: 10, Exclude: []string{"ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"}})
	if len(got) != 3 {
		t.Fatalf("%v", got)
	}
}

func TestValidateMessages(t *testing.T) {
	cases := []struct {
		cfg  string
		path string
		msg  string
	}{
		{`{"cidrs":["::/0"],"exclude":[],"prefix":null,"maxAnalyses":100000000}`, "/maxAnalyses",
			"cidrs expand to 340282366920938463463374607431768211456 analyses, above maxAnalyses 100000000"},
		{`{"cidrs":["10.0.0.0/8","10.0.0.0/9"],"exclude":["10.128.0.0/9"],"prefix":null,"maxAnalyses":8388608}`, "", ""},
		{`{"cidrs":["fe80::1%eth0"],"exclude":[],"prefix":null,"maxAnalyses":1}`, "/cidrs/0", "zones are not allowed"},
		{`{"cidrs":["::ffff:10.0.0.1"],"exclude":[],"prefix":null,"maxAnalyses":1}`, "/cidrs/0", "IPv4-mapped"},
		{`{"cidrs":["10.0.0.1"],"exclude":["10.0.0.0/33"],"prefix":null,"maxAnalyses":1}`, "/exclude/0", "not a valid"},
		{`{"cidrs":["010.0.0.1"],"exclude":[],"prefix":null,"maxAnalyses":1}`, "/cidrs/0", "not a valid"},
		{`{"cidrs":["2001:db8::/32"],"exclude":[],"prefix":48,"maxAnalyses":65536}`, "", ""},
		{`{"cidrs":["2001:db8::/32"],"exclude":[],"prefix":49,"maxAnalyses":65536}`, "/maxAnalyses", "cidrs expand to 131072 analyses"},
	}
	for _, tc := range cases {
		issues := New().Validate(json.RawMessage(tc.cfg))
		if tc.path == "" {
			if len(issues) > 0 {
				t.Errorf("%s: unexpected %v", tc.cfg, issues)
			}
			continue
		}
		if len(issues) != 1 || issues[0].Path != tc.path || !strings.Contains(issues[0].Message, tc.msg) {
			t.Errorf("%s: issues %v, want %s containing %q", tc.cfg, issues, tc.path, tc.msg)
		}
	}
}

func TestSubnetModeWithExclusionsAcrossRanges(t *testing.T) {
	prefix := 30
	got, count := expand(t, Config{
		Cidrs:       []string{"10.0.0.0/28", "10.0.0.16/28", "10.0.1.0/30"},
		Exclude:     []string{"10.0.0.13/32", "10.0.0.14/31", "10.0.0.16/30"},
		Prefix:      &prefix,
		MaxAnalyses: 100,
	})
	var ips []string
	for _, a := range got {
		ips = append(ips, a.IP)
	}
	want := "10.0.0.0 10.0.0.4 10.0.0.8 10.0.0.20 10.0.0.24 10.0.0.28 10.0.1.0"
	if strings.Join(ips, " ") != want || count != 7 {
		t.Fatalf("got %d %v, want %s", count, ips, want)
	}
}

func BenchmarkStream(b *testing.B) {
	raw := json.RawMessage(`{"cidrs":["10.0.0.0/16"],"exclude":["10.0.128.0/24"],"prefix":null,"maxAnalyses":65536}`)
	res, err := New().Resolve(context.Background(), core.Env{}, raw)
	if err != nil {
		b.Fatal(err)
	}
	for b.Loop() {
		n := 0
		for _, err := range New().Stream(context.Background(), core.Env{}, res) {
			if err != nil {
				b.Fatal(err)
			}
			n++
		}
		if n != 65536-256 {
			b.Fatal(fmt.Sprint(n))
		}
	}
}
