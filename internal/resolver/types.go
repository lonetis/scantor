// Package resolver is the node resolver: the DNS server every node daemon runs as one host-network
// container next to its workers (`scantor node resolver serve`). It answers the workers' queries from a
// byte-bounded cache and resolves the rest with the zdns library, recursively through upstream servers or
// iteratively from the root servers (docs/nodes.md §6.11). zdns is imported only by this package.
//
// This file holds the contract shared with internal/node: the configuration the daemon passes with
// --config, the stats the resolver writes to its state file and prints as its health output, and the
// result of the probe container.
package resolver

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"
	"strings"
)

// Modes of a running resolver. A disabled node resolver does not run at all.
const (
	ModeRecursive = "recursive"
	ModeIterative = "iterative"
)

// ProbeName is the name the resolver answers itself (TXT "scantor-resolver node=<id> spec=<hash>"); the
// probe container looks it up through Docker's embedded DNS, exactly the workers' path.
const ProbeName = "resolver.scantor.invalid."

// ProbeAnswerPrefix starts the TXT answer of ProbeName.
const ProbeAnswerPrefix = "scantor-resolver"

// StatePath is the state file the serving resolver rewrites every second (tmpfs /run of its container);
// the healthcheck reads it.
const StatePath = "/run/scantor-resolver/state.json"

// Config is the configuration of one resolver process (--config, compact JSON). The daemon builds it;
// ParseConfig rejects unknown fields. Lists are sorted and deduplicated by Normalize, so equal
// configurations hash equally.
type Config struct {
	// NodeID is the node the resolver serves (part of the probe answer).
	NodeID string `json:"nodeId"`
	// Listen is the gateway IPv4 address of the worker network with port 53 ("10.10.0.1:53").
	Listen string `json:"listen"`
	// Clients are the subnets of the worker network; queries from other sources get REFUSED (the
	// listen address itself is always allowed).
	Clients []string `json:"clients"`
	// Mode is ModeRecursive or ModeIterative.
	Mode string `json:"mode"`
	// Upstreams are the upstream servers of recursive mode as "ip:port" or "[v6]:port".
	Upstreams []string `json:"upstreams"`
	// UseHostNameservers adds the host nameservers (/etc/resolv.conf of the resolver container) to the
	// upstreams (the "host" keyword of SCANTOR_NODE_DNS_UPSTREAMS).
	UseHostNameservers bool `json:"useHostNameservers"`
	// RootServers are the root servers of iterative mode ("ip:port"); empty means the IANA root servers.
	RootServers []string `json:"rootServers"`
	// LocalNames (exact) and LocalDomains (suffix on a label boundary) are resolved through the host
	// nameservers in every mode: the master's endpoint hosts, the built-in local suffixes and
	// SCANTOR_NODE_DNS_LOCAL_DOMAINS.
	LocalNames   []string `json:"localNames"`
	LocalDomains []string `json:"localDomains"`
	// DenyServers are CIDRs (SCANTOR_NODE_EGRESS_DENY) the resolver never sends a query to, except to
	// a trusted server of its route and to the host nameservers.
	DenyServers []string `json:"denyServers"`
	// TrustedServers are the environment-configured upstream and root servers ("ip:port"): the guard
	// allows each for its own route whatever its address (private, loopback, link-local, inside
	// DenyServers or the node's own). Daemon-override servers are never trusted.
	TrustedServers []string `json:"trustedServers"`
	// CacheBytes bounds the answer cache.
	CacheBytes int64 `json:"cacheBytes"`
	// MaxLookups bounds the lookups in flight.
	MaxLookups int `json:"maxLookups"`
	// UpstreamQPS and AuthoritativeQPS limit queries per second per server (0 = no limit).
	UpstreamQPS      int `json:"upstreamQps"`
	AuthoritativeQPS int `json:"authoritativeQps"`
	// LogLevel (debug, info, warn, error) and LogFormat (json, text) of the resolver process.
	LogLevel  string `json:"logLevel"`
	LogFormat string `json:"logFormat"`
}

// Normalize sorts and deduplicates every list and lowercases names, so the spec hash only changes with
// the content.
func (c Config) Normalize() Config {
	norm := func(in []string, lower bool) []string {
		out := make([]string, 0, len(in))
		for _, v := range in {
			v = strings.TrimSpace(v)
			if lower {
				v = strings.ToLower(strings.TrimSuffix(v, "."))
			}
			if v != "" {
				out = append(out, v)
			}
		}
		slices.Sort(out)
		return slices.Compact(out)
	}
	c.Clients = norm(c.Clients, false)
	c.Upstreams = norm(c.Upstreams, false)
	c.RootServers = norm(c.RootServers, false)
	c.LocalNames = norm(c.LocalNames, true)
	c.LocalDomains = norm(c.LocalDomains, true)
	c.DenyServers = norm(c.DenyServers, false)
	c.TrustedServers = norm(c.TrustedServers, false)
	return c
}

// SpecHash is the resolver spec hash ("sha256:<hex>") of an image and a configuration: the label
// scantor.spec-hash of the resolver container and the suffix source of its name. LogLevel and LogFormat
// are not part of it.
func SpecHash(image string, cfg Config) string {
	cfg = cfg.Normalize()
	cfg.LogLevel, cfg.LogFormat = "", ""
	b, err := json.Marshal(struct {
		Image  string `json:"image"`
		Config Config `json:"config"`
	}{image, cfg})
	if err != nil { // cannot happen: only strings, ints and bools
		panic(err)
	}
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// Rcodes counts the response codes sent to clients.
type Rcodes struct {
	NoError  int64 `json:"noError"`
	NXDomain int64 `json:"nxDomain"`
	ServFail int64 `json:"servFail"`
	Refused  int64 `json:"refused"`
	Other    int64 `json:"other"`
}

// Conntrack is the host's netfilter connection tracking usage (zero when unreadable).
type Conntrack struct {
	Count int64 `json:"count"`
	Max   int64 `json:"max"`
}

// Stats is the state file content and the healthcheck output (one JSON line, < 4 KiB). Counters are
// cumulative since the process started.
type Stats struct {
	V     int    `json:"v"`
	Ready bool   `json:"ready"`
	Node  string `json:"node"`
	Spec  string `json:"spec"`
	Mode  string `json:"mode"`
	// Listen is the configured listen address; Error is a bind or start error code (api.ResolverErr*)
	// while Ready is false.
	Listen          string   `json:"listen"`
	Error           string   `json:"error,omitempty"`
	UpstreamOK      bool     `json:"upstreamOk"`
	UpstreamError   string   `json:"upstreamError,omitempty"`
	IPv6            bool     `json:"ipv6"`
	HostNameservers []string `json:"hostNameservers"`
	StartedAt       string   `json:"startedAt"`
	At              string   `json:"at"`
	Queries         int64    `json:"queries"`
	CacheHits       int64    `json:"cacheHits"`
	Lookups         int64    `json:"lookups"`
	Inflight        int64    `json:"inflight"`
	Overloaded      int64    `json:"overloaded"`
	RateLimited     int64    `json:"rateLimited"`
	Timeouts        int64    `json:"timeouts"`
	TCPFallbackFail int64    `json:"tcpFallbackFailures"`
	Panics          int64    `json:"panics"`
	// QueryBudgetExceeded counts the lookups that ended because they spent their query budget;
	// TCPRejected the client TCP connections closed at accept (not a client, or over a connection cap).
	QueryBudgetExceeded int64     `json:"queryBudgetExceeded"`
	TCPRejected         int64     `json:"tcpRejected"`
	Rcodes              Rcodes    `json:"rcodes"`
	QPS                 float64   `json:"qps"`
	CacheBytes          int64     `json:"cacheBytes"`
	CacheEntries        int64     `json:"cacheEntries"`
	Conntrack           Conntrack `json:"conntrack"`
}

// Failures is servFail + timeouts + overloaded (the "failures" of the status report).
func (s Stats) Failures() int64 { return s.Rcodes.ServFail + s.Timeouts + s.Overloaded }

// ProbeResult is the last stdout line of `scantor node resolver probe`.
type ProbeResult struct {
	OK    bool   `json:"ok"`
	Node  string `json:"node,omitempty"`
	Spec  string `json:"spec,omitempty"`
	MS    int64  `json:"ms,omitempty"`
	Error string `json:"error,omitempty"`
}
