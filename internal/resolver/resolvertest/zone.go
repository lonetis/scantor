// Package resolvertest is an authoritative fake DNS server on real UDP and TCP sockets for the unit
// tests of the node resolver (internal/resolver) and the fake DNS of the test stack's fixtures server
// (tests/docker/fixtures). It answers from zones the way an authoritative server does: referrals with
// glue at zone cuts, CNAME chains inside a zone, DNAME, NXDOMAIN and NODATA with the zone's SOA, and
// additional addresses for NS, MX and SRV targets. Per question it can delay, drop, truncate, fail or
// edit its answers and send a forged answer first, and it logs every query it receives.
package resolvertest

import (
	"fmt"
	"slices"
	"strings"

	"github.com/zmap/dns"
)

// Zone is the data of one zone: every record at or below its origin, including the NS records of
// delegations (zone cuts) and their glue.
type Zone struct {
	origin string
	rrs    map[string][]dns.RR
	soa    *dns.SOA
}

// maxChase bounds the CNAME and DNAME chain a zone follows inside itself in one answer.
const maxChase = 8

// NewZone parses records in presentation format; names may be relative to origin and a missing TTL
// means 3600. Every record must be at or below origin. Without an SOA record the zone gets
// "<origin> 300 IN SOA ns.<origin> hostmaster.<origin> 1 3600 600 86400 300" (ns. and hostmaster. for the
// root).
func NewZone(origin string, records ...string) (*Zone, error) {
	origin = canonical(origin)
	z := &Zone{origin: origin, rrs: make(map[string][]dns.RR)}
	zp := dns.NewZoneParser(strings.NewReader(strings.Join(records, "\n")), origin, "")
	zp.SetDefaultTTL(3600)
	for rr, ok := zp.Next(); ok; rr, ok = zp.Next() {
		name := canonical(rr.Header().Name)
		if !dns.IsSubDomain(origin, name) {
			return nil, fmt.Errorf("record %q is outside zone %s", rr.String(), origin)
		}
		rr.Header().Name = name
		if soa, ok := rr.(*dns.SOA); ok {
			if name != origin {
				return nil, fmt.Errorf("SOA record %q is not at the zone origin", rr.String())
			}
			z.soa = soa
			continue
		}
		z.rrs[name] = append(z.rrs[name], rr)
	}
	if err := zp.Err(); err != nil {
		return nil, fmt.Errorf("zone %s: %w", origin, err)
	}
	if z.soa == nil {
		below := func(label string) string {
			if origin == "." {
				return label + "."
			}
			return label + "." + origin
		}
		rr, err := dns.NewRR(fmt.Sprintf("%s 300 IN SOA %s %s 1 3600 600 86400 300", origin, below("ns"), below("hostmaster")))
		if err != nil {
			return nil, fmt.Errorf("zone %s: default SOA: %w", origin, err)
		}
		z.soa = rr.(*dns.SOA)
	}
	return z, nil
}

// MustZone is NewZone for static zone data; it panics on an error.
func MustZone(origin string, records ...string) *Zone {
	z, err := NewZone(origin, records...)
	if err != nil {
		panic(err)
	}
	return z
}

// Origin returns the zone's origin (lowercase, fully qualified).
func (z *Zone) Origin() string { return z.origin }

// canonical lowercases a name and makes it fully qualified.
func canonical(name string) string { return dns.CanonicalName(name) }

// answer fills m (a reply to q) like an authoritative server of z.
func (z *Zone) answer(q dns.Question, m *dns.Msg) {
	name := canonical(q.Name)
	if cut := z.cut(name); cut != "" {
		z.refer(cut, m)
		return
	}
	m.Authoritative = true
	seen := map[string]bool{}
	for range maxChase {
		if seen[name] {
			return // a loop inside the zone: answer what was collected
		}
		seen[name] = true
		next, done := z.step(name, q.Qtype, m)
		if done {
			z.addAdditionals(m)
			return
		}
		// Follow the target only while it is in this zone and above every cut.
		if !dns.IsSubDomain(z.origin, next) || z.cut(next) != "" {
			z.addAdditionals(m)
			return
		}
		name = next
	}
	z.addAdditionals(m)
}

// step answers one name of a chain. It returns the next name of a CNAME or DNAME chain, or done.
func (z *Zone) step(name string, qtype uint16, m *dns.Msg) (next string, done bool) {
	if dname, target := z.dname(name); dname != nil {
		m.Answer = append(m.Answer, dns.Copy(dname))
		cname := &dns.CNAME{
			Hdr:    dns.RR_Header{Name: name, Rrtype: dns.TypeCNAME, Class: dns.ClassINET, Ttl: dname.Hdr.Ttl},
			Target: target,
		}
		m.Answer = append(m.Answer, cname)
		return target, false
	}
	rrs := z.rrs[name]
	if len(rrs) == 0 {
		if z.hasBelow(name) {
			m.Rcode = dns.RcodeSuccess // empty non-terminal: NODATA
		} else {
			m.Rcode = dns.RcodeNameError
		}
		m.Ns = append(m.Ns, dns.Copy(z.soa))
		return "", true
	}
	var matched []dns.RR
	var cname *dns.CNAME
	for _, rr := range rrs {
		t := rr.Header().Rrtype
		if qtype == dns.TypeANY || t == qtype {
			matched = append(matched, dns.Copy(rr))
		}
		if c, ok := rr.(*dns.CNAME); ok {
			cname = c
		}
	}
	if len(matched) > 0 {
		m.Answer = append(m.Answer, matched...)
		return "", true
	}
	if cname != nil {
		m.Answer = append(m.Answer, dns.Copy(cname))
		return canonical(cname.Target), false
	}
	m.Ns = append(m.Ns, dns.Copy(z.soa)) // NODATA
	return "", true
}

// cut returns the closest zone cut (a name strictly below the origin with NS records) at or above
// name, or "".
func (z *Zone) cut(name string) string {
	labels := dns.SplitDomainName(name)
	originLabels := dns.CountLabel(z.origin)
	// Walk from the label right below the origin down to name itself.
	for i := len(labels) - originLabels - 1; i >= 0; i-- {
		candidate := dns.Fqdn(strings.Join(labels[i:], "."))
		for _, rr := range z.rrs[candidate] {
			if rr.Header().Rrtype == dns.TypeNS {
				return candidate
			}
		}
	}
	return ""
}

// refer answers with a referral to the delegation at cut: its NS records and the glue the zone holds.
func (z *Zone) refer(cut string, m *dns.Msg) {
	for _, rr := range z.rrs[cut] {
		if ns, ok := rr.(*dns.NS); ok {
			m.Ns = append(m.Ns, dns.Copy(ns))
			m.Extra = append(m.Extra, z.addresses(canonical(ns.Ns))...)
		}
	}
}

// dname returns the DNAME of the closest proper ancestor of name inside the zone and the name it
// rewrites name to.
func (z *Zone) dname(name string) (*dns.DNAME, string) {
	labels := dns.SplitDomainName(name)
	originLabels := dns.CountLabel(z.origin)
	for i := 1; i <= len(labels)-originLabels; i++ {
		owner := dns.Fqdn(strings.Join(labels[i:], "."))
		if i == len(labels) {
			owner = "."
		}
		for _, rr := range z.rrs[owner] {
			if d, ok := rr.(*dns.DNAME); ok {
				prefix := strings.TrimSuffix(name, owner)
				if owner == "." {
					prefix = name
				}
				return d, canonical(prefix + d.Target)
			}
		}
	}
	return nil, ""
}

// hasBelow reports whether the zone holds a name below name (name is an empty non-terminal).
func (z *Zone) hasBelow(name string) bool {
	for owner := range z.rrs {
		if owner != name && dns.IsSubDomain(name, owner) {
			return true
		}
	}
	return false
}

// addresses returns copies of the A and AAAA records of name the zone holds.
func (z *Zone) addresses(name string) []dns.RR {
	var out []dns.RR
	for _, rr := range z.rrs[name] {
		switch rr.Header().Rrtype {
		case dns.TypeA, dns.TypeAAAA:
			out = append(out, dns.Copy(rr))
		}
	}
	return out
}

// addAdditionals adds the addresses of NS, MX and SRV targets in the answer section, as BIND does.
func (z *Zone) addAdditionals(m *dns.Msg) {
	for _, rr := range m.Answer {
		var target string
		switch v := rr.(type) {
		case *dns.NS:
			target = v.Ns
		case *dns.MX:
			target = v.Mx
		case *dns.SRV:
			target = v.Target
		default:
			continue
		}
		for _, a := range z.addresses(canonical(target)) {
			if !slices.ContainsFunc(m.Extra, func(e dns.RR) bool { return dns.IsDuplicate(e, a) }) {
				m.Extra = append(m.Extra, a)
			}
		}
	}
}
