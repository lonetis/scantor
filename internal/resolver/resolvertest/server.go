package resolvertest

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/zmap/dns"
)

// Query is one query the server received.
type Query struct {
	// Net is "udp" or "tcp".
	Net string
	// Name is the question name, lowercase and fully qualified.
	Name string
	Type uint16
	ID   uint16
	// RD is the recursion desired bit of the query.
	RD   bool
	From netip.AddrPort
	At   time.Time
}

// Behavior changes how the server answers the questions it is set for (Server.On).
type Behavior struct {
	// Net limits the behavior to "udp" or "tcp" queries ("" = both).
	Net string
	// Delay holds the answer back.
	Delay time.Duration
	// Drop never answers.
	Drop bool
	// Truncate answers over UDP with TC=1 and empty sections; TCP queries get the full answer.
	Truncate bool
	// Rcode, when not zero, replaces the answer with an empty one carrying this rcode (AA=0).
	Rcode int
	// Spoof first sends, over UDP, a forged answer (A 192.0.2.66) with another message ID.
	Spoof bool
	// Edit changes the answer last, after every other behavior.
	Edit func(m *dns.Msg)
	// Times limits the behavior to the first Times matching queries (0 = every query).
	Times int
}

// SpoofedAddress is the address of the forged answer of Behavior.Spoof.
var SpoofedAddress = netip.MustParseAddr("192.0.2.66")

type rule struct {
	name  string // "" = every name
	qtype uint16 // 0 = every type
	b     Behavior
	used  int
}

// Server is an authoritative fake DNS server listening on one UDP and one TCP socket of the same
// address.
type Server struct {
	addr  netip.AddrPort
	udp   *dns.Server
	tcp   *dns.Server
	zones []*Zone
	wg    sync.WaitGroup

	mu    sync.Mutex
	rules []*rule
	log   []Query
}

// Start serves zones on addr ("127.0.0.1:0" picks a free port; UDP and TCP use the same port; ":53"
// listens on every IPv4 address). A server for the iterative mode of a resolver (its root server) needs
// a zone "." with ". NS" records, which the resolver's upstream check asks for.
func Start(addr string, zones ...*Zone) (*Server, error) {
	if strings.HasPrefix(addr, ":") {
		addr = "0.0.0.0" + addr // every IPv4 address, as net.Listen does
	}
	ap, err := netip.ParseAddrPort(addr)
	if err != nil {
		return nil, fmt.Errorf("listen address: %w", err)
	}
	pc, ln, err := listenBoth(ap)
	if err != nil {
		return nil, err
	}
	s := &Server{addr: netip.AddrPortFrom(ap.Addr(), pc.LocalAddr().(*net.UDPAddr).AddrPort().Port()), zones: zones}
	accept := func(dh dns.Header) dns.MsgAcceptAction {
		if dh.Bits&(1<<15) != 0 { // QR: a response
			return dns.MsgIgnore
		}
		return dns.MsgAccept
	}
	s.udp = &dns.Server{PacketConn: pc, Handler: dns.HandlerFunc(s.serve), MsgAcceptFunc: accept, UDPSize: 4096}
	s.tcp = &dns.Server{Listener: ln, Handler: dns.HandlerFunc(s.serve), MsgAcceptFunc: accept}
	for _, srv := range []*dns.Server{s.udp, s.tcp} {
		started := make(chan struct{})
		srv.NotifyStartedFunc = func() { close(started) }
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			_ = srv.ActivateAndServe()
		}()
		<-started
	}
	return s, nil
}

// listenBoth binds UDP and TCP on the same port; with port 0 it retries until a free UDP port is also
// free for TCP.
func listenBoth(ap netip.AddrPort) (net.PacketConn, net.Listener, error) {
	var lastErr error
	for range 20 {
		pc, err := net.ListenPacket("udp", ap.String())
		if err != nil {
			return nil, nil, fmt.Errorf("listen udp: %w", err)
		}
		port := pc.LocalAddr().(*net.UDPAddr).AddrPort().Port()
		ln, err := net.Listen("tcp", netip.AddrPortFrom(ap.Addr(), port).String())
		if err == nil {
			return pc, ln, nil
		}
		_ = pc.Close()
		lastErr = err
		if ap.Port() != 0 {
			break
		}
	}
	return nil, nil, fmt.Errorf("listen tcp: %w", lastErr)
}

// Addr is the address the server listens on (UDP and TCP).
func (s *Server) Addr() netip.AddrPort { return s.addr }

// Close stops the server.
func (s *Server) Close() error {
	err := errors.Join(s.udp.Shutdown(), s.tcp.Shutdown())
	s.wg.Wait()
	return err
}

// On sets a behavior for the questions of name (any case; "" = every name) and qtype (0 = every
// type). The first matching behavior that is still active applies.
func (s *Server) On(name string, qtype uint16, b Behavior) {
	if name != "" {
		name = canonical(name)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rules = append(s.rules, &rule{name: name, qtype: qtype, b: b})
}

// Queries returns the query log.
func (s *Server) Queries() []Query {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Query(nil), s.log...)
}

// Count returns how many queries for name and qtype (0 = every type) the server received.
func (s *Server) Count(name string, qtype uint16) int {
	name = canonical(name)
	n := 0
	for _, q := range s.Queries() {
		if q.Name == name && (qtype == 0 || q.Type == qtype) {
			n++
		}
	}
	return n
}

// ResetLog empties the query log.
func (s *Server) ResetLog() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.log = nil
}

// behavior logs the query and returns the behavior that applies to it.
func (s *Server) behavior(netw string, from netip.AddrPort, req *dns.Msg) Behavior {
	q := req.Question[0]
	name := canonical(q.Name)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.log = append(s.log, Query{Net: netw, Name: name, Type: q.Qtype, ID: req.Id, RD: req.RecursionDesired, From: from, At: time.Now()})
	for _, r := range s.rules {
		if (r.name != "" && r.name != name) || (r.qtype != 0 && r.qtype != q.Qtype) || (r.b.Net != "" && r.b.Net != netw) {
			continue
		}
		if r.b.Times > 0 && r.used >= r.b.Times {
			continue
		}
		r.used++
		return r.b
	}
	return Behavior{}
}

func (s *Server) serve(w dns.ResponseWriter, req *dns.Msg) {
	netw, from := "udp", netip.AddrPort{}
	switch a := w.RemoteAddr().(type) {
	case *net.UDPAddr:
		from = a.AddrPort()
	case *net.TCPAddr:
		netw, from = "tcp", a.AddrPort()
	}
	m := new(dns.Msg)
	m.SetReply(req)
	if len(req.Question) != 1 || req.Opcode != dns.OpcodeQuery {
		m.Rcode = dns.RcodeFormatError
		_ = w.WriteMsg(m)
		return
	}
	b := s.behavior(netw, from, req)
	if b.Drop {
		return
	}
	if b.Spoof && netw == "udp" {
		forged := new(dns.Msg)
		forged.SetReply(req)
		forged.Id = req.Id + 1
		forged.Authoritative = true
		forged.Answer = []dns.RR{&dns.A{
			Hdr: dns.RR_Header{Name: req.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 300},
			A:   SpoofedAddress.AsSlice(),
		}}
		_ = w.WriteMsg(forged)
	}
	if b.Delay > 0 {
		time.Sleep(b.Delay)
	}
	switch {
	case b.Rcode != 0:
		m.Rcode = b.Rcode
	case b.Truncate && netw == "udp":
		m.Truncated = true
		if z := s.zoneFor(req.Question[0].Name); z != nil {
			m.Authoritative = true
		}
	default:
		if z := s.zoneFor(req.Question[0].Name); z != nil {
			z.answer(req.Question[0], m)
		} else {
			m.Rcode = dns.RcodeRefused
		}
	}
	size := dns.MaxMsgSize
	if opt := req.IsEdns0(); opt != nil {
		m.SetEdns0(1232, false)
		if netw == "udp" {
			size = int(max(opt.UDPSize(), dns.MinMsgSize))
		}
	} else if netw == "udp" {
		size = dns.MinMsgSize
	}
	if b.Edit != nil {
		b.Edit(m)
	}
	m.Truncate(size)
	_ = w.WriteMsg(m)
}

// zoneFor returns the zone with the longest origin at or above name, or nil.
func (s *Server) zoneFor(name string) *Zone {
	name = canonical(name)
	var best *Zone
	for _, z := range s.zones {
		if dns.IsSubDomain(z.origin, name) && (best == nil || dns.CountLabel(z.origin) > dns.CountLabel(best.origin)) {
			best = z
		}
	}
	return best
}

// Network maps the port-53 addresses that root hints and glue give fake servers to the loopback
// addresses the servers listen on. Rewrite is the address-rewrite hook of the resolver's dialer.
type Network struct {
	mu sync.Mutex
	m  map[netip.AddrPort]netip.AddrPort
}

// Add routes public:53 to s.
func (n *Network) Add(public netip.Addr, s *Server) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.m == nil {
		n.m = make(map[netip.AddrPort]netip.AddrPort)
	}
	n.m[netip.AddrPortFrom(public.Unmap(), 53)] = s.Addr()
}

// AddPort routes public (any port) to s.
func (n *Network) AddPort(public netip.AddrPort, s *Server) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.m == nil {
		n.m = make(map[netip.AddrPort]netip.AddrPort)
	}
	n.m[netip.AddrPortFrom(public.Addr().Unmap(), public.Port())] = s.Addr()
}

// Rewrite returns the loopback address of the server routed at address, or an address nothing
// listens on (port 9 of 127.0.0.1, discard) for an address no server has, so a test never reaches a
// real network.
func (n *Network) Rewrite(_, address string) string {
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return address
	}
	ap = netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port())
	n.mu.Lock()
	defer n.mu.Unlock()
	if to, ok := n.m[ap]; ok {
		return to.String()
	}
	if ap.Addr().IsLoopback() {
		return address
	}
	return "127.0.0.1:9"
}
