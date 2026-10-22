// Package cidr implements the template cidr (docs/templates.md §9.7): one analysis per IP address, or
// per aligned subnet of length `prefix`, of IPv4/IPv6 ranges minus exclusions. Ranges are normalised
// (host bits cleared), merged and iterated in ascending order, IPv4 before IPv6. The expansion must
// not exceed `maxAnalyses`; larger scans are rejected, never truncated.
package cidr

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"math/big"
	"net/netip"
	"slices"
	"strconv"
	"strings"

	"github.com/lonetis/scantor/internal/templates/core"
)

// Name is the template name.
const Name = "cidr"

// Template is the cidr template.
type Template struct{}

// New returns the cidr template.
func New() *Template { return &Template{} }

// Config is the scan config.
type Config struct {
	Cidrs       []string `json:"cidrs"`
	Exclude     []string `json:"exclude"`
	Prefix      *int     `json:"prefix"`
	MaxAnalyses int64    `json:"maxAnalyses"`
}

// AnalysisConfig is one item of the stream: an address (prefix 32 or 128) or the network address
// and length of a subnet.
type AnalysisConfig struct {
	IP      string `json:"ip"`
	Prefix  int    `json:"prefix"`
	Version int    `json:"version"`
}

// Name returns "cidr".
func (*Template) Name() string { return Name }

// Validate checks the entries, the subnet length and the exact count against maxAnalyses.
func (*Template) Validate(cfg json.RawMessage) []core.Issue {
	var c Config
	if err := core.DecodeConfig(cfg, &c); err != nil {
		return []core.Issue{{Message: err.Error()}}
	}
	_, issues := newPlan(c)
	return issues
}

// Estimate is the exact number of addresses or subnets after merging and exclusions.
func (*Template) Estimate(cfg json.RawMessage, _ core.Env) (core.Estimate, error) {
	p, err := parse(cfg)
	if err != nil {
		return core.Estimate{}, err
	}
	return core.Estimate{ExpectedTotal: core.Total(p.count.Int64()), Exact: true}, nil
}

// Resolve records the effective config with empty provenance and the exact count.
func (*Template) Resolve(_ context.Context, _ core.Env, cfg json.RawMessage) (core.Resolution, error) {
	p, err := parse(cfg)
	if err != nil {
		return core.Resolution{}, err
	}
	resolved, err := core.EncodeItem(p.cfg)
	if err != nil {
		return core.Resolution{}, core.Platformf(false, err, "encode the resolved scan config: %v", err)
	}
	return core.Resolution{ScanConfig: resolved, Provenance: map[string]any{}, ExpectedTotal: core.Total(p.count.Int64())}, nil
}

// Stream yields the IPv4 then the IPv6 addresses or subnets in ascending order.
func (*Template) Stream(ctx context.Context, _ core.Env, res core.Resolution) iter.Seq2[json.RawMessage, error] {
	return func(yield func(json.RawMessage, error) bool) {
		p, err := parse(res.ScanConfig)
		if err != nil {
			yield(nil, err)
			return
		}
		for _, f := range []*family{&p.v4, &p.v6} {
			if !f.each(func(start u128) bool {
				if err := ctx.Err(); err != nil {
					yield(nil, err)
					return false
				}
				item, err := core.EncodeItem(AnalysisConfig{IP: toAddr(start, f.v4).String(), Prefix: f.length, Version: f.version()})
				return yield(item, err) && err == nil
			}) {
				return
			}
		}
	}
}

func parse(raw json.RawMessage) (*plan, error) {
	var c Config
	if err := core.DecodeConfig(raw, &c); err != nil {
		return nil, err
	}
	p, issues := newPlan(c)
	if len(issues) > 0 {
		return nil, core.IssuesError(issues)
	}
	return p, nil
}

// interval is an inclusive range of addresses.
type interval struct{ lo, hi u128 }

// family is the merged work of one address family.
type family struct {
	v4      bool
	width   int        // 32 or 128
	length  int        // emitted prefix length: the subnet length, or width per address
	ranges  []interval // merged, ascending
	exclude []interval // merged, ascending; expanded to subnet boundaries in subnet mode
}

func (f *family) version() int {
	if f.v4 {
		return 4
	}
	return 6
}

// step returns the number of addresses per emitted item minus one (the host mask of a subnet).
func (f *family) hostMask() u128 { return lowMask(f.width - f.length) }

// count returns the number of emitted items.
func (f *family) count() *big.Int {
	total := new(big.Int)
	for _, r := range f.ranges {
		total.Add(total, size(r))
		for _, e := range f.exclude {
			if is, ok := intersect(r, e); ok {
				total.Sub(total, size(is))
			}
		}
	}
	return total.Rsh(total, uint(f.width-f.length)) // #nosec G115 -- width ≥ length ≥ 0
}

// each calls fn with the first address of every emitted item in ascending order and reports whether
// iteration ran to the end.
func (f *family) each(fn func(start u128) bool) bool {
	mask := f.hostMask()
	step := mask.add(u128{lo: 1})
	j := 0
	for _, r := range f.ranges {
		cur := r.lo
		for {
			for j < len(f.exclude) && f.exclude[j].hi.cmp(cur) < 0 {
				j++
			}
			stop := r.hi
			if j < len(f.exclude) && f.exclude[j].lo.cmp(cur) <= 0 {
				// cur is excluded: continue after the exclusion.
				if f.exclude[j].hi.cmp(r.hi) >= 0 {
					break
				}
				cur = f.exclude[j].hi.add(u128{lo: 1})
				continue
			}
			if j < len(f.exclude) && f.exclude[j].lo.cmp(r.hi) <= 0 {
				stop = f.exclude[j].lo.sub(u128{lo: 1})
			}
			last := stop.andNot(mask)
			for {
				if !fn(cur) {
					return false
				}
				if cur.cmp(last) >= 0 {
					break
				}
				cur = cur.add(step)
			}
			if stop.cmp(r.hi) >= 0 {
				break
			}
			cur = stop.add(u128{lo: 1})
		}
	}
	return true
}

// plan is a parsed and checked config.
type plan struct {
	cfg   Config
	v4    family
	v6    family
	count *big.Int
}

// newPlan parses the entries, checks the subnet length and counts the expansion.
func newPlan(c Config) (*plan, []core.Issue) {
	if c.Exclude == nil {
		c.Exclude = []string{}
	}
	p := &plan{cfg: c, v4: family{v4: true, width: 32, length: 32}, v6: family{width: 128, length: 128}}
	var issues []core.Issue
	if len(c.Cidrs) == 0 {
		issues = append(issues, core.Issue{Path: "/cidrs", Message: "must contain at least one range"})
	}
	if c.MaxAnalyses < 1 {
		issues = append(issues, core.Issue{Path: "/maxAnalyses", Message: "must be ≥ 1"})
	}
	if c.Prefix != nil && (*c.Prefix < 0 || *c.Prefix > 128) {
		issues = append(issues, core.Issue{Path: "/prefix", Message: "must be between 0 and 128"})
	}
	ranges := make([]netip.Prefix, 0, len(c.Cidrs))
	for i, s := range c.Cidrs {
		pfx, err := parseEntry(s)
		if err != nil {
			issues = append(issues, core.Issue{Path: "/cidrs/" + strconv.Itoa(i), Message: err.Error()})
			continue
		}
		ranges = append(ranges, pfx)
	}
	excludes := make([]netip.Prefix, 0, len(c.Exclude))
	for i, s := range c.Exclude {
		pfx, err := parseEntry(s)
		if err != nil {
			issues = append(issues, core.Issue{Path: "/exclude/" + strconv.Itoa(i), Message: err.Error()})
			continue
		}
		excludes = append(excludes, pfx)
	}
	if len(issues) > 0 {
		return nil, issues
	}
	if c.Prefix != nil {
		if is := checkSubnetLength(*c.Prefix, ranges); is != nil {
			return nil, []core.Issue{*is}
		}
		p.v4.length, p.v6.length = *c.Prefix, *c.Prefix
	}
	for _, f := range []*family{&p.v4, &p.v6} {
		f.ranges = merge(collect(ranges, f.v4, 0))
		f.exclude = merge(collect(excludes, f.v4, f.width-f.length))
	}
	p.count = new(big.Int).Add(p.v4.count(), p.v6.count())
	if p.count.Cmp(big.NewInt(c.MaxAnalyses)) > 0 {
		return nil, []core.Issue{{
			Path:    "/maxAnalyses",
			Message: fmt.Sprintf("cidrs expand to %s analyses, above maxAnalyses %d", p.count.String(), c.MaxAnalyses),
		}}
	}
	return p, nil
}

// parseEntry parses a CIDR range or a single address and clears host bits. Zones and IPv4-mapped
// IPv6 addresses are rejected.
func parseEntry(s string) (netip.Prefix, error) {
	var pfx netip.Prefix
	if strings.Contains(s, "/") {
		parsed, err := netip.ParsePrefix(s)
		if err != nil {
			return netip.Prefix{}, fmt.Errorf("%q is not a valid IPv4/IPv6 CIDR range", s)
		}
		pfx = parsed
	} else {
		addr, err := netip.ParseAddr(s)
		if err != nil {
			return netip.Prefix{}, fmt.Errorf("%q is not a valid IPv4/IPv6 address", s)
		}
		if addr.Zone() != "" {
			return netip.Prefix{}, fmt.Errorf("%q has a zone; zones are not allowed", s)
		}
		pfx = netip.PrefixFrom(addr, addr.BitLen())
	}
	if pfx.Addr().Is4In6() {
		return netip.Prefix{}, fmt.Errorf("%q is an IPv4-mapped IPv6 address; use the IPv4 form", s)
	}
	return pfx.Masked(), nil
}

// checkSubnetLength checks that every range is at least as large as a subnet of length prefix and
// that prefix ≤ 32 when an IPv4 range is present.
func checkSubnetLength(prefix int, ranges []netip.Prefix) *core.Issue {
	for _, r := range ranges {
		if r.Addr().Is4() && prefix > 32 {
			return &core.Issue{Path: "/prefix", Message: fmt.Sprintf("must be ≤ 32 when an IPv4 range is present (%s)", r)}
		}
	}
	for _, r := range ranges {
		if r.Bits() > prefix {
			return &core.Issue{Path: "/prefix", Message: fmt.Sprintf("a /%d subnet is larger than the range %s; use a prefix ≥ %d", prefix, r, r.Bits())}
		}
	}
	return nil
}

// collect returns the intervals of one family; with hostBits > 0 every interval is widened to the
// subnets of that size it intersects (exclusions in subnet mode).
func collect(prefixes []netip.Prefix, v4 bool, hostBits int) []interval {
	mask := lowMask(hostBits)
	var out []interval
	for _, p := range prefixes {
		if p.Addr().Is4() != v4 {
			continue
		}
		lo := fromAddr(p.Addr())
		hi := lo.or(lowMask(p.Addr().BitLen() - p.Bits()))
		out = append(out, interval{lo: lo.andNot(mask), hi: hi.or(mask)})
	}
	return out
}

// merge sorts intervals and merges overlapping and adjacent ones.
func merge(in []interval) []interval {
	slices.SortFunc(in, func(a, b interval) int { return cmp.Or(a.lo.cmp(b.lo), a.hi.cmp(b.hi)) })
	var out []interval
	for _, iv := range in {
		if n := len(out); n > 0 {
			last := &out[n-1]
			if last.hi == maxU128 || iv.lo.cmp(last.hi.add(u128{lo: 1})) <= 0 {
				if iv.hi.cmp(last.hi) > 0 {
					last.hi = iv.hi
				}
				continue
			}
		}
		out = append(out, iv)
	}
	return out
}

func size(iv interval) *big.Int {
	n := iv.hi.sub(iv.lo).big()
	return n.Add(n, big.NewInt(1))
}

func intersect(a, b interval) (interval, bool) {
	lo, hi := a.lo, a.hi
	if b.lo.cmp(lo) > 0 {
		lo = b.lo
	}
	if b.hi.cmp(hi) < 0 {
		hi = b.hi
	}
	return interval{lo: lo, hi: hi}, lo.cmp(hi) <= 0
}
