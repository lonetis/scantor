package node

import (
	"bytes"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/resolver"
)

// Daemon overrides (docs/nodes.md §6.12): an admin replaces selected settings of the running daemon
// instance through the orchestrator, which delivers the complete set with every assignments response.
// The daemon applies them to its environment's settings (Config.Settings) and keeps the result as an
// immutable snapshot (effective) that every consumer loads once per operation: the reported maxWorkers,
// the settings of each worker container it creates, the image GC retention, the pull timeout, the
// logger's level and the node resolver. Overrides last until the daemon process stops; they are never
// written anywhere on the node.

// overrideSpec is one overridable key with the bounds of schemas/daemon-overrides.json (the same bounds
// apply to its environment variable).
type overrideSpec struct {
	// key is the dotted key of the daemon configuration ("dns.mode").
	key string
	// env is the variable that sets it.
	env string
	// typ is integer, string or array.
	typ string
	// min and max bound an integer (inclusive).
	min, max int64
	// enum lists the values of a string.
	enum []string
	// minItems, maxItems and format describe an array of strings (format: server, serverOrHost, domain).
	minItems, maxItems int
	format             string
}

// Formats of array items.
const (
	formatServer       = "server"
	formatServerOrHost = "serverOrHost"
	formatDomain       = "domain"
)

// overrideSpecs restates schemas/daemon-overrides.json (TestOverrideSpecsMatchTheBoundsFile keeps them
// equal).
var overrideSpecs = []overrideSpec{
	{key: "maxWorkers", env: "SCANTOR_NODE_MAX_WORKERS", typ: "integer", min: 1, max: 100_000},
	{key: "pidsLimit", env: "SCANTOR_NODE_PIDS_LIMIT", typ: "integer", min: 1, max: 1 << 30},
	{key: "shmSizeBytes", env: "SCANTOR_NODE_SHM_SIZE", typ: "integer", min: 1 << 20, max: 64 << 30},
	{key: "nofile", env: "SCANTOR_NODE_NOFILE", typ: "integer", min: 1, max: 1 << 30},
	{key: "workerLogMaxSizeBytes", env: "SCANTOR_NODE_WORKER_LOG_MAX_SIZE", typ: "integer", min: 1, max: 16 << 30},
	{key: "workerLogMaxFiles", env: "SCANTOR_NODE_WORKER_LOG_MAX_FILES", typ: "integer", min: 1, max: 1000},
	{key: "imageRetentionMs", env: "SCANTOR_NODE_IMAGE_RETENTION", typ: "integer", min: 0, max: 365 * 24 * 3600 * 1000},
	{key: "pullTimeoutMs", env: "SCANTOR_NODE_PULL_TIMEOUT", typ: "integer", min: 1000, max: 24 * 3600 * 1000},
	{key: "logLevel", env: "SCANTOR_LOG_LEVEL", typ: "string", enum: []string{"debug", "info", "warn", "error"}},
	{key: "dns.mode", env: "SCANTOR_NODE_DNS_MODE", typ: "string", enum: []string{api.ResolverModeRecursive, api.ResolverModeIterative, api.ResolverModeDisabled}},
	{key: "dns.upstreams", env: "SCANTOR_NODE_DNS_UPSTREAMS", typ: "array", minItems: 1, maxItems: 16, format: formatServerOrHost},
	{key: "dns.rootServers", env: "SCANTOR_NODE_DNS_ROOT_SERVERS", typ: "array", minItems: 0, maxItems: 16, format: formatServer},
	{key: "dns.localDomains", env: "SCANTOR_NODE_DNS_LOCAL_DOMAINS", typ: "array", minItems: 0, maxItems: 64, format: formatDomain},
	{key: "dns.cacheSizeBytes", env: "SCANTOR_NODE_DNS_CACHE_SIZE", typ: "integer", min: 16 << 20, max: 64 << 30},
	{key: "dns.maxLookups", env: "SCANTOR_NODE_DNS_MAX_LOOKUPS", typ: "integer", min: 1, max: 20_000},
	{key: "dns.upstreamQps", env: "SCANTOR_NODE_DNS_UPSTREAM_QPS", typ: "integer", min: 0, max: 1_000_000},
	{key: "dns.authoritativeQps", env: "SCANTOR_NODE_DNS_AUTHORITATIVE_QPS", typ: "integer", min: 0, max: 1_000_000},
}

var overrideSpecByKey = func() map[string]overrideSpec {
	m := make(map[string]overrideSpec, len(overrideSpecs))
	for _, s := range overrideSpecs {
		m[s.key] = s
	}
	return m
}()

// specOf returns the spec of a known key.
func specOf(key string) overrideSpec {
	s, ok := overrideSpecByKey[key]
	if !ok {
		panic("unknown override key " + key)
	}
	return s
}

// overrideKeyNames returns the override keys in table order.
func overrideKeyNames() []string {
	names := make([]string, len(overrideSpecs))
	for i, s := range overrideSpecs {
		names[i] = s.key
	}
	return names
}

// parseList checks the count and every item of an array setting and returns the normalised items (domains
// lowercase without trailing dot, servers and the host keyword trimmed).
func (s overrideSpec) parseList(items []string) ([]string, error) {
	if len(items) < s.minItems || len(items) > s.maxItems {
		return nil, fmt.Errorf("must list between %d and %d entries", s.minItems, s.maxItems)
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		item = strings.TrimSpace(item)
		switch {
		case s.format == formatDomain:
			d, err := ParseDomain(item)
			if err != nil {
				return nil, err
			}
			item = d
		case s.format == formatServerOrHost && item == UpstreamHost:
		default:
			if _, err := ParseDNSServer(item); err != nil {
				if s.format == formatServerOrHost {
					return nil, fmt.Errorf("%w, or %s", err, UpstreamHost)
				}
				return nil, err
			}
		}
		out = append(out, item)
	}
	return out, nil
}

// effective is the daemon's settings snapshot: the environment's settings with the daemon overrides of
// the last assignments response applied. It is never changed after it was stored.
type effective struct {
	settings Settings
	// rev is the overrides revision it was built from (appliedOverridesRev).
	rev int64
	// overridden holds the keys an override set; rejected maps refused keys to the reason.
	overridden map[string]bool
	rejected   map[string]string
	// key is the canonical encoding of everything above; dnsKey that of settings.DNS.
	key, dnsKey string
}

func newEffective(set Settings, rev int64, overridden map[string]bool, rejected map[string]string) *effective {
	e := &effective{settings: set, rev: rev, overridden: overridden, rejected: rejected}
	if e.overridden == nil {
		e.overridden = map[string]bool{}
	}
	if e.rejected == nil {
		e.rejected = map[string]string{}
	}
	e.key = canonicalJSON(struct {
		Settings   Settings
		Rev        int64
		Overridden map[string]bool
		Rejected   map[string]string
	}{set, rev, e.overridden, e.rejected})
	e.dnsKey = canonicalJSON(set.DNS)
	return e
}

// canonicalJSON encodes v deterministically (struct fields in order, map keys sorted).
func canonicalJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil { // cannot happen: only strings, numbers, booleans, slices and string-keyed maps
		panic(err)
	}
	return string(b)
}

// settings returns the current snapshot of the daemon's settings.
func (d *Daemon) settings() *effective { return d.eff.Load() }

// applyOverrides makes the daemon overrides of an assignments response effective. It always computes the
// environment's settings plus the given values, without comparing revisions: a hello of another instance
// on the same engine resets the overrides, so the revision of one instance can go back to 0. A value whose
// key this daemon does not know, does not allow (SCANTOR_NODE_OVERRIDES) or that is invalid is rejected
// and reported. The snapshot is only replaced when the result differs; changed reports that (the next
// status reports it), dnsChanged that the node resolver's settings differ.
func (d *Daemon) applyOverrides(o *api.DaemonOverrides, log *slog.Logger) (changed, dnsChanged bool) {
	var rev int64
	var raw json.RawMessage
	if o != nil {
		rev, raw = o.Rev, o.Values
	}
	set := d.cfg.Settings.clone()
	overridden := map[string]bool{}
	values, rejected := flattenOverrides(raw)
	for _, key := range slices.Sorted(maps.Keys(values)) {
		spec, known := overrideSpecByKey[key]
		var err error
		switch {
		case !known:
			err = errors.New("not supported by this daemon version")
		case !d.cfg.Overrides.Allows(key):
			err = errors.New("not allowed on this node (SCANTOR_NODE_OVERRIDES)")
		case key == "logLevel" && d.level == nil:
			err = errors.New("the log level of this daemon cannot change while it runs")
		default:
			err = applyOverride(&set, spec, values[key], d.cfg.EgressDeny)
		}
		if err != nil {
			rejected[key] = err.Error()
			continue
		}
		overridden[key] = true
	}
	next := newEffective(set, rev, overridden, rejected)
	prev := d.eff.Load()
	if prev.key == next.key {
		return false, false
	}
	d.eff.Store(next)
	if d.level != nil {
		d.level.Set(set.LogLevel)
	}
	log.Info("daemon overrides applied", "overridesRev", rev, "keys", slices.Sorted(maps.Keys(overridden)))
	if len(rejected) > 0 {
		log.Warn("daemon overrides rejected", "overridesRev", rev, "rejected", rejected)
	}
	return true, prev.dnsKey != next.dnsKey
}

// flattenOverrides decodes the values object into dotted keys ("dns": {"mode": …} becomes "dns.mode").
// Null values set nothing. A malformed values object or dns member is rejected as a whole.
func flattenOverrides(raw json.RawMessage) (map[string]json.RawMessage, map[string]string) {
	values, rejected := map[string]json.RawMessage{}, map[string]string{}
	if len(bytes.TrimSpace(raw)) == 0 || isNull(raw) {
		return values, rejected
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		rejected["values"] = "the overrides are not a JSON object"
		return values, rejected
	}
	for key, v := range top {
		if isNull(v) {
			continue
		}
		if key != "dns" {
			values[key] = v
			continue
		}
		var dns map[string]json.RawMessage
		if err := json.Unmarshal(v, &dns); err != nil {
			rejected["dns"] = "must be an object"
			continue
		}
		for k, dv := range dns {
			if !isNull(dv) {
				values["dns."+k] = dv
			}
		}
	}
	return values, rejected
}

func isNull(raw json.RawMessage) bool { return string(bytes.TrimSpace(raw)) == "null" }

// applyOverride validates one override value against its spec and sets it. Override servers in a private
// or special-purpose range or inside SCANTOR_NODE_EGRESS_DENY are refused (checkOverrideServers).
func applyOverride(set *Settings, spec overrideSpec, raw json.RawMessage, deny []netip.Prefix) error {
	switch spec.typ {
	case "integer":
		n, err := decodeInteger(raw)
		if err != nil || n < spec.min || n > spec.max {
			return fmt.Errorf("must be an integer between %d and %d", spec.min, spec.max)
		}
		setInteger(set, spec.key, n)
	case "string":
		var v string
		if err := json.Unmarshal(raw, &v); err != nil || !slices.Contains(spec.enum, v) {
			return fmt.Errorf("must be one of %s", strings.Join(spec.enum, ", "))
		}
		if spec.key == "logLevel" {
			set.LogLevel = levelOf(v)
		} else {
			set.DNS.Mode = v
		}
	default:
		var items []string
		if err := json.Unmarshal(raw, &items); err != nil {
			return errors.New("must be an array of strings")
		}
		list, err := spec.parseList(items)
		if err != nil {
			return err
		}
		if spec.format != formatDomain {
			if err := checkOverrideServers(list, deny); err != nil {
				return err
			}
		}
		switch spec.key {
		case "dns.upstreams":
			set.DNS.Upstreams = list
		case "dns.rootServers":
			set.DNS.RootServers = list
		default:
			set.DNS.LocalDomains = list
		}
	}
	return nil
}

// decodeInteger decodes a JSON number that is an integer (no fraction, no exponent). A string is refused,
// although json.Number would accept one that holds a number.
func decodeInteger(raw json.RawMessage) (int64, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || (raw[0] != '-' && (raw[0] < '0' || raw[0] > '9')) {
		return 0, errors.New("not a number")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var n json.Number
	if err := dec.Decode(&n); err != nil {
		return 0, err
	}
	return strconv.ParseInt(n.String(), 10, 64)
}

func setInteger(set *Settings, key string, n int64) {
	switch key {
	case "maxWorkers":
		set.MaxWorkers = int(n)
	case "pidsLimit":
		set.PidsLimit = n
	case "shmSizeBytes":
		set.ShmSize = n
	case "nofile":
		set.Nofile = n
	case "workerLogMaxSizeBytes":
		set.LogMaxSize = n
	case "workerLogMaxFiles":
		set.LogMaxFiles = int(n)
	case "imageRetentionMs":
		set.ImageRetention = time.Duration(n) * time.Millisecond
	case "pullTimeoutMs":
		set.PullTimeout = time.Duration(n) * time.Millisecond
	case "dns.cacheSizeBytes":
		set.DNS.CacheSize = n
	case "dns.maxLookups":
		set.DNS.MaxLookups = int(n)
	case "dns.upstreamQps":
		set.DNS.UpstreamQPS = int(n)
	case "dns.authoritativeQps":
		set.DNS.AuthoritativeQPS = int(n)
	}
}

// errEnvironmentOnlyServer rejects an override server that only the node's environment may name.
var errEnvironmentOnlyServer = errors.New("private and special-purpose servers can only be configured in the node environment (SCANTOR_NODE_DNS_*)")

// checkOverrideServers refuses override upstream and root servers whose address lies in a range the node
// resolver never queries unless it trusts the server (resolver.AlwaysRefused: private, loopback,
// link-local, shared, benchmark, multicast, reserved and NAT64 space) or inside SCANTOR_NODE_EGRESS_DENY.
// The resolver trusts only the servers of the node's environment (resolverConfig), so such an override
// could never be queried; and an admin must not point the node's lookups into the node's own networks.
// The host keyword (the host nameservers) passes.
func checkOverrideServers(servers []string, deny []netip.Prefix) error {
	for _, s := range servers {
		if s == UpstreamHost {
			continue
		}
		ap, err := ParseDNSServer(s)
		if err != nil {
			return err
		}
		if resolver.AlwaysRefused(ap.Addr()) || inPrefixes(ap.Addr(), deny) {
			return errEnvironmentOnlyServer
		}
	}
	return nil
}

// inPrefixes reports whether a (unmapped) lies in one of prefixes; an IPv4-mapped IPv6 prefix counts as
// its IPv4 prefix.
func inPrefixes(a netip.Addr, prefixes []netip.Prefix) bool {
	for _, p := range prefixes {
		if p.Addr().Is4In6() && p.Bits() >= 96 {
			p = netip.PrefixFrom(p.Addr().Unmap(), p.Bits()-96)
		}
		if p.Contains(a) {
			return true
		}
	}
	return false
}

func levelOf(name string) slog.Level {
	switch name {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// The daemon configuration report (hello and status, docs/nodes.md §6.12).

// daemonConfig returns the daemon configuration of the current snapshot: every value, its source
// (env, default or override), the configuration warnings, the applied overrides revision and the
// rejected overrides. Secrets (the token, SCANTOR_SECRET) are never part of it.
func (d *Daemon) daemonConfig() *api.DaemonConfigReport {
	e := d.settings()
	s := e.settings
	deny := make([]string, len(d.cfg.EgressDeny))
	for i, p := range d.cfg.EgressDeny {
		deny[i] = p.String()
	}
	values := api.DaemonConfigValues{
		URL:                     truncateChars(redactURL(d.cfg.URL), maxReportURLChars),
		BuiltIn:                 d.cfg.BuiltIn,
		MaxWorkers:              s.EffectiveMaxWorkers(d.host.cpus),
		DinD:                    d.cfg.DinD,
		EgressDeny:              deny,
		AllowUnisolatedNetworks: d.cfg.AllowUnisolatedNetworks,
		AllowInsecureTransport:  d.cfg.AllowInsecure,
		CACertificates:          slices.Clone(d.caCerts),
		PidsLimit:               s.PidsLimit,
		ShmSizeBytes:            s.ShmSize,
		Nofile:                  s.Nofile,
		WorkerLogMaxSizeBytes:   s.LogMaxSize,
		WorkerLogMaxFiles:       s.LogMaxFiles,
		ImageRetentionMs:        s.ImageRetention.Milliseconds(),
		PullTimeoutMs:           s.PullTimeout.Milliseconds(),
		LogLevel:                levelName(s.LogLevel),
		LogFormat:               d.cfg.LogFormat,
		Overrides:               overridesJSON(d.cfg.Overrides),
		DNS: api.DaemonDNSConfig{
			Mode:             s.DNS.Mode,
			Upstreams:        nonNil(s.DNS.Upstreams),
			RootServers:      nonNil(s.DNS.RootServers),
			LocalDomains:     nonNil(s.DNS.LocalDomains),
			CacheSizeBytes:   s.DNS.CacheSize,
			MaxLookups:       s.DNS.MaxLookups,
			UpstreamQPS:      s.DNS.UpstreamQPS,
			AuthoritativeQPS: s.DNS.AuthoritativeQPS,
		},
	}
	sources := make(map[string]string, len(configKeys))
	for key := range configKeys {
		switch {
		case e.overridden[key]:
			sources[key] = api.SourceOverride
		case d.cfg.Sources[key] == api.SourceEnv:
			sources[key] = api.SourceEnv
		default:
			sources[key] = api.SourceDefault
		}
	}
	rejected := make(map[string]string, len(e.rejected))
	for key, msg := range e.rejected {
		rejected[key] = truncateChars(msg, maxReportTextChars)
	}
	rep := &api.DaemonConfigReport{
		AppliedOverridesRev: e.rev,
		Values:              values,
		Sources:             treeJSON(sources),
		Warnings:            nonNil(d.cfg.Warnings),
		Rejected:            treeJSON(rejected),
	}
	boundReport(rep)
	return rep
}

// Bounds of the daemon configuration report (docs/nodes.md §6.12): the orchestrator drops a whole report
// whose JSON exceeds its NODE_SUB_REPORT_MAX_BYTES or whose lists exceed its limits, which are at least
// these caps. A configuration the daemon accepts must never produce such a report, so the report lists
// at most maxReportCACertificates certificates of SCANTOR_CA_CERT, maxReportEgressDeny CIDRs of
// SCANTOR_NODE_EGRESS_DENY and maxReportWarnings warnings of at most maxReportTextChars characters (as
// every rejected-override message), and certificate subjects of at most maxReportSubjectChars characters.
// Only the report is cut: the daemon applies every certificate and every CIDR.
const (
	maxReportBytes          = 64 << 10
	maxReportCACertificates = 32
	maxReportEgressDeny     = 256
	maxReportWarnings       = 32
	maxReportTextChars      = 512
	maxReportSubjectChars   = 256
	// maxReportURLChars bounds the reported SCANTOR_URL (the orchestrator accepts at most 2048 characters).
	maxReportURLChars = 2048
)

// boundReport cuts the lists of rep to the report caps and then, while its JSON is larger than
// maxReportBytes, drops entries from the end of the certificates, the warnings and the egress deny list,
// in this order. When it cut anything, the last warning says what (reportTruncated).
func boundReport(rep *api.DaemonConfigReport) {
	v := &rep.Values
	certs := v.CACertificates
	for i := range certs {
		certs[i].Subject = truncateChars(certs[i].Subject, maxReportSubjectChars)
	}
	deny, warnings := v.EgressDeny, make([]string, len(rep.Warnings))
	for i, w := range rep.Warnings {
		warnings[i] = truncateChars(w, maxReportTextChars)
	}
	keepCerts, keepDeny := min(len(certs), maxReportCACertificates), min(len(deny), maxReportEgressDeny)
	keepWarnings := min(len(warnings), maxReportWarnings)
	for {
		cut := keepCerts < len(certs) || keepDeny < len(deny) || keepWarnings < len(warnings)
		if cut && keepWarnings == maxReportWarnings {
			keepWarnings-- // room for the note
		}
		v.CACertificates, v.EgressDeny = certs[:keepCerts], deny[:keepDeny]
		rep.Warnings = warnings[:keepWarnings:keepWarnings]
		if cut {
			rep.Warnings = append(rep.Warnings, reportTruncated(keepCerts, len(certs), keepDeny, len(deny), keepWarnings, len(warnings)))
		}
		excess := jsonSize(rep) - maxReportBytes
		if excess <= 0 || keepCerts+keepWarnings+keepDeny == 0 {
			// Without these lists the report is bounded by the limits of the settings.
			return
		}
		// Drop just enough entries (each with its comma), then measure again: the note changes the size.
		for ; excess > 0 && keepCerts > 0; keepCerts-- {
			excess -= jsonSize(certs[keepCerts-1]) + 1
		}
		for ; excess > 0 && keepWarnings > 0; keepWarnings-- {
			excess -= jsonSize(warnings[keepWarnings-1]) + 1
		}
		for ; excess > 0 && keepDeny > 0; keepDeny-- {
			excess -= jsonSize(deny[keepDeny-1]) + 1
		}
	}
}

// reportTruncated is the warning of a cut report: which lists it shows only in part.
func reportTruncated(certs, allCerts, deny, allDeny, warnings, allWarnings int) string {
	var parts []string
	if certs < allCerts {
		parts = append(parts, fmt.Sprintf("%d of %d certificates of SCANTOR_CA_CERT", certs, allCerts))
	}
	if deny < allDeny {
		parts = append(parts, fmt.Sprintf("%d of %d CIDRs of SCANTOR_NODE_EGRESS_DENY", deny, allDeny))
	}
	if warnings < allWarnings {
		parts = append(parts, fmt.Sprintf("%d of %d warnings", warnings, allWarnings))
	}
	return "the daemon configuration report is truncated: it lists " + strings.Join(parts, ", ") +
		" (the daemon applies every certificate and CIDR)"
}

// jsonSize returns the length of the JSON encoding of v.
func jsonSize(v any) int { return len(canonicalJSON(v)) }

// truncateChars cuts s to at most n characters (runes), ending with "…" when it cut.
func truncateChars(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	runes := []rune(s)
	return string(runes[:n-1]) + "…"
}

// treeJSON nests dotted keys ({"dns.mode": "x"} becomes {"dns": {"mode": "x"}}), mirroring the structure
// of the configuration values.
func treeJSON(flat map[string]string) json.RawMessage {
	tree := map[string]any{}
	for key, v := range flat {
		parent, child, nested := strings.Cut(key, ".")
		if !nested {
			tree[key] = v
			continue
		}
		sub, ok := tree[parent].(map[string]any)
		if !ok {
			sub = map[string]any{}
			tree[parent] = sub
		}
		sub[child] = v
	}
	return json.RawMessage(canonicalJSON(tree))
}

// overridesJSON renders SCANTOR_NODE_OVERRIDES for the report: "all", "none" or the list of keys.
func overridesJSON(l OverrideAllowList) json.RawMessage {
	switch {
	case l.All:
		return json.RawMessage(canonicalJSON(OverridesAll))
	case len(l.Keys) == 0:
		return json.RawMessage(canonicalJSON(OverridesNone))
	default:
		return json.RawMessage(canonicalJSON(l.Keys))
	}
}

// redactURL removes user information from a URL.
func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	u.User = nil
	return u.String()
}

// caCertificates describes the certificates of a PEM bundle (subject, SHA-256 of the DER, expiry).
func caCertificates(bundle string) []api.CACertificate {
	out := []api.CACertificate{}
	rest := []byte(bundle)
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			return out
		}
		if block.Type != "CERTIFICATE" {
			continue
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			continue
		}
		sum := sha256.Sum256(block.Bytes)
		out = append(out, api.CACertificate{Subject: cert.Subject.String(), SHA256: hex.EncodeToString(sum[:]), NotAfter: api.NewTime(cert.NotAfter)})
	}
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return slices.Clone(s)
}
