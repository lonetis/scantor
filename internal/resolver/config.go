package resolver

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/netip"
	"regexp"
	"strings"

	"github.com/zmap/dns"

	"github.com/lonetis/scantor/internal/redact"
)

// Bounds of the configuration (the env bounds of docs/nodes.md §2 and schemas/daemon-overrides.json).
const (
	MinCacheBytes      int64 = 16 << 20
	MaxCacheBytes      int64 = 64 << 30
	MaxMaxLookups            = 20000
	MaxQPS                   = 1000000
	MaxUpstreams             = 16
	MaxRootServers           = 16
	maxClients               = 64
	maxLocalNames            = 256
	maxLocalDomains          = 128
	maxDenyServers           = 4096
	maxTrustedServers        = 64
	maxDomainNameBytes       = 253
)

// nodeIDPattern bounds the node id that goes into the probe answer.
var nodeIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,63}$`)

// ParseConfig decodes the --config JSON strictly (unknown fields and trailing data are errors),
// normalizes it and validates it.
func ParseConfig(data []byte) (Config, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var c Config
	if err := dec.Decode(&c); err != nil {
		return Config{}, fmt.Errorf("resolver config: %w", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return Config{}, errors.New("resolver config: trailing data after the JSON object")
	}
	c = c.Normalize()
	if err := c.Validate(); err != nil {
		return Config{}, err
	}
	return c, nil
}

// Validate checks every field of the configuration.
func (c Config) Validate() error {
	_, err := c.compile()
	return err
}

// settings is the compiled form of a Config.
type settings struct {
	nodeID           string
	listen           netip.AddrPort
	clients          []netip.Prefix
	mode             string
	upstreams        []netip.AddrPort
	useHost          bool
	roots            []netip.AddrPort
	localNames       map[string]bool // lowercase FQDNs
	localDomains     []string        // lowercase FQDNs, built-in local suffixes included
	deny             []netip.Prefix
	trusted          map[netip.AddrPort]bool
	cacheBytes       int64
	maxLookups       int
	upstreamQPS      int
	authoritativeQPS int
	logLevel         slog.Level
	logFormat        string
}

// compile validates c and returns its compiled form.
func (c Config) compile() (*settings, error) {
	c = c.Normalize()
	var errs []error
	fail := func(format string, args ...any) { errs = append(errs, fmt.Errorf(format, args...)) }
	s := &settings{
		nodeID:           c.NodeID,
		mode:             c.Mode,
		useHost:          c.UseHostNameservers,
		localNames:       make(map[string]bool, len(c.LocalNames)),
		trusted:          make(map[netip.AddrPort]bool, len(c.TrustedServers)),
		cacheBytes:       c.CacheBytes,
		maxLookups:       c.MaxLookups,
		upstreamQPS:      c.UpstreamQPS,
		authoritativeQPS: c.AuthoritativeQPS,
	}
	if !nodeIDPattern.MatchString(c.NodeID) {
		fail("nodeId %q: use 1-64 letters, digits and hyphens", c.NodeID)
	}
	if ap, err := netip.ParseAddrPort(c.Listen); err != nil {
		fail("listen %q: %v", c.Listen, err)
	} else if !ap.Addr().Unmap().Is4() || ap.Addr().IsUnspecified() || ap.Port() == 0 {
		fail("listen %q: use a specific IPv4 address and a port (never a wildcard)", c.Listen)
	} else {
		s.listen = netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port())
	}
	s.clients = parsePrefixes("clients", c.Clients, maxClients, fail)
	s.deny = parsePrefixes("denyServers", c.DenyServers, maxDenyServers, fail)
	switch c.Mode {
	case ModeRecursive, ModeIterative:
	default:
		fail("mode %q: use %s or %s", c.Mode, ModeRecursive, ModeIterative)
	}
	s.upstreams = parseServers("upstreams", c.Upstreams, MaxUpstreams, fail)
	if c.Mode == ModeRecursive && len(c.Upstreams) == 0 && !c.UseHostNameservers {
		fail("upstreams: recursive mode needs at least one upstream server or useHostNameservers")
	}
	s.roots = parseServers("rootServers", c.RootServers, MaxRootServers, fail)
	for _, ap := range parseServers("trustedServers", c.TrustedServers, maxTrustedServers, fail) {
		s.trusted[ap] = true
	}
	if len(c.LocalNames) > maxLocalNames {
		fail("localNames: at most %d names", maxLocalNames)
	}
	for _, n := range c.LocalNames {
		if err := checkDomainName(n); err != nil {
			fail("localNames: %v", err)
			continue
		}
		s.localNames[dns.Fqdn(n)] = true
	}
	if len(c.LocalDomains) > maxLocalDomains {
		fail("localDomains: at most %d domains", maxLocalDomains)
	}
	s.localDomains = append(s.localDomains, builtinLocalFQDNs...)
	for _, d := range c.LocalDomains {
		if err := checkDomainName(d); err != nil {
			fail("localDomains: %v", err)
			continue
		}
		s.localDomains = append(s.localDomains, dns.Fqdn(d))
	}
	if c.CacheBytes < MinCacheBytes || c.CacheBytes > MaxCacheBytes {
		fail("cacheBytes %d: use %d to %d", c.CacheBytes, MinCacheBytes, MaxCacheBytes)
	}
	if c.MaxLookups < 1 || c.MaxLookups > MaxMaxLookups {
		fail("maxLookups %d: use 1 to %d", c.MaxLookups, MaxMaxLookups)
	}
	if c.UpstreamQPS < 0 || c.UpstreamQPS > MaxQPS {
		fail("upstreamQps %d: use 0 to %d", c.UpstreamQPS, MaxQPS)
	}
	if c.AuthoritativeQPS < 0 || c.AuthoritativeQPS > MaxQPS {
		fail("authoritativeQps %d: use 0 to %d", c.AuthoritativeQPS, MaxQPS)
	}
	s.logLevel = slog.LevelInfo
	if c.LogLevel != "" {
		lvl, err := redact.ParseLevel(c.LogLevel)
		if err != nil {
			fail("logLevel: %v", err)
		}
		s.logLevel = lvl
	}
	s.logFormat = redact.FormatJSON
	switch c.LogFormat {
	case "":
	case redact.FormatJSON, redact.FormatText:
		s.logFormat = c.LogFormat
	default:
		fail("logFormat %q: use json or text", c.LogFormat)
	}
	if len(errs) > 0 {
		return nil, fmt.Errorf("resolver config: %w", errors.Join(errs...))
	}
	return s, nil
}

func parsePrefixes(field string, in []string, limit int, fail func(string, ...any)) []netip.Prefix {
	if len(in) > limit {
		fail("%s: at most %d entries", field, limit)
	}
	out := make([]netip.Prefix, 0, len(in))
	for _, v := range in {
		p, err := netip.ParsePrefix(v)
		if err != nil {
			fail("%s %q: %v", field, v, err)
			continue
		}
		out = append(out, netip.PrefixFrom(p.Addr().Unmap(), unmappedBits(p)).Masked())
	}
	return out
}

// unmappedBits converts the prefix length of a v4-mapped IPv6 prefix to its IPv4 length.
func unmappedBits(p netip.Prefix) int {
	if p.Addr().Is4In6() {
		return max(p.Bits()-96, 0)
	}
	return p.Bits()
}

// parseServers parses "ip:port" and "[v6]:port" server addresses.
func parseServers(field string, in []string, limit int, fail func(string, ...any)) []netip.AddrPort {
	if len(in) > limit {
		fail("%s: at most %d servers", field, limit)
	}
	out := make([]netip.AddrPort, 0, len(in))
	for _, v := range in {
		ap, err := parseServer(v)
		if err != nil {
			fail("%s: %v", field, err)
			continue
		}
		out = append(out, ap)
	}
	return out
}

// parseServer parses one server address ("ip:port", "[ipv6]:port"); the address is unmapped, never
// zoned, IPv6 link-local (fe80::/10, which needs an interface), multicast or unspecified, and the port
// is not 0. IPv4 link-local addresses (a cloud's metadata DNS server, 169.254.169.254) are servers.
func parseServer(v string) (netip.AddrPort, error) {
	ap, err := netip.ParseAddrPort(v)
	if err != nil {
		return netip.AddrPort{}, fmt.Errorf("server %q: use ip:port or [ipv6]:port", v)
	}
	a := ap.Addr().Unmap()
	switch {
	case ap.Port() == 0:
		return netip.AddrPort{}, fmt.Errorf("server %q: port 0", v)
	case a.Zone() != "", a.Is6() && a.IsLinkLocalUnicast():
		return netip.AddrPort{}, fmt.Errorf("server %q: IPv6 link-local and zoned addresses are not supported", v)
	case a.IsUnspecified(), a.IsMulticast():
		return netip.AddrPort{}, fmt.Errorf("server %q: not a unicast address", v)
	}
	return netip.AddrPortFrom(a, ap.Port()), nil
}

// checkDomainName accepts a domain name (no trailing dot needed) of at most 253 octets in
// presentation format without escapes; the root is not a domain here.
func checkDomainName(n string) error {
	n = strings.TrimSuffix(n, ".")
	if n == "" || len(n) > maxDomainNameBytes || strings.ContainsAny(n, "\\ \t") {
		return fmt.Errorf("invalid domain name %q", n)
	}
	if _, ok := dns.IsDomainName(n); !ok {
		return fmt.Errorf("invalid domain name %q", n)
	}
	for _, label := range strings.Split(n, ".") {
		if label == "" {
			return fmt.Errorf("invalid domain name %q: empty label", n)
		}
	}
	return nil
}
