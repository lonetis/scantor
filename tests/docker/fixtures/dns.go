package main

// The fixtures DNS server (docs/testing.md §7.9): the only name server of a fake internet that knows the
// names below scantor.test and nothing else. It is authoritative for the root zone "." and answers every
// question itself (AA, no delegations), so a node resolver in iterative mode whose root servers point here
// (SCANTOR_NODE_DNS_ROOT_SERVERS=172.17.0.1:1053: the stack publishes port 53 of the container on the
// runner as 1053) resolves every name with this one server: an iterative resolver always sends delegated
// servers to port 53, so a fake that referred would never be reached again. Every query is logged as one
// JSON line, like the HTTP requests, so specs can see which names reached it.

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/zmap/dns"
)

const (
	dnsListenAddress = ":53"
	// dnsUDPSize is the EDNS buffer size the server advertises and the largest UDP answer it sends.
	dnsUDPSize = 1232
	// maxCNAMEChain bounds the CNAME chain an answer follows inside the zone.
	maxCNAMEChain = 8
)

// fixturesZone is the zone the server answers from: the root zone of the fake internet. Below scantor.test
// it has an address (a), a TXT record, a CNAME (www) and a chain of two (alias), names with only AAAA (v6)
// or both families (dual), and the empty non-terminals test. and scantor.test. Every other name is
// NXDOMAIN. Negative answers are cached for 30 s (min of the SOA TTL and its MINIMUM).
var fixturesZone = []string{
	". 300 IN SOA ns.scantor.test. hostmaster.scantor.test. 1 3600 600 86400 30",
	". 300 IN NS ns.scantor.test.",
	"ns.scantor.test. 300 IN A 192.0.2.53",
	"a.scantor.test. 300 IN A 192.0.2.10",
	`a.scantor.test. 300 IN TXT "scantor fixtures"`,
	"www.scantor.test. 300 IN CNAME a.scantor.test.",
	"alias.scantor.test. 300 IN CNAME www.scantor.test.",
	"v6.scantor.test. 300 IN AAAA 2001:db8::10",
	"dual.scantor.test. 300 IN A 192.0.2.11",
	"dual.scantor.test. 300 IN AAAA 2001:db8::11",
}

// zone is one authoritative zone held in memory. Owner names are lowercase and fully qualified.
type zone struct {
	origin string
	soa    *dns.SOA
	// records holds the RRsets per owner and type.
	records map[string]map[uint16][]dns.RR
	// names holds every name that exists: the owners and the empty non-terminals between them and the
	// origin, which answer NODATA instead of NXDOMAIN.
	names map[string]bool
}

// newZone parses the records of a zone given in presentation format. Exactly one SOA, owned by the origin,
// is required; every owner must lie at or below the origin.
func newZone(origin string, lines []string) (*zone, error) {
	origin = strings.ToLower(dns.Fqdn(origin))
	z := &zone{origin: origin, records: map[string]map[uint16][]dns.RR{}, names: map[string]bool{}}
	for _, line := range lines {
		rr, err := dns.NewRR(line)
		if err != nil {
			return nil, fmt.Errorf("zone record %q: %w", line, err)
		}
		if rr == nil {
			return nil, fmt.Errorf("zone record %q is empty", line)
		}
		owner := strings.ToLower(rr.Header().Name)
		if !dns.IsSubDomain(origin, owner) {
			return nil, fmt.Errorf("zone record %q lies outside the zone %s", line, origin)
		}
		rr.Header().Name = owner
		if soa, ok := rr.(*dns.SOA); ok {
			if owner != origin || z.soa != nil {
				return nil, fmt.Errorf("zone record %q: the zone needs exactly one SOA, owned by %s", line, origin)
			}
			z.soa = soa
		}
		types := z.records[owner]
		if types == nil {
			types = map[uint16][]dns.RR{}
			z.records[owner] = types
		}
		types[rr.Header().Rrtype] = append(types[rr.Header().Rrtype], rr)
		for name := owner; ; name = parentName(name) {
			z.names[name] = true
			if name == origin {
				break
			}
		}
	}
	if z.soa == nil {
		return nil, fmt.Errorf("the zone %s has no SOA record", origin)
	}
	for owner, types := range z.records {
		if len(types[dns.TypeCNAME]) > 0 && len(types) > 1 {
			return nil, fmt.Errorf("the CNAME owner %s has other records", owner)
		}
	}
	return z, nil
}

// parentName is the name one label up ("a.b." → "b.", "b." → ".").
func parentName(name string) string {
	if name == "." {
		return "."
	}
	if i := strings.IndexByte(name, '.'); i >= 0 && i+1 < len(name) {
		return name[i+1:]
	}
	return "."
}

// answer resolves one question inside the zone: the RRset of the name, a CNAME chain followed inside the
// zone, NODATA (no record of the type) or NXDOMAIN, the negative answers with the SOA in the authority
// section. It returns copies, so concurrent replies never share a record.
func (z *zone) answer(q dns.Question) (rcode int, answer, authority []dns.RR) {
	name := strings.ToLower(dns.Fqdn(q.Name))
	if !dns.IsSubDomain(z.origin, name) {
		return dns.RcodeRefused, nil, nil
	}
	seen := map[string]bool{}
	for {
		if !z.names[name] {
			return dns.RcodeNameError, answer, z.negative()
		}
		types := z.records[name]
		if rrs := rrsetOf(types, q.Qtype); len(rrs) > 0 {
			return dns.RcodeSuccess, append(answer, rrs...), nil
		}
		cname := types[dns.TypeCNAME]
		if len(cname) == 0 || q.Qtype == dns.TypeCNAME || seen[name] || len(seen) == maxCNAMEChain {
			return dns.RcodeSuccess, answer, z.negative()
		}
		seen[name] = true
		answer = append(answer, dns.Copy(cname[0]))
		name = strings.ToLower(cname[0].(*dns.CNAME).Target)
		if !dns.IsSubDomain(z.origin, name) {
			return dns.RcodeSuccess, answer, nil
		}
	}
}

// rrsetOf copies the records of a type (every record for ANY, in type order).
func rrsetOf(types map[uint16][]dns.RR, qtype uint16) []dns.RR {
	var out []dns.RR
	if qtype == dns.TypeANY {
		keys := make([]uint16, 0, len(types))
		for t := range types {
			keys = append(keys, t)
		}
		slices.Sort(keys)
		for _, t := range keys {
			for _, rr := range types[t] {
				out = append(out, dns.Copy(rr))
			}
		}
		return out
	}
	for _, rr := range types[qtype] {
		out = append(out, dns.Copy(rr))
	}
	return out
}

// negative is the authority section of NXDOMAIN and NODATA: the SOA with the negative TTL (RFC 2308 §3).
func (z *zone) negative() []dns.RR {
	soa := dns.Copy(z.soa).(*dns.SOA)
	soa.Hdr.Ttl = min(soa.Hdr.Ttl, soa.Minttl)
	return []dns.RR{soa}
}

// dnsHandler answers every query from the zone and logs it.
type dnsHandler struct {
	zone *zone
	log  *slog.Logger
}

func (h *dnsHandler) ServeDNS(w dns.ResponseWriter, r *dns.Msg) {
	start := time.Now()
	m := new(dns.Msg)
	m.SetReply(r)
	m.Authoritative = true
	proto := "udp"
	if _, ok := w.RemoteAddr().(*net.TCPAddr); ok {
		proto = "tcp"
	}
	var q dns.Question
	switch {
	case r.Opcode != dns.OpcodeQuery:
		m.Authoritative = false
		m.Rcode = dns.RcodeNotImplemented
	case len(r.Question) != 1:
		m.Authoritative = false
		m.Rcode = dns.RcodeFormatError
	default:
		q = r.Question[0]
		switch {
		case q.Qclass != dns.ClassINET, q.Qtype == dns.TypeAXFR, q.Qtype == dns.TypeIXFR:
			m.Authoritative = false
			m.Rcode = dns.RcodeRefused
		default:
			m.Rcode, m.Answer, m.Ns = h.zone.answer(q)
		}
	}
	size := dns.MinMsgSize
	if opt := r.IsEdns0(); opt != nil {
		if opt.Version() != 0 {
			m.Authoritative = false
			m.Rcode, m.Answer, m.Ns = dns.RcodeBadVers, nil, nil
		}
		m.SetEdns0(dnsUDPSize, false)
		size = min(max(int(opt.UDPSize()), dns.MinMsgSize), dnsUDPSize)
	}
	if proto == "udp" {
		m.Truncate(size)
	}
	err := w.WriteMsg(m)
	attrs := []any{
		"proto", proto, "remote", w.RemoteAddr().String(), "name", strings.ToLower(q.Name), "type", dns.TypeToString[q.Qtype],
		"rcode", rcodeName(m), "answers", len(m.Answer), "truncated", m.Truncated, "ms", time.Since(start).Milliseconds(),
	}
	if err != nil {
		h.log.Warn("dns query", append(attrs, "err", err.Error())...)
		return
	}
	h.log.Info("dns query", attrs...)
}

// rcodeName is the name of a reply's response code (16 is BADVERS with EDNS, BADSIG otherwise).
func rcodeName(m *dns.Msg) string {
	if m.Rcode == dns.RcodeBadVers && m.IsEdns0() != nil {
		return "BADVERS"
	}
	return dns.RcodeToString[m.Rcode]
}

// dnsServers are the UDP and TCP servers of one handler.
type dnsServers struct {
	servers []*dns.Server
	started sync.WaitGroup
	// errs receives the error of a server that stopped serving.
	errs chan error
}

// serveDNS serves the handler on an already bound UDP socket and TCP listener in the background.
func serveDNS(handler dns.Handler, pc net.PacketConn, l net.Listener) *dnsServers {
	s := &dnsServers{
		servers: []*dns.Server{{PacketConn: pc, Handler: handler}, {Listener: l, Handler: handler}},
		errs:    make(chan error, 2),
	}
	s.started.Add(len(s.servers))
	for _, srv := range s.servers {
		srv.NotifyStartedFunc = s.started.Done
		go func() {
			err := srv.ActivateAndServe()
			if err == nil {
				err = errors.New("the server stopped")
			}
			s.errs <- fmt.Errorf("dns over %s: %w", protoOf(srv), err)
		}()
	}
	return s
}

func protoOf(srv *dns.Server) string {
	if srv.PacketConn != nil {
		return "udp"
	}
	return "tcp"
}

// waitStarted returns once both servers serve, or with the error of one that failed first.
func (s *dnsServers) waitStarted(timeout time.Duration) error {
	done := make(chan struct{})
	go func() {
		s.started.Wait()
		close(done)
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
		return nil
	case err := <-s.errs:
		return err
	case <-timer.C:
		return fmt.Errorf("the dns servers did not start within %s", timeout)
	}
}

// shutdown stops both servers.
func (s *dnsServers) shutdown() error {
	var errs []error
	for _, srv := range s.servers {
		if err := srv.Shutdown(); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// startDNS serves the zone on addr over UDP and TCP; it returns once both servers serve.
func startDNS(log *slog.Logger, addr string, z *zone) (*dnsServers, error) {
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		return nil, fmt.Errorf("dns over udp: %w", err)
	}
	l, err := net.Listen("tcp", addr)
	if err != nil {
		_ = pc.Close()
		return nil, fmt.Errorf("dns over tcp: %w", err)
	}
	s := serveDNS(&dnsHandler{zone: z, log: log}, pc, l)
	if err := s.waitStarted(10 * time.Second); err != nil {
		_ = pc.Close()
		_ = l.Close()
		return nil, err
	}
	return s, nil
}
